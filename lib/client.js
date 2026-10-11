// dsh-steer — Client 半区（v0.4.0：运行诊断面板 + 运行中「侧边对话式指导」）
// 注册进 conversation.session.header.actions。
// 原则：秒级更新时间，事件级更新状态，正常极安静，长时间无进展/错误/重试/断线时突出异常。
// 时间全部本地计算（收到 startedAt / current.startedAt / lastProgressAt / serverTime 差值）；
// 状态由 Host Runtime Snapshot 推送（状态变化才推）。
// 投递只有一条：POST /dsh-steer/steer → Host 用自定义 kind + agent.steer 投「运行中指导」
// （小步边界被读、任务不打断）。排队 / 官方插话已移除 —— 直接用对话框即可。
window.__ModuleLoader__.load({
  id: '@lyonleeeee/dsh-steer',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')

    const TAG_ID = 'dsh-steer/panel.css'
    const CSS = [
      /* ── 徽标 + 按钮 ───────────────────────────────── */
      '.dsh-steer-wrap { display:flex; align-items:center; gap:6px; position:relative; }',
      '.dsh-steer-chip { display:inline-flex; align-items:center; gap:7px; background:var(--dsw-alias-bg-layer-2); border:1px solid var(--dsw-alias-border-l1); border-radius:9px; padding:4px 10px; font:inherit; font-size:12px; line-height:1.4; cursor:pointer; color:var(--dsw-alias-label-primary); transition:border-color .12s ease; }',
      '.dsh-steer-chip:hover { border-color:var(--dsw-static-blue-450); }',
      '.dsh-steer-chip.stale { border-color:#e06060; color:#ffb3b3; }',
      '.dsh-steer-chip .txt { white-space:nowrap; max-width:190px; overflow:hidden; text-overflow:ellipsis; }',
      '.dsh-steer-chip .time { color:var(--dsw-alias-label-tertiary); font-size:11px; font-variant-numeric:tabular-nums; }',
      '.dsh-steer-dot { width:8px; height:8px; border-radius:50%; background:#555b68; flex:0 0 auto; }',
      '.dsh-steer-dot.working { background:#e0a13c; }',
      '.dsh-steer-dot.thinking { background:#a98cf0; animation:dsh-steer-breathe 2.6s ease-in-out infinite; }',
      '.dsh-steer-dot.toolargs { background:#e0a13c; animation:dsh-steer-blink 1.4s infinite; }',
      '.dsh-steer-dot.streaming { background:#7ecb8e; }',
      '.dsh-steer-dot.waiting { background:#8fb4e8; animation:dsh-steer-blink 1.2s infinite; }',
      '.dsh-steer-dot.retry { background:#d9a441; animation:dsh-steer-pulse 1s infinite; }',
      '.dsh-steer-dot.error { background:#e06060; animation:dsh-steer-pulse 1s infinite; }',
      '.dsh-steer-dot.stale { background:#e06060; }',
      '@keyframes dsh-steer-breathe { 0%,100%{opacity:1} 50%{opacity:.45} }',
      '@keyframes dsh-steer-pulse { 0%,100%{opacity:1} 50%{opacity:.3} }',
      '@keyframes dsh-steer-blink { 0%,100%{opacity:1} 50%{opacity:.35} }',
      '.dsh-steer-btn { background:var(--dsw-alias-bg-layer-2); border:1px solid var(--dsw-alias-border-l1); border-radius:9px; padding:4px 11px; font:inherit; font-size:12px; cursor:pointer; color:var(--dsw-alias-label-primary); transition:border-color .12s ease; }',
      '.dsh-steer-btn:hover { border-color:var(--dsw-static-blue-450); }',

      /* ── 浮层骨架（详情 / 指导共用）───────────────── */
      '.dsh-steer-pop, .dsh-steer-shell { position:fixed; right:16px; top:46px; width:360px; background:var(--dsw-alias-bg-overlay); border:1px solid var(--dsw-alias-border-l1); border-radius:14px; z-index:1000; box-shadow:0 16px 40px rgba(0,0,0,.5); overflow:hidden; }',
      '.dsh-steer-shell { z-index:1001; border-color:var(--dsw-static-blue-450); }',
      '.dsh-steer-head { display:flex; align-items:center; gap:8px; padding:12px 14px 11px; border-bottom:1px solid var(--dsw-alias-border-l1); }',
      '.dsh-steer-head h4 { margin:0; font-size:12.5px; font-weight:600; letter-spacing:.2px; color:var(--dsw-alias-label-primary); }',
      '.dsh-steer-head .x { margin-left:auto; background:none; border:none; padding:2px 5px; cursor:pointer; color:var(--dsw-alias-label-tertiary); font-size:13px; line-height:1; border-radius:6px; font-family:inherit; }',
      '.dsh-steer-head .x:hover { color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-layer-2); }',
      '.dsh-steer-body { padding:12px 14px 14px; }',

      /* ── 详情面板 ──────────────────────────────── */
      '.dsh-steer-block { border:1px solid var(--dsw-alias-border-l1); border-radius:10px; padding:10px 12px; margin-bottom:10px; background:var(--dsw-alias-bg-layer-1); }',
      '.dsh-steer-block .tl { display:flex; justify-content:space-between; align-items:baseline; gap:8px; font-size:12.5px; font-weight:600; color:var(--dsw-alias-label-primary); }',
      '.dsh-steer-block .tl .time { font-variant-numeric:tabular-nums; font-weight:400; }',
      '.dsh-steer-block .st { font-size:11px; line-height:1.5; color:var(--dsw-alias-label-tertiary); margin-top:3px; }',
      '.dsh-steer-row { display:flex; justify-content:space-between; align-items:baseline; gap:12px; font-size:11px; line-height:1.75; color:var(--dsw-alias-label-tertiary); }',
      '.dsh-steer-row > span:last-child { color:var(--dsw-alias-label-primary); text-align:right; }',
      '.dsh-steer-warn { font-size:11px; color:#ff9a6a; margin-top:6px; }',
      '.dsh-steer-conn { font-size:11px; color:var(--dsw-alias-label-tertiary); margin-top:10px; padding-top:8px; border-top:1px solid var(--dsw-alias-border-l1); }',
      '.dsh-steer-langs { display:inline-flex; gap:4px; }',
      '.dsh-steer-langs .lg { background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-tertiary); border:1px solid var(--dsw-alias-border-l1); border-radius:7px; padding:2px 8px; font:inherit; font-size:11px; cursor:pointer; }',
      '.dsh-steer-langs .lg.on { border-color:var(--dsw-static-blue-450); color:var(--dsw-alias-label-primary); }',

      /* ── 指导浮层 ──────────────────────────────── */
      '.dsh-steer-hint { font-size:11px; line-height:1.55; color:var(--dsw-alias-label-tertiary); margin:0 0 10px; padding-left:8px; border-left:2px solid var(--dsw-alias-border-l1); }',
      '.dsh-steer-hint.idle { color:#8fb4e8; border-left-color:#8fb4e8; }',
      '.dsh-steer-shell textarea { width:100%; min-height:76px; background:var(--dsw-alias-bg-layer-1); border:1px solid var(--dsw-alias-border-l1); border-radius:10px; color:var(--dsw-alias-label-primary); padding:9px 11px; font:inherit; font-size:13px; line-height:1.55; resize:vertical; box-sizing:border-box; }',
      '.dsh-steer-shell textarea::placeholder { color:var(--dsw-alias-label-tertiary); }',
      '.dsh-steer-shell textarea:focus { outline:none; border-color:var(--dsw-static-blue-450); }',
      '.dsh-steer-files { display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin-top:8px; }',
      '.dsh-steer-files .f { display:inline-flex; align-items:center; gap:5px; max-width:210px; font-size:11px; background:var(--dsw-alias-bg-layer-2); border:1px solid var(--dsw-alias-border-l1); border-radius:7px; padding:2px 7px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }',
      '.dsh-steer-files .x { cursor:pointer; color:var(--dsw-alias-label-tertiary); }',
      '.dsh-steer-files .x:hover { color:#ff9a9a; }',
      '.dsh-steer-actions { display:flex; align-items:center; gap:8px; margin-top:10px; }',
      '.dsh-steer-status { flex:1 1 auto; min-width:0; font-size:11px; line-height:1.5; color:var(--dsw-alias-label-tertiary); overflow:hidden; text-overflow:ellipsis; }',
      '.dsh-steer-status.ok { color:#7ecb8e; }',
      '.dsh-steer-status.err { color:#ff9a9a; }',
      '.dsh-steer-ghost { flex:0 0 auto; background:transparent; color:var(--dsw-alias-label-tertiary); border:1px solid var(--dsw-alias-border-l1); border-radius:8px; padding:5px 12px; font:inherit; font-size:12px; cursor:pointer; }',
      '.dsh-steer-ghost:hover { color:var(--dsw-alias-label-primary); border-color:var(--dsw-static-blue-450); }',
      '.dsh-steer-icon { flex:0 0 auto; width:30px; height:30px; display:inline-flex; align-items:center; justify-content:center; background:transparent; border:1px solid var(--dsw-alias-border-l1); border-radius:8px; cursor:pointer; font-size:13px; line-height:1; }',
      '.dsh-steer-icon:hover { border-color:var(--dsw-static-blue-450); background:var(--dsw-alias-bg-layer-2); }',
      '.dsh-steer-send { flex:0 0 auto; background:var(--dsw-static-blue-450); color:#fff; border:none; border-radius:8px; padding:6px 16px; font:inherit; font-size:12px; font-weight:600; cursor:pointer; }',
      '.dsh-steer-send:disabled { opacity:.45; cursor:default; }',

      /* ── 插话历史（**只含插件发出的插话**）──────────── */
      '.dsh-steer-hist { margin-top:14px; padding-top:11px; border-top:1px solid var(--dsw-alias-border-l1); }',
      '.dsh-steer-hist .cap { display:flex; justify-content:space-between; align-items:baseline; gap:8px; margin-bottom:6px; font-size:10px; font-weight:600; letter-spacing:.7px; text-transform:uppercase; color:var(--dsw-alias-label-tertiary); }',
      '.dsh-steer-hist .cap .meta { font-weight:400; letter-spacing:0; text-transform:none; }',
      '.dsh-steer-hist .list { max-height:200px; overflow-y:auto; margin:0 -6px; padding:0 2px; }',
      '.dsh-steer-hist .it { display:flex; align-items:center; gap:8px; padding:6px; border-radius:8px; cursor:pointer; white-space:nowrap; }',
      '.dsh-steer-hist .it:hover { background:var(--dsw-alias-bg-layer-2); }',
      '.dsh-steer-hist .st { flex:0 0 12px; text-align:center; font-size:11px; }',
      '.dsh-steer-hist .st.ok { color:#7ecb8e; }',
      '.dsh-steer-hist .st.pending { color:var(--dsw-alias-label-tertiary); }',
      '.dsh-steer-hist .st.drop { color:#ff9a9a; }',
      '.dsh-steer-hist .tm { flex:0 0 auto; font-size:10.5px; color:var(--dsw-alias-label-tertiary); font-variant-numeric:tabular-nums; }',
      '.dsh-steer-hist .atts { flex:0 0 auto; display:inline-flex; gap:3px; align-items:center; }',
      '.dsh-steer-hist .thumb { width:18px; height:18px; border-radius:4px; object-fit:cover; border:1px solid var(--dsw-alias-border-l1); display:block; }',
      '.dsh-steer-hist .afile { font-size:10px; color:var(--dsw-alias-label-tertiary); }',
      '.dsh-steer-hist .tx { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; font-size:11.5px; color:var(--dsw-alias-label-primary); }',
      '.dsh-steer-hist .mk { flex:0 0 auto; font-size:10px; color:var(--dsw-alias-label-tertiary); }',
      '.dsh-steer-hist .mk.ok { color:#7ecb8e; }',
      '.dsh-steer-hist .mk.drop { color:#ff9a9a; }',
      '.dsh-steer-hist .re { flex:0 0 auto; font-size:10px; padding:2px 8px; border-radius:6px; border:1px solid var(--dsw-alias-border-l1); color:var(--dsw-static-blue-450); background:transparent; font-family:inherit; cursor:pointer; }',
      '.dsh-steer-hist .re:hover { border-color:var(--dsw-static-blue-450); }',
      '.dsh-steer-hist .empty { font-size:11px; color:var(--dsw-alias-label-tertiary); padding:4px 6px; }',

      /* ── 附件查看器 ────────────────────────────── */
      '.dsh-steer-viewer { position:fixed; inset:0; z-index:2000; background:rgba(0,0,0,.74); display:flex; align-items:center; justify-content:center; padding:24px; }',
      '.dsh-steer-viewer img { max-width:92vw; max-height:88vh; border-radius:10px; box-shadow:0 20px 60px rgba(0,0,0,.6); background:#111; }',
      '.dsh-steer-viewer .vb { position:absolute; top:16px; right:20px; background:rgba(255,255,255,.12); border:none; color:#fff; font-size:13px; padding:6px 12px; border-radius:8px; cursor:pointer; font-family:inherit; }',
    ].join('\n')
    // 样式注入：**每次都把最新 CSS 写回同一个 style 标签**。
    // 旧写法是「已存在就跳过」→ 热重载后浏览器里留着旧样式表，新类名全不生效（0.6.0 踩到的真 bug）。
    if (typeof document !== 'undefined') {
      const sel = 'style[data-plugin-css=' + JSON.stringify(TAG_ID) + ']'
      let tag = document.querySelector(sel)
      if (!tag) {
        tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-steer'
        tag.dataset.pluginCss = TAG_ID
        document.head.appendChild(tag)
      }
      if (tag.textContent !== CSS) tag.textContent = CSS
    }

    // —— 中英文文案表（v0.6.0 C）——
    // 原则：**host 只发 state 码 / 原始数字 / 原始工具名，文案与单位一律由客户端按语言生成**。
    const STR = {
      zh: {
        idle: '空闲', analyzing: '分析中', thinking: '思考中', outputting: '输出中',
        toolArgs: '准备调用', toolRunning: '运行', readingResult: '读取工具结果',
        working: '工作中', retryWait: '等待重试', failed: '请求失败', charsUnit: ' 字',
        connLost: '○ 状态实时源断开', connRecover: '○ 状态实时源正在恢复…',
        staleNote: '（暂无新增量）', detailTitle: '运行状态诊断', guide: '💬 指导',
        guideTitle: '💬 运行中指导（不打断）',
        guideHint: '任务不打断：在最近一次小步（思考 / 一次工具调用）结束的边界被读进去，可用来改写后面的步骤。',
        guideHintIdle: 'Agent 已空闲 —— 运行中指导用不上；直接在下面对话框发送即可（排队 / 插话归官方队列栏）。',
        placeholder: '补充你的意思，或纠正理解…（可直接贴图）', attach: '📎 附件', send: '发送', sending: '发送中…', cancel: '取消',
        draftSaved: '已存为草稿', historyCap: '插话历史',
        read: '已读取', delivered: '已送达', unread: '未读取', notRead: '未被读取', resend: '重发',
        noText: '(无文字)', sentOk: '已投递指导：小步边界生效', sendFail: '发送失败', sendFailNet: '发送失败（网络错误）',
        curRun: '当前运行', total: '总计', status: '状态', model: '模型', step: '步',
        recent: '最近进展', lastErr: '最近错误', retry: '重试', reason: '原因', nextRetry: '下次重试', myAdd: '我的补充',
        dAnalyzing: '模型请求已发出，正在分析（尚未有增量输出）', dThinking: '模型推理中', dOutputting: '正在输出回答',
        dToolArgs: '正在生成工具调用参数', dToolRunning: '正在运行', dReading: '正在读取工具结果',
        dRetry: '模型请求失败，等待重试', dError: '发生错误', dWorkingAgent: 'Agent 正在处理', dWorking: '处理中', dIdle: 'Agent 当前空闲',
        toolNoInner: '（DSH 不暴露工具内部进度）', agoNow: '刚刚', agoSec: ' 秒前', agoMin: ' 分钟前', agoHour: ' 小时前', agoUnknown: '未知',
        langLabel: '语言', langAuto: '自动', tooltipRefill: '点击回填到输入框',
        seeAtt: '（见附件）', langNotSaved: '语言已切换，但写盘失败（仅本次生效）',
        histMeta: '{n} 条', close: '关闭（Esc）', viewAtt: '点击查看附件',
      },
      en: {
        idle: 'Idle', analyzing: 'Analyzing', thinking: 'Thinking', outputting: 'Writing',
        toolArgs: 'Preparing', toolRunning: 'Running', readingResult: 'Reading result',
        working: 'Working', retryWait: 'Waiting to retry', failed: 'Request failed', charsUnit: ' chars',
        connLost: '○ Live source disconnected', connRecover: '○ Live source recovering…',
        staleNote: ' (no new progress)', detailTitle: 'Runtime status', guide: '💬 Guide',
        guideTitle: '💬 In-flight guidance (non-interrupting)',
        guideHint: 'Non-interrupting: read at the end of the nearest small step (one reasoning / one tool call) and can rewrite the following steps.',
        guideHintIdle: 'Agent is idle — in-flight guidance is unavailable; just send from the composer below.',
        placeholder: 'Add or correct your intent… (paste an image directly)', attach: '📎 Attach', send: 'Send', sending: 'Sending…', cancel: 'Cancel',
        draftSaved: 'Saved as draft', historyCap: 'Guidance history',
        read: 'Read', delivered: 'Delivered', unread: 'Not read', notRead: 'Not read', resend: 'Resend',
        noText: '(no text)', sentOk: 'Guidance delivered (read at the next step boundary)', sendFail: 'Send failed', sendFailNet: 'Send failed (network)',
        curRun: 'Current run', total: 'total', status: 'Status', model: 'Model', step: 'Step',
        recent: 'Last progress', lastErr: 'Last error', retry: 'Retry', reason: 'Reason', nextRetry: 'Next retry', myAdd: 'My guidance',
        dAnalyzing: 'Request sent, analyzing (no output yet)', dThinking: 'Model reasoning', dOutputting: 'Writing the answer',
        dToolArgs: 'Generating tool-call arguments', dToolRunning: 'Running', dReading: 'Reading tool result',
        dRetry: 'Request failed, waiting to retry', dError: 'Error', dWorkingAgent: 'Agent is working', dWorking: 'Working', dIdle: 'Agent is idle',
        toolNoInner: ' (DSH does not expose tool internals)', agoNow: 'just now', agoSec: 's ago', agoMin: 'm ago', agoHour: 'h ago', agoUnknown: 'unknown',
        langLabel: 'Language', langAuto: 'Auto', tooltipRefill: 'Click to refill the input',
        seeAtt: '(see attachment)', langNotSaved: 'Language switched but not saved (this session only)',
        histMeta: '{n} items', close: 'Close (Esc)', viewAtt: 'Click to view attachment',
      },
    }

    // host 的错误码 → 本地化文案。**逐条映射**（审查 #4）：英文界面不得出现 host 的中文 message；
    // 只有未映射的码才回落到 host 的 message。
    const ERR = {
      zh: {
        'forbidden': '仅允许本机访问',
        'bad url': '请求地址非法',
        'not found': '接口不存在',
        'content-type must be application/json': '请求类型必须是 JSON',
        'invalid json': '请求体不是合法 JSON',
        'payload too large': '请求体过大',
        'missing session': '缺少 session',
        'missing session or id': '缺少 session 或附件 id',
        'missing sessionId or content': '需要 sessionId，且文字与附件至少给一个',
        'text too long': '文字太长',
        'mode-removed': '排队 / 官方插话已移除：直接用对话框发送即可',
        'no-live-agent': 'Agent 当前空闲：运行中指导只在 Agent 工作时可用',
        'no-attachments': '此宿主不支持附件',
        'no-attachment-api': '此宿主不支持读取附件',
        'attachment-unreadable': '附件读不出来（可能已不在会话里）',
        'reuse-attachment-unreadable': '重发时这些附件读不回来',
        'guide-failed': '投递失败',
      },
      en: {
        'forbidden': 'Local access only',
        'bad url': 'Bad request URL',
        'not found': 'No such endpoint',
        'content-type must be application/json': 'Content-Type must be application/json',
        'invalid json': 'Request body is not valid JSON',
        'payload too large': 'Payload too large',
        'missing session': 'Missing session',
        'missing session or id': 'Missing session or attachment id',
        'missing sessionId or content': 'Need a sessionId and at least text or an attachment',
        'text too long': 'Text too long',
        'mode-removed': 'Queue / official steer were removed — just send from the composer',
        'no-live-agent': 'Agent is idle: in-flight guidance only works while it runs',
        'no-attachments': 'This host does not support attachments',
        'no-attachment-api': 'This host cannot read attachments',
        'attachment-unreadable': 'Attachment unreadable (may no longer be in the session)',
        'reuse-attachment-unreadable': 'These attachments could not be re-read',
        'guide-failed': 'Delivery failed',
      },
    }

    // 纯附件插话的占位文本（必须与 host 的 SEE_ATT 一致）；显示时按语言替换
    const SEE_ATT = '(see attachment)'

    /** 剥掉 host 给指导消息套的 <system-reminder> 框架，只留用户原文（纯函数，可测）。 */
    function cleanGuide(t) {
      return String(t || '')
        .replace(/^[\s\S]*?\[运行中指导 · dsh-steer\]\s*/, '')
        .replace(/（这是对当前任务的补充或纠正[\s\S]*$/, '')
        .trim()
    }

    /** host history + 本地 sessionStorage 记录 → 统一列表（去重、按时间升序、host 状态优先）。纯函数，可测。 */
    function mergeHist(hostHist, sent, steers) {
      const seen = new Set()
      const out = []
      const stOf = (id) => (Array.isArray(steers) ? steers.find((x) => x.id === id) : null) || null
      const push = (key, at, text, atts, st) => {
        out.push({
          key, at, text, atts,
          status: (st && st.status) || 'unknown',
          claimedTurn: st ? st.claimedTurn : null,
          claimedStep: st ? st.claimedStep : null,
        })
      }
      for (const h of (Array.isArray(hostHist) ? hostHist : [])) {
        const k = h.id || ('seq:' + h.seq)
        if (seen.has(k)) continue
        seen.add(k)
        const st = stOf(h.id)
        push(k, h.at, (st && st.text) ? st.text : cleanGuide(h.text), Array.isArray(h.atts) ? h.atts : [], st)
      }
      for (const it of (Array.isArray(sent) ? sent : [])) {
        if (seen.has(it.id)) continue
        seen.add(it.id)
        const st = stOf(it.id)
        // 本地记录的附件存的是 id 数组 → 归一成 {id,type}，这样刷新后缩略图也还在
        const atts = (Array.isArray(it.atts) ? it.atts : []).map((a) => (typeof a === 'string' ? { id: a, type: 'image' } : a))
        push(it.id, it.at, it.text, atts, st)
      }
      out.sort((a, b) => (a.at || 0) - (b.at || 0))
      return out
    }

    /** 一条插话的展示状态（纯函数，可测）：cls=图标样式类，mark=右侧状态文字，markTip=悬停说明。 */
    function markOf(it, L, runLive) {
      const bad = it.status === 'discarded' || it.status === 'rejected'
      const unread = !bad && !runLive && (it.status === 'inserted' || it.status === 'sending' || it.status === 'unknown')
      const cls = it.status === 'claimed' ? 'ok' : (bad || unread) ? 'drop' : 'pending'
      const mark = it.status === 'claimed'
        ? ('T' + (it.claimedTurn != null ? it.claimedTurn : '?') + (it.claimedStep != null ? '·S' + it.claimedStep : ''))
        : bad ? L.notRead : unread ? L.unread : L.delivered
      const markTip = it.status === 'claimed'
        ? (L.read + (it.claimedTurn != null ? ' · T' + it.claimedTurn + (it.claimedStep != null ? '·S' + it.claimedStep : '') : ''))
        : mark
      return { bad, unread, cls, mark, markTip }
    }

    function fmtMs(ms) {
      if (!ms || !isFinite(ms) || ms < 0) return '00:00'
      const s = Math.floor(ms / 1000)
      const h = Math.floor(s / 3600)
      const m = Math.floor((s % 3600) / 60)
      const ss = s % 60
      if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + String(ss).padStart(2, '0')
      return String(m).padStart(2, '0') + ':' + String(ss).padStart(2, '0')
    }
    function fmtAgo(ms, L) {
      const t = L || { agoUnknown: '未知', agoNow: '刚刚', agoSec: ' 秒前', agoMin: ' 分钟前', agoHour: ' 小时前' }
      if (ms == null || !isFinite(ms)) return t.agoUnknown
      const s = Math.max(0, Math.floor(ms / 1000))
      if (s < 5) return t.agoNow
      if (s < 60) return s + t.agoSec
      const m = Math.floor(s / 60)
      if (m < 60) return m + t.agoMin
      const h = Math.floor(m / 60)
      return h + t.agoHour
    }

    function SteerControl(props) {
      const sessionId = props.sessionId
      const [state, setState] = React.useState(null)
      const [conn, setConn] = React.useState('connecting')
      const [showDetail, setShowDetail] = React.useState(false)
      const [shellOpen, setShellOpen] = React.useState(false)
      const [text, setText] = React.useState('')
      const [feedback, setFeedback] = React.useState({ kind: '', msg: '' })
      const [sending, setSending] = React.useState(false)
      const [lastMsgId, setLastMsgId] = React.useState(null)
      const [sent, setSent] = React.useState([])
      const [now, setNow] = React.useState(Date.now())
      const wrapRef = React.useRef(null)

      // —— 语言解析（v0.6.0 C）：host 的 lang 优先；auto 时看浏览器语言 ——
      const hostLang = (state && state.lang) || 'auto'
      const lang = hostLang === 'auto'
        ? ((typeof navigator !== 'undefined' && /^zh/i.test(navigator.language || '')) ? 'zh' : 'en')
        : hostLang
      const L = STR[lang] || STR.zh
      const maxAtt = (state && state.maxAttach) || 6      // 上限由 host 下发（审查 #11）
      const charsOf = (n) => (n == null ? null : (n < 1000 ? String(n) : (n / 1000).toFixed(1) + 'k') + L.charsUnit)

      // SSE 订阅（Host 状态变化才推；首帧即当前快照）
      React.useEffect(() => {
        let es
        try {
          es = new EventSource('/dsh-steer/state?session=' + encodeURIComponent(sessionId))
          setConn('connecting')
          es.onopen = () => setConn('connected')
          es.onmessage = (e) => { try { setState(JSON.parse(e.data)); setConn('connected') } catch { /* ignore */ } }
          es.onerror = () => setConn((c) => (c === 'connected' ? 'reconnecting' : c))
        } catch { setConn('closed') }
        return () => { if (es) es.close(); setConn('closed') }
      }, [sessionId])

      // 本地秒级计时：仅运行态或当前有活动时跑，空闲零定时器
      const active = state && state.run && (state.run.status === 'running' || (state.current && state.current.state !== 'idle'))
      React.useEffect(() => {
        if (!active) return
        const t = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(t)
      }, [active])

      // 草稿（sessionStorage，切换会话不串；发送失败保留）
      const draftKey = 'dsh-steer:draft:' + sessionId
      React.useEffect(() => { try { const v = window.sessionStorage.getItem(draftKey); if (v) setText(v) } catch { /* ignore */ } }, [draftKey])

      // 已发指导记录（v0.5.0 追加需求 A）：权威记录放 sessionStorage —— host 侧的 snapshot.steer
      // 只在内存（MAX_STEER=20，空闲 90s 随 state 回收），刷新即丢，所以「发过什么」必须客户端自己留。
      const sentKey = 'dsh-steer:sent:' + sessionId
      React.useEffect(() => {
        try { const v = window.sessionStorage.getItem(sentKey); setSent(v ? (JSON.parse(v) || []) : []) } catch { setSent([]) }
      }, [sentKey])
      const rememberSent = (rec) => {
        const next = sent.concat([rec]).slice(-50)
        setSent(next)
        try { window.sessionStorage.setItem(sentKey, JSON.stringify(next)) } catch { /* ignore */ }
      }

      // —— 附件（v0.6.0 A）：选文件 / 直接贴图 → base64（**不落盘**，只随请求发给本机插件）——
      const [files, setFiles] = React.useState([])
      const readOne = (f) => new Promise((resolve) => {
        const r = new FileReader()
        r.onload = () => {
          const s = String(r.result || '')
          const i = s.indexOf(',')
          resolve({
            kind: (f.type || '').startsWith('image/') ? 'image' : 'file',
            mediaType: f.type || undefined,
            name: f.name || 'pasted',
            dataBase64: i >= 0 ? s.slice(i + 1) : '',
            size: f.size || 0,
          })
        }
        r.onerror = () => resolve(null)
        r.readAsDataURL(f)
      })
      const addFiles = (list) => {
        const arr = Array.from(list || []).slice(0, maxAtt)
        if (!arr.length) return
        Promise.all(arr.map(readOne)).then((got) => {
          const ok = got.filter((x) => x && x.dataBase64)
          if (ok.length) setFiles((prev) => prev.concat(ok).slice(0, maxAtt))
        })
      }

      // 附件查看器（v0.6.0 修正）：插话里的附件**点开即看**，不再只显示 "attachment" 字样
      const [viewer, setViewer] = React.useState(null)
      const attUrl = (aid) => '/dsh-steer/attachment?session=' + encodeURIComponent(sessionId)
        + '&id=' + encodeURIComponent(aid) + '&raw=1'

      // 审查修正：切换会话必须清掉**属于上一个会话的本地态**（已选附件 / 查看器 / 提示 / 浮层），
      // 否则 A 会话选的图会跟着出现在 B 会话的指导框里。
      React.useEffect(() => {
        setFiles([]); setViewer(null); setFeedback({ kind: '', msg: '' })
        setShowDetail(false); setShellOpen(false)
      }, [sessionId])
      const onTextChange = (e) => {
        const v = e.target.value
        setText(v)
        try { window.sessionStorage.setItem(draftKey, v) } catch { /* ignore */ }
      }

      // 点外部关闭 + Esc 关闭（详情/指导框都算）；只在有浮层时挂监听，平时零监听
      React.useEffect(() => {
        if (!showDetail && !shellOpen && !viewer) return
        const onDown = (e) => {
          if (viewer) return   // 查看器自己处理点击关闭
          if (wrapRef.current && !wrapRef.current.contains(e.target)) { setShowDetail(false); setShellOpen(false) }
        }
        const onKey = (e) => {
          if (e.key === 'Escape') { setViewer(null); setShowDetail(false); setShellOpen(false); setFeedback({ kind: '', msg: '' }) }
        }
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey)
        return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
      }, [showDetail, shellOpen, viewer])

      const send = (override, reuseIds) => {
        const trimmed = (override != null && typeof override === 'string' ? override : text).trim()
        const reuse = Array.isArray(reuseIds) ? reuseIds.filter(Boolean) : []
        // 允许「只有附件」的插话：文字为空但有（复用/新）附件也要能发
        if ((!trimmed && !reuse.length && !files.length) || sending) return
        setSending(true); setFeedback({ kind: 'info', msg: L.sending })
        fetch('/dsh-steer/steer', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          // 审查修正：无超时会让 sending 永久卡住（按钮一直禁用）
          signal: (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(120000) : undefined,
          body: JSON.stringify({
            sessionId, text: trimmed,
            attachments: reuse.length ? [] : files.map((f) => ({ kind: f.kind, mediaType: f.mediaType, name: f.name, dataBase64: f.dataBase64 })),
            reuseAtts: reuse,      // 重发：复用已有 durable ref，不重传字节（审查 #7）
          }),
        }).then((r) => r.json()).then((d) => {
          if (d && d.ok) {
            setLastMsgId(d.messageId)
            // 真话：只承诺 Host 已接收（agent.steer 未抛异常）；「已读取」由 Host 经 inbox/claimed 回写
            setFeedback({ kind: 'ok', msg: L.sentOk })
            // 连**附件 id** 一起记，重发才能原样复用（审查 #7）
            rememberSent({ id: d.messageId, text: trimmed, at: Date.now(), atts: Array.isArray(d.attIds) ? d.attIds : [] })
            try { window.sessionStorage.removeItem(draftKey) } catch { /* ignore */ }
            setFiles([])
            setText(''); setShellOpen(false); setSending(false)
          } else {
            // 失败：不清草稿、不关闭、可重发。文案走**本地错误码表**（英文界面不露 host 的中文），未映射才回落
            const em = ERR[lang] || ERR.zh
            setFeedback({ kind: 'err', msg: (d && (em[d.error] || d.message || d.error)) || L.sendFail })
            setSending(false)
          }
        }).catch(() => { setFeedback({ kind: 'err', msg: L.sendFailNet }); setSending(false) })
      }
      const onKeyDown = (e) => {
        if (e.key === 'Escape') { setShellOpen(false); setFeedback({ kind: '', msg: '' }) }
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); send() }
      }

      // —— 计算快照展示值 ——
      const run = (state && state.run) || { status: 'idle', startedAt: 0, lastProgressAt: 0 }
      const cur = (state && state.current) || { target: null, state: 'idle', label: '空闲', detail: null, startedAt: 0 }
      const retry = state && state.retry ? state.retry : null
      const req = state && state.request ? state.request : null
      const staleMs = run.status === 'running' && run.lastProgressAt ? now - run.lastProgressAt : 0
      const stale = run.status === 'running' && staleMs > 60 * 1000
      const agoMs = run.lastProgressAt ? now - run.lastProgressAt : null
      const curElapsed = cur.startedAt ? now - cur.startedAt : 0
      const totalElapsed = run.status === 'running' && run.startedAt ? now - run.startedAt : 0

      // 徽标（label 以 Host 为准 + 状态圆点）——Host 是唯一事实源，客户端不再自己编一套文案
      // v0.5.0：state 名换成四段口径（analyzing/thinking/outputting/tool-running/reading-result…）
      const phaseSrc = (state && state.phaseSource) || null
      const DOT_BY_STATE = {
        'working': 'working', 'tool-running': 'working', 'reading-result': 'working',
        'analyzing': 'waiting', 'thinking': 'thinking', 'outputting': 'streaming',
        'tool-args': 'toolargs', 'retry-wait': 'retry', 'error': 'error',
      }
      const toolOf = () => {
        if (state && state.toolName) return String(state.toolName)
        return String(cur.label || '').replace(/^准备调用\s*/, '').replace(/^运行\s*/, '') || '—'
      }
      const stageText = (st) => {
        const ch = charsOf(state && state.chars)
        if (st === 'analyzing') return L.analyzing
        if (st === 'thinking') return L.thinking + (ch ? ' · ' + ch : '')
        if (st === 'outputting') return L.outputting + (ch ? ' · ' + ch : '')
        if (st === 'tool-args') return L.toolArgs + ' ' + toolOf()
        if (st === 'tool-running') return L.toolRunning + ' ' + toolOf()
        if (st === 'reading-result') return L.readingResult
        if (st === 'working') return L.working
        if (st === 'retry-wait') return L.retryWait
        if (st === 'error') return L.failed
        if (st === 'idle') return L.idle
        return cur.label || L.working
      }
      const connLost = conn !== 'connected'
      let dotCls = 'working'
      let label = stageText(cur.state)
      let staleNote = ''
      if (connLost) { dotCls = 'waiting'; label = conn === 'reconnecting' ? L.connRecover : L.connLost }
      else if (cur.state === 'idle') { dotCls = ''; label = L.idle }
      else if (cur.state === 'error') { dotCls = 'error'; label = '⚠ ' + (cur.detail || L.failed) }
      else if (cur.state === 'retry-wait') { dotCls = 'retry'; label = L.retryWait }
      else if (stale) { dotCls = 'stale'; staleNote = L.staleNote }
      else { dotCls = DOT_BY_STATE[cur.state] || 'working' }
      // 徽标 = 阶段（含本步字数）+ 阶段耗时；**不带模型名**（Lyon 口径）
      const chipLabel = connLost ? label : (label + staleNote)
      const chipTime = cur.state !== 'idle' ? curElapsed : totalElapsed

      // —— 补充状态（来自 snapshot.steer，真实）——
      const steers = (state && state.steer) || []
      // —— 指令历史（v0.6.0 D）：host 侧 history（**主对话框消息 + 插件指导**）与本地记录合并 ——
      // —— 插话历史（**只含插件发出的插话**）：合并逻辑抽成工厂作用域的纯函数 mergeHist（可测）——
      const runLive = !!(state && state.run && state.run.status === 'running')
      const histView = mergeHist(state && state.history, sent, steers)
      const histShow = histView.slice(-50).reverse()   // host 保留 50 条，界面就展示 50 条（审查 #9）

      // 目标模型标签
      const targetTag = cur.target === 'tool' ? 'TOOL' : cur.target === 'model' ? 'MODEL' : cur.target === 'agent' ? 'AGENT' : ''

      // 两个浮层互斥：整个 header 同时最多一个 overlay
      const openDetail = () => { setShellOpen(false); setShowDetail((v) => !v) }
      const openShell = () => {
        const next = !shellOpen
        setShowDetail(false)
        setShellOpen(next)
        if (next) { setFeedback({ kind: '', msg: '' }); setTimeout(() => { const ta = document.getElementById('dsh-steer-ta'); if (ta) ta.focus() }, 50) }
      }

      const R = React.createElement
      return R('div', { className: 'dsh-steer-wrap', ref: wrapRef },
        // 徽标用 button：拿到键盘焦点 / Enter·Space / disabled 语义（原来是无障碍缺失的 div）
        R('button', { type: 'button', className: 'dsh-steer-chip' + (stale ? ' stale' : ''), onClick: openDetail, title: L.detailTitle },
          R('span', { className: 'dsh-steer-dot ' + dotCls }),
          R('span', { className: 'txt' }, chipLabel),
          conn !== 'connected' ? null : (chipTime > 0 ? R('span', { className: 'time' }, fmtMs(chipTime)) : null),
        ),
        R('button', { type: 'button', className: 'dsh-steer-btn', onClick: openShell, title: L.guideTitle.replace('💬 ', '') }, L.guide),

        showDetail ? R('div', { className: 'dsh-steer-pop', onClick: (e) => e.stopPropagation() },
          R('div', { className: 'dsh-steer-head' },
            R('h4', null, L.curRun + (totalElapsed ? '　' + L.total + ' ' + fmtMs(totalElapsed) : '')),
            R('button', { className: 'x', onClick: () => setShowDetail(false), title: L.close }, '✕')),
          R('div', { className: 'dsh-steer-body' },
          // 当前对象块
          R('div', { className: 'dsh-steer-block' },
            R('div', { className: 'tl' },
              R('span', null, (targetTag ? targetTag + ' · ' : '') + stageText(cur.state)),
              cur.state !== 'idle' ? R('span', { className: 'time' }, fmtMs(curElapsed)) : null),
            R('div', { className: 'st' },
              cur.state === 'analyzing' ? L.dAnalyzing
              : cur.state === 'thinking' ? (L.dThinking + (charsOf(state && state.chars) ? '（' + charsOf(state.chars) + '）' : ''))
              : cur.state === 'outputting' ? (L.dOutputting + (charsOf(state && state.chars) ? '（' + charsOf(state.chars) + '）' : ''))
              : cur.state === 'tool-args' ? (L.dToolArgs + '（' + toolOf() + '）')
              : cur.state === 'tool-running' ? (L.dToolRunning + ' ' + toolOf() + L.toolNoInner)
              : cur.state === 'reading-result' ? L.dReading
              : cur.state === 'retry-wait' ? L.dRetry
              : cur.state === 'error' ? (cur.detail || L.dError)
              : cur.state === 'working' ? (cur.target === 'agent' ? L.dWorkingAgent : L.dWorking)
              : L.dIdle),
            // 最近进展（核心信息）
            R('div', { className: 'dsh-steer-row', style: { marginTop: 6 } },
              R('span', null, L.recent),
              R('span', null, agoMs != null ? fmtAgo(agoMs, L) : '—')),
            stale ? R('div', { className: 'dsh-steer-warn' }, '⚠ ' + L.staleNote.replace(/[（）()]/g, '')) : null,
          ),

          // 请求 / 工具状态
          R('div', { className: 'dsh-steer-row' },
            R('span', null, L.status),
            R('span', null, cur.state === 'idle' ? L.idle : stageText(cur.state))),
          // 模型名 / provider / step —— **只在详情面板出现，徽标不带**（Lyon 口径）
          req && (req.provider || req.model) ? R('div', { className: 'dsh-steer-row' },
            R('span', null, L.model),
            R('span', null, [req.provider, req.model].filter(Boolean).join(' / ')
              + (req.contextWindow ? ' · ' + Math.round(req.contextWindow / 1000) + 'k ctx' : ''))) : null,
          (req && req.turn != null && req.step != null) ? R('div', { className: 'dsh-steer-row' },
            R('span', null, L.step),
            R('span', null, 'T' + req.turn + ' · S' + req.step + (phaseSrc ? ' · ' + phaseSrc : ''))) : null,
          req && req.error ? R('div', { className: 'dsh-steer-row' },
            R('span', null, L.lastErr),
            R('span', null, String(req.error.code || req.error.message || '—'))) : null,
          retry ? R('div', null,
            R('div', { className: 'dsh-steer-row' },
              R('span', null, L.retry),
              R('span', null, '#' + (retry.attempt || 0) + (retry.maxAttempts ? ' / ' + retry.maxAttempts : ''))),
            retry.reason ? R('div', { className: 'dsh-steer-row' },
              R('span', null, L.reason),
              R('span', null, retry.reason)) : null,
            retry.active && retry.delayMs ? R('div', { className: 'dsh-steer-row' },
              R('span', null, L.nextRetry),
              R('span', null, fmtMs(retry.delayMs))) : null,
          ) : null,

          // 语言设置（v0.6.0 C）：自动 / 中文 / English —— 存 host 侧文件，**不用 localStorage**
          R('div', { className: 'dsh-steer-row', style: { marginTop: 10 } },
            R('span', null, L.langLabel),
            R('span', { className: 'dsh-steer-langs' },
              ['auto', 'zh', 'en'].map((v) => R('button', {
                key: v, type: 'button', className: 'lg' + (hostLang === v ? ' on' : ''),
                onClick: () => {
                  fetch('/dsh-steer/lang', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ lang: v }),
                  }).then((r) => r.json()).then((d) => {
                    if (d && d.ok) {
                      setState((prev) => (prev ? Object.assign({}, prev, { lang: d.lang }) : prev))
                      // 写盘失败要如实说（审查 #8）：不能让用户以为已保存
                      setFeedback(d.persisted === false ? { kind: 'err', msg: L.langNotSaved } : { kind: '', msg: '' })
                    }
                  }).catch(() => { /* 切换失败保持原语言 */ })
                },
              }, v === 'auto' ? L.langAuto : (v === 'zh' ? '中文' : 'English'))))),

          connLost ? R('div', { className: 'dsh-steer-conn' },
            conn === 'reconnecting' ? L.connRecover : L.connLost) : null),
        ) : null,

        shellOpen ? R('div', { className: 'dsh-steer-shell', onClick: (e) => e.stopPropagation() },
          R('div', { className: 'dsh-steer-head' },
            R('h4', null, L.guideTitle),
            R('button', { className: 'x', onClick: () => { setShellOpen(false); setFeedback({ kind: '', msg: '' }) }, title: L.close }, '✕')),
          R('div', { className: 'dsh-steer-body' },
            R('div', { className: 'dsh-steer-hint' + (cur.state === 'idle' ? ' idle' : '') },
              cur.state === 'idle' ? L.guideHintIdle : L.guideHint),
            R('textarea', {
              id: 'dsh-steer-ta', value: text, onChange: onTextChange, onKeyDown: onKeyDown,
              placeholder: L.placeholder,
              onPaste: (e) => {
                const fl = (e.clipboardData && e.clipboardData.files) || []
                if (fl && fl.length) addFiles(fl)   // 不 preventDefault：有文字时也让它正常落进输入框
              },
            }),
            R('input', {
              id: 'dsh-steer-file', type: 'file', multiple: true, style: { display: 'none' },
              onChange: (e) => { addFiles(e.target.files); e.target.value = '' },
            }),
            files.length ? R('div', { className: 'dsh-steer-files' },
              files.map((f, i) => R('span', { key: i, className: 'f', title: f.name },
                (f.kind === 'image' ? '🖼 ' : '📄 ') + f.name + ' (' + Math.max(1, Math.round(f.size / 1024)) + 'KB)',
                R('span', { className: 'x', onClick: () => setFiles((prev) => prev.filter((_, j) => j !== i)) }, '✕')))) : null,
            R('div', { className: 'dsh-steer-actions' },
              R('button', {
                type: 'button', className: 'dsh-steer-icon', title: L.attach,
                onClick: () => { const el = document.getElementById('dsh-steer-file'); if (el) el.click() },
              }, '📎'),
              R('span', { className: 'dsh-steer-status ' + feedback.kind },
                sending ? L.sending : (feedback.msg || (text ? L.draftSaved : ''))),
              R('button', { className: 'dsh-steer-ghost', onClick: () => { setShellOpen(false); setFeedback({ kind: '', msg: '' }) } }, L.cancel),
              R('button', { className: 'dsh-steer-send', disabled: sending || (!text.trim() && files.length === 0) || cur.state === 'idle', onClick: () => send(), title: cur.state === 'idle' ? L.guideHintIdle : 'Cmd/Ctrl + Enter' }, sending ? '…' : L.send)),
            // 插话历史（**只含插件发出的插话**）：附件给缩略图，点开即看（不再只显示 attachment 字样）
            R('div', { className: 'dsh-steer-hist' },
              R('div', { className: 'cap' },
                R('span', null, L.historyCap),
                R('span', { className: 'meta' }, histShow.length ? L.histMeta.replace('{n}', histShow.length) : '')),
              histShow.length ? R('div', { className: 'list' }, histShow.map((it) => {
                const { bad, unread, cls, mark, markTip } = markOf(it, L, runLive)
                const refill = () => { setText(it.text === SEE_ATT ? '' : (it.text || '')); setTimeout(() => { const ta = document.getElementById('dsh-steer-ta'); if (ta) ta.focus() }, 30) }
                const atts = Array.isArray(it.atts) ? it.atts : []
                const attsNode = atts.length ? R('span', { className: 'atts', title: L.viewAtt },
                  atts.map((a) => (a.type === 'image'
                    ? R('img', {
                      key: a.id, className: 'thumb', src: attUrl(a.id), alt: a.name || '',
                      onClick: (e) => { e.stopPropagation(); setViewer({ url: attUrl(a.id), name: a.name || '' }) },
                    })
                    : R('span', {
                      key: a.id, className: 'afile', title: a.name || '',
                      onClick: (e) => { e.stopPropagation(); setViewer({ url: attUrl(a.id), name: a.name || '' }) },
                    }, '📄')))) : null
                return R('div', { key: it.key, className: 'it' },
                  R('span', { className: 'st ' + cls }, it.status === 'claimed' ? '✓' : (bad || unread) ? '✗' : '·'),
                  R('span', { className: 'tm' }, new Date(it.at).toTimeString().slice(0, 5)),
                  attsNode,
                  R('span', { className: 'tx', title: (it.text === SEE_ATT ? L.seeAtt : (it.text || '')) + ' · ' + L.tooltipRefill, onClick: refill },
                    it.text === SEE_ATT ? L.seeAtt : (it.text || L.noText)),
                  R('span', { className: 'mk ' + cls, title: markTip }, mark),
                  (bad || unread) ? R('button', {
                    className: 're', title: L.resend,
                    onClick: (e) => {
                      e.stopPropagation()
                      const t = (it.text === SEE_ATT || it.text === L.seeAtt) ? '' : (it.text || '')
                      send(t, (it.atts || []).map((a) => a.id))   // 原样带上附件，不再丢图（审查 #7）
                    },
                  }, L.resend) : null)
              })) : R('div', { className: 'empty' }, '—')),
          )) : null,

        // 附件查看器：点缩略图 / 文件名 → 全屏看图（点空白或 Esc 关闭）
        viewer ? R('div', { className: 'dsh-steer-viewer', onClick: () => setViewer(null) },
          R('img', { src: viewer.url, alt: viewer.name || '' }),
          R('button', { className: 'vb', onClick: () => setViewer(null) }, L.close)) : null,
      )
    }

    const inject = ['slots']

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      ctx.effect(() => slots.inject('conversation.session.header.actions', () => slots.register(
        { name: 'conversation.session.header.actions', id: 'dsh-steer', order: 30, label: '插话/状态' },
        (props) => React.createElement(SteerControl, { sessionId: props.sessionId }),
      )), 'dsh-steer: header control')
    }

    exports.apply = apply
    exports.inject = inject
    // 供 tests/ 使用的纯函数钩子（不影响插件挂载）
    exports.__test = { STR, ERR, SEE_ATT, cleanGuide, mergeHist, markOf, fmtAgo, fmtMs }
    return module.exports
  },
})
