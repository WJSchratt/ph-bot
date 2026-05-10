# PC Bridge

Tiny HTTP server that runs on your home PC and is the target of the Railway-hosted `/jarvis` proxy.

It spawns the **`claude` CLI** as a subprocess for each chat turn, which means:

- It uses your **Max plan** auth (whatever `claude` is logged into on this PC). No `ANTHROPIC_API_KEY` needed.
- It runs with `--dangerously-skip-permissions` so it never blocks waiting for approval.
- It runs `claude` from `WORKDIR` (your home directory by default), so Claude has access to your files there.

## Endpoints

The Railway `/jarvis` proxy expects these:

| Method | Path     | Purpose                                            |
|--------|----------|----------------------------------------------------|
| GET    | `/health`| liveness + current session info                    |
| POST   | `/start` | start a new conversation, returns `{sessionId}`    |
| POST   | `/chat`  | body `{message}`, returns `{response, sessionId}`  |
| POST   | `/reset` | drop the current session (next chat starts fresh)  |

Multi-turn context is preserved by passing `--session-id <uuid>` on the first turn and `--resume <uuid>` on subsequent turns.

## One-time setup on the PC

Open PowerShell **as Administrator**.

```powershell
# 1. Make sure claude is installed and you're logged in to your Max plan
claude --version
claude auth   # follow prompts if not already logged in

# 2. Make sure Tailscale is installed and SSH is enabled (escape hatch for next time it dies)
tailscale up --ssh

# 3. Stop Windows from sleeping when on AC power
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /change monitor-timeout-ac 0

# 4. Install Node 18+ (skip if already installed)
#    https://nodejs.org/  -> LTS

# 5. Clone this repo somewhere stable on the PC
cd $env:USERPROFILE
git clone https://github.com/WJSchratt/ph-bot.git
cd ph-bot\pc
npm install

# 6. Install PM2 + Windows service wrapper for auto-restart
npm install -g pm2 pm2-windows-startup
pm2-startup install
```

## Run it

```powershell
cd $env:USERPROFILE\ph-bot\pc
pm2 start ecosystem.config.js
pm2 save
```

That's it. PM2 will:

- Restart the bridge if it crashes
- Restart the bridge automatically when Windows reboots (because of `pm2-startup install` and `pm2 save`)

## Verify it's working

```powershell
# From the PC itself:
curl http://localhost:8080/health

# From your phone or laptop on the same tailnet:
curl http://100.127.86.39:8080/health
```

You should get back something like:
```json
{ "ok": true, "sessionId": null, "sessionPrimed": false, "inFlight": false, ... }
```

## Point Railway at this

In Railway env vars for the `ph-bot` service:

```
PC_TAILSCALE_IP=100.127.86.39   # whatever shows in Tailscale admin
PC_PORT=8080
JARVIS_PASSWORD=<something_not_the_default>
```

Then the `/jarvis` web UI on Railway → log in → click START SESSION → chat.

> **You also need Tailscale installed *on the Railway container itself*** so it can reach `100.x.x.x` IPs. If `/jarvis/pc/health` always shows offline even though the PC is up, that's the problem. Easiest fix: use Tailscale's "Funnel" or "Serve" features to expose the PC bridge over HTTPS instead, then point `PC_TAILSCALE_IP` at the public hostname and run the proxy as plain HTTPS. Cleaner than installing Tailscale on Railway.

## Useful PM2 commands

```powershell
pm2 status               # is it running?
pm2 logs pc-bridge       # tail logs
pm2 restart pc-bridge    # force restart
pm2 stop pc-bridge       # stop it
pm2 monit                # live monitor
```

## Environment variables

Set in `ecosystem.config.js` or pass via `pm2 start ... --env`:

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | bridge listens here |
| `HOST` | `0.0.0.0` | bind address (must be 0.0.0.0 for tailnet access) |
| `WORKDIR` | your home dir | directory `claude` runs in — it has full access here |
| `CLAUDE_BIN` | `claude` | path to claude binary if not on PATH |
| `MODEL` | (empty, uses default) | e.g. `opus` or `sonnet` |
| `REQUEST_TIMEOUT_MS` | `600000` | kill claude if it runs longer than this |

## Why this protects against "boom it stopped responding"

Three layers of recovery, in order from cheapest to most disruptive:

1. **Bridge crash** → PM2 restarts it within 2s. You don't notice.
2. **Bridge hung but PC alive** → SSH in via Tailscale, `pm2 restart pc-bridge`. Takes 30 seconds from your phone.
3. **PC frozen / sleep / power loss** → still need physical access OR a smart plug on the PC's power. There is no remote fix for a dead PC.

The `tailscale up --ssh` step is the most important one. It's the difference between "5-minute fix from a coffee shop" and "stranded until you're home."
