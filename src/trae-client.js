/**
 * trae-client.js - Trae API client
 *
 * Communicates with Trae backend API with 3-level endpoint fallback:
 * 1. /api/agent/v3/llm_utils_chat (primary - lightweight chat)
 * 2. /api/ide/v1/chat (fallback 1 - standard chat)
 * 3. /api/agent/v3/create_agent_task (fallback 2 - full agent)
 */

const crypto = require('crypto');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const auth = require('./auth');

const IDE_VERSION_CN = '3.3.103';

const MODEL_MAP = {
  'claude-opus-4-7': 'glm-5.2',
  'claude-opus-4-6': 'glm-5.2',
  'claude-opus-4-5': 'glm-5.2',
  'claude-sonnet-4-6': 'glm-5.2',
  'claude-sonnet-4-5': 'glm-5.2',
  'claude-sonnet-4': 'glm-5.2',
  'claude-3.5-sonnet': 'glm-5.2',
  'claude-3.7-sonnet': 'glm-5.2',
  'claude-haiku-4-5': 'glm-5.1',
  'mimo-v2.5-pro': 'glm-5.2',
  'mimo-v2.5': 'glm-5.2',
  'gpt-4o': 'DeepSeek-V4-Pro',
  'gpt-4o-mini': 'DeepSeek-V4-Flash',
  'gpt-4.1': 'DeepSeek-V4-Pro',
  'auto': 'glm-5.2',
};

const MODEL_TIERS = {
  T1: ['glm-5.2'],
  T2: ['glm-5.1', 'qwen-3.7-plus', 'kimi-k2.6', 'DeepSeek-V4-Pro'],
  T3: ['glm-5', 'qwen-3.6-plus', 'minimax-m3', 'DeepSeek-V4-Flash'],
  T4: ['glm-4.7', 'kimi-k2', 'qwen3-coder', 'minimax-m2.7'],
  T5: ['glm-4.6', 'minimax-m2.1'],
};

function getTier(model) {
  for (const [tier, models] of Object.entries(MODEL_TIERS)) {
    if (models.includes(model)) return tier;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 设备身份：上游已加强设备校验。随机生成的 machineId/deviceId 会被风控降级
// （表现为所有回复退化为复读循环，provider 显示 FastApply-Gateway）。
// 必须从本机 Trae storage.json 读取真实持久化的设备标识。
// ---------------------------------------------------------------------------

const TRAE_VERSION_CODE_FALLBACK = '20260716';
let cachedIdentity = null;

function normalizeVersionCode(buildVersion) {
  if (!buildVersion || !buildVersion.trim()) return TRAE_VERSION_CODE_FALLBACK;
  const trimmed = buildVersion.trim();
  return /^\d+$/.test(trimmed) ? trimmed : TRAE_VERSION_CODE_FALLBACK;
}

function readStorageJson(dataDir) {
  try {
    const p = require('path').join(dataDir, 'globalStorage', 'storage.json');
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { return null; }
}

function readProductJson(appName) {
  try {
    const candidates = [];
    if (process.platform === 'darwin') {
      candidates.push(require('path').join('/Applications', `${appName}.app`, 'Contents', 'Resources', 'app', 'product.json'));
    } else {
      const roots = [process.env.LOCALAPPDATA, require('path').join(process.env.HOME || '', 'AppData', 'Local')].filter(Boolean);
      for (const root of roots) candidates.push(require('path').join(root, 'Programs', appName, 'resources', 'app', 'product.json'));
    }
    for (const p of candidates) {
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
  } catch {}
  return null;
}

function readIdentity(edition) {
  if (cachedIdentity) return cachedIdentity;

  const EDITION_DIRS = {
    cn: () => require('path').join(process.env.APPDATA || require('path').join(process.env.HOME || '', 'Library', 'Application Support'), 'Trae CN', 'User'),
    solo: () => require('path').join(process.env.APPDATA || require('path').join(process.env.HOME || '', 'Library', 'Application Support'), 'TRAE SOLO CN', 'User'),
    sg: () => require('path').join(process.env.APPDATA || require('path').join(process.env.HOME || '', 'Library', 'Application Support'), 'Trae', 'User'),
    'solo-sg': () => require('path').join(process.env.APPDATA || require('path').join(process.env.HOME || '', 'Library', 'Application Support'), 'TRAE SOLO', 'User'),
  };
  const APP_NAMES = { cn: 'Trae CN', solo: 'TRAE SOLO CN', sg: 'Trae', 'solo-sg': 'TRAE SOLO' };

  const dirs = [];
  if (EDITION_DIRS[edition]) dirs.push([edition, EDITION_DIRS[edition]()]);
  for (const [name, fn] of Object.entries(EDITION_DIRS)) {
    if (name !== edition) dirs.push([name, fn()]);
  }

  let machineId = process.env.TRAE_MACHINE_ID || '';
  let deviceId = process.env.TRAE_DEVICE_ID || '';
  let buildVersion = '';

  for (const [name, dir] of dirs) {
    const storage = readStorageJson(dir);
    if (!storage) continue;
    if (!machineId) machineId = (storage['telemetry.machineId'] || '').trim();
    if (!deviceId) {
      const dcPrefix = 'iCubeAuthInfo://icube-dc:';
      const dcIds = Object.keys(storage).filter(k => k.startsWith(dcPrefix)).map(k => k.slice(dcPrefix.length)).filter(Boolean);
      if (dcIds.length === 1) deviceId = dcIds[0];
      else if (storage['telemetry.devDeviceId']) deviceId = storage['telemetry.devDeviceId'].trim();
    }
    if (!buildVersion) buildVersion = (storage['iCubeLastVersion'] || '').trim();
    if (machineId && deviceId && buildVersion) break;
  }

  if (!machineId) {
    machineId = crypto.createHash('sha256').update(String(process.env.TRAE_USER_ID || 'dsh-trae-api')).digest('hex');
    console.warn('[trae-client] No persisted machine identity found — using derived ID (may be degraded by upstream)');
  }
  if (!deviceId) deviceId = crypto.createHash('sha256').update(machineId).digest('hex').slice(0, 32);

  const appName = APP_NAMES[edition] || 'Trae CN';
  const product = readProductJson(appName) || readProductJson('Trae CN') || {};
  const appVersion = process.env.TRAE_APP_VERSION || (product.appVersion || IDE_VERSION_CN);

  const platform = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows' : process.platform;
  const osVersion = `${process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : process.platform} ${require('os').release()}`;

  cachedIdentity = {
    machineId, deviceId, appVersion,
    versionCode: normalizeVersionCode(process.env.TRAE_VERSION_CODE || buildVersion),
    platform, osVersion,
  };
  console.log(`[trae-client] Identity: machine=${machineId.slice(0, 12)}..., device=${deviceId.slice(0, 12)}..., version=${appVersion}/${cachedIdentity.versionCode}`);
  return cachedIdentity;
}

function buildHeaders(token, userId) {
  const identity = readIdentity(process.env.TRAE_EDITION || 'cn');
  const requestId = crypto.randomUUID();
  const traceId = requestId.replaceAll('-', '').slice(0, 32);
  return {
    'Authorization': `Cloud-IDE-JWT ${token}`,
    'X-Ide-Token': token,
    'x-plugin-channel': 'icube-ai',
    'User-Agent': `Trae/${identity.appVersion}`,
    'x-app-id': '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8',
    'x-machine-id': identity.machineId,
    'x-device-id': identity.deviceId,
    'x-device-type': identity.platform,
    'x-os-version': identity.osVersion,
    'x-app-version': identity.appVersion,
    'x-ide-version': identity.appVersion,
    'x-app-version-code': identity.versionCode,
    'x-ide-version-code': identity.versionCode,
    'x-ide-version-type': 'stable',
    'x-custom-trace-id': traceId,
    'x-flow-traceparent': `04-${traceId}-${traceId.slice(0, 16)}-01`,
    'request-traffic-type': 'prod',
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
  };
}

function mapModel(requestedModel) {
  const mapped = MODEL_MAP[requestedModel];
  if (mapped) return mapped;
  return requestedModel;
}

function estimateTokens(text) {
  if (!text) return 0;
  let tokens = 0;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code > 0x2000) {
      tokens += 1.5;
    } else {
      tokens += 0.25;
    }
  }
  return Math.ceil(tokens);
}

function getMessageContent(msg) {
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content.map(b => b.text || b.content || '').join(' ');
  }
  return '';
}

function truncateMessages(messages, maxTokens) {
  if (!maxTokens) {
    maxTokens = parseInt(process.env.MAX_CONTEXT_TOKENS || '200000', 10);
  }
  if (messages.length === 0) return messages;

  let totalTokens = 0;
  for (const m of messages) {
    totalTokens += estimateTokens(getMessageContent(m));
  }

  if (totalTokens <= maxTokens) return messages;

  console.log(`[trae-client] Context truncation: ${totalTokens} est. tokens > ${maxTokens} limit`);

  const result = [];
  let startIdx = 0;

  if (messages[0] && messages[0].role === 'system') {
    result.push(messages[0]);
    startIdx = 1;
    totalTokens = estimateTokens(getMessageContent(messages[0]));
  }

  const recentMessages = [];
  for (let i = messages.length - 1; i >= startIdx; i--) {
    const msgTokens = estimateTokens(getMessageContent(messages[i]));
    if (totalTokens + msgTokens > maxTokens && recentMessages.length > 0) {
      console.log(`[trae-client] Truncated: kept ${result.length + recentMessages.length}/${messages.length} messages`);
      break;
    }
    recentMessages.unshift(messages[i]);
    totalTokens += msgTokens;
  }

  if (recentMessages.length < messages.length - startIdx) {
    const dropped = messages.length - startIdx - recentMessages.length;
    result.push({
      role: 'system',
      content: `[Note: ${dropped} earlier messages were truncated to fit context window]`,
    });
  }

  result.push(...recentMessages);

  // 截断可能把 assistant(tool_calls) 切掉而留下孤儿 tool 结果——上游会拒绝。
  // 丢弃开头的孤儿 tool 消息（以及其后续同轮的 tool 消息）。
  while (result.length > 0 && result[0].role === 'tool') {
    result.shift();
  }
  // 若首条非 system 消息是 tool 消息已被清除；再检查 system note 后紧跟的孤儿
  for (let i = 0; i < result.length; i++) {
    if (result[i].role !== 'system') {
      while (i < result.length && result[i].role === 'tool') result.splice(i, 1);
      break;
    }
  }

  console.log(`[trae-client] Final messages: ${result.length}, ~${totalTokens} tokens`);
  return result;
}

// ---------------------------------------------------------------------------
// 2026-10 起的新协议（SOLO 通道）：
//  - function 不再是 inline_chat/chat，而是 SOLO 函数名；每个模型只归属于
//    特定函数（发错函数返回 4001/4011）
//  - 新增必填 config_name 字段（= 模型名）
//  - tools 原生传参：parameters 需序列化为 JSON 字符串
//  - assistant 的 tool_calls 用 function_call 键；tool 结果保持 role=tool +
//    tool_call_id（原生函数调用，不再需要伪 <tool_call> 标签）
// ---------------------------------------------------------------------------

const FUNCTION_MAP = {
  'glm-5.3': ['solo_work_remote'],
  'glm-5.3-flash': ['solo_work_remote'],
  'glm-5.3-flashx': ['solo_work_remote'],
  'glm-5.2': ['solo_work_lite'],
  'glm-5.1': ['solo_coder', 'solo_work_lite'],
  'glm-5': ['solo_coder', 'solo_work_lite'],
  'qwen-3.5': ['solo_coder'],
  'DeepSeek-V4-Pro': ['solo_coder', 'solo_work_lite'],
  'DeepSeek-V4-Flash': ['solo_coder', 'solo_work_lite'],
};
const DEFAULT_FUNCTIONS = ['solo_work_lite', 'solo_work_remote', 'chat_v3', 'solo_coder'];

function getChatFunctions(model) {
  return FUNCTION_MAP[model] || DEFAULT_FUNCTIONS;
}

function toNativeMessage(m) {
  const msg = { role: m.role };
  if (typeof m.content === 'string') {
    msg.content = m.content ? [{ type: 'text', text: m.content }] : [];
  } else if (Array.isArray(m.content)) {
    msg.content = m.content;
  } else {
    msg.content = [];
  }
  if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
    msg.tool_calls = m.tool_calls.map((tc, i) => {
      const fn = tc.function || {};
      let args = fn.arguments;
      if (typeof args !== 'string') args = JSON.stringify(args || {});
      return {
        index: typeof tc.index === 'number' ? tc.index : i,
        id: tc.id || `call_${uuidv4().replace(/-/g, '').slice(0, 24)}`,
        type: 'function',
        function_call: { name: fn.name || '', arguments: args },
      };
    });
  }
  if (m.role === 'tool' && m.tool_call_id) {
    msg.tool_call_id = m.tool_call_id;
  }
  return msg;
}

function buildChatBody(messages, model, stream, options, fn) {
  const truncated = truncateMessages(messages);

  const body = {
    messages: truncated.map(toNativeMessage),
    model: model,
    config_name: model,
    function: fn,
    stream: stream !== false,
  };

  const tools = options && options.tools;
  if (Array.isArray(tools) && tools.length > 0) {
    body.tools = tools.map(t => {
      const fn2 = t.function || t;
      const params = fn2.parameters ?? fn2.input_schema;
      return {
        type: 'function',
        function: {
          name: fn2.name || t.name || 'unknown',
          description: fn2.description || '',
          parameters: typeof params === 'string' ? params : JSON.stringify(params || { type: 'object', properties: {} }),
        },
      };
    });
  }

  const maxTokens = options && options.maxTokens;
  if (maxTokens && typeof maxTokens === 'number' && maxTokens > 0) {
    body.max_tokens = maxTokens;
  }

  return body;
}

// 探测流首事件：4001/4011 表示函数不服务该模型，需换函数重试。
// 返回 null 表示可继续（正常流），否则返回错误码。
async function peekStreamError(resp) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let firstChunk = null;
  // 只读第一块数据，足够看到首个 error 事件
  const { value } = await reader.read();
  firstChunk = value;
  buffer = decoder.decode(value || new Uint8Array(), { stream: true });
  const m = buffer.match(/event:error\ndata:\{"code":(\d+)/) || buffer.match(/"code":(\d+)[^}]*"message"/);
  if (m) {
    const code = parseInt(m[1], 10);
    if (code === 4001 || code === 4011) {
      await reader.cancel().catch(() => {});
      return { code };
    }
  }
  // 正常流：把首块数据拼回一个可完整读取的 Response
  const replay = new ReadableStream({
    start(controller) {
      if (firstChunk) controller.enqueue(firstChunk);
      (async () => {
        try {
          while (true) {
            const { done, value: v } = await reader.read();
            if (done) break;
            controller.enqueue(v);
          }
          controller.close();
        } catch (e) { controller.error(e); }
      })();
    },
  });
  return { response: new Response(replay, { status: resp.status, headers: resp.headers }) };
}

async function sendChatRequest(messages, model, stream, baseUrl, options) {
  const token = auth.getToken();
  const userId = auth.getUserId();

  if (!token) {
    const err = new Error('No auth token available');
    err.status = 401;
    throw err;
  }

  if (auth.needsRefresh()) {
    await auth.refreshToken();
  }

  const traeModel = mapModel(model);
  const headers = buildHeaders(auth.getToken(), userId);
  const functions = getChatFunctions(traeModel);
  const url = `${baseUrl}/api/agent/v3/llm_utils_chat`;

  let lastError = null;
  let lastStatus = 502;

  for (const fn of functions) {
    const body = buildChatBody(messages, traeModel, stream, options, fn);
    console.log(`[trae-client] Trying function: ${fn} (model: ${traeModel})`);

    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const text = await resp.text();
        console.warn(`[trae-client] Function ${fn} returned ${resp.status}: ${text.substring(0, 300)}`);
        lastError = new Error(`${fn}: ${resp.status} ${text.substring(0, 300)}`);
        lastError.status = resp.status;
        lastStatus = resp.status;
        continue;
      }

      const peek = await peekStreamError(resp);
      if (peek.response) {
        console.log(`[trae-client] Success with function: ${fn}`);
        return { response: peek.response, model: traeModel, endpoint: '/api/agent/v3/llm_utils_chat' };
      }
      // 4001/4011：该函数不服务此模型，换下一个函数
      console.warn(`[trae-client] Function ${fn} does not serve ${traeModel} (code ${peek.code}), trying next...`);
      lastError = new Error(`no function serves model ${traeModel} (code ${peek.code})`);
      lastError.status = 400;
      lastStatus = 400;
    } catch (err) {
      console.warn(`[trae-client] Function ${fn} error: ${err.message}`);
      err.status = err.status || 502;
      lastError = err;
      lastStatus = err.status;
    }
  }

  if (lastError) {
    lastError.status = lastStatus;
    throw lastError;
  }
  throw new Error('All functions failed');
}

async function getModels(baseUrl) {
  const allModels = [];
  for (const [tier, models] of Object.entries(MODEL_TIERS)) {
    for (const m of models) {
      if (!allModels.find(x => x.id === m)) {
        allModels.push({
          id: m,
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: 'trae',
          tier: tier,
        });
      }
    }
  }
  return allModels;
}

module.exports = {
  sendChatRequest,
  getModels,
  mapModel,
  MODEL_MAP,
  MODEL_TIERS,
};