// dsh-steer 客户端测试（审查 #7）：用最小 stub 求值 lib/client.js，只测工厂作用域的**纯函数**
// 运行：node --test tests/*.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const clientSrc = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')
const hostSrc = readFileSync(join(here, '..', 'lib', 'index.js'), 'utf8')

// —— 最小 stub：只为让 client.js 求值并把 factory 交出来 ——
let loaded = null
const styleTag = { dataset: {}, textContent: '' }
const documentStub = {
  querySelector: () => null,
  createElement: () => styleTag,
  head: { appendChild: () => {} },
}
const ReactStub = {
  createElement: () => null,
  useState: (v) => [v, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
}
const windowStub = { __ModuleLoader__: { load: (m) => { loaded = m } } }
const requireStub = (n) => (n === 'react' ? ReactStub : {})

new Function('window', 'document', 'require', clientSrc)(windowStub, documentStub, requireStub)
const mod = loaded.factory(requireStub)
const T = mod.__test

test('client.js 能在最小 stub 下求值，并暴露 apply / inject / __test', () => {
  assert.ok(loaded && typeof loaded.factory === 'function', '应注册到 ModuleLoader')
  assert.equal(typeof mod.apply, 'function')
  assert.ok(Array.isArray(mod.inject), 'inject 应是数组')
  assert.ok(T && typeof T.cleanGuide === 'function', '应导出 __test 钩子')
})

test('i18n：中英 key 一一对应（无漏翻）', () => {
  assert.deepEqual(Object.keys(T.STR.zh).sort(), Object.keys(T.STR.en).sort())
})

test('错误码表覆盖 host 的每一个 error 码，且英文文案不含中文（英文界面不露中文）', () => {
  const codes = [...hostSrc.matchAll(/error: '([^']+)'/g)].map((m) => m[1])
  assert.ok(codes.length >= 15, `host 错误码应被扫到（实得 ${codes.length}）`)
  for (const c of new Set(codes)) {
    assert.ok(T.ERR.zh[c], `zh 缺错误码文案: ${c}`)
    assert.ok(T.ERR.en[c], `en 缺错误码文案: ${c}`)
    assert.ok(!/[\u4e00-\u9fff]/.test(T.ERR.en[c]), `en 文案不得含中文: ${c}`)
  }
  assert.deepEqual(Object.keys(T.ERR.zh).sort(), Object.keys(T.ERR.en).sort())
})

test('cleanGuide：剥掉 <system-reminder> 框架，只留用户原文', () => {
  const raw = '<system-reminder>\n[运行中指导 · dsh-steer] 别改数据库\n'
    + '（这是对当前任务的补充或纠正：并进后面的步骤、继续把原任务做完；不要当成一个独立的新任务重开。）\n</system-reminder>'
  assert.equal(T.cleanGuide(raw), '别改数据库')
  assert.equal(T.cleanGuide(''), '')
  assert.equal(T.cleanGuide(null), '')
})

test('mergeHist：去重 / 按时间升序 / host 状态优先 / 本地附件 id 归一成对象', () => {
  const host = [
    { id: 'b', at: 200, text: 'second', atts: [{ id: 'img1', type: 'image' }] },
    { id: 'a', at: 100, text: 'first', atts: [] },
  ]
  const sent = [
    { id: 'b', at: 200, text: 'dup', atts: [] },              // 与 host 重复 → 只留一条
    { id: 'c', at: 300, text: 'third', atts: ['img2'] },       // 本地附件存的是 id 字符串
  ]
  const steers = [{ id: 'b', status: 'claimed', claimedTurn: 4, claimedStep: 3, text: 'second' }]
  const out = T.mergeHist(host, sent, steers)
  assert.deepEqual(out.map((x) => x.key), ['a', 'b', 'c'], '按时间升序且按 id 去重')
  assert.equal(out[1].status, 'claimed', 'host 状态优先')
  assert.equal(out[1].claimedTurn, 4)
  assert.deepEqual(out[2].atts, [{ id: 'img2', type: 'image' }], '本地附件 id 应归一成对象')
})

test('markOf：claimed→ok+T·S；discarded→drop；空闲时 inserted→未读；运行中 inserted→已送达', () => {
  const L = T.STR.zh
  const c = T.markOf({ status: 'claimed', claimedTurn: 7, claimedStep: 3 }, L, true)
  assert.equal(c.cls, 'ok')
  assert.equal(c.mark, 'T7·S3')
  assert.match(c.markTip, /已读取/)

  const d = T.markOf({ status: 'discarded' }, L, true)
  assert.equal(d.cls, 'drop')
  assert.equal(d.mark, L.notRead)

  const u = T.markOf({ status: 'inserted' }, L, false)
  assert.equal(u.cls, 'drop')
  assert.equal(u.mark, L.unread)

  const ok = T.markOf({ status: 'inserted' }, L, true)
  assert.equal(ok.cls, 'pending')
  assert.equal(ok.mark, L.delivered)
})

test('fmtMs / fmtAgo 基本行为（含语言参数）', () => {
  assert.equal(T.fmtMs(0), '00:00')
  assert.equal(T.fmtMs(61000), '01:01')
  assert.equal(T.fmtAgo(0, T.STR.zh), T.STR.zh.agoNow)
  assert.equal(T.fmtAgo(null, T.STR.en), T.STR.en.agoUnknown)
})
