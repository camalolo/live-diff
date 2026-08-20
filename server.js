#!/usr/bin/env node
'use strict';
/*
 * live-diff — a live working-tree diff viewer with per-file staging.
 *
 * Serves a Monaco-backed diff of any git repository's working tree, split into
 * STAGED (index vs HEAD) and UNSTAGED (working tree vs index + untracked)
 * collapsible trees, with per-file stage/unstage. Pushes live updates over SSE.
 *
 * Pure Node (zero npm runtime deps). Monaco loads from a CDN in the browser.
 *
 * Changes are detected near-instantly via fs.watch on every directory that
 * contains tracked or non-ignored files (plus .git), with the interval poll
 * kept only as a safety net.
 *
 *   node server.js --repo /path/to/repo --port 4966 --host 127.0.0.1
 *
 * Options can also be set via env vars: LIVE_DIFF_REPO, LIVE_DIFF_PORT,
 * LIVE_DIFF_HOST, LIVE_DIFF_NAME, LIVE_DIFF_POLL. CLI flags take precedence.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

/* ---------------------------- config / args ---------------------------- */
function printHelp() {
  process.stdout.write(
`live-diff — live working-tree diff viewer

Usage: live-diff [options]

Options:
  -r, --repo <path>     repository to watch (default: current directory)
  -p, --port <n>        port to listen on (default: 4966)
      --host <addr>     address to bind (default: 127.0.0.1)
  -n, --name <label>    display name shown in the UI (default: repo basename)
      --poll <ms>       safety-net recompute interval (default: 2500)
  -h, --help            show this help

Env: LIVE_DIFF_REPO, LIVE_DIFF_PORT, LIVE_DIFF_HOST, LIVE_DIFF_NAME, LIVE_DIFF_POLL
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
const REPO = path.resolve(ARGS.repo || process.cwd());
const PORT = parseInt(ARGS.port || '4966', 10);
const HOST = ARGS.host || '127.0.0.1';
const POLL_MS = parseInt(ARGS.poll || '2500', 10);
const NAME = ARGS.name || path.basename(REPO);
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

/* ---------------------------- git helpers ---------------------------- */
function git(args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: REPO, maxBuffer: 256 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) reject(err); else resolve(stdout);
    });
  });
}
function gitBuf(args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: REPO, maxBuffer: 256 * 1024 * 1024, encoding: 'buffer' }, (err, stdout) => {
      if (err) resolve(null); else resolve(stdout);
    });
  });
}
function readFileSafe(relPath) {
  return new Promise((resolve) => {
    fs.readFile(path.join(REPO, relPath), (err, buf) => { if (err) resolve(null); else resolve(buf); });
  });
}

// Validate a client-supplied path: must be a relative path inside REPO (no traversal).
function safeRelPath(p) {
  if (!p || typeof p !== 'string' || p.indexOf('\0') !== -1 || path.isAbsolute(p)) return null;
  const resolved = path.normalize(path.join(REPO, p));
  const rel = path.relative(REPO, resolved);
  if (rel === '' || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return null;
  return rel;
}

// Build a unified-diff "new file" block for an untracked file (without staging it).
async function untrackedDiff(filePath) {
  const buf = await readFileSafe(filePath);
  if (buf == null) return '';
  if (buf.indexOf(0) !== -1) return `diff --git a/${filePath} b/${filePath}\nnew file mode 100644\nBinary files differ\n`;
  const lines = buf.toString('utf8').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  let out = `diff --git a/${filePath} b/${filePath}\nnew file mode 100644\nindex 0000000..0000000\n--- /dev/null\n+++ b/${filePath}\n`;
  out += `@@ -0,0 +1,${lines.length} @@\n`;
  for (const l of lines) out += '+' + l + '\n';
  return out;
}

// { staged: <index vs HEAD>, unstaged: <working tree vs index + untracked> }
async function computeDiff() {
  let staged = '';
  try { staged = await git(['-c', 'core.safecrlf=false', 'diff', '--cached', 'HEAD', '--no-color', '-U3']); } catch (e) {}
  let unstaged = '';
  try { unstaged = await git(['-c', 'core.safecrlf=false', 'diff', '--no-color', '-U3']); } catch (e) {}
  let untrackedList = '';
  try { untrackedList = await git(['ls-files', '--others', '--exclude-standard']); } catch (e) {}
  const files = untrackedList.split('\n').filter(Boolean);
  let extra = '';
  for (const f of files) extra += await untrackedDiff(f);
  return { staged, unstaged: unstaged + extra };
}

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

// Before/after content of a file for a given side ('staged' or 'unstaged').
async function getFile(filePath, side) {
  const rel = safeRelPath(filePath);
  if (rel == null) throw new Error('invalid path');
  const idxBuf = await gitBuf(['show', `:${rel}`]);      // index (staged) version
  const headBuf = await gitBuf(['show', `HEAD:${rel}`]);  // HEAD version
  const wtBuf = await readFileSafe(rel);                  // working-tree version
  const beforeBuf = side === 'staged' ? headBuf : idxBuf;
  const afterBuf = side === 'staged' ? idxBuf : wtBuf;
  const isBin = (b) => b != null && b.indexOf(0) !== -1;
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

/* ---------------------------- state / cache ---------------------------- */
let cached = { staged: '', unstaged: '' };
let cachedHash = null;

/* ---------------------------- SSE clients ---------------------------- */
const clients = new Set();
function notifyClients() {
  const payload = 'event: changed\ndata: {}\n\n';
  for (const res of clients) { try { res.write(payload); } catch (e) {} }
}

/* ---------------------------- http ---------------------------- */
function send(res, code, body, headers = {}) { res.writeHead(code, headers); res.end(body); }
const JSON_TYPE = { 'Content-Type': 'application/json; charset=utf-8' };

function serveStatic(req, res) {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  const fp = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!fp.startsWith(PUBLIC_DIR)) return send(res, 403, 'forbidden');
  fs.readFile(fp, (err, buf) => {
    if (err) return send(res, 404, 'not found');
    const headers = { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' };
    if (path.extname(fp) === '.html') headers['Cache-Control'] = 'no-cache';
    send(res, 200, buf, headers);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const url = u.pathname;

  if (url === '/api/config') {
    return send(res, 200, JSON.stringify({ repo: REPO, name: NAME }), JSON_TYPE);
  }
  if (url === '/api/diff') {
    return send(res, 200, JSON.stringify(cached), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  }
  if (url === '/api/file') {
    const p = u.searchParams.get('path');
    const side = u.searchParams.get('side') === 'staged' ? 'staged' : 'unstaged';
    if (!p || !safeRelPath(p)) return send(res, 400, '{"error":"invalid path"}', JSON_TYPE);
    try { return send(res, 200, JSON.stringify(await getFile(p, side)), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); }
    catch (e) { return send(res, 500, JSON.stringify({ error: String(e.message || e) }), JSON_TYPE); }
  }
  if (url === '/api/stage' && req.method === 'POST') {
    const p = u.searchParams.get('path');
    if (!p) return send(res, 400, '{"error":"missing path"}', JSON_TYPE);
    const rel = safeRelPath(p);
    if (!rel) return send(res, 400, '{"error":"invalid path"}', JSON_TYPE);
    try { await git(['add', '--', rel]); await recomputeAndNotify(); return send(res, 200, '{"ok":true}', JSON_TYPE); }
    catch (e) { return send(res, 500, JSON.stringify({ error: String(e.message || e) }), JSON_TYPE); }
  }
  if (url === '/api/unstage' && req.method === 'POST') {
    const p = u.searchParams.get('path');
    if (!p) return send(res, 400, '{"error":"missing path"}', JSON_TYPE);
    const rel = safeRelPath(p);
    if (!rel) return send(res, 400, '{"error":"invalid path"}', JSON_TYPE);
    try { await git(['reset', '-q', 'HEAD', '--', rel]); await recomputeAndNotify(); return send(res, 200, '{"ok":true}', JSON_TYPE); }
    catch (e) { return send(res, 500, JSON.stringify({ error: String(e.message || e) }), JSON_TYPE); }
  }
  if (url === '/api/health') {
    return send(res, 200, JSON.stringify({ ok: true, repo: REPO, name: NAME }), JSON_TYPE);
  }
  if (url === '/api/watch') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('event: hello\ndata: {}\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  return serveStatic(req, res);
});

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
let pollTimer = null;
let recomputeChain = Promise.resolve();
function recomputeAndNotify() {
  recomputeChain = recomputeChain.then(async () => {
    try {
      const d = await computeDiff();
      const hash = crypto.createHash('sha1').update(d.staged + '\x00' + d.unstaged).digest('hex');
      if (hash !== cachedHash) { cached = d; cachedHash = hash; notifyClients(); }
    } catch (e) { console.error('[live-diff] recompute error:', e.message); }
    try { await refreshWatchers(); } catch (e) {}
  });
  return recomputeChain;
}

const dirWatchers = new Map(); // abs dir -> fs.FSWatcher
const WATCH_DEBOUNCE_MS = 150; // quiet period before recompute
const WATCH_MAX_WAIT_MS = 2000; // force a recompute after this long under continuous events
let watchTimer = null, watchFirstAt = 0;

function onWatchEvent() {
  if (!watchFirstAt) watchFirstAt = Date.now();
  const waited = Date.now() - watchFirstAt >= WATCH_MAX_WAIT_MS;
  clearTimeout(watchTimer);
  watchTimer = setTimeout(() => {
    watchTimer = null; watchFirstAt = 0;
    recomputeAndNotify();
  }, waited ? 0 : WATCH_DEBOUNCE_MS);
}

function watchDir(dir) {
  try {
    const w = fs.watch(dir, onWatchEvent);
    w.on('error', () => { try { w.close(); } catch (e) {} dirWatchers.delete(dir); });
    dirWatchers.set(dir, w);
  } catch (e) { /* e.g. EACCES or watcher limit — poll covers us */ }
}

async function getWatchDirs() {
  const dirs = new Set([REPO, path.join(REPO, '.git')]);
  let tracked = '', untracked = '';
  try { tracked = await git(['ls-files']); } catch (e) {}
  try { untracked = await git(['ls-files', '--others', '--exclude-standard']); } catch (e) {}
  for (const list of [tracked, untracked]) {
    for (const line of list.split('\n')) {
      if (!line) continue;
      let d = path.dirname(path.join(REPO, line));
      while (true) {
        dirs.add(d);
        if (d === REPO) break;
        d = path.dirname(d);
      }
    }
  }
  return dirs;
}

async function refreshWatchers() {
  const dirs = await getWatchDirs();
  for (const [dir, w] of dirWatchers) {
    if (!dirs.has(dir)) { try { w.close(); } catch (e) {} dirWatchers.delete(dir); }
  }
  for (const dir of dirs) if (!dirWatchers.has(dir)) watchDir(dir);
}

function closeWatchers() {
  for (const [, w] of dirWatchers) { try { w.close(); } catch (e) {} }
  dirWatchers.clear();
}

(async () => {
  await recomputeAndNotify();
  server.listen(PORT, HOST, () => console.log(`[live-diff] "${NAME}" (${REPO}) at http://${HOST}:${PORT}/ (fs.watch + poll ${POLL_MS}ms)`));
  pollTimer = setInterval(recomputeAndNotify, POLL_MS);
})();
process.on('SIGTERM', () => { clearInterval(pollTimer); closeWatchers(); server.close(); process.exit(0); });
process.on('SIGINT', () => { clearInterval(pollTimer); closeWatchers(); server.close(); process.exit(0); });
