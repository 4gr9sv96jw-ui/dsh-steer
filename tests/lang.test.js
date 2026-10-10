// dsh-steer 语言设置测试（v0.6.0 C）：用临时文件 + env 覆盖，**不碰用户真实设置**
// 运行：node --test tests/
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 关键：env 必须在**导入模块之前**设好（LANG_FILE 在模块加载时求值）
const dir = mkdtempSync(join(tmpdir(), 'dsh-steer-lang-'))
const langFile = join(dir, 'dsh-steer.lang')
process.env.DSH_STEER_LANG_FILE = langFile
const { apply } = await import('../lib/index.js')

function makeRoute() {
  const registered = []
  const ctx = {
    get: () => undefined,
    agents: { get: () => undefined },
    on: () => () => {},
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    webServer: { register: (r) => { registered.push(r); return () => {} } },
  }
  apply(ctx, {})
  return registered[0]
}

function call(route, method, body) {
  const out = { status: 0, body: '' }
  const res = {
    writeHead(s) { out.status = s },
    write(d) { out.body += d },
    end(d) { if (d) out.body += d },
    on() {},
  }
  const req = {
    method,
    url: '/dsh-steer/lang',
    headers: { 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(body) },
  }
  return route.handler(req, res).then(() => {
    let json = null
    try { json = JSON.parse(out.body) } catch { /* 非 JSON */ }
    return { status: out.status, json }
  })
}

test('语言文件不存在时 GET → auto（首次运行的默认）', async () => {
  const route = makeRoute()
  const r = await call(route, 'GET')
  assert.equal(r.status, 200)
  assert.equal(r.json.lang, 'auto')
  assert.deepEqual(r.json.langs, ['auto', 'zh', 'en'])
  assert.equal(existsSync(langFile), false, '只读不该创建文件')
})

test('POST en → 落盘 + 回读一致（不用 localStorage，落在 DSH_HOME 小文件）', async () => {
  const route = makeRoute()
  const r = await call(route, 'POST', JSON.stringify({ lang: 'en' }))
  assert.equal(r.status, 200)
  assert.equal(r.json.lang, 'en')
  assert.equal(readFileSync(langFile, 'utf8').trim(), 'en')
  const g = await call(route, 'GET')
  assert.equal(g.json.lang, 'en', '写后读必须一致')
})

test('非法值归一为 auto（不写坏文件、不静默乱改）', async () => {
  const route = makeRoute()
  const r = await call(route, 'POST', JSON.stringify({ lang: 'fr' }))
  assert.equal(r.json.lang, 'auto')
  assert.equal(readFileSync(langFile, 'utf8').trim(), 'auto')
})

test('invalid json → 400', async () => {
  const route = makeRoute()
  const r = await call(route, 'POST', '{nope')
  assert.equal(r.status, 400)
  assert.equal(r.json.error, 'invalid json')
})

test('cleanup', () => {
  rmSync(dir, { recursive: true, force: true })
  assert.equal(existsSync(dir), false)
})
