#!/usr/bin/env node
'use strict';
/*
 * live-diff — a live working-tree diff viewer with per-file staging.
 *
 * Serves a Monaco-backed diff of any git repository's working tree, split into
 * STAGED (index vs HEAD) and UNSTAGED (working tree vs index + untracked)
 * collapsible trees, with per-file stage/unstage. Pushes live updates over SSE.
 * Any number of repositories can be watched at once.
 *
 * Pure Node (zero npm runtime deps). Monaco loads from a CDN in the browser.
 *
 * Changes are detected near-instantly via fs.watch on every directory that
 * contains tracked or non-ignored files (plus .git), with the interval poll
 * kept only as a safety net.
 *
 *   node server.js --repo /path/to/repo --port 4966 --host 127.0.0.1
 *
 * Multi-repo: when the UI is served under some mount prefix (e.g. /diff behind
 * a reverse proxy), any other repository can be opened on demand:
 *
 *   /diff                       → the default repo (--repo / LIVE_DIFF_REPO)
 *   /diff:/abs/path/to/repo     → that repository (path-colon form)
 *   /diff/?repo=/abs/path       → same, as a query parameter
 *
 * Every /api/* endpoint also takes ?repo=/abs/path. The server detects its
 * mount prefix from the request, so it works at the root or under any sub-path.
 * LIVE_DIFF_ALLOW restricts which repositories may be opened.
 *
 * Options can also be set via env vars: LIVE_DIFF_REPO, LIVE_DIFF_PORT,
 * LIVE_DIFF_HOST, LIVE_DIFF_NAME, LIVE_DIFF_POLL, LIVE_DIFF_ALLOW,
 * LIVE_DIFF_MAX_REPOS, LIVE_DIFF_MAX_DIFF_MB, LIVE_DIFF_MAX_FILE_MB.
 * CLI flags take precedence.
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');

/* ---------------------------- config / args ---------------------------- */
function printHelp() {
  process.stdout.write(
`live-diff — live working-tree diff viewer

Usage: live-diff [options]

Options:
  -r, --repo <path>     default repository to watch (default: current directory)
  -p, --port <n>        port to listen on (default: 4966)
      --host <addr>     address to bind (default: 127.0.0.1)
  -n, --name <label>    display name for the default repo (default: repo basename)
      --poll <ms>       safety-net recompute interval (default: 15000)
  -h, --help            show this help

Multi-repo: the same server can also open any other repository on demand:
  /                    the default repo (as configured above)
  /:/abs/path/to/repo  that repository (the path after the mount point)
  /?repo=/abs/path     same, as a query parameter
Every /api/* endpoint accepts ?repo=/abs/path too. LIVE_DIFF_ALLOW restricts
which repositories may be opened; unset means any git repository is allowed.

Env: LIVE_DIFF_REPO, LIVE_DIFF_PORT, LIVE_DIFF_HOST, LIVE_DIFF_NAME,
     LIVE_DIFF_POLL, LIVE_DIFF_ALLOW, LIVE_DIFF_MAX_REPOS,
     LIVE_DIFF_MAX_DIFF_MB, LIVE_DIFF_MAX_FILE_MB
`);
}

function parseArgs(argv) {
  const o = {
    repo: process.env.LIVE_DIFF_REPO,
    port: process.env.LIVE_DIFF_PORT,
    host: process.env.LIVE_DIFF_HOST,
    name: process.env.LIVE_DIFF_NAME,
    poll: process.env.LIVE_DIFF_POLL,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i], next = argv[i + 1];
    if (a === '-h' || a === '--help') { printHelp(); process.exit(0); }
    else if ((a === '-r' || a === '--repo') && next) { o.repo = next; i++; }
    else if ((a === '-p' || a === '--port') && next) { o.port = next; i++; }
    else if (a === '--host' && next) { o.host = next; i++; }
    else if ((a === '-n' || a === '--name') && next) { o.name = next; i++; }
    else if (a === '--poll' && next) { o.poll = next; i++; }
  }
  return o;
}

const ARGS = parseArgs(process.argv);
const PORT = parseInt(ARGS.port || '4966', 10);
const HOST = ARGS.host || '127.0.0.1';
const POLL_MS = parseInt(ARGS.poll || '15000', 10);
const DEFAULT_NAME = ARGS.name;
const PUBLIC_DIR = path.join(__dirname, 'public');

// How many repositories may be watched at once (least-recently-used, idle ones
// are evicted first — a repo with a live SSE client is never evicted).
const MAX_REPOS = Math.max(1, parseInt(process.env.LIVE_DIFF_MAX_REPOS || '12', 10) || 12);

/* Size caps — a working tree can produce diffs far larger than a JavaScript
 * string may hold (V8's limit is ~512 MiB–1 GiB) or a browser may render.
 * Rather than dying with "Invalid string length" mid-recompute (which freezes
 * the UI on stale data until restart), oversized output is truncated at a
 * `diff --git` block boundary with a visible marker line. */
// Max diff text kept per tree (staged, unstaged incl. untracked).
const MAX_DIFF_BYTES = Math.max(1, parseInt(process.env.LIVE_DIFF_MAX_DIFF_MB || '32', 10) || 32) * 1024 * 1024;
// Max commit-patch text served by /api/commit (history click).
const MAX_COMMIT_PATCH_BYTES = 2 * 1024 * 1024;
// Text files larger than this are treated as binary by the per-file viewers
// (tree diff block, /api/file, /api/raw) — Monaco cannot sanely render them.
const MAX_TEXT_FILE_BYTES = Math.max(1, parseInt(process.env.LIVE_DIFF_MAX_FILE_MB || '16', 10) || 16) * 1024 * 1024;

// Optional allowlist of repository prefixes (PATH-style, ':'-separated).
// Empty = any git repository on the machine may be opened.
const ALLOW = (process.env.LIVE_DIFF_ALLOW || '')
  .split(':').map(s => s.trim()).filter(Boolean).map(s => path.resolve(s));

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};
const JSON_TYPE = { 'Content-Type': 'application/json; charset=utf-8' };
const NO_STORE_JSON = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };

const LANG_BY_EXT = {
  '.php': 'php', '.phtml': 'php', '.php5': 'php', '.inc': 'php',
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.ts': 'typescript', '.jsx': 'javascript', '.tsx': 'typescript',
  '.xml': 'xml', '.xsd': 'xml', '.config': 'xml', '.svg': 'xml',
  '.html': 'html', '.htm': 'html',
  '.css': 'css', '.scss': 'scss', '.sass': 'scss', '.less': 'less',
  '.json': 'json', '.md': 'markdown', '.markdown': 'markdown',
  '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell',
  '.yml': 'yaml', '.yaml': 'yaml', '.sql': 'sql', '.ini': 'ini',
  '.csv': 'csv', '.txt': 'plaintext',
};
function langFor(p) { return LANG_BY_EXT[path.extname(p).toLowerCase()] || 'plaintext'; }

/* Cap a git-diff Buffer into a string that is always safe to build and ship.
 * Oversized output is cut at the last complete `diff --git` block boundary
 * (so file headers/counts stay parseable) and a marker line is appended —
 * it deliberately starts with '…' because the clients count '+'/'-'/'@@'
 * lines and would misread a marker starting with those. Returns '' for null. */
function diffText(buf, capBytes) {
  if (!buf || !buf.length) return '';
  if (buf.length <= capBytes) return buf.toString('utf8');
  let cut = buf.lastIndexOf('\ndiff --git ', capBytes);       // keep whole blocks
  if (cut === -1) cut = buf.lastIndexOf(0x0A, capBytes);      // else whole lines
  if (cut === -1) cut = capBytes;
  const kept = buf.slice(0, cut).toString('utf8');
  return kept + `\n… (live-diff: truncated — output exceeded ${Math.round(capBytes / 1048576)} MiB; the rest is hidden) …\n`;
}


/* ---------------------------- ripgrep probe ---------------------------- *
 * Probed once; symbol search transparently falls back to git grep without rg.
 * A machine property, shared by every repository. */
let rgProbe = null;
function haveRg() {
  if (rgProbe == null) {
    rgProbe = new Promise((resolve) => {
      execFile('rg', ['--version'], { timeout: 2000 }, (err) => resolve(!err));
    });
  }
  return rgProbe;
}

/* ============================== Repo ============================== *
 * One watcher per repository: private index snapshot, diff cache, SSE
 * clients, fs watchers, poll timer and commit-log cache. */
class Repo {
  constructor(root, opts = {}) {
    this.root = root;
    this.name = opts.name || path.basename(root);
    this.pinned = !!opts.pinned;      // default repo: never LRU-evicted
    this.lastUsed = Date.now();
    this.clients = new Set();         // SSE responses
    this.started = false;
    this.pollTimer = null;

    this.cached = { staged: '', unstaged: '' };
    this.cachedHash = null;
    this.logCache = { head: undefined, commits: null };

    this.recomputeChain = Promise.resolve();
    this.dirWatchers = new Map();     // abs dir -> fs.FSWatcher
    this.watchTimer = null;
    this.watchFirstAt = 0;

    // Private index snapshot (see lock discipline in syncSnapshot).
    this.snapDir = path.join(os.tmpdir(), 'live-diff-' + crypto.createHash('sha1').update(root).digest('hex').slice(0, 12));
    this.snapIndex = path.join(this.snapDir, 'index');
    this.snapStatKey = null;
  }

  /* ---------------------------- git helpers ---------------------------- *
   * Lock discipline: this is a watcher — recurring reads must NEVER create
   * .git/index.lock (git's opportunistic index refresh does, racing the user's
   * own git commands). Two layers:
   *   1. GIT_OPTIONAL_LOCKS=0 on every git call (kills optional locks; commands
   *      whose real job is writing the index — add/reset — still lock fine).
   *   2. Recurring reads (diffs, ls-files, `git show :path`) additionally run
   *      against a private SNAPSHOT of .git/index via GIT_INDEX_FILE: git's
   *      racy-clean index rewrite (not gated by GIT_OPTIONAL_LOCKS on older
   *      gits) then locks <snapshot>.lock in /tmp instead of the user's .git.
   * The snapshot is re-copied whenever the real index's stat changes (git
   * replaces the index atomically, so a copy is always a valid snapshot). */
  syncSnapshot() {
    try {
      const st = fs.statSync(path.join(this.root, '.git', 'index'));
      const key = st.mtimeMs + ':' + st.size;
      if (key === this.snapStatKey) return;
      fs.mkdirSync(this.snapDir, { recursive: true });
      fs.copyFileSync(path.join(this.root, '.git', 'index'), this.snapIndex);
      this.snapStatKey = key;
    } catch (e) { /* no index yet (fresh repo) or .git is a file — fall back below */ }
  }
  snapEnv() {
    const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
    if (this.snapStatKey != null) env.GIT_INDEX_FILE = this.snapIndex; // only when snapshot exists
    return env;
  }
  gitEnv() { return { ...process.env, GIT_OPTIONAL_LOCKS: '0' }; }

  git(args, opts = {}) {
    return new Promise((resolve, reject) => {
      const env = opts.snapshot ? this.snapEnv() : this.gitEnv();
      execFile('git', args, { cwd: this.root, maxBuffer: 256 * 1024 * 1024, env }, (err, stdout, stderr) => {
        if (err) reject(err); else resolve(stdout);
      });
    });
  }
  gitBuf(args, opts = {}) {
    return new Promise((resolve) => {
      const env = opts.snapshot ? this.snapEnv() : this.gitEnv();
      execFile('git', args, { cwd: this.root, maxBuffer: 256 * 1024 * 1024, encoding: 'buffer', env }, (err, stdout) => {
        if (err) resolve(null); else resolve(stdout);
      });
    });
  }
  /* Stream-capped git run for diff-like output: collects at most `capBytes`
   * of stdout (killing git once exceeded) and never builds anything larger.
   * Unlike execFile+maxBuffer this cannot silently return an empty diff on
   * huge output, and memory stays bounded no matter how big the diff gets.
   * Resolves a Buffer, or null when git fails (same as gitBuf). */
  gitDiffCapped(args, capBytes, opts = {}) {
    return new Promise((resolve) => {
      const env = opts.snapshot ? this.snapEnv() : this.gitEnv();
      const child = spawn('git', args, { cwd: this.root, env, stdio: ['ignore', 'pipe', 'ignore'] });
      const chunks = [];
      let size = 0, capped = false;
      child.stdout.on('data', (c) => {
        if (capped) return;
        if (size + c.length > capBytes) {
          // Keep one sentinel byte past the cap so diffText() reliably sees
          // "over cap" (exactly-cap buffers must not pass as complete).
          chunks.push(c.subarray(0, Math.min(c.length, capBytes - size + 1)));
          capped = true; child.kill('SIGTERM'); return;
        }
        chunks.push(c); size += c.length;
      });
      child.on('error', () => resolve(null));
      child.on('close', (code) => {
        if (code && !capped) resolve(null); // real git failure → caller treats as ''
        else resolve(Buffer.concat(chunks));
      });
    });
  }
  // ripgrep wrapper: resolves stdout on exit 0 (matches) AND exit 1 (no matches);
  // null only on real failure (missing binary, bad flags, …).
  // NOTE: callers must pass an explicit path ('.') — with no path and a piped
  // stdin (execFile default) rg would block reading stdin forever.
  rgBuf(args) {
    return new Promise((resolve) => {
      execFile('rg', args, { cwd: this.root, maxBuffer: 256 * 1024 * 1024, encoding: 'buffer' }, (err, stdout) => {
        if (!err || err.code === 1) resolve(stdout || Buffer.alloc(0));
        else resolve(null);
      });
    });
  }
  readFileSafe(relPath) {
    return new Promise((resolve) => {
      fs.readFile(path.join(this.root, relPath), (err, buf) => { if (err) resolve(null); else resolve(buf); });
    });
  }
  // Validate a client-supplied path: must be a relative path inside this repo (no traversal).
  safeRelPath(p) {
    if (!p || typeof p !== 'string' || p.indexOf('\0') !== -1 || path.isAbsolute(p)) return null;
    const resolved = path.normalize(path.join(this.root, p));
    const rel = path.relative(this.root, resolved);
    if (rel === '' || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return null;
    return rel;
  }

  // Build a unified-diff "new file" block for an untracked file (without staging it).
  async untrackedDiff(filePath) {
    const buf = await this.readFileSafe(filePath);
    if (buf == null) return '';
    if (buf.indexOf(0) !== -1) return `diff --git a/${filePath} b/${filePath}\nnew file mode 100644\nBinary files differ\n`;
    if (buf.length > MAX_TEXT_FILE_BYTES) {
      // Treat oversized text like git treats binaries: a placeholder block the
      // UI shows without ever loading the content (Monaco would choke anyway).
      return `diff --git a/${filePath} b/${filePath}\nnew file mode 100644\nindex 0000000..0000000\nBinary files differ (file exceeds ${Math.round(MAX_TEXT_FILE_BYTES / 1048576)} MiB)\n`;
    }
    const lines = buf.toString('utf8').split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    let out = `diff --git a/${filePath} b/${filePath}\nnew file mode 100644\nindex 0000000..0000000\n--- /dev/null\n+++ b/${filePath}\n`;
    out += `@@ -0,0 +1,${lines.length} @@\n`;
    for (const l of lines) out += '+' + l + '\n';
    return out;
  }

  // { staged: <index vs HEAD>, unstaged: <working tree vs index + untracked> }
  // All output is size-capped (see MAX_DIFF_BYTES): the three git reads run in
  // parallel, untracked blocks are appended while a byte budget lasts, and no
  // unbounded string concatenation happens anywhere on this path.
  async computeDiff() {
    this.syncSnapshot(); // all reads below use the private index snapshot
    const diffArgs = ['-c', 'core.safecrlf=false', 'diff', '--no-color', '-U3'];
    const [stagedBuf, unstagedBuf, untrackedBuf] = await Promise.all([
      this.gitDiffCapped([...diffArgs, '--cached', 'HEAD'], MAX_DIFF_BYTES, { snapshot: true }),
      this.gitDiffCapped(diffArgs, MAX_DIFF_BYTES, { snapshot: true }),
      this.gitBuf(['ls-files', '--others', '--exclude-standard'], { snapshot: true }),
    ]);
    const staged = diffText(stagedBuf, MAX_DIFF_BYTES);
    const unstaged = diffText(unstagedBuf, MAX_DIFF_BYTES);
    // Untracked files: append "new file" blocks while the budget lasts. Each
    // block is complete (untrackedDiff caps per file), so stopping between
    // blocks keeps the result parseable; a marker records the cut.
    const parts = [unstaged];
    let size = Buffer.byteLength(unstaged);
    let overflow = false;
    if (untrackedBuf) {
      for (const f of untrackedBuf.toString('utf8').split('\n')) {
        if (!f) continue;
        if (size >= MAX_DIFF_BYTES) { overflow = true; break; }
        const d = await this.untrackedDiff(f);
        parts.push(d); size += Buffer.byteLength(d);
      }
    }
    if (overflow) parts.push(`\n… (live-diff: truncated — untracked diff exceeded ${Math.round(MAX_DIFF_BYTES / 1048576)} MiB total) …\n`);
    return { staged, unstaged: parts.join('') };
  }

  // Before/after content of a file for a given side ('staged' or 'unstaged').
  async getFile(filePath, side) {
    const rel = this.safeRelPath(filePath);
    if (rel == null) throw new Error('invalid path');
    this.syncSnapshot(); // staged side shows `:path` from the snapshot
    const idxBuf = await this.gitBuf(['show', `:${rel}`], { snapshot: true }); // index (staged) version
    const headBuf = await this.gitBuf(['show', `HEAD:${rel}`]);                 // HEAD version
    const wtBuf = await this.readFileSafe(rel);                  // working-tree version
    const beforeBuf = side === 'staged' ? headBuf : idxBuf;
    const afterBuf = side === 'staged' ? idxBuf : wtBuf;
    const isBin = (b) => b != null && (b.indexOf(0) !== -1 || b.length > MAX_TEXT_FILE_BYTES);
    const binary = isBin(beforeBuf) || isBin(afterBuf);
    let status;
    if (side === 'staged') {
      if (headBuf == null && idxBuf != null) status = 'added';
      else if (headBuf != null && idxBuf == null) status = 'deleted';
      else status = 'modified';
    } else {
      if (idxBuf == null && wtBuf != null) status = 'added';
      else if (idxBuf != null && wtBuf == null) status = 'deleted';
      else status = 'modified';
    }
    return {
      path: rel, side, status, binary, language: langFor(rel),
      before: binary ? '' : (beforeBuf ? beforeBuf.toString('utf8') : ''),
      after: binary ? '' : (afterBuf ? afterBuf.toString('utf8') : ''),
    };
  }

  /* Commit history (sidebar): last 20 commits, cached until HEAD moves.
     add/del come from --numstat; merges (2+ parents) get a first-parent diff in
     /api/commit — i.e. exactly "the changes the commit introduced". */
  async getCommits() {
    let head = null;
    try { head = (await this.git(['rev-parse', '--verify', 'HEAD'])).trim(); } catch (e) {} // null: empty repo
    if (this.logCache.head === head) return this.logCache.commits;
    let out = '';
    try {
      out = await this.git(['log', '-20', '--no-color', '--pretty=format:%H%x1f%h%x1f%an%x1f%aI%x1f%P%x1f%s', '--numstat']);
    } catch (e) {}
    const commits = [];
    let cur = null;
    for (const line of out.split('\n')) {
      if (line.indexOf('\x1f') !== -1) {
        const f = line.split('\x1f');
        cur = {
          sha: f[0], short: f[1], author: f[2], date: f[3],
          parents: (f[4] || '').split(' ').filter(Boolean), subject: f[5] || '',
          add: 0, del: 0, binary: false,
        };
        commits.push(cur);
      } else if (cur) {
        const m = line.match(/^(\d+|-)\t(\d+|-)\t/);
        if (m) {
          if (m[1] === '-' || m[2] === '-') cur.binary = true;
          else { cur.add += +m[1]; cur.del += +m[2]; }
        }
      }
    }
    this.logCache = { head, commits };
    return commits;
  }

  // Unified diff a commit introduced (vs first parent; --root covers the initial
  // commit). -U3 to match the staged/unstaged views. Capped like the trees.
  async getCommitPatch(sha) {
    const buf = await this.gitDiffCapped(
      ['diff-tree', '--no-commit-id', '--no-color', '-r', '-U3', '--root', '-p', '-m', '--first-parent', sha],
      MAX_COMMIT_PATCH_BYTES);
    return diffText(buf, MAX_COMMIT_PATCH_BYTES);
  }

  /* ---------------------------- SSE clients ---------------------------- */
  notify() {
    const payload = 'event: changed\ndata: {}\n\n';
    for (const res of this.clients) { try { res.write(payload); } catch (e) {} }
  }

  /* ---------------------------- change detection ---------------------------- *
   * Serialized via a promise chain: every call (watch events, background poll AND
   * stage/unstage actions) appends one recompute that always runs — never
   * skipped — so a stage/unstage immediately recomputes with the post-action
   * state and notifies.
   *
   * Near-instant detection: fs.watch is installed on every directory that holds
   * tracked or untracked-but-not-ignored files, plus their ancestors and .git
   * (catches index/HEAD changes). Ignored dirs (node_modules, …) are never
   * watched. Events are debounced; the poll stays as a fallback for anything
   * watchers miss (inotify limits, network filesystems, …). */
  recomputeAndNotify() {
    this.recomputeChain = this.recomputeChain.then(async () => {
      let changed = false;
      try {
        const d = await this.computeDiff();
        // HEAD participates in the hash: a commit that leaves the working diff
        // identical (e.g. committing the staged changes) must still notify, so
        // the sidebar History re-renders.
        let headSha = '';
        try { headSha = (await this.git(['rev-parse', '--verify', 'HEAD'])).trim(); } catch (e) {}
        // Incremental hashing: update() never concatenates the (possibly huge)
        // diffs into one string the way `a + b + c` would.
        const hash = crypto.createHash('sha1')
          .update(d.staged).update('\x00')
          .update(d.unstaged).update('\x00')
          .update(headSha).digest('hex');
        if (hash !== this.cachedHash) { this.cached = d; this.cachedHash = hash; changed = true; this.notify(); }
      } catch (e) { console.error(`[live-diff] recompute error (${this.root}):`, e.message); }
      // Refresh the watcher set only when something actually changed: it runs
      // two full `git ls-files` passes, far too costly to repeat on every poll
      // tick for large repos. (First run always changes: cachedHash starts null.)
      if (changed) { try { await this.refreshWatchers(); } catch (e) {} }
    });
    return this.recomputeChain;
  }

  onWatchEvent() {
    if (!this.watchFirstAt) this.watchFirstAt = Date.now();
    const waited = Date.now() - this.watchFirstAt >= 2000; // force after this long under continuous events
    clearTimeout(this.watchTimer);
    this.watchTimer = setTimeout(() => {
      this.watchTimer = null; this.watchFirstAt = 0;
      this.recomputeAndNotify();
    }, waited ? 0 : 150);
  }

  watchDir(dir) {
    try {
      const w = fs.watch(dir, () => this.onWatchEvent());
      w.on('error', () => { try { w.close(); } catch (e) {} this.dirWatchers.delete(dir); });
      this.dirWatchers.set(dir, w);
    } catch (e) { /* e.g. EACCES or watcher limit — poll covers us */ }
  }

  async getWatchDirs() {
    const dirs = new Set([this.root, path.join(this.root, '.git')]);
    let tracked = '', untracked = '';
    try { tracked = await this.git(['ls-files']); } catch (e) {}
    try { untracked = await this.git(['ls-files', '--others', '--exclude-standard']); } catch (e) {}
    for (const list of [tracked, untracked]) {
      for (const line of list.split('\n')) {
        if (!line) continue;
        let d = path.dirname(path.join(this.root, line));
        while (true) {
          dirs.add(d);
          if (d === this.root) break;
          d = path.dirname(d);
        }
      }
    }
    return dirs;
  }

  async refreshWatchers() {
    const dirs = await this.getWatchDirs();
    for (const [dir, w] of this.dirWatchers) {
      if (!dirs.has(dir)) { try { w.close(); } catch (e) {} this.dirWatchers.delete(dir); }
    }
    for (const dir of dirs) if (!this.dirWatchers.has(dir)) this.watchDir(dir);
  }

  closeWatchers() {
    for (const [, w] of this.dirWatchers) { try { w.close(); } catch (e) {} }
    this.dirWatchers.clear();
  }

  /* Idempotent start: first recompute (which installs the watcher set) then the
   * safety-net poll. Awaited so the first /api/diff answer is already correct. */
  async ensureStarted() {
    if (this.started) return;
    this.started = true;
    await this.recomputeAndNotify();
    if (!this.pollTimer) this.pollTimer = setInterval(() => this.recomputeAndNotify(), POLL_MS);
  }

  stop() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.pollTimer = null; this.watchTimer = null;
    this.closeWatchers();
    for (const res of this.clients) { try { res.end(); } catch (e) {} }
    this.clients.clear();
  }
}

/* ---------------------------- repo registry ---------------------------- */
const repos = new Map();            // abs path -> Repo
let defaultRepo = null;

function isAllowed(root) {
  if (!ALLOW.length) return true;
  return ALLOW.some(e => root === e || root.startsWith(e + path.sep));
}

// Evict least-recently-used idle repos when over the cap. Repos with a live SSE
// client (someone is looking at them) are never evicted.
function evictRepos() {
  while (repos.size > MAX_REPOS) {
    let victim = null;
    for (const r of repos.values()) {
      if (r.pinned || r.clients.size) continue;
      if (!victim || r.lastUsed < victim.lastUsed) victim = r;
    }
    if (!victim) break;
    victim.stop();
    repos.delete(victim.root);
    console.log(`[live-diff] closed idle repo "${victim.name}" (${victim.root}) — cap ${MAX_REPOS}`);
  }
}

function isWorkTree(root) {
  return new Promise((resolve) => {
    execFile('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'], { timeout: 5000 }, (err, stdout) => {
      resolve(!err && String(stdout).trim() === 'true');
    });
  });
}

// Resolve an optional client-supplied repo path to a live Repo. Absent/empty ->
// the default repo. Throws (message shown to the user) on anything invalid.
async function findRepo(p) {
  if (p == null || p === '') return defaultRepo;
  if (typeof p !== 'string' || p[0] !== '/' || p.indexOf('\0') !== -1) {
    throw new Error('repo must be an absolute path (e.g. /home/me/project)');
  }
  const root = path.resolve(p);
  if (!isAllowed(root)) throw new Error('repo not allowed by LIVE_DIFF_ALLOW: ' + root);
  const existing = repos.get(root);
  if (existing) { existing.lastUsed = Date.now(); await existing.ensureStarted(); return existing; }
  let st;
  try { st = fs.statSync(root); } catch (e) { throw new Error('directory not found: ' + root); }
  if (!st.isDirectory()) throw new Error('not a directory: ' + root);
  if (!(await isWorkTree(root))) throw new Error('not a git work tree: ' + root);
  const repo = new Repo(root);
  repos.set(root, repo);
  evictRepos();
  await repo.ensureStarted();
  console.log(`[live-diff] watching "${repo.name}" (${root}) — ${repos.size}/${MAX_REPOS} repo(s) open`);
  return repo;
}

/* ---------------------------- http ---------------------------- */
function send(res, code, body, headers = {}) { res.writeHead(code, headers); res.end(body); }

// Replace the placeholders in index.html with the deployment-specific facts the
// frontend needs: the API base (its mount prefix), the repo being shown, and any
// startup error (bad repo path, …).
function injectHtml(buf, base, repo, err) {
  return buf.toString('utf8')
    .replace('"__LD_BASE__"', JSON.stringify(base))
    .replace('"__LD_REPO__"', JSON.stringify(repo || ''))
    .replace('__LD_ERR__', JSON.stringify(err || null));
}

function servePage(res, base, repo, err) {
  fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e, buf) => {
    if (e) return send(res, 500, 'index.html missing');
    send(res, 200, injectHtml(buf, base, repo, err),
      { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  });
}

async function handleApi(route, u, req, res, repo) {
  if (route === '/api/config') {
    return send(res, 200, JSON.stringify({ repo: repo.root, name: repo.name }), JSON_TYPE);
  }
  if (route === '/api/diff') {
    return send(res, 200, JSON.stringify(repo.cached), NO_STORE_JSON);
  }
  if (route === '/api/file') {
    const p = u.searchParams.get('path');
    const side = u.searchParams.get('side') === 'staged' ? 'staged' : 'unstaged';
    if (!p || !repo.safeRelPath(p)) return send(res, 400, '{"error":"invalid path"}', JSON_TYPE);
    try { return send(res, 200, JSON.stringify(await repo.getFile(p, side)), NO_STORE_JSON); }
    catch (e) { return send(res, 500, JSON.stringify({ error: String(e.message || e) }), JSON_TYPE); }
  }
  if (route === '/api/raw') {
    const p = u.searchParams.get('path');
    const rel = p != null ? repo.safeRelPath(p) : null;
    if (!rel) return send(res, 400, '{"error":"invalid path"}', JSON_TYPE);
    let buf = await repo.readFileSafe(rel); let where = 'wt';
    if (buf == null) { buf = await repo.gitBuf(['show', `HEAD:${rel}`]); where = 'head'; } // deleted in WT -> HEAD version
    if (buf == null) return send(res, 200, JSON.stringify({ path: rel, content: null }), NO_STORE_JSON);
    // Oversized text is flagged binary too: the clients then show a placeholder
    // instead of piping hundreds of MiB into Monaco/the JSON response.
    const binary = buf.indexOf(0) !== -1 || buf.length > MAX_TEXT_FILE_BYTES;
    return send(res, 200, JSON.stringify({ path: rel, where, binary, language: langFor(rel), content: binary ? null : buf.toString('utf8') }), NO_STORE_JSON);
  }
  if (route === '/api/symbol') {
    // Heuristic go-to-definition backend: fixed-string, word-bounded repo search
    // over tracked + untracked (non-ignored) files. Ranking happens client-side.
    // Prefer ripgrep when installed (much faster on big repos); git grep is the
    // zero-dependency fallback with the same file-set semantics.
    const q = (u.searchParams.get('q') || '').trim();
    // Unicode-aware identifier chars (letters, digits, _, $) — accented
    // identifiers must not 400.
    if (!q || q.length > 120 || !/^[\p{L}\p{N}_$]+$/u.test(q)) return send(res, 400, '{"error":"bad query"}', JSON_TYPE);
    let out = null;
    if (await haveRg()) {
      // --hidden keeps tracked dotpaths (.github/…) searchable; .git itself is
      // excluded. (Known gap vs git grep: files force-added past .gitignore.)
      out = await repo.rgBuf(['-n', '-w', '-F', '--no-messages', '--hidden', '--glob', '!.git', '--max-count', '50', '--', q, '.']);
    }
    if (out == null) out = await repo.gitBuf(['grep', '-n', '-w', '-F', '--untracked', '--exclude-standard', '--', q]);
    const matches = [];
    if (out) {
      for (const line of out.toString('utf8').split('\n')) {
        const m = line.match(/^(.+?):(\d+):(.*)$/);
        if (m && matches.length < 200) matches.push({ path: m[1].replace(/^\.\//, ''), line: +m[2], text: m[3].slice(0, 300) });
      }
    }
    return send(res, 200, JSON.stringify({ q, matches }), NO_STORE_JSON);
  }
  if (route === '/api/stage' && req.method === 'POST') {
    const p = u.searchParams.get('path');
    if (!p) return send(res, 400, '{"error":"missing path"}', JSON_TYPE);
    const rel = repo.safeRelPath(p);
    if (!rel) return send(res, 400, '{"error":"invalid path"}', JSON_TYPE);
    try { await repo.git(['add', '--', rel]); await repo.recomputeAndNotify(); return send(res, 200, '{"ok":true}', JSON_TYPE); }
    catch (e) { return send(res, 500, JSON.stringify({ error: String(e.message || e) }), JSON_TYPE); }
  }
  if (route === '/api/unstage' && req.method === 'POST') {
    const p = u.searchParams.get('path');
    if (!p) return send(res, 400, '{"error":"missing path"}', JSON_TYPE);
    const rel = repo.safeRelPath(p);
    if (!rel) return send(res, 400, '{"error":"invalid path"}', JSON_TYPE);
    try { await repo.git(['reset', '-q', 'HEAD', '--', rel]); await repo.recomputeAndNotify(); return send(res, 200, '{"ok":true}', JSON_TYPE); }
    catch (e) { return send(res, 500, JSON.stringify({ error: String(e.message || e) }), JSON_TYPE); }
  }
  if (route === '/api/commits') {
    const commits = await repo.getCommits();
    return send(res, 200, JSON.stringify({ commits }), NO_STORE_JSON);
  }
  if (route === '/api/commit') {
    const sha = u.searchParams.get('sha') || '';
    if (!/^[0-9a-f]{4,40}$/.test(sha)) return send(res, 400, '{"error":"bad sha"}', JSON_TYPE);
    try {
      let patch = await repo.getCommitPatch(sha);
      if (patch.length > 2 * 1024 * 1024) patch = patch.slice(0, 2 * 1024 * 1024) + '\n… (diff truncated)';
      return send(res, 200, JSON.stringify({ sha, patch }), NO_STORE_JSON);
    } catch (e) { return send(res, 404, '{"error":"unknown commit"}', JSON_TYPE); }
  }
  if (route === '/api/health') {
    return send(res, 200, JSON.stringify({ ok: true, repo: repo.root, name: repo.name, repos: repos.size }), JSON_TYPE);
  }
  if (route === '/api/watch') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('event: hello\ndata: {}\n\n');
    repo.clients.add(res);
    req.on('close', () => repo.clients.delete(res));
    return;
  }
  return send(res, 404, 'not found');
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  let P;
  try { P = decodeURIComponent(u.pathname); } catch (e) { P = u.pathname; }

  // API routes are found wherever they sit, so the app works under any mount
  // prefix (/diff/api/diff) or at the root (/api/diff).
  const ai = P.indexOf('/api/');
  const ci = P.indexOf(':');
  if (ai !== -1 && (ci === -1 || ai < ci)) {
    let repo;
    try { repo = await findRepo(u.searchParams.get('repo')); }
    catch (e) { return send(res, 400, JSON.stringify({ error: String(e.message || e) }), JSON_TYPE); }
    // Never let an API error escape as an unhandled rejection — on modern Node
    // that would take the whole server down.
    try { return await handleApi(P.slice(ai), u, req, res, repo); }
    catch (e) {
      try { send(res, 500, JSON.stringify({ error: String((e && e.message) || e) }), JSON_TYPE); } catch (_) {}
    }
    return;
  }

  // Page request naming a repo: <mount-prefix>:<abs-repo-path>
  // e.g. /diff:/home/me/project  →  mount "/diff", repo "/home/me/project".
  if (ci !== -1) {
    const mount = ci === 0 ? '' : P.slice(0, ci);
    const repoPath = P.slice(ci + 1);
    const base = mount === '' ? '/' : (mount.endsWith('/') ? mount : mount + '/');
    let err = repoPath === '' ? 'no repository path given after ":"' : null;
    if (!err) { try { await findRepo(repoPath); } catch (e) { err = String(e.message || e); } }
    return servePage(res, base, repoPath, err);
  }

  // Served index.html directly (e.g. /diff/index.html): inject with that base.
  if (P.endsWith('/index.html')) {
    return servePage(res, P.slice(0, -'index.html'.length) || '/', u.searchParams.get('repo'), null);
  }

  // Static assets. index.html is the only HTML and always goes through inject.
  const ext = path.extname(P);
  const fp = path.normalize(path.join(PUBLIC_DIR, P));
  if (ext && (fp === PUBLIC_DIR || fp.startsWith(PUBLIC_DIR + path.sep))) {
    return fs.readFile(fp, (e, buf) => {
      if (e) return send(res, 404, 'not found');
      const headers = { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' };
      if (path.extname(fp) === '.html') {
        headers['Cache-Control'] = 'no-cache';
        buf = injectHtml(buf, P.slice(0, P.lastIndexOf('/') + 1) || '/', u.searchParams.get('repo'), null);
      }
      send(res, 200, buf, headers);
    });
  }

  // Anything else is the UI itself at its mount point: "/", "/diff", "/diff/",
  // "/tools/diff", … An optional ?repo= picks a non-default repository.
  const repoParam = u.searchParams.get('repo');
  const base = P === '/' ? '/' : P.replace(/\/+$/, '') + '/';
  let err = null;
  if (repoParam) { try { await findRepo(repoParam); } catch (e) { err = String(e.message || e); } }
  return servePage(res, base, repoParam, err);
});

/* ---------------------------- boot ---------------------------- */
defaultRepo = new Repo(path.resolve(ARGS.repo || process.cwd()), { name: DEFAULT_NAME, pinned: true });
repos.set(defaultRepo.root, defaultRepo);

(async () => {
  await defaultRepo.ensureStarted();
  server.listen(PORT, HOST, () => console.log(
    `[live-diff] "${defaultRepo.name}" (${defaultRepo.root}) at http://${HOST}:${PORT}/ ` +
    `(fs.watch + poll ${POLL_MS}ms; multi-repo via /:repo or ?repo=, max ${MAX_REPOS}${ALLOW.length ? ', allowlist on' : ''})`));
})();

function shutdown() {
  for (const r of repos.values()) r.stop();
  server.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
