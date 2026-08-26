/**
 * trae-client.js - Trae API client
 *
 * Communicates with Trae backend API with 3-level endpoint fallback:
 * 1. /api/agent/v3/llm_utils_chat (primary - lightweight chat)
 * 2. /api/ide/v1/chat (fallback 1 - standard chat)
 * 3. /api/agent/v3/create_agent_task (fallback 2 - full agent)
 */

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const auth = require('./auth');

const IDE_VERSION_CN = '3.3.67';
const IDE_VERSION_CODE_CN = '20260401';

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

function hashDeviceId(machineId) {
  return crypto.createHash('sha256').update(machineId).digest('hex').substring(0, 32);
}

function generateMachineId() {
  return crypto.randomBytes(32).toString('hex');
}

function buildHeaders(token, userId) {
  const machineId = generateMachineId();
  const requestId = crypto.randomUUID();
  return {
    'Authorization': `Cloud-IDE-JWT ${token}`,
    'X-Cloudide-Token': token,
    'x-uid': userId || '',
    'x-app-id': '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8',
    'x-device-id': hashDeviceId(machineId),
    'x-machine-id': machineId,
    'x-request-id': requestId,
    'x-ide-version': IDE_VERSION_CN,
    'x-ide-version-code': IDE_VERSION_CODE_CN,
    'x-device-type': 'windows',
    'x-os-version': 'Windows 10',
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
  console.log(`[trae-client] Final messages: ${result.length}, ~${totalTokens} tokens`);
  return result;
}

function buildChatBody(messages, model, stream, options) {
  const truncated = truncateMessages(messages);
  const sessionId = crypto.randomUUID();

  const body = {
    messages: truncated.map(m => ({
      role: m.role,
      content: typeof m.content === 'string'
        ? [{ type: 'text', text: m.content }]
        : m.content,
    })),
    model: model,
    function: 'inline_chat',
    stream: stream !== false,
    request_id: sessionId,
    session_id: sessionId,
  };

  const maxTokens = options && options.maxTokens;
  if (maxTokens && typeof maxTokens === 'number' && maxTokens > 0) {
    body.max_tokens = maxTokens;
  }

  return body;
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
  const body = buildChatBody(messages, traeModel, stream, options);
  const headers = buildHeaders(auth.getToken(), userId);

  const endpoints = [
    '/api/agent/v3/llm_utils_chat',
    '/api/ide/v1/chat',
    '/api/agent/v3/create_agent_task',
  ];

  let lastError = null;
  let lastStatus = 502;

  for (const endpoint of endpoints) {
    const url = `${baseUrl}${endpoint}`;
    console.log(`[trae-client] Trying endpoint: ${endpoint} (model: ${traeModel})`);

    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (resp.ok) {
        console.log(`[trae-client] Success with endpoint: ${endpoint}`);
        return { response: resp, model: traeModel, endpoint };
      }

      const text = await resp.text();
      console.warn(`[trae-client] Endpoint ${endpoint} returned ${resp.status}: ${text.substring(0, 500)}`);
      const err = new Error(`${endpoint}: ${resp.status} ${text.substring(0, 500)}`);
      err.status = resp.status;
      err.endpoint = endpoint;
      lastError = err;
      lastStatus = resp.status;
    } catch (err) {
      console.warn(`[trae-client] Endpoint ${endpoint} error: ${err.message}`);
      err.status = err.status || 502;
      lastError = err;
      lastStatus = err.status;
    }
  }

  if (lastError) {
    lastError.status = lastStatus;
    throw lastError;
  }
  throw new Error('All endpoints failed');
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