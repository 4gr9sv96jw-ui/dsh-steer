// dsh-steer — Host 半区（0.2.0-rc.2 版：Runtime Snapshot + 官方 admission 插话）
//
// 设计原则（基于 DSH 0.2.0-rc.2 源码实测，非猜测）：
//   0. 【插话只走官方通道】投递一律经 ctx.sessionController.prompt(request, signal)——
//      服务门面签名就是 (request, signal)，首句 signal.throwIfAborted()（@Remote 约定，
//      调用方必须显式给 signal，漏了会 TypeError）。下游 commands.prompt 内部做
//      createUserMessage({source:{kind:'user',rpcId}}) + agent.steer()/agent.followup()，
//      自带 rpcId 幂等、冷会话 resume、附件收据绑定。
//   0b.【默认 queue，不默认 steer】mode:'steer' = agent.steer() = send(msg,'next-step',true)，
//      会把消息**并入正在跑的回合**（改变当前回合方向）→ Lyon 实测＝「打断直接发」；
//      mode:'queue' = agent.followup() = send(msg,'next-turn',true)，等本轮跑完立刻起一轮，
//      即 Codex 那种「排队引导」。所以默认 queue，steer 只在调用方显式要求时才用。
//   0c.【不手搓消息 + 不用 agent.inject()】inject = send(msg,'next-step',false) 不唤醒
//      （idle 时无人消费、静默丢弃）。
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
import { randomUUID } from 'node:crypto'

export const name = 'dsh-steer'
export const inject = ['agents', 'webServer', 'sessionController']

const states = new Map()       // sessionId -> snapshot
const subscribers = new Map()  // sessionId -> Set<res>
const pruneTimers = new Map()  // sessionId -> timeout（空闲清理）
const liveStreams = new Map()  // sessionId -> { ac, chars, toolName }（官方 assistant-stream 订阅）
const liveTimers = new Map()   // sessionId -> timeout（订阅断开后的延迟收流）
const MAX_BODY = 3 * 1024
const MAX_STEER = 20
const STEER_TEXT_MAX = 4000
const THROTTLE_MS = 1000
const IDLE_PRUNE_MS = 90 * 1000
const PROMPT_TIMEOUT_MS = 180 * 1000  // 只约束「admission + 冷会话 resume」，不含随后的 agent 回合
const LIVE_LINGER_MS = 20 * 1000      // SSE 订阅断开后，流再留一会儿（刷新页面不抖动）

// 0.2.x 实测：模型实时增量**不在** session/event 里（旧版等的 assistant/chunk 已不存在），
// 而在官方 ctx.sessionController.follow({assistantStream:true}) 的 assistant-stream 帧上。
// chunk.type：block-start / reasoning-delta / text-delta / tool-call-delta / block-end / usage / finish
const STREAM_LABEL = {
  reasoning: { state: 'reasoning', label: '思考中' },
  text: { state: 'streaming', label: '输出中' },
  'tool-call': { state: 'tool-args', label: '准备调用工具' },
}

/** 官方 admission 的请求身份（SessionRequestId）：0.2.x 就是 randomUUID()。 */
function makeRequestId() { return randomUUID() }

/** 字符量 → 短标签（思考/输出进度用）。 */
function fmtChars(n) {
  if (!n) return null
  return n < 1000 ? n + ' 字' : (n / 1000).toFixed(1) + 'k 字'
}

/** inbox 里的消息 → 本地插话条目 key。官方 admission 把 requestId 写进 source.rpcId。 */
function steerKeyOf(message) {
  const source = message && message.source
  return (source && source.rpcId) || (message && message.id) || null
}

/** RemoteError → HTTP：只暴露官方给的 code，不臆测。 */
function promptErrorOf(e) {
  const code = (e && e.isDSHRemoteError === true && typeof e.code === 'string') ? e.code : null
  const message = String((e && e.message) || e || 'prompt failed')
  if (code === 'session/not-found') return { status: 404, body: { ok: false, error: code, message } }
  if (code === 'gateway/bad-request' || code === 'session/invalid-time-zone' || code === 'session/attachment-invalid') {
    return { status: 400, body: { ok: false, error: code, message } }
  }
  if (code === 'session/agent-busy' || code === 'session/writer-held') return { status: 409, body: { ok: false, error: code, message } }
  return { status: 502, body: { ok: false, error: code || 'gateway/internal', message } }
}

function freshState(sessionId) {
  return {
    sessionId,
    run: { status: 'idle', startedAt: 0, lastProgressAt: 0 },
    current: { target: null, state: 'idle', label: '空闲', detail: null, startedAt: 0 },
    tool: null,
    request: null,
    retry: null,
    steer: [],
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
    tool: s.tool,
    request: s.request,
    retry: s.retry,
    steer: s.steer.slice(-MAX_STEER).map((x) => ({ id: x.id, text: x.text, status: x.status })),
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
 *  否则「当前阶段耗时」会被刷成 00:00（旧版每个 assistant/message 都重置，就是这个毛病）。 */
function setCurrent(s, target, state, label, detail) {
  const prev = s.current || {}
  const same = prev.state === state && prev.target === target
  s.current = {
    target,
    state,
    label: label || state,
    detail: detail === undefined ? (same ? prev.detail ?? null : null) : detail,
    startedAt: same ? (prev.startedAt || Date.now()) : Date.now(),
  }
}

// —— 官方实时流（assistant-stream）：思考 / 输出 / 准备工具调用 ——

function ensureLive(ctx, sid) {
  if (liveStreams.has(sid)) return
  const timer = liveTimers.get(sid)
  if (timer) { clearTimeout(timer); liveTimers.delete(sid) }
  const ac = new AbortController()
  const rec = { ac, chars: { reasoning: 0, text: 0, toolArgs: 0 }, toolName: null, frames: 0 }
  liveStreams.set(sid, rec)
  markLive(sid, { open: true, frames: 0, error: null })
  ;(async () => {
    try {
      const it = ctx.sessionController.follow({
        address: { kind: 'session', sessionId: sid },
        assistantStream: true,
        maxMessages: 2,
        turnWindow: { minMessages: 2, minTurns: 2 },
      }, ac.signal)
      for await (const frame of it) {
        if (ac.signal.aborted) break
        // 外层是 SessionFollowFrame：{ type:'assistant-stream', frame:{ type:'start'|'chunk'|'end' } }
        if (frame && frame.type === 'assistant-stream' && frame.frame) onStreamFrame(sid, frame.frame, rec)
      }
      markLive(sid, { open: false, frames: rec.frames, error: ac.signal.aborted ? null : 'stream ended' })
    } catch (e) {
      // abort 是正常收流；其余必须可见（写进快照 live.error，并在宿主日志留一行）
      const msg = String((e && e.message) || e)
      markLive(sid, { open: false, frames: rec.frames, error: msg })
      if (!ac.signal.aborted) { try { ctx.logger?.warn?.(`dsh-steer: live stream ${sid} failed: ${msg}`) } catch { /* ignore */ } }
    } finally {
      if (liveStreams.get(sid) === rec) liveStreams.delete(sid)
    }
  })()
}

/** 把实时流状态写进快照（诊断用：open/frames/error），订阅者可见。 */
function markLive(sid, patch) {
  const s = stateFor(sid, false)
  if (!s) return
  s.live = { ...(s.live || {}), ...patch }
  commit(s, {}, { progress: false })
}

function stopLive(sid) {
  const rec = liveStreams.get(sid)
  if (rec) { try { rec.ac.abort() } catch { /* ignore */ } liveStreams.delete(sid) }
}

/** SSE 订阅者从 0 → 1：开流；从 1 → 0：延迟收流。 */
function syncLive(ctx, sid) {
  const n = (subscribers.get(sid) && subscribers.get(sid).size) || 0
  if (n > 0) { ensureLive(ctx, sid); return }
  if (!liveStreams.has(sid)) return
  const t = setTimeout(() => {
    liveTimers.delete(sid)
    const still = (subscribers.get(sid) && subscribers.get(sid).size) || 0
    const s = stateFor(sid, false)
    if (still === 0 && (!s || s.run.status !== 'running')) stopLive(sid)
  }, LIVE_LINGER_MS)
  liveTimers.set(sid, t)
}

function onStreamFrame(sid, frame, rec) {
  const s = stateFor(sid, false)
  if (!s || !frame) return
  rec.frames += 1
  if (s.live && s.live.frames !== rec.frames && rec.frames % 25 === 0) markLive(sid, { frames: rec.frames })
  if (frame.type === 'start') {
    setCurrent(s, 'model', 'waiting-first-response', '等待模型响应', null)
    s.request = { startedAt: frame.time || Date.now(), firstResponseAt: 0, lastProgressAt: Date.now(), provider: null, error: null, turn: frame.turn ?? null, step: frame.step ?? null }
    commit(s, {}, { progress: false })
    return
  }
  if (frame.type === 'end') {
    // 一次 attempt 收尾（committed / abandoned）：回到「Agent 处理中」，等 assistant/message 或 tool/call 接管
    if (s.current && s.current.state !== 'tool-running') setCurrent(s, 'agent', 'working', '工作中', null)
    commit(s, {}, { progress: true })
    return
  }
  if (frame.type !== 'chunk' || !frame.chunk) return
  const c = frame.chunk
  const now = Date.now()
  switch (c.type) {
    case 'reasoning-delta': {
      rec.chars.reasoning += (c.text || '').length
      if (s.request && !s.request.firstResponseAt) s.request.firstResponseAt = now
      setCurrent(s, 'model', STREAM_LABEL.reasoning.state, STREAM_LABEL.reasoning.label, fmtChars(rec.chars.reasoning))
      commit(s, {}, { progress: true, throttled: true })
      break
    }
    case 'text-delta': {
      rec.chars.text += (c.text || '').length
      if (s.request && !s.request.firstResponseAt) s.request.firstResponseAt = now
      setCurrent(s, 'model', STREAM_LABEL.text.state, STREAM_LABEL.text.label, fmtChars(rec.chars.text))
      commit(s, {}, { progress: true, throttled: true })
      break
    }
    case 'tool-call-delta': {
      rec.chars.toolArgs += (c.argumentsDelta || '').length
      if (c.name) rec.toolName = c.name
      const label = rec.toolName ? ('准备调用 ' + rec.toolName) : STREAM_LABEL['tool-call'].label
      setCurrent(s, 'model', STREAM_LABEL['tool-call'].state, label, null)
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
        if (s.current.state === 'idle') setCurrent(s, 'agent', 'working', '工作中', null)
        commit(s, {}, { progress: false })
      }
      // 有人在看这个会话（SSE 订阅者）→ 保证官方实时流已开，第一帧 reasoning-delta 就不会漏
      syncLive(ctx, a.id)
    } else {
      s.run = { status: 'idle', startedAt: 0, lastProgressAt: Date.now() }
      s.current = { target: null, state: 'idle', label: '空闲', detail: null, startedAt: 0 }
      s.tool = null; s.request = null; s.retry = null; s.alert = null
      commit(s, {}, { progress: false })
      schedulePrune(a.id, s)
      syncLive(ctx, a.id)   // 空闲且无人订阅 → 延迟收流
    }
  }))

  // session/event：运行状态事实主源（每个事件带 .time/.seq/.type/.data）
  d.push(ctx.on('session/event', (session, ev) => {
    const sid = session && session.id
    if (!sid) return
    const s = stateFor(sid, false)
    if (!s) return                 // 只跟踪已被 agent/status running 或 steer 建立的会话
    const at = (ev && ev.time) ? ev.time : Date.now()
    const type = ev && ev.type
    let changed = false
    switch (type) {
      case 'step/start': {
        // 每个 step 发一次模型请求 → 请求锚点（真正「思考中/输出中」由 assistant-stream 帧接管）
        setCurrent(s, 'model', 'waiting-first-response', '等待模型响应', null)
        s.request = { startedAt: at, firstResponseAt: 0, lastProgressAt: at, provider: null, error: null }
        s.retry = null
        changed = true
        break
      }
      // 注意：0.2.x **没有** assistant/chunk 这个 session 事件（旧版插件等它，于是整个模型阶段
      // 都停在「等待响应」）。实时增量只走上面的官方 assistant-stream（见 onStreamFrame）。
      case 'assistant/message': {
        // assistant 一轮完成（含 0 工具调用）→ 确定进展
        setCurrent(s, 'agent', 'working', '工作中', null)
        if (s.request) s.request.lastProgressAt = at
        changed = true
        break
      }
      case 'tool/call': {
        const t = (ev.data && ev.data) || {}
        s.tool = { callId: t.callId || null, name: t.name || 'tool', startedAt: at, lastProgressAt: at }
        setCurrent(s, 'tool', 'tool-running', (t.name || '执行工具'), null)
        changed = true
        break
      }
      case 'tool/result': {
        // 工具结束。内部进度不可观察，只回到模型状态，不伪装。
        if (s.tool) s.tool = null
        setCurrent(s, s.request ? 'model' : 'agent', 'requesting', '处理结果', null)
        changed = true
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
        if (s.request) s.request.error = r.failure ? { code: r.failure.code || null, message: r.failure.message || null } : s.request.error
        setCurrent(s, 'model', 'retry-wait', '等待重试', r.retry ? '第 ' + r.retry + ' 次' : null)
        changed = true
        break
      }
      case 'llm/retry-started': {
        // 重试真正开始 → 重新请求中（这是「进展」：它真的继续了）
        const r = (ev.data && ev.data) || {}
        if (!s.retry) s.retry = { active: false, attempt: r.retry, maxAttempts: 0, delayMs: 0, retryAt: 0, reason: null }
        else s.retry.active = false
        setCurrent(s, 'model', 'requesting', '重新请求', r.retry ? '第 ' + r.retry + ' 次' : null)
        changed = true
        break
      }
    }
    if (changed) commit(s, {}, { progress: true })
    else if (type === 'assistant/chunk') commit(s, {}, { progress: true, throttled: true }) // 流式进展节流
  }))

  // request-error：显示真实 failure，不臆测；必须 next()（waterfall，llm-retry 在其后接管）
  d.push(ctx.on('agent/request-error', async (p, next) => {
    const a = p && p.agent
    if (a) {
      const s = stateFor(a.id, true)
      const f = p && p.failure
      if (s.request) s.request.error = f ? { code: f.code || null, message: f.message || null } : { code: null, message: '模型请求失败' }
      setCurrent(s, 'model', 'error', '请求失败', (f && (f.code || f.message)) || '模型请求失败')
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
    setCurrent(s, 'agent', 'error', '出错', String(msg).slice(0, 200))
    commit(s, {}, { progress: false })
  }))

  // —— 插话（官方 admission）状态：inserted → claimed（已读取进下一步）/ discarded。 ——
  const markSteer = (status) => (p) => {
    const a = p && p.agent; const msg = p && p.message
    if (!a || !msg) return
    const s = stateFor(a.id, false); if (!s) return
    const key = steerKeyOf(msg)
    if (key && setSteerStatus(s, key, status)) commit(s, {}, { progress: false })
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
    stopLive(a.id)
    const t = liveTimers.get(a.id); if (t) { clearTimeout(t); liveTimers.delete(a.id) }
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
        let set = subscribers.get(sid); if (!set) { set = new Set(); subscribers.set(sid, set) }
        set.add(res)
        s._lastPushAt = Date.now()
        syncLive(ctx, sid)   // 有人看 → 开官方实时流（思考/输出/准备工具都从这里来）
        res.on('close', () => {
          set.delete(res)
          if (set.size === 0) { subscribers.delete(sid); schedulePrune(sid, stateFor(sid, false)) }
          syncLive(ctx, sid)
        })
        return
      }

      // POST /dsh-steer/steer {sessionId, text, mode?}
      // 走官方 admission：与 GUI 队列栏完全同一条通道（sessionController.prompt），
      // 由 Host 负责合法 source / rpcId 幂等 / 冷会话 resume / steer|queue 真实投递。
      // mode 缺省：运行中 → steer（并入最近 step 边界，不打断当前工具调用）；空闲 → queue（立即起一轮）。
      if (url.pathname === '/dsh-steer/steer' && req.method === 'POST') {
        const ct = req.headers['content-type'] || ''
        if (!/application\/json/i.test(ct)) return sendJson(res, { ok: false, error: 'content-type must be application/json' }, 415)
        let body = ''
        let tooBig = false
        for await (const chunk of req) {
          body += chunk
          if (body.length > MAX_BODY) { tooBig = true; break }
        }
        if (tooBig) return sendJson(res, { ok: false, error: 'payload too large' }, 413)
        let parsed
        try { parsed = JSON.parse(body) } catch { return sendJson(res, { ok: false, error: 'invalid json' }, 400) }
        const sid = parsed.sessionId
        const text = String(parsed.text || '').trim()
        if (!sid || !text) return sendJson(res, { ok: false, error: 'missing sessionId or text' }, 400)
        if (text.length > STEER_TEXT_MAX) return sendJson(res, { ok: false, error: 'text too long' }, 400)
        const known = stateFor(sid, false)
        const wasLive = !!ctx.agents.get(sid)
        // 默认 = queue（followup）=「像 Codex 那样排队引导」：当前这一步/这一轮先跑完，
        // 结束后立刻起一轮按你这句走 —— 不打断。
        // 只有显式 mode:'steer' 才并入当前回合的最近 step 边界；DSH 的 steer 会改变
        // 正在跑的这一回合的方向，Lyon 实测感知为「打断直接发」，故**不再**做运行中默认。
        const mode = parsed.mode === 'steer' ? 'steer' : 'queue'
        const requestId = makeRequestId()
        // 先登记再投递：官方 steer/followup 都是 wakeup=true，admission 返回前 owner
        // 就可能已经 claim，事后再登记会漏掉 claimed 事件（这是 0.2.x 实测踩到的坑）。
        const s = stateFor(sid, true)
        cancelPrune(sid)
        pushSteer(s, requestId, text, 'sending')
        commit(s, {}, { progress: false })
        try {
          await ctx.sessionController.prompt({
            requestId,
            sessionId: sid,
            mode,
            content: [{ type: 'text', text }],
          }, AbortSignal.timeout(PROMPT_TIMEOUT_MS))
        } catch (e) {
          setSteerStatus(s, requestId, 'rejected', true)
          commit(s, {}, { progress: false })
          if (known === undefined && !(subscribers.get(sid) && subscribers.get(sid).size > 0)) {
            // 本次调用才建立的状态、且无人订阅：失败即回收，不给未知会话留垃圾
            const t = setTimeout(() => { if (states.get(sid) === s) states.delete(sid) }, IDLE_PRUNE_MS)
            pruneTimers.set(sid, t)
          }
          const { status, body: errBody } = promptErrorOf(e)
          return sendJson(res, errBody, status)
        }
        // 只承诺「已被 Agent 接收」；真正被读取由 inbox/claimed 异步回写（不覆盖已前进的状态）
        if (setSteerStatus(s, requestId, 'inserted')) commit(s, {}, { progress: false })
        return sendJson(res, {
          ok: true, delivered: true, mode, wasLive, messageId: requestId, requestId,
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

      if (url.pathname === '/dsh-steer/ping') return sendJson(res, { ok: true })

      return sendJson(res, { ok: false, error: 'not found' }, 404)
    },
  }), 'dsh-steer: routes')

  return () => {
    for (const d of disposers) d()
    for (const sid of [...liveStreams.keys()]) stopLive(sid)
    for (const t of liveTimers.values()) clearTimeout(t)
    liveTimers.clear()
  }
}

export default { name, inject, apply }
