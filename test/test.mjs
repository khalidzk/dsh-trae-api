/**
 * Smoke test: mount the plugin apply() with a mocked cordis ctx, then hit
 * every /plug-trae-api/* route in-process. No network / Trae IDE required:
 * auth is expected to FAIL on CI-less machines, and every route must still
 * answer with well-formed JSON instead of throwing.
 *
 * Run: node test/test.mjs
 */
import { createRequire } from 'node:module'
import assert from 'node:assert'
import { Readable } from 'node:stream'
import { Writable } from 'node:stream'
import { once } from 'node:events'

const require = createRequire(import.meta.url)
const plugin = await import('../lib/index.js')

// ---- mock cordis ctx ----------------------------------------------------
const routes = new Map()
const effects = []
const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  webServer: {
    register(route) {
      const key = route.kind + ' ' + route.path
      if (routes.has(key)) throw new Error('duplicate route ' + key)
      routes.set(key, route.handler)
      return () => routes.delete(key)
    },
  },
  effect(fn, label) { effects.push({ fn, label }); return () => {} },
  get: () => undefined,
}

// Point DSH_HOME at a temp dir so the test never touches real settings.
const os = await import('node:os')
const path = await import('node:path')
const fs = await import('node:fs')
process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-trae-api-test-'))
process.env.PORT = '19220' // keep the proxy off the default port during tests
delete process.env.TRAE_TOKEN

plugin.apply(ctx, {})

// ---- helpers --------------------------------------------------------------
function fakeReq(method, body) {
  const req = Readable.from(body !== undefined ? [Buffer.from(JSON.stringify(body))] : [])
  req.method = method
  req.url = '/'
  return req
}
async function call(routePath, method = 'GET', body) {
  const handler = routes.get('exact ' + routePath)
  assert.ok(handler, 'route not registered: ' + routePath)
  const chunks = []
  const res = new Writable({
    write(chunk, _enc, cb) { chunks.push(chunk); cb() },
  })
  res.writeHead = () => {}
  res.end = function (data) { if (data) chunks.push(Buffer.from(data)); this.emit('finished'); }
  const finished = once(res, 'finished') // attach BEFORE the handler: sync routes emit immediately
  await handler(fakeReq(method, body), res)
  await finished
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

// ---- assertions -------------------------------------------------------------
// status: shape + graceful auth failure
const status = await call('/plug-trae-api/status')
assert.equal(status.ok, true)
assert.equal(typeof status.status.port, 'number')
assert.equal(typeof status.status.listening, 'boolean')
assert.ok(status.auth && typeof status.auth.hasToken === 'boolean')
console.log('[test] status OK — port', status.status.port, 'authOk', status.status.authOk)

// config GET
const cfgGet = await call('/plug-trae-api/config')
assert.equal(cfgGet.ok, true)
assert.equal(cfgGet.config.port, 19220)
assert.ok(Array.isArray(cfgGet.config.fromCordis))
console.log('[test] config GET OK —', JSON.stringify(cfgGet.config))

// config POST: valid save -> persisted + hot restart
const cfgPost = await call('/plug-trae-api/config', 'POST', { config: { port: 19221, host: '127.0.0.1', maxContextTokens: 100000 } })
assert.equal(cfgPost.ok, true, 'save should succeed: ' + cfgPost.error)
assert.equal(cfgPost.config.port, 19221)
assert.ok(cfgPost.status, 'save response should embed a fresh snapshot')
const persistedFile = path.join(process.env.DSH_HOME, 'plug-trae-api.json')
const persisted = JSON.parse(fs.readFileSync(persistedFile, 'utf8'))
assert.equal(persisted.port, 19221)
console.log('[test] config POST OK — hot restart to port', cfgPost.status.port)

// config POST: invalid input rejected
const badPort = await call('/plug-trae-api/config', 'POST', { config: { port: 99999 } })
assert.equal(badPort.ok, false)
assert.ok(String(badPort.error).includes('端口'))
const badUrl = await call('/plug-trae-api/config', 'POST', { config: { baseUrl: 'ftp://nope' } })
assert.equal(badUrl.ok, false)
console.log('[test] config POST validation OK —', badPort.error, '/', badUrl.error)

// refresh-token: with a real Trae login it refreshes; without one it must
// fail cleanly with an actionable message. Both outcomes are acceptable.
const refresh = await call('/plug-trae-api/refresh-token', 'POST')
assert.equal(typeof refresh.ok, 'boolean')
if (refresh.ok) {
  assert.ok(refresh.auth && refresh.auth.hasToken === true)
  console.log('[test] refresh-token OK — refreshed, expires', refresh.auth.expiredAt)
} else {
  assert.ok(String(refresh.error).length > 0)
  console.log('[test] refresh-token OK —', refresh.error)
}

// reauth: re-decrypts when a Trae IDE is present; clean error otherwise
const reauth = await call('/plug-trae-api/reauth', 'POST', { edition: status.status.edition || 'cn' })
assert.equal(typeof reauth.ok, 'boolean')
if (!reauth.ok) assert.ok(String(reauth.error).length > 0)
console.log('[test] reauth OK —', reauth.ok ? 'decrypted' : reauth.error.slice(0, 80))

// upstream probe: consumes a few real tokens when auth exists — assert shape
const probe = await call('/plug-trae-api/test', 'POST')
assert.equal(typeof probe.ok, 'boolean')
if (probe.ok) {
  assert.ok(probe.detail && typeof probe.detail.latencyMs === 'number')
  assert.ok(typeof probe.detail.endpoint === 'string')
  console.log('[test] upstream probe OK —', probe.detail.endpoint, probe.detail.latencyMs + 'ms')
} else {
  assert.ok(String(probe.error).length > 0)
  console.log('[test] upstream probe OK —', probe.error)
}

// the proxy itself answers /v1/status on the new port (auth disabled via none? no — default key)
const resp = await fetch('http://127.0.0.1:19221/v1/status', { headers: { authorization: 'Bearer trae-local-api' } })
const v1 = await resp.json()
assert.equal(v1.status, 'ok')
assert.equal(v1.port, 19221)
console.log('[test] proxy /v1/status OK —', JSON.stringify(v1))

// wrong API key rejected
const rej = await fetch('http://127.0.0.1:19221/v1/status', { headers: { authorization: 'Bearer wrong' } })
assert.equal(rej.status, 401)
console.log('[test] auth rejection OK — HTTP', rej.status)

// effect cleanup disposes the server
for (const eff of effects) { const dispose = eff.fn(); if (typeof dispose === 'function') dispose() }
console.log('[test] all smoke tests passed ✓')
process.exit(0)
