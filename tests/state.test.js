// dsh-steer 单元测试：纯函数 / 可注入 ctx 的辅助（零依赖，node --test）
// 运行：node --test tests/
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  fmtChars, turnStepOf, beginStep, setRequest, toolSummary,
  bodyCapFor, makeGuidanceMessage, admitAttachments,
} from '../lib/index.js'

test('fmtChars：0 → null，<1000 → N 字，≥1000 → N.Nk 字', () => {
  assert.equal(fmtChars(0), null)
  assert.equal(fmtChars(999), '999 字')
  assert.equal(fmtChars(1000), '1.0k 字')
  assert.equal(fmtChars(1200), '1.2k 字')
})

test('turnStepOf：data 优先、顶层兜底、缺省 null', () => {
  assert.deepEqual(turnStepOf({ data: { turn: 2, step: 3 } }), { turn: 2, step: 3 })
  assert.deepEqual(turnStepOf({ turn: 4, step: 5 }), { turn: 4, step: 5 })
  assert.deepEqual(turnStepOf({}), { turn: null, step: null })
  assert.deepEqual(turnStepOf(null), { turn: null, step: null })
})

test('beginStep：同一步保持计数，换步必须归零（v0.5.0 的硬 bug 回归）', () => {
  const s = {}
  beginStep(s, 2, 3)
  assert.equal(s.step.key, '2:3')
  assert.equal(s.step.chars, 0)
  s.step.chars = 1234            // 本步累计
  const same = beginStep(s, 2, 3)
  assert.equal(same.chars, 1234, '同一步不得清零')
  const next = beginStep(s, 2, 4)
  assert.equal(next.key, '2:4')
  assert.equal(next.chars, 0, '换步必须归零')
})

test('beginStep：拿不到 turn/step 时视为新步（不会中途误清零）', () => {
  const s = {}
  beginStep(s, 2, 3)
  s.step.chars = 50
  const st = beginStep(s, null, null)
  assert.equal(st.key, null)
  assert.equal(st.chars, 0)
})

test('setRequest：默认值齐全，且绝不被 undefined 覆盖（步标识必须保住）', () => {
  const s = {}
  setRequest(s, { turn: 2, step: 3 })
  setRequest(s, { lastProgressAt: 99 })          // 不传 turn/step
  assert.equal(s.request.turn, 2, 'turn 不能被 undefined 抹掉')
  assert.equal(s.request.step, 3)
  assert.equal(s.request.lastProgressAt, 99)
  assert.equal(s.request.provider, null)
  setRequest(s, { turn: 7 })
  assert.equal(s.request.turn, 7)
  assert.equal(s.request.step, 3, '未提供的字段保持原值')
})

test('toolSummary：bash 取 description/command，半截 JSON 必须安全返回 null', () => {
  assert.equal(toolSummary('bash', JSON.stringify({ description: 'List files' })), 'List files')
  assert.equal(toolSummary('bash', JSON.stringify({ command: 'git status\nsecond' })), 'git status')
  assert.equal(toolSummary('bash', '{"description":"半截没收尾"'), null, '半截 JSON 不能抛')
  assert.equal(toolSummary('bash', 'not json'), null)
  assert.equal(toolSummary('read', JSON.stringify({ description: 'x' })), null, '非 bash 不给摘要')
  const long = 'a'.repeat(60)
  assert.equal(toolSummary('bash', JSON.stringify({ description: long })).length, 24)
})

test('bodyCapFor：无 attachments 服务用兜底上限；有 imageLimits 按其换算，且被 48MB 封顶', () => {
  assert.equal(bodyCapFor({ get: () => undefined }), 48 * 1024 * 1024)
  const ctx = { get: () => ({ imageLimits: { maxMessageImageBytes: 1000 } }) }
  assert.equal(bodyCapFor(ctx), Math.ceil(1000 * 4 / 3 * 1.2) + 3 * 1024)
  // 宿主实测 maxMessageImageBytes = 200MB → 不封顶会算出 320MB（审查发现的隐患）
  const real = { get: () => ({ imageLimits: { maxMessageImageBytes: 209715200 } }) }
  assert.equal(bodyCapFor(real), 48 * 1024 * 1024, '必须封顶到 48MB')
})

test('makeGuidanceMessage：文字在前、附件在后，kind 固定为 dsh-steer', () => {
  const m = makeGuidanceMessage('别改数据库')
  assert.match(m.id, /^msg-/)
  assert.equal(m.role, 'user')
  assert.equal(m.source.kind, 'dsh-steer')
  assert.equal(m.source.form, 'guidance')
  assert.equal(m.content.length, 1)
  assert.equal(m.content[0].type, 'text')
  assert.match(m.content[0].text, /运行中指导/)
  assert.match(m.content[0].text, /别改数据库/)

  const img = { type: 'image', attachment: { attachmentId: 'a1' } }
  const m2 = makeGuidanceMessage('看这个', [img])
  assert.equal(m2.content.length, 2)
  assert.deepEqual(m2.content[1], img)
})

test('admitAttachments：拿不到服务必须抛 no-attachments（不静默降级）', async () => {
  await assert.rejects(
    () => admitAttachments({ get: () => undefined }, [{ kind: 'image', dataBase64: 'AA==' }]),
    (e) => e.code === 'no-attachments',
  )
})

test('admitAttachments：图片走 saveImages（批量）、文件走 admitEncodedFile，顺序图片在前', async () => {
  const calls = { images: [], files: [] }
  const ctx = {
    get: () => ({
      imageLimits: { maxMessageImageBytes: 1000 },
      async saveImages(inputs) {
        calls.images.push(inputs)
        return inputs.map((_, i) => ({ attachmentId: 'img' + i, mediaType: 'image/png', bytes: 3, width: 1, height: 1 }))
      },
      async admitEncodedFile(input) {
        calls.files.push(input)
        return { attachmentId: 'f0', name: input.name, bytes: 3 }
      },
    }),
  }
  const out = await admitAttachments(ctx, [
    { kind: 'image', mediaType: 'image/png', name: 'a.png', dataBase64: Buffer.from('abc').toString('base64') },
    { kind: 'file', name: 'log.txt', dataBase64: Buffer.from('xyz').toString('base64') },
    { kind: 'image', name: 'empty.png', dataBase64: '' },   // 空数据必须被跳过
  ])
  assert.equal(calls.images.length, 1)
  assert.equal(calls.images[0].length, 1, '空数据的附件不得进入批量')
  assert.ok(calls.images[0][0].data instanceof Uint8Array, '图片必须是字节而不是 base64 字符串')
  assert.equal(calls.files.length, 1)
  assert.equal(calls.files[0].name, 'log.txt')
  assert.equal(out.length, 2)
  assert.equal(out[0].type, 'image')
  assert.equal(out[1].type, 'file')
  assert.equal(out[0].attachment.attachmentId, 'img0')
})
