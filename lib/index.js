// dsh-steer — Host 半区（v0.5.0：宿主事件实时流 + 四段精确阶段 + 步内字数归零）
//
// 设计原则（基于 DSH 0.2.0-rc.2 源码实测，非猜测）：
//   0. 【只保留一条投递通道：运行中指导】自定义 source.kind（非 'user'）手搓一条消息
//      + agent.steer() → 落在 next-step，在最近一次小步边界被读，**同一个 turn 继续跑**。
//      用 'user' kind 就会变成「用户新发言」，模型当成新任务 → 表现为打断（v0.2.x 的毛病）。
//   0b.【已移除 queue / 官方 steer】这两条 = agent.followup()/agent.steer() 以用户身份发消息，
//      等价于在下面对话框敲一句话（官方队列栏本来就有排队与插话）→ 插件不重复实现；
//      调用方仍传这两个 mode 时明确 400（不静默忽略），冷会话直接 409 并指回对话框。
//   0c.【不用 agent.inject()】inject = send(msg,'next-step',false) 不唤醒（idle 时静默丢弃）。
//   1. 状态不是事件流水，而是「运行快照」：run / current / tool / request / retry / steer / alert。
//   2. lastProgressAt = 最近一次确认真实进展的时间（step/start、首包、assistant/message、
//      tool/call、tool/result、llm/retry-started），与 startedAt 严格区分。
//   3. 重试用真实事件 llm/retry + llm/retry-started（来自 @deepseek-ai/dsh-llm-retry），
//      不再用 request-error++ 伪造次数。
//   4. request-error 只显示其真实可证明的 failure.code/message，不臆测"网络/魔法"。
//   5. 工具运行时内部 stdout 不可由 session 事件观察 → 降级"无法观察内部进度"，不假装卡死。
//   6. 状态变化才推送 SSE；流式 chunk 的 lastProgressAt 用 ~1s 节流刷新，空闲零定时器。
//   7. 只发时间戳，Client 本地秒级计时。
//   8. 零 @deepseek-ai import，loopback-only。
//   9. 【v0.5.0 · P0-1 换数据源】实时增量改为根级宿主事件 `agent/assistant-stream`
//      （模式 emit，payload { agent, frame }，实测根级 ctx.on 收得到）。**不再用**
//      ctx.sessionController.follow()：旧实现只在「有 SSE 订阅者」时才开流（syncLive 判
//      subscribers.size），订阅端一抖动徽标就卡死在旧阶段，且 follow 的 open/error/linger
//      语义全是订阅侧的伪状态。新实现是纯事件监听 → 状态机始终正确，与有没有人订阅无关。
//      → liveStreams / liveTimers / LIVE_LINGER_MS / ensureLive / markLive / stopLive /
//        syncLive 全部删除；inject 去掉 sessionController。
//   10.【v0.5.0 · P0-2 四段精确阶段】分析中 → 思考中 → 输出中 → 运行 <工具> → 读取工具结果
//      → 工作中（兜底）。措辞一律正向、带信息量；**禁止**把"请求在飞、尚无增量"写成负向的
//      "等待响应"式文案（那正是 v0.4.0 被用户点名的问题）。
//      字数 = **本步**字数（turn/step 作步标识，步变化即清零），不再跨步累加。
//   11.【v0.5.0 · P0-3】快照带 phaseSource（当前 current 由 session-event 还是
//      assistant-stream 设定），便于排障；run.lastProgressAt 语义不变（有真实进展才更新）。
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

export const name = 'dsh-steer'
export const inject = ['agents', 'webServer']

const states = new Map()       // sessionId -> snapshot
const subscribers = new Map()  // sessionId -> Set<res>
const pruneTimers = new Map()  // sessionId -> timeout（空闲清理）
const MAX_BODY = 3 * 1024              // 纯文字请求体上限
const MAX_BODY_ATTACH = 48 * 1024 * 1024   // 带附件的上限**封顶**（宿主 maxMessageImageBytes 实测 200MB，不封顶会算出 320MB）
const MAX_ATTACH = 6                   // 单条指导附件数兜底上限（有 imageLimits 时以宿主为准）
const MAX_STEER = 20
const MAX_HISTORY = 50         // 指令历史条数上限（v0.6.0 D）
const STEER_TEXT_MAX = 4000
const THROTTLE_MS = 1000
const IDLE_PRUNE_MS = 90 * 1000
const TOOL_DETAIL_MAX = 24     // 工具短摘要截断长度（字符）

// ── 侧边对话式「运行中指导」───────────────────────────────────────────────
// 与第一方插件同款做法（plan-mode / hooks-claude-code / cordis-host-runner 都用自定义 kind）：
// 手搓一条 source.kind 非 'user' 的消息 + agent.steer() → 落在 next-step，
// 在**最近一次小步（思考/一次工具调用）结束的边界**被 claim 读进上下文，
// 任务是同一个 turn 继续跑（不 abort、不重开），所以能「插进去代替第 3 步」。
// 用 'user' kind 就会变成"用户新发言"，模型会当成新任务 → 表现为打断（这是 v0.2.x 的问题）。
const GUIDE_KIND = 'dsh-steer'
// 纯附件插话的占位文本：**语言中性**，客户端按语言显示（避免英文界面里出现中文「见附件」）
const SEE_ATT = '(see attachment)'
function makeGuidanceMessage(text, extraParts) {
  const id = 'msg-' + randomUUID()
  const framed = '<system-reminder>\n[运行中指导 · dsh-steer] ' + text
    + '\n（这是对当前任务的补充或纠正：并进后面的步骤、继续把原任务做完；不要当成一个独立的新任务重开。）\n</system-reminder>'
  return {
    id,
    role: 'user',
    // 附件（图片/文件）跟在文字后面；没有附件时就是纯文字，与 v0.5.0 完全一致
    content: [{ type: 'text', text: framed }].concat(extraParts || []),
    source: { kind: GUIDE_KIND, form: 'guidance', plugin: 'dsh-steer' },
  }
}

/** 字节数 → 人话（KB / MB），用于 413 的错误文案。 */
function fmtSize(n) {
  return n >= 1048576 ? Math.round(n / 1048576) + ' MB' : Math.floor(n / 1024) + ' KB'
}

/** 请求体上限：有宿主 imageLimits 就按它算（base64 膨胀 4/3 + 20% 余量），否则用兜底值。
 *  **并用 MAX_BODY_ATTACH 封顶**：宿主实测 maxMessageImageBytes = 200MB，不封顶会算出 320MB。 */
function bodyCapFor(ctx) {
  const at = ctx.get('attachments')
  const limits = at && at.imageLimits
  const perMsg = limits && Number.isFinite(limits.maxMessageImageBytes) ? limits.maxMessageImageBytes : 0
  if (perMsg > 0) return Math.min(Math.ceil(perMsg * 4 / 3 * 1.2) + MAX_BODY, MAX_BODY_ATTACH)
  return MAX_BODY_ATTACH
}

/** 客户端 base64 附件 → 宿主 durable ref → 消息 content blocks。
 *  契约：`saveImages` 自带「先验全部、再存任何一个」；`admitEncodedFile` 收 canonical base64。
 *  **拿不到 attachments 服务一律抛**（由路由回 501），绝不静默降级成纯文字。 */
async function admitAttachments(ctx, list) {
  const at = ctx.get('attachments')
  if (!at) {
    const e = new Error('此宿主不支持附件（attachments 服务不可用）')
    e.code = 'no-attachments'
    throw e
  }
  const images = []
  const files = []
  for (const a of list) {
    const data = String((a && a.dataBase64) || '')
    if (!data) continue
    if (a.kind === 'image') images.push({ data: Buffer.from(data, 'base64'), mediaType: a.mediaType, name: a.name })
    else files.push({ data, name: a.name })
  }
  const out = []
  if (images.length) {
    const refs = await at.saveImages(images)
    for (const r of refs) out.push({ type: 'image', attachment: r })
  }
  for (const f of files) {
    const ref = await at.admitEncodedFile({ data: f.data, name: f.name })
    out.push({ type: 'file', attachment: ref })
  }
  return out
}

/** 字符量 → 短标签（本步字数用）。 */
function fmtChars(n) {
  if (!n) return null
  return n < 1000 ? n + ' 字' : (n / 1000).toFixed(1) + 'k 字'
}

/** inbox 里的消息 → 本地插话条目 key。官方 admission 把 requestId 写进 source.rpcId。 */
function steerKeyOf(message) {
  const source = message && message.source
  return (source && source.rpcId) || (message && message.id) || null
}

// —— 语言设置（v0.6.0 C）：存 DSH_HOME 下一个小文件。**不用 localStorage**、不引依赖。
//    取值 auto | zh | en；auto = 由客户端按浏览器/宿主语言决定。
const LANG_FILE = process.env.DSH_STEER_LANG_FILE
  || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-steer.lang')
const LANGS = ['auto', 'zh', 'en']
let langCache = null
function readLang() {
  if (langCache) return langCache
  try {
    const v = String(readFileSync(LANG_FILE, 'utf8')).trim()
    langCache = LANGS.includes(v) ? v : 'auto'
  } catch { langCache = 'auto' }   // 文件不存在 = auto（首次运行）
  return langCache
}
function writeLang(v) {
  const val = LANGS.includes(v) ? v : 'auto'
  langCache = val
  let persisted = true
  try {
    mkdirSync(dirname(LANG_FILE), { recursive: true })
    writeFileSync(LANG_FILE, val + '\n')
  } catch { persisted = false }   // 写不了：内存值仍生效，但**必须如实回报**，不能让 UI 以为已保存
  return { lang: val, persisted }
}

function freshState(sessionId) {
  return {
    sessionId,
    run: { status: 'idle', startedAt: 0, lastProgressAt: 0 },
    current: { target: null, state: 'idle', label: '空闲', detail: null, startedAt: 0 },
    // 本步标识 + 本步字数（P0-2：步变化即清零，绝不跨步累加）
    step: { key: null, turn: null, step: null, chars: 0, toolName: null, startedAt: 0 },
    phaseSource: null,
    // P0-1：live 不再是「订阅开没开」的伪状态，而是事件源的真实计数
    live: { source: 'event', lastFrameAt: 0, frames: 0, chunks: 0 },
    tool: null,
    request: null,
    retry: null,
    steer: [],
    history: [],
    alert: null,
    seq: 0,
    _lastPushAt: 0,
  }
}

function stateFor(sessionId, create = false) {
  let s = states.get(sessionId)
  if (!s && create) { s = freshState(sessionId); states.set(sessionId, s) }
  return s
}

function serialize(s) {
  return {
    sessionId: s.sessionId,
    run: s.run,
    current: s.current,
    // v0.6.0 C 准备：给客户端**原始数字/原始工具名**，让文案（含单位）由客户端按语言生成
    chars: (s.step && s.step.chars) ? s.step.chars : null,
    toolName: (s.tool && s.tool.name) ? s.tool.name : null,
    phaseSource: s.phaseSource || null,
    lang: readLang(),
    maxAttach: MAX_ATTACH,          // 附件数上限由 host 下发，客户端不再自己写死（审查 #11）
    tool: s.tool,
    request: s.request,
    retry: s.retry,
    steer: s.steer.slice(-MAX_STEER).map((x) => ({
      id: x.id, text: x.text, status: x.status,
      claimedTurn: x.claimedTurn || null, claimedStep: x.claimedStep || null,
    })),
    history: (s.history || []).slice(-MAX_HISTORY),
    alert: s.alert,
    live: s.live || null,
    seq: s.seq,
    serverTime: Date.now(),
  }
}

/** 原子更新：应用 patch（或直接改 s 字段后传 {}），更新进展时间戳，seq++，按需推送一次。 */
function commit(s, patch, opts = {}) {
  Object.assign(s, patch)
  if (opts.progress) s.run.lastProgressAt = Date.now()
  s.seq += 1
  if (opts.throttled) maybePush(s)
  else push(s)
  return s
}

function maybePush(s) {
  const now = Date.now()
  if (now - s._lastPushAt >= THROTTLE_MS) push(s)
}

function push(s) {
  s._lastPushAt = Date.now()
  const set = subscribers.get(s.sessionId)
  if (set && set.size > 0) {
    const payload = serialize(s)
    for (const res of set) { try { res.write(`data: ${JSON.stringify(payload)}\n\n`) } catch { /* 断开忽略 */ } }
  }
}

/** 换阶段才重置 startedAt：同一个 state 的重复调用（例如每个 delta 一次）必须保住已跑时长，
 *  否则「当前阶段耗时」会被刷成 00:00（旧版每个 assistant/message 都重置，就是这个毛病）。
 *  source = phaseSource：本次 current 是 session-event 还是 assistant-stream 设的（P0-3 排障）。 */
function setCurrent(s, target, state, label, detail, source) {
  const prev = s.current || {}
  const same = prev.state === state && prev.target === target
  s.current = {
    target,
    state,
    label: label || state,
    detail: detail === undefined ? (same ? prev.detail ?? null : null) : detail,
    startedAt: same ? (prev.startedAt || Date.now()) : Date.now(),
  }
  if (source) s.phaseSource = source
}

// —— 请求锚点：turn/step 一旦拿到就必须保住（任何分支都不许用 undefined 覆盖） ——

function setRequest(s, patch) {
  const next = Object.assign({
    startedAt: 0, firstResponseAt: 0, lastProgressAt: 0,
    provider: null, model: null, contextWindow: null, error: null,
    turn: null, step: null,
  }, s.request || {})
  for (const k of Object.keys(patch || {})) if (patch[k] !== undefined) next[k] = patch[k]
  s.request = next
  return next
}

/** 会话事件的 turn/step：data 里优先，其次事件顶层（两种形状都兼容）。 */
function turnStepOf(ev) {
  const d = (ev && ev.data) || {}
  const turn = d.turn != null ? d.turn : (ev ? ev.turn : null)
  const step = d.step != null ? d.step : (ev ? ev.step : null)
  return { turn: turn == null ? null : turn, step: step == null ? null : step }
}

/** 步标识 = turn:step。标识变化 → 新建步记录（本步字数归零）。
 *  拿不到 id 时一律视为新步（只会在 step 开头的 start 帧上发生，不会中途误清零）。 */
function beginStep(s, turn, step) {
  const hasId = turn != null || step != null
  const key = hasId ? (String(turn == null ? '?' : turn) + ':' + String(step == null ? '?' : step)) : null
  if (key !== null && s.step && s.step.key === key) return s.step
  s.step = {
    key,
    turn: turn == null ? null : turn,
    step: step == null ? null : step,
    chars: 0,
    toolName: null,
    startedAt: Date.now(),
  }
  return s.step
}

/** 工具短摘要：只对 bash 给（description 优先，否则 command 首行），截断 24 字符。
 *  arguments 是模型流式生成的 JSON 字符串，**可能不完整** → 必须 try/catch。 */
function toolSummary(name, argsRaw) {
  if (!name || String(name).toLowerCase().indexOf('bash') === -1) return null
  let obj = null
  try { obj = JSON.parse(argsRaw) } catch { return null }
  if (!obj || typeof obj !== 'object') return null
  let raw = (typeof obj.description === 'string' && obj.description.trim()) ? obj.description.trim() : ''
  if (!raw && typeof obj.command === 'string') raw = obj.command.split('\n')[0].trim()
  if (!raw) return null
  return raw.length > TOOL_DETAIL_MAX ? raw.slice(0, TOOL_DETAIL_MAX) : raw
}

// —— 宿主事件 agent/assistant-stream（v0.5.0 的实时主源）——
// 帧形状（已实测）：
//   { type:'start', attemptId, revision, turn, step }
//   { type:'chunk', attemptId, revision, index, time, chunk: StreamChunk }
//   { type:'end',   attemptId, revision, index, outcome }
// StreamChunk: block-start / text-delta / reasoning-delta / tool-call-delta / block-end / usage / finish

function noteFrame(s, kind) {
  const l = s.live || (s.live = { source: 'event', lastFrameAt: 0, frames: 0, chunks: 0 })
  l.source = 'event'
  l.lastFrameAt = Date.now()
  l.frames += 1
  if (kind === 'chunk') l.chunks += 1
}

function onStreamFrame(sid, frame) {
  // 审查修正：只跟踪**已建档**的 agent。根级监听会收到所有 agent（含子代理）的帧，
  // 旧写法 stateFor(sid, true) 会给每个子代理建档并逐帧做无用状态更新。
  const s = stateFor(sid, false)
  if (!s || !frame) return
  cancelPrune(sid)
  noteFrame(s, frame.type === 'chunk' ? 'chunk' : 'frame')
  const now = Date.now()

  if (frame.type === 'start') {
    // 步标识来源之一：stream start 帧带 turn/step（实测确认）
    beginStep(s, frame.turn, frame.step)
    setCurrent(s, 'model', 'analyzing', '分析中', null, 'assistant-stream')
    setRequest(s, {
      startedAt: frame.time || now,
      firstResponseAt: 0,
      lastProgressAt: now,
      error: null,
      turn: frame.turn,
      step: frame.step,
    })
    s.retry = null
    commit(s, {}, { progress: false })
    return
  }

  if (frame.type === 'end') {
    // 一次 attempt 收尾（committed / abandoned）：回到「工作中」兜底，
    // 等 assistant/message 或 tool/call 接管（工具运行中不覆盖）
    if (!s.current || s.current.state !== 'tool-running') {
      setCurrent(s, 'agent', 'working', '工作中', null, 'assistant-stream')
    }
    commit(s, {}, { progress: true })
    return
  }

  if (frame.type !== 'chunk' || !frame.chunk) return
  const c = frame.chunk
  const st = s.step || beginStep(s, null, null)

  switch (c.type) {
    case 'reasoning-delta': {
      // 本步字数（思考 + 输出共用一个「本步」计数）→ 步切换时已在 beginStep 归零
      st.chars += (c.text || '').length
      if (s.request && !s.request.firstResponseAt) setRequest(s, { firstResponseAt: now })
      setCurrent(s, 'model', 'thinking', '思考中', fmtChars(st.chars), 'assistant-stream')
      commit(s, {}, { progress: true, throttled: true })
      break
    }
    case 'text-delta': {
      st.chars += (c.text || '').length
      if (s.request && !s.request.firstResponseAt) setRequest(s, { firstResponseAt: now })
      setCurrent(s, 'model', 'outputting', '输出中', fmtChars(st.chars), 'assistant-stream')
      commit(s, {}, { progress: true, throttled: true })
      break
    }
    case 'tool-call-delta': {
      if (c.name) st.toolName = c.name
      const label = st.toolName ? ('准备调用 ' + st.toolName) : '准备调用工具'
      setCurrent(s, 'model', 'tool-args', label, null, 'assistant-stream')
      commit(s, {}, { progress: true, throttled: true })
      break
    }
    default:
      // block-start / block-end / usage / finish：都算真实进展（模型确实在动）
      commit(s, {}, { progress: true, throttled: true })
      break
  }
}

// —— steers：快照内小数组，MAX_STEER 内保留 ——
// 状态只能前进（sending → inserted → claimed/discarded），失败态 rejected 需 force，
// 因为 admission 返回前 owner 可能已经 claim（此时不得被后续的 inserted 回退覆盖）。
const STEER_RANK = { sending: 0, inserted: 1, claimed: 2, discarded: 2, rejected: 3 }
function pushSteer(s, messageId, text, status = 'inserted') {
  s.steer.push({ id: messageId, text, createdAt: Date.now(), status })
  if (s.steer.length > MAX_STEER) s.steer.shift()
}
function setSteerStatus(s, messageId, status, force = false) {
  const it = s.steer.find((x) => x.id === messageId)
  if (!it || it.status === status) return false
  if (!force && (STEER_RANK[status] ?? 0) < (STEER_RANK[it.status] ?? 0)) return false
  it.status = status
  return true
}
function steerStatusOf(s, messageId) {
  const it = s && s.steer.find((x) => x.id === messageId)
  return it ? it.status : null
}

/** 指令历史（v0.6.0 D）：本会话**全部用户侧指令** —— 主对话框消息（kind='user'）与插件指导
 *  （kind='dsh-steer'）都在这里，用 kind 区分来源；按 id 去重、cap MAX_HISTORY。 */
function pushHistory(s, rec) {
  if (!s.history) s.history = []
  if (rec.id) {
    const i = s.history.findIndex((x) => x.id === rec.id)
    if (i >= 0) { s.history[i] = Object.assign({}, s.history[i], rec); return }
  }
  // 审查修正：**按时间插入**。回填（异步）与实时事件可能交错到达，append 会让顺序错乱，
  // 而 serialize 的 slice(-MAX_HISTORY) 是按数组顺序截的 → 可能截掉最新的那条。
  const at = rec.at || 0
  let i = s.history.length
  while (i > 0 && (s.history[i - 1].at || 0) > at) i -= 1
  s.history.splice(i, 0, rec)
  if (s.history.length > MAX_HISTORY) s.history.shift()
}

/** 会话事件里的 user/message → 一条历史记录（主对话框与插件指导共用这条映射）。 */
// v0.6.0 修正（Lyon）：「插话历史」**只收插件发出的插话**（source.kind='dsh-steer'）——
// 主对话框的聊天记录 / 会话命令**不算**插话，不进这张表。附件记成**可点开查看**的引用数组。
function historyOfEvent(ev) {
  const m = (ev && ev.data) || {}
  const src = m.source || {}
  if (src.kind !== GUIDE_KIND) return null          // 只收插件插话
  const parts = Array.isArray(m.content) ? m.content : []
  const text = parts.filter((p) => p && p.type === 'text').map((p) => p.text).join(' ').trim()
  const atts = parts
    .filter((p) => p && (p.type === 'image' || p.type === 'file') && p.attachment)
    .map((p) => ({
      id: p.attachment.attachmentId,
      type: p.type,
      mediaType: p.attachment.mediaType || null,
      name: p.attachment.name || null,
    }))
  return {
    id: src.rpcId || m.id || null,
    at: (ev && ev.time) || null,
    seq: ev && ev.seq != null ? ev.seq : null,
    kind: 'guidance',
    text,
    atts,
  }
}

/** D 回填：SSE 订阅时用**有界** follow 读一次历史 —— 契约实测：首帧就是 `snapshot`，
 *  其 `records` 即历史事件（含 user/message）。**只要首帧就收流**，不长期订阅。
 *  sessionController 走**可选获取**（不写进 inject）：拿不到/失败就静默跳过，
 *  历史退化为"本次运行期"，界面上会如实说明，不假装全量。 */
async function backfillHistory(ctx, sid, s) {
  if (!s || (s.history && s.history.length)) return
  const sc = ctx.get('sessionController')
  if (!sc || typeof sc.follow !== 'function') return
  const ac = new AbortController()
  const timer = setTimeout(() => { try { ac.abort() } catch { /* ignore */ } }, 5000)
  try {
    const it = sc.follow({
      address: { kind: 'session', sessionId: sid },
      maxMessages: 200,
      turnWindow: { minMessages: 200, minTurns: 60 },
    }, ac.signal)
    for await (const frame of it) {
      if (frame && frame.type === 'snapshot' && Array.isArray(frame.records)) {
        for (const rec of frame.records) {
          const ev = rec && rec.type === 'event' ? rec.event : null
          if (ev && ev.type === 'user/message') { const r = historyOfEvent(ev); if (r) pushHistory(s, r) }
        }
        break                    // 首帧快照拿到就走，不做长期订阅
      }
    }
  } catch { /* 回填失败不影响主流程 */ } finally {
    clearTimeout(timer)
    try { ac.abort() } catch { /* ignore */ }
  }
  commit(s, {}, { progress: false })   // 推一次，让客户端立刻看到回填后的历史
}

// —— 事件处理 ——

function installListeners(ctx) {
  const d = []

  // agent/status：running / idle 仅状态变化时发（源码 setPhase）。载荷自动带 agent。
  d.push(ctx.on('agent/status', (p) => {
    const a = p && p.agent; if (!a) return
    const s = stateFor(a.id, true)
    cancelPrune(a.id)
    if (p.status === 'running') {
      if (s.run.status !== 'running') {
        s.run = { status: 'running', startedAt: Date.now(), lastProgressAt: s.run.lastProgressAt || Date.now() }
        if (s.current.state === 'idle') setCurrent(s, 'agent', 'working', '工作中', null, 'session-event')
        commit(s, {}, { progress: false })
      }
    } else {
      s.run = { status: 'idle', startedAt: 0, lastProgressAt: Date.now() }
      s.current = { target: null, state: 'idle', label: '空闲', detail: null, startedAt: 0 }
      s.step = { key: null, turn: null, step: null, chars: 0, toolName: null, startedAt: 0 }
      s.phaseSource = null
      s.tool = null; s.request = null; s.retry = null; s.alert = null
      commit(s, {}, { progress: false })
      schedulePrune(a.id, s)
    }
  }))

  // agent/assistant-stream：实时增量主源（根级监听，实测收得到；与订阅者无关）
  d.push(ctx.on('agent/assistant-stream', (payload) => {
    const a = payload && payload.agent
    const sid = a && a.id
    if (!sid) return
    onStreamFrame(sid, payload && payload.frame)
  }))

  // session/event：运行状态事实主源（每个事件带 .time/.seq/.type/.data）
  d.push(ctx.on('session/event', (session, ev) => {
    const sid = session && session.id
    if (!sid) return
    const s = stateFor(sid, false)
    if (!s) return                 // 只跟踪已被 agent/status running 或 steer 建立的会话
    const at = (ev && ev.time) ? ev.time : Date.now()
    const type = ev && ev.type
    const ts = turnStepOf(ev)
    let changed = false
    switch (type) {
      case 'user/message': {
        // 只收**插件插话**（historyOfEvent 对非 dsh-steer 来源返回 null，主对话框消息不进历史）
        const rec = historyOfEvent(ev)
        if (!rec) break
        // 优先用我们登记过的**原文**，避免把 <system-reminder> 框架文本展示给用户
        if (rec.id) {
          const it = s.steer.find((x) => x.id === rec.id)
          if (it && it.text) rec.text = it.text
        }
        pushHistory(s, rec)
        changed = true
        break
      }
      case 'step/start': {
        // 步开始 → 分析中（尚未有增量）；并把 turn/step 写进状态（快照必须始终带步标识）
        beginStep(s, ts.turn, ts.step)
        setCurrent(s, 'model', 'analyzing', '分析中', null, 'session-event')
        setRequest(s, { startedAt: at, firstResponseAt: 0, lastProgressAt: at, error: null, turn: ts.turn, step: ts.step })
        s.retry = null
        changed = true
        break
      }
      case 'assistant/message': {
        // assistant 一轮完成（含 0 工具调用）→ 兜底「工作中」
        setCurrent(s, 'agent', 'working', '工作中', null, 'session-event')
        setRequest(s, { lastProgressAt: at, turn: ts.turn, step: ts.step })
        changed = true
        break
      }
      case 'tool/call': {
        const t = (ev.data && ev.data) || {}
        const nm = t.name || 'tool'
        s.tool = { callId: t.callId || null, name: nm, startedAt: at, lastProgressAt: at }
        setCurrent(s, 'tool', 'tool-running', '运行 ' + nm, toolSummary(nm, t.arguments), 'session-event')
        setRequest(s, { turn: ts.turn, step: ts.step })
        changed = true
        break
      }
      case 'tool/result': {
        // 工具结束 → 读取工具结果。内部进度不可观察，不伪装。
        if (s.tool) s.tool = null
        setCurrent(s, s.request ? 'model' : 'agent', 'reading-result', '读取工具结果', null, 'session-event')
        setRequest(s, { turn: ts.turn, step: ts.step })
        changed = true
        break
      }
      case 'request/context': {
        const r = (ev.data && ev.data) || {}
        if (s.request && (r.provider || r.model)) {
          const before = s.request.provider + '/' + s.request.model
          setRequest(s, { provider: r.provider, model: r.model, contextWindow: r.contextWindow })
          if (before !== (s.request.provider + '/' + s.request.model)) changed = true
        }
        break
      }
      case 'request/header': {
        const r = (ev.data && ev.data) || {}
        const cfg = (r.header && r.header.config) || {}
        if (s.request && (cfg.provider || cfg.model)) {
          const before = s.request.provider + '/' + s.request.model
          setRequest(s, { provider: cfg.provider, model: cfg.model })
          if (before !== (s.request.provider + '/' + s.request.model)) changed = true
        }
        break
      }
      case 'llm/retry': {
        // 真实重试排程（来自 llm-retry）
        const r = (ev.data && ev.data) || {}
        s.retry = {
          active: true,
          attempt: r.retry,
          maxAttempts: r.maxRetries,
          delayMs: r.delayMs,
          retryAt: Date.now() + (r.delayMs || 0),
          reason: (r.failure && (r.failure.code || r.failure.message)) || null,
        }
        if (s.request && r.failure) setRequest(s, { error: { code: r.failure.code || null, message: r.failure.message || null } })
        setCurrent(s, 'model', 'retry-wait', '等待重试', r.retry ? '第 ' + r.retry + ' 次' : null, 'session-event')
        changed = true
        break
      }
      case 'llm/retry-started': {
        // 重试真正开始 → 重新请求中（这是「进展」：它真的继续了）
        const r = (ev.data && ev.data) || {}
        if (!s.retry) s.retry = { active: false, attempt: r.retry, maxAttempts: 0, delayMs: 0, retryAt: 0, reason: null }
        else s.retry.active = false
        setCurrent(s, 'model', 'requesting', '重新请求', r.retry ? '第 ' + r.retry + ' 次' : null, 'session-event')
        changed = true
        break
      }
    }
    if (changed) commit(s, {}, { progress: true })
  }))

  // request-error：显示真实 failure，不臆测；必须 next()（waterfall，llm-retry 在其后接管）
  d.push(ctx.on('agent/request-error', async (p, next) => {
    const a = p && p.agent
    if (a) {
      const s = stateFor(a.id, true)
      const f = p && p.failure
      if (s.request) setRequest(s, { error: f ? { code: f.code || null, message: f.message || null } : { code: null, message: '模型请求失败' } })
      setCurrent(s, 'model', 'error', '请求失败', (f && (f.code || f.message)) || '模型请求失败', 'session-event')
      commit(s, {}, { progress: false })
      // 若随后有 llm/retry 事件，会被覆盖为 retry-wait
    }
    return next()
  }))

  d.push(ctx.on('agent/error', (p) => {
    const a = p && p.agent; if (!a) return
    const s = stateFor(a.id, true)
    const e = p && p.error
    const msg = (e && (e.message || e.code)) || String(e || 'Agent 错误')
    setCurrent(s, 'agent', 'error', '出错', String(msg).slice(0, 200), 'session-event')
    commit(s, {}, { progress: false })
  }))

  // —— 插话（官方 admission）状态：inserted → claimed（已读取进下一步）/ discarded。 ——
  const markSteer = (status) => (p) => {
    const a = p && p.agent; const msg = p && p.message
    if (!a || !msg) return
    const s = stateFor(a.id, false); if (!s) return
    const key = steerKeyOf(msg)
    if (key && setSteerStatus(s, key, status)) {
      // E2：claimed 时记下「在第几轮第几步被读」—— 载荷带 turn，step 取当时的 request.step
      if (status === 'claimed') {
        const it = s.steer.find((x) => x.id === key)
        if (it) {
          it.claimedTurn = p.turn != null ? p.turn : null
          it.claimedStep = (s.request && s.request.step != null) ? s.request.step : null
        }
      }
      commit(s, {}, { progress: false })
    }
  }
  d.push(ctx.on('agent/inbox/inserted', markSteer('inserted')))
  d.push(ctx.on('agent/inbox/claimed', markSteer('claimed')))
  d.push(ctx.on('agent/inbox/discarded', markSteer('discarded')))

  // agent 销毁 → 纯净回收
  d.push(ctx.on('agent/disposed', (p) => {
    const a = p && p.agent; if (!a) return
    states.delete(a.id)
    const set = subscribers.get(a.id)
    if (set) { for (const r of set) { try { r.end() } catch { /* ignore */ } } subscribers.delete(a.id) }
    cancelPrune(a.id)
  }))

  return d
}

// —— 空闲回收 ——
function schedulePrune(sid, s) {
  cancelPrune(sid)
  const hasSub = (subscribers.get(sid) && subscribers.get(sid).size > 0) || s.steer.length > 0
  if (hasSub) return
  const t = setTimeout(() => { if (states.get(sid) && states.get(sid).run.status === 'idle') states.delete(sid) }, IDLE_PRUNE_MS)
  pruneTimers.set(sid, t)
}
function cancelPrune(sid) { const t = pruneTimers.get(sid); if (t) { clearTimeout(t); pruneTimers.delete(sid) } }

// —— 路由 ——

function isLoopback(req) {
  const addr = req.socket && req.socket.remoteAddress
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}
function sendJson(res, obj, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj))
}

export function apply(ctx, config = {}) {
  const disposers = installListeners(ctx)

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/dsh-steer',
    handler: async (req, res) => {
      if (!isLoopback(req)) return sendJson(res, { ok: false, error: 'forbidden' }, 403)
      let url
      try { url = new URL(req.url || '/', 'http://x') } catch { url = null }
      if (!url) return sendJson(res, { ok: false, error: 'bad url' }, 500)

      // GET /dsh-steer/state?session=xxx → SSE（状态变化才推；首帧即发当前快照）
      if (url.pathname === '/dsh-steer/state' && req.method === 'GET') {
        const sid = url.searchParams.get('session') || ''
        if (!sid) return sendJson(res, { ok: false, error: 'missing session' }, 400)
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' })
        const s = stateFor(sid, true)
        cancelPrune(sid)
        res.write(`data: ${JSON.stringify(serialize(s))}\n\n`)
        backfillHistory(ctx, sid, s).catch(() => { /* 回填失败不影响实时状态 */ })
        let set = subscribers.get(sid); if (!set) { set = new Set(); subscribers.set(sid, set) }
        set.add(res)
        s._lastPushAt = Date.now()
        res.on('close', () => {
          set.delete(res)
          if (set.size === 0) { subscribers.delete(sid); schedulePrune(sid, stateFor(sid, false)) }
        })
        return
      }

      // POST /dsh-steer/steer {sessionId, text}
      // 唯一投递语义 = 运行中「侧边对话式指导」：自定义 kind + agent.steer()，
      // 在最近一次小步边界被读、同一个 turn 继续跑（详见 makeGuidanceMessage 上方注释）。
      // v0.4.0 起不再提供 queue / 官方 steer —— 那两条就是「以用户身份发一条消息」，
      // 对话框（官方队列栏）本来就能做。旧 mode 明确 400，冷会话明确 409（不静默回退）。
      if (url.pathname === '/dsh-steer/steer' && req.method === 'POST') {
        const ct = req.headers['content-type'] || ''
        if (!/application\/json/i.test(ct)) return sendJson(res, { ok: false, error: 'content-type must be application/json' }, 415)
        // v0.6.1 修正（审查发现）：旧写法无条件用附件上限，而宿主 imageLimits 是 200MB
        // → 纯文字 POST 也能塞 320MB 进 `body +=` 的内存里。现在：
        //   ① 读的时候按**封顶后的附件上限**（48MB）硬卡，内存不会被撑爆；
        //   ② 解析后若**没有附件**而 body 超过 MAX_BODY，再回 413（纯文字就是 3KB）。
        //   —— 不能在读的途中靠 `"attachments"` 键提前判定：客户端把 text 放前面时该键出现得很晚，会误杀长文本+附件的正常请求。
        const attachCap = bodyCapFor(ctx)
        let body = ''
        let tooBig = false
        for await (const chunk of req) {
          body += chunk
          if (body.length > attachCap) { tooBig = true; break }
        }
        if (tooBig) {
          return sendJson(res, {
            ok: false, error: 'payload too large',
            message: '请求体超过上限 ' + fmtSize(attachCap),
          }, 413)
        }
        let parsed
        try { parsed = JSON.parse(body) } catch { return sendJson(res, { ok: false, error: 'invalid json' }, 400) }
        const sid = parsed.sessionId
        const text = String(parsed.text || '').trim()
        const rawAtt = Array.isArray(parsed.attachments) ? parsed.attachments.slice(0, MAX_ATTACH) : []
        // 重发复用已有附件：只给 attachmentId，不重传字节（审查 #7）
        const rawReuse = Array.isArray(parsed.reuseAtts) ? parsed.reuseAtts.slice(0, MAX_ATTACH) : []
        if (!rawAtt.length && body.length > MAX_BODY) {
          return sendJson(res, {
            ok: false, error: 'payload too large',
            message: '纯文字请求体上限 ' + fmtSize(MAX_BODY) + '（带附件才放开到 ' + fmtSize(attachCap) + '）',
          }, 413)
        }
        if (!sid || (!text && rawAtt.length === 0 && rawReuse.length === 0)) {
          return sendJson(res, {
            ok: false, error: 'missing sessionId or content',
            message: '需要 sessionId，且 text 与 attachments 至少给一个',
          }, 400)
        }
        if (text.length > STEER_TEXT_MAX) return sendJson(res, { ok: false, error: 'text too long' }, 400)
        // 已移除的投递方式：明确拒绝（不静默忽略）。浏览器里未刷新的旧 client.js 仍可能发
        // 这两个 mode —— 给它一句能读懂的话，并把它指回对话框。
        if (parsed.mode === 'queue' || parsed.mode === 'steer') {
          return sendJson(res, {
            ok: false, error: 'mode-removed',
            message: '排队 / 官方插话已移除：直接用对话框发送即可（官方队列栏本来就能排队与插话）',
          }, 400)
        }
        const agent = ctx.agents.get(sid)
        if (!agent) {
          return sendJson(res, {
            ok: false, error: 'no-live-agent',
            message: 'Agent 当前空闲：运行中指导只在 Agent 工作时可用；直接在下面对话框发送即可',
          }, 409)
        }
        // 附件 → 宿主 durable ref → content blocks。拿不到 attachments 服务 → **501，不静默降级成纯文字**。
        let extraParts = []
        if (rawAtt.length) {
          try {
            extraParts = await admitAttachments(ctx, rawAtt)
          } catch (e) {
            if (e && e.code === 'no-attachments') {
              return sendJson(res, { ok: false, error: 'no-attachments', message: String((e && e.message) || e) }, 501)
            }
            const at = ctx.get('attachments')
            const isAtt = !!(at && typeof at.isAttachmentError === 'function' && at.isAttachmentError(e))
            return sendJson(res, {
              ok: false, error: isAtt ? (e.code || 'attachment-rejected') : 'attachment-failed',
              message: String((e && e.message) || e),
            }, 400)
          }
        }
        // 复用已有附件（重发）：走官方 sessionController.attachment 读回 durable ref —— 无需重传字节。
        // 读不回的**如实报出是哪些 id**，不静默丢附件。
        if (rawReuse.length) {
          const sc = ctx.get('sessionController')
          if (!sc || typeof sc.attachment !== 'function') {
            return sendJson(res, { ok: false, error: 'no-attachment-api', message: '此宿主不支持读取附件' }, 501)
          }
          const bad = []
          for (const aid of rawReuse) {
            try {
              const v = await sc.attachment({ sessionId: sid, attachmentId: aid })
              if (v && v.attachment) extraParts.push({ type: 'image', attachment: v.attachment })
              else bad.push(aid)
            } catch { bad.push(aid) }
          }
          if (bad.length) {
            return sendJson(res, {
              ok: false, error: 'reuse-attachment-unreadable',
              message: '这些附件读不回来：' + bad.join(', '),
            }, 404)
          }
        }
        const known = stateFor(sid, false)
        const guideMessage = makeGuidanceMessage(text || SEE_ATT, extraParts)
        const requestId = guideMessage.id
        // 先登记再投递：agent.steer 是 wakeup=true，投递返回前 owner 就可能已经 claim，
        // 事后再登记会漏掉 claimed 事件（0.2.x 实测踩到的坑）。
        const s = stateFor(sid, true)
        cancelPrune(sid)
        pushSteer(s, requestId, text || ('[附件] ' + rawAtt.map((a) => (a && a.name) || 'file').join(' · ')), 'sending')
        commit(s, {}, { progress: false })
        try {
          agent.steer(guideMessage)   // next-step + 唤醒：小步边界读，不 abort 当前 turn
        } catch (e) {
          setSteerStatus(s, requestId, 'rejected', true)
          commit(s, {}, { progress: false })
          if (known === undefined && !(subscribers.get(sid) && subscribers.get(sid).size > 0)) {
            // 本次调用才建立的状态、且无人订阅：失败即回收，不给未知会话留垃圾
            const t = setTimeout(() => { if (states.get(sid) === s) states.delete(sid) }, IDLE_PRUNE_MS)
            pruneTimers.set(sid, t)
          }
          return sendJson(res, { ok: false, error: 'guide-failed', message: String((e && e.message) || e) }, 502)
        }
        // 只承诺「已被 Agent 接收」；真正被读取由 inbox/claimed 异步回写（不覆盖已前进的状态）
        if (setSteerStatus(s, requestId, 'inserted')) commit(s, {}, { progress: false })
        const attIds = extraParts.map((p) => (p.attachment && p.attachment.attachmentId) || null).filter(Boolean)
        return sendJson(res, {
          ok: true, delivered: true, mode: 'guide', wasLive: true,
          messageId: requestId, requestId,
          attachments: extraParts.length,
          attIds,                     // 回给客户端，供「重发」原样复用（审查 #7）
          readState: steerStatusOf(s, requestId) || 'inserted',
        })
      }

      // GET /dsh-steer/steer-state?session=xxx&messageId=yyy → 插话读取状态
      if (url.pathname === '/dsh-steer/steer-state' && req.method === 'GET') {
        const sid = url.searchParams.get('session') || ''
        const mid = url.searchParams.get('messageId') || ''
        const s = stateFor(sid, false)
        const st = s && s.steer.find((x) => x.id === mid)
        return sendJson(res, { ok: true, messageId: mid, readState: st ? st.status : 'unknown' })
      }

      // GET /dsh-steer/attachment?session=<sid>&id=<attachmentId> —— 让插话里的附件**可点开查看**。
      // 走官方 sessionController.attachment 读字节；拿不到服务/读不到 → 明确 501/404，不伪造。
      if (url.pathname === '/dsh-steer/attachment' && req.method === 'GET') {
        const sid = url.searchParams.get('session') || ''
        const aid = url.searchParams.get('id') || ''
        if (!sid || !aid) return sendJson(res, { ok: false, error: 'missing session or id' }, 400)
        const sc = ctx.get('sessionController')
        if (!sc || typeof sc.attachment !== 'function') {
          return sendJson(res, { ok: false, error: 'no-attachment-api', message: '此宿主不支持读取附件' }, 501)
        }
        try {
          const v = await sc.attachment({ sessionId: sid, attachmentId: aid })
          const mediaType = (v && v.attachment && v.attachment.mediaType) || 'application/octet-stream'
          const data = (v && v.data) || ''
          // raw=1：直接回字节流 —— 给 <img src> 用（缩略图 / 查看器），避免把 base64 塞进前端状态
          if (url.searchParams.get('raw') === '1') {
            res.writeHead(200, { 'content-type': mediaType, 'cache-control': 'private, max-age=300' })
            res.end(Buffer.from(data, 'base64'))
            return
          }
          return sendJson(res, {
            ok: true,
            mediaType: (v && v.attachment && v.attachment.mediaType) || null,
            name: (v && v.attachment && v.attachment.name) || null,
            data,
          })
        } catch (e) {
          return sendJson(res, { ok: false, error: 'attachment-unreadable', message: String((e && e.message) || e) }, 404)
        }
      }

      // GET/POST /dsh-steer/lang —— 中英文设置（v0.6.0 C）。语言是全局的，写文件 + 推一次快照。
      if (url.pathname === '/dsh-steer/lang' && req.method === 'GET') {
        return sendJson(res, { ok: true, lang: readLang(), langs: LANGS })
      }
      if (url.pathname === '/dsh-steer/lang' && req.method === 'POST') {
        let body = ''
        for await (const chunk of req) { body += chunk; if (body.length > 1024) break }
        let parsed = null
        try { parsed = JSON.parse(body) } catch { return sendJson(res, { ok: false, error: 'invalid json' }, 400) }
        const w = writeLang(String((parsed && parsed.lang) || ''))
        for (const st of states.values()) commit(st, {}, { progress: false })
        return sendJson(res, { ok: true, lang: w.lang, persisted: w.persisted })
      }

      if (url.pathname === '/dsh-steer/ping') return sendJson(res, { ok: true })

      return sendJson(res, { ok: false, error: 'not found' }, 404)
    },
  }), 'dsh-steer: routes')

  return () => {
    for (const d of disposers) d()
  }
}

// —— 供 tests/ 使用的具名导出（纯函数 / 可注入 ctx 的辅助；不影响插件挂载）——
export {
  fmtChars, turnStepOf, beginStep, setRequest, toolSummary,
  bodyCapFor, makeGuidanceMessage, admitAttachments,
}

export default { name, inject, apply }
