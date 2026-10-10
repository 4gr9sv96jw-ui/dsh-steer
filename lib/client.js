// dsh-steer — Client 半区（0.2.0-rc.2 版：运行诊断面板 + 官方 admission 插话）
// 注册进 conversation.session.header.actions。
// 原则：秒级更新时间，事件级更新状态，正常极安静，长时间无进展/错误/重试/断线时突出异常。
// 时间全部本地计算（收到 startedAt / current.startedAt / lastProgressAt / serverTime 差值）；
// 状态由 Host Runtime Snapshot 推送（状态变化才推）。
// 插话不再手搓消息：POST /dsh-steer/steer 由 Host 转官方 sessionController.prompt
// （steer=并入最近步骤边界 / queue=排到下一轮），与 GUI 队列栏同一通道。
window.__ModuleLoader__.load({
  id: '@lyonlee/dsh-steer',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')

    const TAG_ID = 'dsh-steer/panel.css'
    const CSS = [
      '.dsh-steer-wrap { display:flex; align-items:center; gap:6px; position:relative; }',
      '.dsh-steer-chip { display:flex; align-items:center; gap:6px; background: var(--dsw-alias-bg-layer-2); border:1px solid var(--dsw-alias-border-l1); border-radius:8px; padding:3px 9px; font-size:12px; cursor:pointer; color: var(--dsw-alias-label-primary); }',
      '.dsh-steer-chip:hover { border-color: var(--dsw-static-blue-450); }',
      '.dsh-steer-dot { width:8px; height:8px; border-radius:50%; background:#555b68; flex-shrink:0; }',
      '.dsh-steer-dot.working { background:#e0a13c; }',
      '.dsh-steer-dot.thinking { background:#a98cf0; animation: dsh-steer-breathe 2.6s ease-in-out infinite; }',
      '.dsh-steer-dot.toolargs { background:#e0a13c; animation: dsh-steer-blink 1.4s infinite; }',
      '@keyframes dsh-steer-breathe { 0%,100%{opacity:1} 50%{opacity:.45} }',
      '.dsh-steer-dot.streaming { background:#7ecb8e; }',
      '.dsh-steer-dot.waiting { background:#8fb4e8; animation: dsh-steer-blink 1.2s infinite; }',
      '.dsh-steer-dot.retry { background:#d9a441; animation: dsh-steer-pulse 1s infinite; }',
      '.dsh-steer-dot.error { background:#e06060; animation: dsh-steer-pulse 1s infinite; }',
      '.dsh-steer-dot.stale { background:#e06060; }',
      '@keyframes dsh-steer-pulse { 0%,100%{opacity:1} 50%{opacity:.3} }',
      '@keyframes dsh-steer-blink { 0%,100%{opacity:1} 50%{opacity:.35} }',
      '.dsh-steer-chip .txt { white-space:nowrap; max-width:180px; overflow:hidden; text-overflow:ellipsis; }',
      '.dsh-steer-chip .time { color: var(--dsw-alias-label-tertiary); font-size:11px; font-variant-numeric: tabular-nums; }',
      '.dsh-steer-chip.stale { border-color:#e06060; color:#ffb3b3; }',
      '.dsh-steer-btn { background: var(--dsw-alias-bg-layer-2); border:1px solid var(--dsw-alias-border-l1); border-radius:8px; padding:3px 10px; font-size:12px; cursor:pointer; color: var(--dsw-alias-label-primary); }',
      '.dsh-steer-btn:hover { border-color: var(--dsw-static-blue-450); }',
      '.dsh-steer-pop { position:fixed; top:44px; right:16px; width:340px; background: var(--dsw-alias-bg-overlay); border:1px solid var(--dsw-alias-border-l1); border-radius:10px; padding:10px 12px; z-index:1000; box-shadow:0 8px 24px rgba(0,0,0,.45); }',
      '.dsh-steer-pop h4 { font-size:12px; margin:0 0 8px; color: var(--dsw-alias-label-primary); }',
      '.dsh-steer-pop .close { position:absolute; top:6px; right:8px; background:none; border:none; color:var(--dsw-alias-label-tertiary); cursor:pointer; font-size:12px; padding:2px 4px; }',
      '.dsh-steer-block { border:1px solid var(--dsw-alias-border-l1); border-radius:8px; padding:8px 10px; margin-bottom:8px; }',
      '.dsh-steer-block .tl { display:flex; justify-content:space-between; align-items:baseline; font-size:12px; color: var(--dsw-alias-label-primary); }',
      '.dsh-steer-block .tl .time { color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; }',
      '.dsh-steer-block .st { font-size:11px; color: var(--dsw-alias-label-tertiary); margin-top:2px; }',
      '.dsh-steer-row { display:flex; justify-content:space-between; font-size:11px; color: var(--dsw-alias-label-tertiary); margin-bottom:3px; }',
      '.dsh-steer-row b { color: var(--dsw-alias-label-primary); font-weight:600; }',
      '.dsh-steer-warn { font-size:11px; color:#ff9a6a; margin-top:6px; padding-left:2px; }',
      '.dsh-steer-err { font-size:11px; color:#ff9a9a; margin-top:6px; }',
      '.dsh-steer-sub { font-size:11px; color: var(--dsw-alias-label-tertiary); margin-top:6px; }',
      '.dsh-steer-sub .it { display:flex; gap:6px; margin:3px 0; }',
      '.dsh-steer-sub .ok { color:#7ecb8e; flex-shrink:0; }',
      '.dsh-steer-sub .pending { color:var(--dsw-alias-label-tertiary); flex-shrink:0; }',
      '.dsh-steer-sub .drop { color:#ff9a9a; flex-shrink:0; }',
      '.dsh-steer-sub .tx { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }',
      '.dsh-steer-conn { font-size:11px; color:var(--dsw-alias-label-tertiary); margin-top:8px; }',
      '.dsh-steer-shell { position:fixed; top:52px; right:16px; width:340px; background: var(--dsw-alias-bg-overlay); border:1px solid var(--dsw-static-blue-450); border-radius:10px; padding:12px; z-index:1001; box-shadow:0 10px 30px rgba(0,0,0,.5); }',
      '.dsh-steer-shell h4 { font-size:13px; margin:0 0 6px; color: var(--dsw-alias-label-primary); }',
      '.dsh-steer-shell .hint { font-size:11px; color: var(--dsw-alias-label-tertiary); margin-bottom:6px; }',
      '.dsh-steer-shell .hint.idle { color:#8fb4e8; }',
      '.dsh-steer-shell .hint.warnmode { color:#e0a13c; }',
      '.dsh-steer-modes { display:flex; gap:6px; margin:2px 0 8px; }',
      '.dsh-steer-mode { flex:1; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-tertiary); border:1px solid var(--dsw-alias-border-l1); border-radius:7px; padding:4px 8px; font-size:12px; cursor:pointer; }',
      '.dsh-steer-mode.on { border-color: var(--dsw-static-blue-450); color: var(--dsw-alias-label-primary); }',
      '.dsh-steer-shell textarea { width:100%; min-height:64px; background: var(--dsw-alias-bg-layer-1); border:1px solid var(--dsw-alias-border-l1); border-radius:8px; color: var(--dsw-alias-label-primary); padding:8px 10px; font-size:14px; resize:vertical; box-sizing:border-box; font-family:inherit; }',
      '.dsh-steer-shell textarea:focus { outline:none; border-color: var(--dsw-static-blue-450); }',
      '.dsh-steer-shell .savebox { font-size:11px; color:var(--dsw-alias-label-tertiary); margin:6px 0 0; }',
      '.dsh-steer-shell .row { display:flex; justify-content:flex-end; gap:8px; margin-top:8px; align-items:center; }',
      '.dsh-steer-status { font-size:11px; color: var(--dsw-alias-label-tertiary); flex:1; text-align:left; }',
      '.dsh-steer-status.ok { color:#7ecb8e; }',
      '.dsh-steer-status.err { color:#ff9a9a; }',
      '.dsh-steer-ghost { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-tertiary); border:1px solid var(--dsw-alias-border-l1); border-radius:7px; padding:4px 12px; font-size:12px; cursor:pointer; }',
      '.dsh-steer-send { background: var(--dsw-static-blue-450); color:#fff; border:none; border-radius:7px; padding:4px 14px; font-size:12px; cursor:pointer; }',
      '.dsh-steer-send:disabled { opacity:.5; cursor:default; }',
    ].join('\n')
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(TAG_ID) + ']') === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-steer'
      tag.dataset.pluginCss = TAG_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
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
    function fmtAgo(ms) {
      if (ms == null || !isFinite(ms)) return '未知'
      const s = Math.max(0, Math.floor(ms / 1000))
      if (s < 5) return '刚刚'
      if (s < 60) return s + ' 秒前'
      const m = Math.floor(s / 60)
      if (m < 60) return m + ' 分钟前'
      const h = Math.floor(m / 60)
      return h + ' 小时前'
    }
    function fmtDurSec(s) {
      if (s == null || !isFinite(s)) return '—'
      if (s < 60) return Math.floor(s) + ' 秒'
      const m = Math.floor(s / 60); const ss = Math.floor(s % 60)
      if (m < 60) return m + ':' + String(ss).padStart(2, '0')
      const h = Math.floor(m / 60)
      return h + ' 小时 ' + String(m % 60) + ' 分'
    }

    function SteerControl(props) {
      const sessionId = props.sessionId
      const [state, setState] = React.useState(null)
      const [conn, setConn] = React.useState('connecting')
      const [showDetail, setShowDetail] = React.useState(false)
      const [shellOpen, setShellOpen] = React.useState(false)
      const [text, setText] = React.useState('')
      // 投递方式：queue = 排队引导（默认，Codex 式，不打断）；steer = 并入当前回合下一步
      const [mode, setMode] = React.useState('queue')
      const [feedback, setFeedback] = React.useState({ kind: '', msg: '' })
      const [sending, setSending] = React.useState(false)
      const [lastMsgId, setLastMsgId] = React.useState(null)
      const [now, setNow] = React.useState(Date.now())

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
      const onTextChange = (e) => {
        const v = e.target.value
        setText(v)
        try { window.sessionStorage.setItem(draftKey, v) } catch { /* ignore */ }
      }

      const send = () => {
        const trimmed = text.trim()
        if (!trimmed || sending) return
        setSending(true); setFeedback({ kind: 'info', msg: '发送中…' })
        fetch('/dsh-steer/steer', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, text: trimmed, mode }),
        }).then((r) => r.json()).then((d) => {
          if (d && d.ok) {
            setLastMsgId(d.messageId)
            // 真话：只承诺 Host 已接收（官方 admission）；已读取由 Host 经 inbox/claimed 回写 snapshot.steer
            setFeedback({ kind: 'ok', msg: d.mode === 'steer' ? '已插话：并入当前回合下一步' : '已排队：本轮结束后立刻生效' })
            try { window.sessionStorage.removeItem(draftKey) } catch { /* ignore */ }
            setText(''); setShellOpen(false); setSending(false)
          } else {
            // 失败：不清草稿、不关闭、可重发
            setFeedback({ kind: 'err', msg: (d && d.error) || '发送失败' })
            setSending(false)
          }
        }).catch(() => { setFeedback({ kind: 'err', msg: '发送失败（网络错误）' }); setSending(false) })
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
      const DOT_BY_STATE = {
        'working': 'working', 'requesting': 'working', 'tool-running': 'working',
        'reasoning': 'thinking', 'streaming': 'streaming', 'tool-args': 'toolargs',
        'waiting-first-response': 'waiting', 'retry-wait': 'retry', 'error': 'error',
      }
      let dotCls = 'working'
      let label = cur.label || '工作中'
      if (conn !== 'connected') { dotCls = 'waiting'; label = '状态未知' }
      else if (cur.state === 'idle') { dotCls = ''; label = '空闲' }
      else if (cur.state === 'error') { dotCls = 'error'; label = '⚠ ' + (cur.label || '出错') }
      else if (cur.state === 'retry-wait') { dotCls = 'retry'; label = cur.label || '等待重试' }
      else if (stale) { dotCls = 'stale'; label = '无新进展' }
      else { dotCls = DOT_BY_STATE[cur.state] || 'working'; label = cur.label || '工作中' }
      // 阶段细节（思考/输出字数）只在运行态贴到徽标上
      const chipLabel = (conn === 'connected' && !stale && cur.state !== 'idle' && cur.detail) ? (label + ' · ' + cur.detail) : label
      const chipTime = cur.state !== 'idle' ? curElapsed : totalElapsed

      // —— 补充状态（来自 snapshot.steer，真实）——
      const steers = (state && state.steer) || []
      const lastSteer = lastMsgId ? steers.find((x) => x.id === lastMsgId) : null
      const readState = lastSteer ? lastSteer.status : null

      // 目标模型标签
      const targetTag = cur.target === 'tool' ? 'TOOL' : cur.target === 'model' ? 'MODEL' : cur.target === 'agent' ? 'AGENT' : ''

      const openDetail = () => setShowDetail(!showDetail)
      const openShell = () => {
        setShellOpen(!shellOpen)
        if (!shellOpen) { setFeedback({ kind: '', msg: '' }); setTimeout(() => { const ta = document.getElementById('dsh-steer-ta'); if (ta) ta.focus() }, 50) }
      }

      const R = React.createElement
      return R('div', { className: 'dsh-steer-wrap' },
        R('div', { className: 'dsh-steer-chip' + (stale ? ' stale' : ''), onClick: openDetail, title: '运行状态诊断' },
          R('span', { className: 'dsh-steer-dot ' + dotCls }),
          R('span', { className: 'txt' }, chipLabel),
          conn !== 'connected' ? null : (chipTime > 0 ? R('span', { className: 'time' }, fmtMs(chipTime)) : null),
        ),
        R('button', { className: 'dsh-steer-btn', onClick: openShell }, '💬 插话'),

        showDetail ? R('div', { className: 'dsh-steer-pop', onClick: (e) => e.stopPropagation() },
          R('button', { className: 'close', onClick: () => setShowDetail(false) }, '✕'),
          R('h4', null, '当前运行' + (totalElapsed ? '　总计 ' + fmtMs(totalElapsed) : '')),

          // 当前对象块
          R('div', { className: 'dsh-steer-block' },
            R('div', { className: 'tl' },
              R('span', null, (targetTag ? targetTag + ' · ' : '') + (cur.label || '空闲')),
              cur.state !== 'idle' ? R('span', { className: 'time' }, fmtMs(curElapsed)) : null),
            R('div', { className: 'st' },
              cur.state === 'reasoning' ? ('模型推理中' + (cur.detail ? '（已 ' + cur.detail + '）' : '') + ' — 实时来自官方 assistant-stream')
              : cur.state === 'streaming' ? ('正在输出回答' + (cur.detail ? '（已 ' + cur.detail + '）' : ''))
              : cur.state === 'tool-args' ? ('正在生成工具调用参数（' + (cur.label || '').replace('准备调用 ', '') + '）')
              : cur.state === 'waiting-first-response' ? '模型请求已发出，尚未收到首个增量'
              : cur.state === 'tool-running' ? '工具运行中（DSH 不暴露工具内部进度）'
              : cur.state === 'retry-wait' ? '模型请求失败，等待重试'
              : cur.state === 'error' ? (cur.detail || '发生错误')
              : cur.state === 'requesting' ? '处理结果'
              : cur.state === 'working' ? (cur.target === 'agent' ? 'Agent 正在处理' : '处理中')
              : 'Agent 当前空闲'),
            // 最近进展（核心信息）
            R('div', { className: 'dsh-steer-row', style: { marginTop: 4 } },
              R('span', null, '最近进展'),
              R('span', null, agoMs != null ? fmtAgo(agoMs) : '—')),
            stale ? R('div', { className: 'dsh-steer-warn' }, '⚠ 长时间没有观察到新的有效进展') : null,
          ),

          // 请求 / 工具状态
          R('div', { className: 'dsh-steer-row' },
            R('span', null, '状态'),
            R('span', null, cur.state === 'idle' ? '空闲' : (cur.label || '—'))),
          req && req.error ? R('div', { className: 'dsh-steer-row' },
            R('span', null, '最近错误'),
            R('span', null, String(req.error.code || req.error.message || '—'))) : null,
          retry ? R('div', null,
            R('div', { className: 'dsh-steer-row' },
              R('span', null, '重试'),
              R('span', null, '第 ' + (retry.attempt || 0) + (retry.maxAttempts ? ' / ' + retry.maxAttempts : '') + ' 次')),
            retry.reason ? R('div', { className: 'dsh-steer-row' },
              R('span', null, '原因'),
              R('span', null, retry.reason)) : null,
            retry.active && retry.delayMs ? R('div', { className: 'dsh-steer-row' },
              R('span', null, '下次重试'),
              R('span', null, fmtMs(retry.delayMs) + ' 后')) : null,
          ) : null,

          // 我的补充
          steers.length ? R('div', { className: 'dsh-steer-sub' }, '我的补充',
            steers.slice(-6).map((it) => {
              const bad = it.status === 'discarded' || it.status === 'rejected'
              return R('div', { key: it.id, className: 'it' },
                R('span', { className: it.status === 'claimed' ? 'ok' : bad ? 'drop' : 'pending' },
                  it.status === 'claimed' ? '✓' : bad ? '✗' : '·'),
                R('span', { className: 'tx', title: it.text }, it.text))
            })) : null,

          conn !== 'connected' ? R('div', { className: 'dsh-steer-conn' },
            conn === 'reconnecting' ? '○ 状态连接正在恢复…' : '○ 状态未知（连接异常）') : null,
        ) : null,

        shellOpen ? R('div', { className: 'dsh-steer-shell', onClick: (e) => e.stopPropagation() },
          R('h4', null, '💬 补充 / 引导'),
          // 投递方式：默认「引导」= 排队（Codex 式），不打断；「插话」= 并入当前回合下一步
          R('div', { className: 'dsh-steer-modes' },
            R('button', {
              className: 'dsh-steer-mode' + (mode === 'queue' ? ' on' : ''),
              onClick: () => setMode('queue'),
            }, '引导（排队）'),
            R('button', {
              className: 'dsh-steer-mode' + (mode === 'steer' ? ' on' : ''),
              onClick: () => setMode('steer'),
            }, '插话（立即）'),
          ),
          cur.state === 'idle' ?
            R('div', { className: 'hint idle' }, 'Agent 空闲：立即作为新输入起一轮。')
            : (mode === 'queue'
              ? R('div', { className: 'hint' }, '像 Codex 那样排队引导：当前这一步先跑完，结束后立刻按你这句走 —— 不打断。')
              : R('div', { className: 'hint warnmode' }, '并入当前回合的最近步骤边界：会改变这一回合的方向（等同官方队列栏的「插话」），但不打断正在跑的工具调用。')),
          R('textarea', { id: 'dsh-steer-ta', value: text, onChange: onTextChange, onKeyDown: onKeyDown, placeholder: '补充你的意思，或纠正理解…' }),
          R('div', { className: 'savebox' }, sending ? '发送中…' : (text ? '已存为草稿' : '')),
          R('div', { className: 'row' },
            R('span', { className: 'dsh-steer-status ' + feedback.kind }, feedback.msg),
            R('button', { className: 'dsh-steer-ghost', onClick: () => { setShellOpen(false); setFeedback({ kind: '', msg: '' }) } }, '取消'),
            R('button', { className: 'dsh-steer-send', disabled: sending || !text.trim(), onClick: send }, sending ? '…' : '发送')),
          readState === 'claimed' ? R('div', { className: 'hint', style: { color: '#7ecb8e' } }, '✓ Agent 已读取') :
            readState === 'inserted' ? R('div', { className: 'hint' }, '已送达，等待读取…') :
              readState === 'sending' ? R('div', { className: 'hint' }, '投递中…') :
                readState === 'rejected' ? R('div', { className: 'hint', style: { color: '#ff9a9a' } }, '✗ Host 拒绝了这次投递') :
                  readState === 'discarded' ? R('div', { className: 'hint', style: { color: '#ff9a9a' } }, '未被读取') : null,
        ) : null,
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
    return module.exports
  },
})
