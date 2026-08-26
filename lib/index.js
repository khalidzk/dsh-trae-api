/**
 * dsh-trae-api — DeepSeek Harness plugin entry (host half)
 *
 * When this plugin is mounted in a profile, it starts the Trae -> OpenAI /
 * Anthropic compatible proxy server so any local agent (Claude Code, Cursor,
 * Cline, ...) can consume Trae Work CN credits through http://localhost:PORT.
 *
 * On top of the proxy it publishes a small local JSON API (/plug-trae-api/*)
 * that powers the browser settings page (client.js): live status, request
 * stats, token refresh / re-decrypt, an upstream connectivity test, and
 * runtime-editable server config persisted to $DSH_HOME/plug-trae-api.json.
 * Saving config hot-restarts the internal proxy — no DSH restart needed.
 *
 * Config precedence (later wins):
 *   defaults < persisted ($DSH_HOME/plug-trae-api.json) < cordis.patch.yml config
 *
 * Plugin config (cordis.patch.yml insert row -> config):
 *   port:             listen port (default: env PORT or 9220)
 *   host:             listen host (default: env HOST or 127.0.0.1)
 *   apiKey:           API key required by clients (default: env API_KEY)
 *   edition:          Trae edition cn/solo/sg/solo-sg (default: env TRAE_EDITION or cn)
 *   manualToken:      manual token fallback (default: env TRAE_MANUAL_TOKEN)
 *   baseUrl:          upstream API base URL (default: auto by edition)
 *   maxContextTokens: context truncation budget (default: env MAX_CONTEXT_TOKENS or 200000)
 *   quiet:            suppress banner logs
 */

import { createRequire } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const { startServer } = require('../src/server-core.js')
const auth = require('../src/auth.js')
const traeClient = require('../src/trae-client.js')

export const name = 'dsh-trae-api'

// Hard dependency: the settings page JSON API rides the GUI web server.
export const inject = ['webServer']

const SETTINGS_FILE = 'plug-trae-api.json'
const EDITIONS = ['cn', 'solo', 'sg', 'solo-sg']
const CONFIG_KEYS = ['port', 'host', 'apiKey', 'edition', 'manualToken', 'baseUrl', 'maxContextTokens']

function dshHomeDir() {
  return typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
}

function loadPersisted() {
  try {
    const parsed = JSON.parse(readFileSync(join(dshHomeDir(), SETTINGS_FILE), 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function savePersisted(cfg) {
  writeFileSync(join(dshHomeDir(), SETTINGS_FILE), JSON.stringify(cfg, null, 2) + '\n', 'utf8')
}

/** Validate + normalize a settings-page config payload. Throws on bad input. */
function normalizeIncoming(raw, current) {
  const out = Object.assign({}, current)
  if (raw === null || typeof raw !== 'object') throw new Error('配置格式无效')

  if (raw.port !== undefined && raw.port !== null && raw.port !== '') {
    const port = Number(raw.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须是 1-65535 的整数')
    out.port = port
  }
  if (raw.host !== undefined && raw.host !== '') {
    const host = String(raw.host).trim()
    if (host !== '') out.host = host
  }
  if (typeof raw.apiKey === 'string' && raw.apiKey !== '') {
    // '' = keep current; 'none' = disable auth (server-core convention)
    out.apiKey = raw.apiKey.trim()
  }
  if (raw.edition !== undefined) {
    const ed = String(raw.edition).trim().toLowerCase()
    if (ed !== '' && !EDITIONS.includes(ed)) throw new Error('未知版本：' + ed + '（可选 ' + EDITIONS.join('/') + '）')
    out.edition = ed
  }
  if (raw.baseUrl !== undefined) {
    const url = String(raw.baseUrl).trim()
    if (url !== '' && !/^https?:\/\//i.test(url)) throw new Error('上游地址需以 http:// 或 https:// 开头')
    out.baseUrl = url
  }
  if (raw.maxContextTokens !== undefined && raw.maxContextTokens !== null && raw.maxContextTokens !== '') {
    const n = Number(raw.maxContextTokens)
    if (!Number.isInteger(n) || n < 1000 || n > 2000000) throw new Error('最大上下文 Token 数需为 1000-2000000 的整数')
    out.maxContextTokens = n
  }
  return out
}

function maskSecret(value) {
  if (typeof value !== 'string' || value === '') return ''
  if (value.length <= 8) return '****'
  return value.slice(0, 3) + '****' + value.slice(-3)
}

export function apply(ctx, cordisConfig = {}) {
  const webServer = ctx.webServer
  const cordis = cordisConfig !== null && typeof cordisConfig === 'object' ? cordisConfig : {}

  let persisted = loadPersisted()
  let handle = null

  /** defaults < persisted < cordis config */
  function effectiveConfig() {
    const cfg = Object.assign({}, persisted)
    for (const key of CONFIG_KEYS) {
      const v = cordis[key]
      if (v !== undefined && v !== null && v !== '') cfg[key] = v
    }
    return cfg
  }

  function boot() {
    const cfg = effectiveConfig()
    if (cfg.maxContextTokens) process.env.MAX_CONTEXT_TOKENS = String(cfg.maxContextTokens)
    handle = startServer({
      port: cfg.port,
      host: cfg.host,
      apiKey: cfg.apiKey,
      edition: cfg.edition,
      manualToken: cfg.manualToken,
      baseUrl: cfg.baseUrl,
      quiet: true,
    })
    ctx.logger?.info(
      '[dsh-trae-api] Trae API proxy listening on http://' + handle.host + ':' + handle.port +
      ' (edition=' + handle.edition + ', auth=' + (handle.authOk ? 'OK' : 'FAILED') + ')'
    )
  }

  function stopServer() {
    if (!handle) return
    try {
      handle.server.close()
      if (typeof handle.server.closeAllConnections === 'function') handle.server.closeAllConnections()
    } catch { /* already closed */ }
  }

  function restartServer() {
    stopServer()
    boot()
  }

  boot()

  ctx.effect(() => () => {
    stopServer()
    ctx.logger?.info('[dsh-trae-api] Trae API proxy stopped')
  }, 'dsh-trae-api: server lifecycle')

  // ------------------------------------------------------------------ 快照

  function uptimeLabel(ms) {
    const sec = Math.max(0, Math.floor(ms / 1000))
    if (sec < 60) return sec + 's'
    const min = Math.floor(sec / 60)
    if (min < 60) return min + 'm ' + (sec % 60) + 's'
    return Math.floor(min / 60) + 'h ' + (min % 60) + 'm'
  }

  function snapshot() {
    const cfg = effectiveConfig()
    const info = auth.getAuthInfo()
    return {
      ok: true,
      status: {
        listening: handle !== null && handle.server.listening === true,
        host: handle ? handle.host : (cfg.host || '127.0.0.1'),
        port: handle ? handle.port : Number(cfg.port || 9220),
        edition: handle ? handle.edition : (cfg.edition || 'cn'),
        baseUrl: handle ? handle.baseUrl : (cfg.baseUrl || ''),
        authOk: handle ? handle.authOk : false,
        authEnabled: handle ? handle.authEnabled : String(cfg.apiKey || '').toLowerCase() !== 'none',
        startedAt: handle && handle.stats ? handle.stats.startedAt : null,
        uptime: handle && handle.stats ? uptimeLabel(Date.now() - handle.stats.startedAt) : '',
      },
      auth: info,
      stats: handle && handle.stats ? {
        requests: handle.stats.requests,
        errors: handle.stats.errors,
        lastRequestAt: handle.stats.lastRequestAt,
        lastError: handle.stats.lastError,
      } : null,
    }
  }

  /**
   * Config view for the settings page. Port/host/edition/baseUrl prefer the
   * live server handle (which also absorbs env fallbacks like PORT), so the UI
   * always shows what is actually running, not just what was persisted.
   */
  function publicConfig() {
    const cfg = effectiveConfig()
    const maxCtx = cfg.maxContextTokens !== undefined && cfg.maxContextTokens !== ''
      ? Number(cfg.maxContextTokens)
      : Number(process.env.MAX_CONTEXT_TOKENS || 200000)
    return {
      port: handle ? handle.port : (cfg.port !== undefined && cfg.port !== '' ? Number(cfg.port) : Number(process.env.PORT || 9220)),
      host: handle ? handle.host : (cfg.host || process.env.HOST || '127.0.0.1'),
      apiKeyMasked: maskSecret(handle ? handle.apiKey : cfg.apiKey),
      authEnabled: handle ? handle.authEnabled : String(cfg.apiKey || '').toLowerCase() !== 'none',
      edition: handle ? handle.edition : (cfg.edition || process.env.TRAE_EDITION || ''),
      baseUrl: handle ? handle.baseUrl : (cfg.baseUrl || ''),
      maxContextTokens: maxCtx,
      fromCordis: CONFIG_KEYS.filter((k) => cordis[k] !== undefined && cordis[k] !== null && cordis[k] !== ''),
    }
  }

  // ------------------------------------------------------- 本地 JSON API

  function sendJson(res, value) {
    const body = JSON.stringify(value)
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(body)
  }

  function readJsonBody(req, limitBytes) {
    return new Promise((resolve, reject) => {
      let size = 0
      const chunks = []
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > limitBytes) {
          reject(new Error('请求体过大'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        if (chunks.length === 0) { resolve({}); return }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch {
          reject(new Error('请求体不是合法 JSON'))
        }
      })
      req.on('error', reject)
    })
  }

  function route(path, fn) {
    webServer.register({
      kind: 'exact',
      path,
      handler: async (req, res) => {
        try {
          const method = (req.method ?? 'GET').toUpperCase()
          sendJson(res, await fn(method, req))
        } catch (error) {
          sendJson(res, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    })
  }

  // 服务状态 + 认证信息 + 请求统计（设置页加载时调用）
  route('/plug-trae-api/status', async (method) => {
    if (method !== 'GET') return { ok: false, error: '仅支持 GET' }
    return snapshot()
  })

  // 读取/保存配置；保存后热重启内部代理服务器
  route('/plug-trae-api/config', async (method, req) => {
    if (method === 'GET') return { ok: true, config: publicConfig() }
    if (method !== 'POST') return { ok: false, error: '仅支持 GET/POST' }
    const body = await readJsonBody(req, 64 * 1024)
    const next = normalizeIncoming(body.config ?? body, Object.assign({}, persisted))
    persisted = next
    try {
      savePersisted(persisted)
    } catch (error) {
      return { ok: false, error: '配置写入失败：' + (error instanceof Error ? error.message : String(error)) }
    }
    try {
      restartServer()
    } catch (error) {
      return { ok: false, error: '服务重启失败：' + (error instanceof Error ? error.message : String(error)), config: publicConfig() }
    }
    return Object.assign({ ok: true, summary: '配置已保存，代理服务已按新配置重启。', config: publicConfig() }, snapshot())
  })

  // 手动触发 token 刷新（ExchangeToken）
  route('/plug-trae-api/refresh-token', async (method) => {
    if (method !== 'POST') return { ok: false, error: '仅支持 POST' }
    if (!auth.getRefreshToken()) return { ok: false, error: '没有可用的 Refresh Token，请先重新解密凭证。' }
    await auth.refreshToken()
    const info = auth.getAuthInfo()
    return { ok: info.hasToken, summary: info.hasToken ? 'Token 已刷新。' : '刷新未成功，请查看宿主日志。', auth: info }
  })

  // 重新从本机 Trae IDE 解密凭证（可指定 edition，缺省按当前配置自动探测）
  route('/plug-trae-api/reauth', async (method, req) => {
    if (method !== 'POST') return { ok: false, error: '仅支持 POST' }
    const body = await readJsonBody(req, 64 * 1024)
    const edition = typeof body.edition === 'string' && body.edition.trim() !== ''
      ? body.edition.trim().toLowerCase()
      : (effectiveConfig().edition || 'cn')
    if (!EDITIONS.includes(edition)) return { ok: false, error: '未知版本：' + edition }
    try {
      auth.initAuth(edition, effectiveConfig().manualToken || '')
    } catch (error) {
      return { ok: false, error: '解密失败：' + (error instanceof Error ? error.message : String(error)) + '。确认本机已安装并登录对应 Trae IDE。' }
    }
    return Object.assign({ ok: true, summary: '已重新解密 ' + edition.toUpperCase() + ' 版凭证。' }, snapshot())
  })

  // 上游连通性测试：发一个最小探针请求（约消耗几十~几百上游 token）
  route('/plug-trae-api/test', async (method) => {
    if (method !== 'POST') return { ok: false, error: '仅支持 POST' }
    if (!auth.getToken()) return { ok: false, error: '没有可用 Token，请先重新解密凭证。' }
    const baseUrl = handle ? handle.baseUrl : effectiveConfig().baseUrl
    const startedAt = Date.now()
    try {
      const { response, model, endpoint } = await traeClient.sendChatRequest(
        [{ role: 'user', content: 'Reply with exactly "OK"' }],
        'claude-sonnet-4-6',
        false,
        baseUrl
      )
      const text = await response.text()
      return {
        ok: true,
        summary: '上游连通正常。',
        detail: {
          endpoint,
          model,
          latencyMs: Date.now() - startedAt,
          httpStatus: response.status,
          bodyBytes: text.length,
        },
      }
    } catch (error) {
      return { ok: false, error: '上游连接失败：' + (error instanceof Error ? error.message : String(error)), detail: { latencyMs: Date.now() - startedAt } }
    }
  })

  ctx.logger?.info('[dsh-trae-api] Settings API mounted at /plug-trae-api/* (status/config/refresh-token/reauth/test)')
}
