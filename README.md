# @lyonlee/dsh-steer

A live **status badge** in the DeepSeek Harness session header, plus **non-interrupting guidance** — send a correction or extra context without breaking the running turn.

Works with **DSH 0.2.0-rc.2** (and is written to degrade gracefully: every surface it touches is an official, documented plugin API).

## What you get

**1. Live status badge** (top-right of the session header)

| Stage shown | Where it comes from |
|---|---|
| `Waiting for model response` | `step/start` |
| `Thinking · 1.2k chars` | official `assistantStream` frames → `reasoning-delta` |
| `Replying · 320 chars` | same stream → `text-delta` |
| `Preparing <tool>` | same stream → `tool-call-delta` |
| `Running <tool>` | `tool/call` / `tool/result` |
| `Retrying (n/max)` | `llm/retry` + `llm/retry-started`, with the real `failure.code` |

Click the badge for a details panel: current stage + elapsed, last-progress age, retry state, and the delivery status of everything you sent.

**2. Guidance that does not interrupt**

- **Guide (default)** — `mode: "queue"`: the current step/turn finishes first, then your message is picked up immediately. This is the Codex-style queue.
- **Steer (opt-in)** — `mode: "steer"`: merged into the nearest step boundary of the running turn (same as the official queue bar's "steer" button).

Delivery state is truthful: `sending → inserted → claimed | discarded | rejected` (`claimed` = the agent actually read it).

## Install

```bash
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"   # macOS desktop
"$DSH" plugin --profile desktop add @lyonlee/dsh-steer   # via npm (scope @lyonlee)
# or straight from GitHub (no npm needed):
"$DSH" plugin --profile desktop add github:4gr9sv96jw-ui/dsh-steer
```

`bundles` are read once at startup → **restart the app** after installing.

## Why it talks to the official channel (and nothing else)

```
POST /dsh-steer/steer
  → ctx.sessionController.prompt({ requestId, sessionId, mode, content }, signal)
     → createUserMessage({ content, source: { kind: 'user', rpcId: requestId } })
     → agent.steer(msg)     // running: send(msg,'next-step',true) — wakes the driver
     → agent.followup(msg)  // idle   : send(msg,'next-turn',true)
```

Hand-rolling a message and calling `agent.inject()` looks tempting and is wrong:
`inject` = `send(msg,'next-step',false)` — it does **not** wake an idle driver (your message is silently dropped), and it bypasses the host's source construction, rpcId idempotency, attachment receipts and cold-session resume. Also note the facade signature is `prompt(request, signal)`: the `signal` is **required** (`@Remote` methods call `signal.throwIfAborted()` first).

## HTTP surface (loopback only)

| Route | Purpose |
|---|---|
| `GET /dsh-steer/state?session=<id>` | SSE runtime snapshot (push-on-change only) |
| `POST /dsh-steer/steer {sessionId, text, mode?}` | deliver guidance (`mode` ∈ `steer｜queue`) |
| `GET /dsh-steer/steer-state?session=<id>&messageId=<requestId>` | read state of one delivery |
| `GET /dsh-steer/ping` | health check |

## Footprint

- **Zero `@deepseek-ai` imports** — it only consumes the public services `ctx.agents`, `ctx.webServer`, `ctx.sessionController`.
- Loopback-only routes; no telemetry; no network calls of its own; no writes outside its own in-memory snapshot.
- Idle cost is ~0: SSE pushes only on state change, and the live stream is opened only while a client is watching.

## Files

| File | Role |
|---|---|
| `lib/index.js` | Host: runtime snapshot + SSE + official-channel delivery |
| `lib/client.js` | Client: header badge + guidance popover |
| `cordis.patch.yml` | Mount row |

MIT.
