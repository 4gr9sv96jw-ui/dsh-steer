# dsh-steer

中文 | [English](#english)

[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

一个 DeepSeek Harness 插件：在会话头放一个实时状态徽标，并允许你在 Agent 干活的中途补一句、纠一句，而不用打断它。

Agent 跑长任务时有两个具体的麻烦。第一，你不知道它此刻在做什么——「等待响应」和「真的卡住」看起来一模一样。第二，你发现方向不对时，只能等它做完，或者直接打断，没有中间选项。这个插件分别解决这两件事。

## 快速开始

```bash
dsh plugin --profile <profile> add github:4gr9sv96jw-ui/dsh-steer
```

装完重启应用（`bundles` 只在启动时读一次）。之后会话头右上角会出现状态徽标和「指导」按钮。

桌面版（DeepSeek Harness.app）独占管理自己的 profile，需要用应用自带的 CLI：

```bash
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop add github:4gr9sv96jw-ui/dsh-steer
```

## 状态徽标

徽标只显示当前阶段，按发生的顺序推进：分析中 → 思考中 · 本步 N 字 → 输出中 · 本步 N 字 → 运行 <工具> → 读取工具结果，收尾回到「工作中」。工具阶段后面跟一句命令摘要，例如「运行 bash · Run route probes」。

有两处刻意的取舍。字数是按步统计的——每个 turn/step 边界重新计数，而不是整段会话的累计值，后者最终只会变成一个越来越大的无意义数字。徽标也不显示模型名，模型、provider、上下文窗口和步号（`T4·S3`）都放在点开的详情面板里，徽标本身保持安静。

耗时秒数由客户端本地时钟计算，host 只发时间戳，所以空闲时没有定时器，也不会每秒推一次 SSE。

状态不猜。没有新进展时显示「暂无新增量」，实时源断开时显示「状态实时源断开」，而不是继续挂着上一次的阶段。请求失败只显示官方返回的 `failure.code`；只有 `llm/retry` 真的触发才显示重试，不写「可能是网络问题」这种无法证明的话。

## 运行中指导

这是插件的主要能力。你写一句话，它会在当前回合内、最近一次小步（一次推理或一次工具调用）结束的边界被读进上下文，任务继续往下跑——不打断、不重开、不等整轮结束。

实现上用自定义消息 kind（`source.kind` 为 `dsh-steer`）加 `agent.steer()`。这一点是关键：如果按普通用户消息投递，模型会把它当成一条新任务，表现就是打断当前工作。

指导框支持直接贴图或选文件，附件经宿主的 `attachments` 服务落成持久引用。输入框按会话保存草稿，刷新不丢。

浮层里会列出本次会话发出的插话，每条标出它的归宿：

- ✓ 已读取，并标出在第几轮第几步被读到，例如 `T7·S3`
- · 已送达，还没被读
- ✗ 未读取，回合已结束或消息被丢弃

点任意一条可以把原文回填到输入框；未读取的可以一键重发，重发会带上原来的附件，不需要重新上传。历史只收本插件发出的插话，主对话框里的聊天记录不算。

界面语言在详情面板里切换，可选自动、中文、English。选择写在 `~/.dsh/dsh-steer.lang`，不使用 localStorage。

## 为什么不提供排队和官方插话

官方的 queue 和 steer 本质上都是「以用户身份发一条消息」——对话框本来就能发，官方队列栏本来就能排队。所以 v0.4.0 把这两条通道删掉了，插件只保留上面那条不打断的投递。

## 数据通道

| 路由 | 用途 |
|---|---|
| `GET /dsh-steer/state?session=<id>` | SSE 实时快照，仅状态变化时推送 |
| `POST /dsh-steer/steer` | 运行中指导。请求体为 `{sessionId, text?, attachments?, reuseAtts?}`，其中 `reuseAtts` 用于重发时复用已有附件，不重传字节 |
| `GET /dsh-steer/attachment?session=<id>&id=<attachmentId>[&raw=1]` | 读取指导附件，`raw=1` 时直接回字节流 |
| `GET\|POST /dsh-steer/lang` | 界面语言，取值 `auto`、`zh`、`en` |
| `GET /dsh-steer/ping` | 健康检查 |

出错时返回稳定的错误码：`mode-removed`（400）、`no-live-agent`（409）、`missing sessionId or content`（400）、`payload too large`（413）、`no-attachments` 与 `no-attachment-api`（501）、`reuse-attachment-unreadable`（404）。客户端按语言把这些码映射成提示文案，界面不会直接显示中文原文。

## 安全

插件不 import 任何 `@deepseek-ai` 包，只使用 `ctx.agents` 与 `ctx.webServer` 两个公开服务，另外可选地取用 `attachments` 和 `sessionController`。所有路由只接受 loopback 地址（127.0.0.1 与 ::1），没有遥测，也没有对外网络请求。

请求体分两档限制：纯文字 3 KB，带附件 48 MB——上限先按宿主 `imageLimits` 计算，再封顶，避免宿主报出的 200 MB 上限把内存撑爆。附件字节只通过官方 `sessionController.attachment` 读回，该方法会校验该附件确实属于目标会话日志。

## 测试

```bash
npm test
```

38 个用例，覆盖状态机（含步切换归零）、附件链路（含宿主不支持时的 501 分支）、路由错误码、语言处理，以及客户端的纯显示逻辑。零依赖，跑在 `node --test` 上。

## 刻意不做的事

这个插件的核心只有一件事：工作中途加一条指令。因此排队与改撤排队消息、投递模式、子代理进度、token 面板、可配置阈值、localStorage 都不做。

## 许可证

MIT © 2026 Lyon

---

<a id="english"></a>

# English

[中文](#dsh-steer) | English

A DeepSeek Harness plugin: a live status badge in the session header, plus a way to add or correct an instruction while the agent is working, without interrupting it.

Long agent runs cause two specific problems. First, you cannot tell what the agent is doing right now — "waiting for a response" and "genuinely stuck" look identical. Second, when you notice the direction is wrong, your only options are to wait for the whole turn or to interrupt it. There is nothing in between. This plugin addresses both.

## Quick start

```bash
dsh plugin --profile <profile> add github:4gr9sv96jw-ui/dsh-steer
```

Restart the app afterwards (`bundles` are read once at startup). The status badge and a "Guide" button then appear in the session header.

The desktop app (DeepSeek Harness.app) manages its profile exclusively, so use the CLI carrier that ships with it:

```bash
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop add github:4gr9sv96jw-ui/dsh-steer
```

## The status badge

The badge shows one phase at a time and advances in order: Analyzing → Thinking · N chars this step → Writing · N chars → Running <tool> → Reading tool result, then back to Working. During a tool call it appends a short summary, for example "Running bash · Run route probes".

Two deliberate trade-offs. Character counts are per step — they reset at every turn/step boundary instead of accumulating over the whole stream, which only ever produced a meaningless growing number. The badge also omits the model name; model, provider, context window and step (`T4·S3`) live in the popover, so the badge itself stays quiet.

Elapsed time is computed by a local clock in the client — the host only sends timestamps — so there is no timer while idle and no SSE push every second.

The badge does not guess. With no new progress it shows "no new progress"; if the live source drops it shows "live source disconnected" rather than keeping a stale phase on screen. A failed request shows the official `failure.code`; a retry appears only when `llm/retry` actually fires, never as a guess about the network.

## In-flight guidance

This is the plugin's main capability. You write a sentence, and it is read into context inside the current turn, at the end of the nearest small step (one reasoning block or one tool call). The task keeps running: no interrupt, no restart, no waiting for the turn to finish.

It works through a custom message kind (`source.kind` is `dsh-steer`) plus `agent.steer()`. That detail matters. Delivered as an ordinary user message, the model would treat it as a new task — which is exactly what an interruption looks like.

The guidance box accepts pasted images and selected files; attachments are committed as durable references through the host's `attachments` service. Drafts are stored per session, so a refresh does not lose them.

The popover lists the guidance sent in this session, each entry marked with where it ended up:

- ✓ read, with the turn and step where it was consumed, for example `T7·S3`
- · delivered, not read yet
- ✗ not read — the turn ended, or the message was discarded

Click any entry to put its text back in the input. Entries that were never read can be resent in one click, and the resend carries the original attachments instead of uploading them again. The list only contains guidance sent from this plugin; messages from the main composer are not included.

The UI language switches in the detail popover: Auto, 中文 or English. The choice is stored in `~/.dsh/dsh-steer.lang`; localStorage is not used.

## Why there is no queue and no official steer

The official queue and steer are both just "send a message as the user" — the composer already does that, and the official queue bar already queues. v0.4.0 removed both channels, leaving only the non-interrupting delivery described above.

## Data channels

| Route | Purpose |
|---|---|
| `GET /dsh-steer/state?session=<id>` | SSE live snapshot, pushed on change only |
| `POST /dsh-steer/steer` | In-flight guidance. Body: `{sessionId, text?, attachments?, reuseAtts?}`; `reuseAtts` reuses existing attachments when resending, without re-uploading |
| `GET /dsh-steer/attachment?session=<id>&id=<attachmentId>[&raw=1]` | Read a guidance attachment; `raw=1` streams the bytes |
| `GET\|POST /dsh-steer/lang` | UI language: `auto`, `zh` or `en` |
| `GET /dsh-steer/ping` | Health check |

Failures return stable codes: `mode-removed` (400), `no-live-agent` (409), `missing sessionId or content` (400), `payload too large` (413), `no-attachments` and `no-attachment-api` (501), `reuse-attachment-unreadable` (404). The client maps each code to a localized message, so the UI never shows the raw Chinese text.

## Security

The plugin imports no `@deepseek-ai` package. It uses the public services `ctx.agents` and `ctx.webServer`, and optionally `attachments` and `sessionController`. Every route accepts loopback addresses only (127.0.0.1 and ::1). There is no telemetry and no outbound network request.

Request bodies are capped in two tiers: 3 KB for text only, 48 MB with attachments — the limit is computed from the host's `imageLimits` and then clamped, so the 200 MB figure the host reports cannot be used to exhaust memory. Attachment bytes are read back only through the official `sessionController.attachment`, which verifies that the attachment really belongs to the addressed session log.

## Tests

```bash
npm test
```

38 cases covering the state machine (including the per-step reset), the attachment path (including the 501 branch when the host has no attachment service), route error codes, language handling, and the client's pure display logic. Zero dependencies, running on `node --test`.

## Deliberately out of scope

The plugin does one thing: add an instruction mid-task. So queueing and editing queued messages, delivery modes, subagent progress, a token panel, configurable thresholds and localStorage are all left out.

## License

MIT © 2026 Lyon
