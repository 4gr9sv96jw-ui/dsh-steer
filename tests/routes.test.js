// dsh-steer 路由测试：真实 handler（stub ctx / req / res），零依赖
// 覆盖：403 / 415 / 400(invalid json) / 400(missing content) / 400(mode-removed) / 409 / 413 / 501 / 400(附件被拒) / 200
// 运行：node --test tests/
import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, bodyCapFor } from '../lib/index.js'

const LOOP = { remoteAddress: '127.0.0.1' }
const SID = 's1'

function makeCtx({ attachments, sessionController, live = true } = {}) {
  const registered = []
  const steered = []
  const ctx = {
    get: (k) => (k === 'attachments' ? attachments : (k === 'sessionController' ? sessionController : undefined)),
    agents: { get: (id) => (live && id === SID ? { steer: (m) => steered.push(m) } : undefined) },
    on: () => () => {},
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    webServer: { register: (r) => { registered.push(r); return () => {} } },
  }
  const dispose = apply(ctx, {})
  return { route: registered[0], steered, dispose }
}

function makeReq({ method = 'POST', url = '/dsh-steer/steer', headers = { 'content-type': 'application/json' }, body = '', socket = LOOP } = {}) {
  return {
    method, url, headers, socket,
    async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(body) },
  }
}

function makeRes() {
  const out = { status: 0, headers: null, body: '' }
  return {
    writeHead(s, h) { out.status = s; out.headers = h },
    write(d) { out.body += d },
    end(d) { if (d) out.body += d },
    on() {},
    _out: out,
  }
}

async function post(route, payload, headers) {
  const res = makeRes()
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload)
  await route.handler(makeReq({ body, headers }), res)
  let json = null
  try { json = JSON.parse(res._out.body) } catch { /* 非 JSON 响应 */ }
  return { status: res._out.status, json }
}

test('非 loopback 一律 403', async () => {
  const { route } = makeCtx()
  const res = makeRes()
  await route.handler(makeReq({ body: '{}', socket: { remoteAddress: '10.0.0.9' } }), res)
  assert.equal(res._out.status, 403)
})

test('content-type 非 JSON → 415', async () => {
  const { route } = makeCtx()
  const r = await post(route, { sessionId: SID, text: 'x' }, { 'content-type': 'text/plain' })
  assert.equal(r.status, 415)
})

test('invalid JSON → 400', async () => {
  const { route } = makeCtx()
  const r = await post(route, '{not json')
  assert.equal(r.status, 400)
  assert.equal(r.json.error, 'invalid json')
})

test('既无 text 又无 attachments → 400', async () => {
  const { route } = makeCtx()
  const r = await post(route, { sessionId: SID })
  assert.equal(r.status, 400)
  assert.equal(r.json.error, 'missing sessionId or content')
})

test('旧 mode=queue → 400 mode-removed', async () => {
  const { route } = makeCtx()
  const r = await post(route, { sessionId: SID, text: 'x', mode: 'queue' })
  assert.equal(r.status, 400)
  assert.equal(r.json.error, 'mode-removed')
})

test('无 live agent → 409（不回退排队）', async () => {
  const { route } = makeCtx({ live: false })
  const r = await post(route, { sessionId: SID, text: 'x' })
  assert.equal(r.status, 409)
  assert.equal(r.json.error, 'no-live-agent')
})

test('请求体超过动态上限 → 413 且报出上限', async () => {
  const attachments = { imageLimits: { maxMessageImageBytes: 1000 } }
  const { route } = makeCtx({ attachments })
  const cap = bodyCapFor({ get: () => attachments })
  const r = await post(route, 'x'.repeat(cap + 100))
  assert.equal(r.status, 413)
  assert.equal(r.json.error, 'payload too large')
  assert.match(r.json.message, /上限 \d+ KB/)
})

test('带附件但宿主无 attachments 服务 → 501（不静默降级成纯文字）', async () => {
  const { route, steered } = makeCtx()
  const r = await post(route, {
    sessionId: SID, text: '看这个',
    attachments: [{ kind: 'image', mediaType: 'image/png', name: 'a.png', dataBase64: 'AA==' }],
  })
  assert.equal(r.status, 501)
  assert.equal(r.json.error, 'no-attachments')
  assert.equal(steered.length, 0, '被拒时绝不能投递')
})

test('带附件且宿主支持 → 200，图片进 content，文字在前', async () => {
  const calls = { images: 0 }
  const attachments = {
    imageLimits: { maxMessageImageBytes: 100000 },
    async saveImages(inputs) {
      calls.images += inputs.length
      return inputs.map((_, i) => ({ attachmentId: 'img' + i, mediaType: 'image/png', bytes: 3, width: 1, height: 1 }))
    },
    async admitEncodedFile(input) { return { attachmentId: 'f0', name: input.name, bytes: 3 } },
    isAttachmentError: () => false,
  }
  const { route, steered } = makeCtx({ attachments })
  const r = await post(route, {
    sessionId: SID, text: '看这个报错',
    attachments: [
      { kind: 'image', mediaType: 'image/png', name: 'a.png', dataBase64: Buffer.from('abc').toString('base64') },
      { kind: 'file', name: 'log.txt', dataBase64: Buffer.from('xyz').toString('base64') },
    ],
  })
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, true)
  assert.equal(r.json.mode, 'guide')
  assert.equal(r.json.attachments, 2)
  assert.equal(calls.images, 1)
  assert.equal(steered.length, 1)
  const msg = steered[0]
  assert.equal(msg.source.kind, 'dsh-steer')
  assert.equal(msg.content[0].type, 'text')
  assert.match(msg.content[0].text, /看这个报错/)
  assert.equal(msg.content[1].type, 'image')
  assert.equal(msg.content[1].attachment.attachmentId, 'img0')
  assert.equal(msg.content[2].type, 'file')
})

test('附件被宿主拒绝（AttachmentError）→ 400 且带宿主错误码', async () => {
  const attachments = {
    imageLimits: { maxMessageImageBytes: 100000 },
    async saveImages() {
      const e = new Error('image too large')
      e.__att = true
      e.code = 'image/too-large'
      throw e
    },
    async admitEncodedFile() { throw new Error('unused') },
    isAttachmentError: (e) => !!(e && e.__att),
  }
  const { route, steered } = makeCtx({ attachments })
  const r = await post(route, {
    sessionId: SID, text: 'x',
    attachments: [{ kind: 'image', mediaType: 'image/png', name: 'big.png', dataBase64: 'AA==' }],
  })
  assert.equal(r.status, 400)
  assert.equal(r.json.error, 'image/too-large')
  assert.equal(steered.length, 0)
})

test('纯文字请求体超过 3KB → 413（即使宿主附件上限是 200MB）—— 审查发现的回归', async () => {
  const attachments = { imageLimits: { maxMessageImageBytes: 209715200 } }   // 宿主实测值
  const { route } = makeCtx({ attachments })
  const r = await post(route, JSON.stringify({ sessionId: SID, text: 'x'.repeat(6000) }))
  assert.equal(r.status, 413, '纯文字不能被附件上限放大')
  assert.match(r.json.message, /纯文字/)
})

test('带 attachments 的请求体可以超过 3KB（不被纯文字上限误杀）', async () => {
  const attachments = {
    imageLimits: { maxMessageImageBytes: 209715200 },
    async saveImages(inputs) { return inputs.map((_, i) => ({ attachmentId: 'i' + i, mediaType: 'image/png', bytes: 1, width: 1, height: 1 })) },
    async admitEncodedFile() { return { attachmentId: 'f', name: 'x', bytes: 1 } },
    isAttachmentError: () => false,
  }
  const { route } = makeCtx({ attachments })
  const r = await post(route, {
    sessionId: SID, text: 'x'.repeat(3500),   // 3500 < STEER_TEXT_MAX(4000)，但 JSON 体 > MAX_BODY(3KB)
    attachments: [{ kind: 'image', mediaType: 'image/png', name: 'a.png', dataBase64: 'AA==' }],
  })
  assert.equal(r.status, 200, '带附件时不该被纯文字上限误杀')
})

test('reuseAtts：重发复用已有附件（不重传字节）→ 200，图片进 content，attIds 回给客户端', async () => {
  const sc = {
    async attachment({ attachmentId }) {
      return { attachment: { attachmentId, mediaType: 'image/webp', bytes: 3, width: 1, height: 1 }, data: 'AA==' }
    },
  }
  const { route, steered } = makeCtx({ sessionController: sc })
  const r = await post(route, { sessionId: SID, text: '重发这条', reuseAtts: ['sha256:abc'] })
  assert.equal(r.status, 200)
  assert.equal(r.json.attachments, 1)
  assert.deepEqual(r.json.attIds, ['sha256:abc'], 'attIds 必须回传，客户端才能再次复用')
  assert.equal(steered[0].content[1].type, 'image')
  assert.equal(steered[0].content[1].attachment.attachmentId, 'sha256:abc')
})

test('reuseAtts 读不回来 → 404 且点名是哪个 id（不静默丢附件）', async () => {
  const sc = { async attachment() { throw new Error('gone') } }
  const { route, steered } = makeCtx({ sessionController: sc })
  const r = await post(route, { sessionId: SID, text: 'x', reuseAtts: ['sha256:dead'] })
  assert.equal(r.status, 404)
  assert.equal(r.json.error, 'reuse-attachment-unreadable')
  assert.match(r.json.message, /sha256:dead/)
  assert.equal(steered.length, 0, '失败时绝不能投递半截消息')
})

test('reuseAtts 但宿主没有 sessionController → 501', async () => {
  const { route } = makeCtx()
  const r = await post(route, { sessionId: SID, text: 'x', reuseAtts: ['a'] })
  assert.equal(r.status, 501)
  assert.equal(r.json.error, 'no-attachment-api')
})

test('纯文字 → 200 且 attachments=0（附件支持不得影响原路径）', async () => {
  const { route, steered } = makeCtx()
  const r = await post(route, { sessionId: SID, text: '别改数据库' })
  assert.equal(r.status, 200)
  assert.equal(r.json.attachments, 0)
  assert.equal(steered[0].content.length, 1)
})
