# live-diff

A live, Monaco-backed working-tree diff viewer for **any git repository**, with
per-file staging. Point it at a repo and get a fast, GitHub/VS Code-style view of
your staged + unstaged changes that updates in real time as you edit — new files,
edits, deletions, renames all appear in place, with no page reloads.

- **Two trees:** Staged (index vs HEAD) and Unstaged (working tree vs index +
  untracked), collapsible and grouped by directory.
- **Stage / unstage** any file with a checkbox (moves it between trees instantly).
- **Monaco diff editor** (the VS Code engine) per file — real syntax highlighting,
  unified view, minimap.
- **Live:** the server `fs.watch`es the working tree and pushes updates over
  Server-Sent Events within ~150 ms of any change.
- **Read-only except explicit staging** — it never modifies your working-tree files.
- **Zero runtime npm dependencies** (pure Node backend; Monaco loads from a CDN).

## Requirements

- [Node.js](https://nodejs.org/) ≥ 18  (`node -v`)
- `git` on your `PATH`  (`git --version`)

## Quick start (try it in 10 seconds)

```bash
git clone <this-repo> live-diff && cd live-diff
node server.js --repo /path/to/your/repo
# → open http://127.0.0.1:4966/
```

Or, from inside the repo you want to watch:

```bash
node /path/to/live-diff/server.js
```

That's it for a quick look. For something that stays running and survives reboots,
set it up as a service (below).

## Installation

Pick one:

- **From source (recommended):** `git clone <this-repo> /opt/live-diff` and run
  `node /opt/live-diff/server.js`. No build step, nothing to install.
- **Global command:** from a clone, `npm install -g .` gives you a `live-diff`
  executable on your `PATH` (`live-diff --repo …`).

## Run as a systemd service (recommended for everyday use)

A systemd **template** unit is included so one install can run an instance per
repo (`live-diff@webapp`, `live-diff@api`, …), each with its own config.

```bash
# 1. Put the app somewhere:
sudo git clone <this-repo> /opt/live-diff

# 2. Install the unit + a config for your repo ("myrepo" is just a name you pick):
sudo mkdir -p /etc/live-diff
sudo cp /opt/live-diff/deploy/live-diff@.service      /etc/systemd/system/
sudo cp /opt/live-diff/deploy/live-diff.conf.example  /etc/live-diff/myrepo.conf

# 3. Edit three placeholders:
#    - /etc/systemd/system/live-diff@.service  -> User=, Group=, WorkingDirectory=
#    - /etc/live-diff/myrepo.conf              -> LIVE_DIFF_REPO=, LIVE_DIFF_PORT=
sudo nano /etc/systemd/system/live-diff@.service
sudo nano /etc/live-diff/myrepo.conf

# 4. Enable + start:
sudo systemctl daemon-reload
sudo systemctl enable --now live-diff@myrepo
systemctl status live-diff@myrepo     # confirm "active"; then open http://127.0.0.1:<port>/
```

**Per extra repo:** copy the `.conf` to a new name with a new port, then
`sudo systemctl enable --now live-diff@OTHERREPO`.

> **User service alternative (no sudo):** drop the unit in
> `~/.config/systemd/user/live-diff@.service`, point `EnvironmentFile` at
> `~/.config/live-diff/%i.conf`, run `systemctl --user ...`, and enable lingering
> once (`loginctl enable-linger $USER`) so it survives logout.

Logs: `journalctl -u live-diff@myrepo -f`.

## Configuration

Options can be passed as CLI flags **or** environment variables (flags win).

| Flag            | Env              | Default            | Description                          |
|-----------------|------------------|--------------------|--------------------------------------|
| `-r, --repo`    | `LIVE_DIFF_REPO`  | current directory  | repository to watch                  |
| `-p, --port`    | `LIVE_DIFF_PORT`  | `4966`             | port to listen on                    |
| `--host`        | `LIVE_DIFF_HOST`  | `127.0.0.1`        | address to bind                       |
| `-n, --name`    | `LIVE_DIFF_NAME`  | repo basename      | name shown in the UI                  |
| `--poll`        | `LIVE_DIFF_POLL`  | `2500` (ms)        | safety-net recompute interval (changes are normally detected instantly via `fs.watch`) |
| `-h, --help`    |                  |                    | show help                             |

```bash
node server.js --repo ~/projects/myapp --port 8080 --name "my app"
# or
LIVE_DIFF_REPO=~/projects/myapp LIVE_DIFF_PORT=8080 node server.js
```

## Exposing it behind a reverse proxy

The app uses **relative URLs**, so it mounts at the root or under any sub-path.
There's **no built-in authentication** — put it behind auth (see Security).

### nginx — under a sub-path (e.g. `/diff/`)

```nginx
location = /diff { return 301 /diff/; }

location /diff/ {
    auth_basic           "restricted";
    auth_basic_user_file /etc/nginx/.htpasswd;
    proxy_pass           http://127.0.0.1:4966/;   # trailing slash strips /diff prefix
    proxy_http_version   1.1;
    proxy_set_header     Connection "";
    proxy_buffering      off;          # required for SSE
    proxy_read_timeout   3600s;
}
```

### nginx — at the root

```nginx
location / {
    auth_basic           "restricted";
    auth_basic_user_file /etc/nginx/.htpasswd;
    proxy_pass           http://127.0.0.1:4966;
    proxy_http_version   1.1;
    proxy_set_header     Connection "";
    proxy_buffering      off;
    proxy_read_timeout   3600s;
}
```

### Caddy

```
diff.example.com {
    basicauth { user <hashed-password> }
    reverse_proxy 127.0.0.1:4966
    flush_interval -1   # pass SSE through unbuffered
}
```

## How it works

- The backend (`server.js`) is pure Node with **no dependencies**. It watches
  (via `fs.watch`) every directory containing tracked or non-ignored files plus
  `.git`, and ~150 ms after any change it recomputes `git diff --cached HEAD`
  (staged) and `git diff` + untracked files (unstaged), then pushes a
  notification to browsers over an SSE channel. A slow interval poll runs as a
  safety net; stage/unstage also recompute immediately.
- The frontend (`public/index.html`) renders a collapsible Staged/Unstaged tree
  and, when you click a file, fetches its before/after content and shows it in a
  [Monaco](https://microsoft.github.io/monaco-editor/) diff editor (loaded from
  a CDN).
- Stage/unstage run `git add` / `git reset HEAD` on the server and refresh
  instantly.

## Security

> ⚠️ Anyone who can reach the app can **stage and unstage files** in the target
> repository (it modifies the git index; it never commits, pushes, or touches
> your working-tree files). **Always run it behind authentication** (HTTP basic
> auth in your reverse proxy, a VPN, SSH tunnel, etc.) and bind to `127.0.0.1`
> unless access is protected. All client-supplied paths are validated to stay
> within the repository.

## Development

```bash
node server.js --repo /path/to/repo     # reload the browser after edits
```

- `server.js` — backend (API + static serving).
- `public/index.html` — the entire frontend (HTML/CSS/JS in one file).
- `deploy/` — systemd unit template + example config.

No build step. Monaco comes from a CDN; if you need fully offline operation,
vendor `monaco-editor` into `public/lib/` and point the loader there.

## License

MIT
