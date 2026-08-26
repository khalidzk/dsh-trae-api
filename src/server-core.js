/**
 * server-core.js - Reusable Express server core
 *
 * Exposes startServer(options) so the same server can be launched either
 * standalone (src/server.js) or as a DSH plugin (lib/index.js).
 */

const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const pkg = require('../package.json');
const auth = require('./auth');
const traeClient = require('./trae-client');
const { handleOpenAIResponse } = require('./openai-format');
const { handleAnthropicResponse, estimateTokens } = require('./anthropic-format');

const DEFAULT_BASE_URLS = {
  cn: 'https://trae-api-cn.mchost.guru',
  solo: 'https://trae-api-cn.mchost.guru',
  sg: 'https://a0ai-api-sg.byteintlapi.com',
  'solo-sg': 'https://a0ai-api-sg.byteintlapi.com',
};

function buildAnthropicError(type, message) {
  return { type: 'error', error: { type, message } };
}

function mapUpstreamStatus(status) {
  if (status === 401 || status === 403) return { status: 401, type: 'authentication_error' };
  if (status === 404) return { status: 404, type: 'not_found_error' };
  if (status === 400) return { status: 400, type: 'invalid_request_error' };
  if (status === 429) return { status: 429, type: 'rate_limit_error' };
  if (status === 529) return { status: 529, type: 'overloaded_error' };
  return { status: 502, type: 'api_error' };
}

function sendAnthropicError(res, httpStatus, errorType, message) {
  return res.status(httpStatus).json(buildAnthropicError(errorType, message));
}

function extractTextFromBlocks(blocks) {
  const parts = [];
  for (const block of blocks) {
    if (block.type === 'text' && block.text) parts.push(block.text);
    else if (block.type === 'image') parts.push('[Image]');
  }
  return parts.join('\n');
}

function extractToolResultText(block) {
  if (typeof block.content === 'string') return block.content || '(empty)';
  if (Array.isArray(block.content)) {
    const parts = [];
    for (const c of block.content) {
      if (c.type === 'text' && c.text) parts.push(c.text);
      else if (c.type === 'image') parts.push('[Image]');
    }
    return parts.join('\n') || '(empty)';
  }
  return '(empty)';
}

// Render a tool call as the <tool_call> tag format that the upstream model is
// instructed to output. Using the tag (instead of "[Called tool: name]" text)
// keeps history consistent with the system prompt so the model mimics the
// correct format, which our response parsers can then convert to tool_calls.
function toolCallToTag(name, input) {
  const argsObj = (typeof input === 'object' && input !== null) ? input : { value: input };
  return `<tool_call>\n${JSON.stringify({ name, arguments: argsObj })}\n</tool_call>`;
}

const CLEAN_PATTERNS = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  /<system-reminder>[\s\S]*?(?=<\/[a-z]|$)/g,
  /<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g,
  /<local-command-caveat>[\s\S]*?(?=<\/[a-z]|$)/g,
  /<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g,
  /<command-name>[\s\S]*?<\/command-name>/g,
  /<command-message>[\s\S]*?<\/command-message>/g,
  /<command-args>[\s\S]*?<\/command-args>/g,
  /<\/?session>/g,
  /\[SUGGESTION MODE:[\s\S]*?\]/g,
  /The following deferred tools are now available[\s\S]*?(?:\n\n\n|\n(?=[A-Z#]))/g,
  /## Available Tools[\s\S]*?(?=\n## [A-Z]|\n# [A-Z]|\n---|\n\*\*)/g,
];

function cleanContent(text) {
  if (!text) return '';
  for (const pattern of CLEAN_PATTERNS) {
    text = text.replace(pattern, '');
  }
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  return text;
}

function toolsToSystemPrompt(tools) {
  if (!tools || !Array.isArray(tools) || tools.length === 0) return '';
  const lines = ['You have access to the following tools. To use a tool, output EXACTLY this format:', '',
    '<tool_call>', '{"name": "tool_name", "arguments": {"param": "value"}}', '</tool_call>', '',
    'Available tools:'];

  for (const tool of tools) {
    const name = tool.name || tool.function?.name || 'unknown';
    const desc = tool.description || tool.function?.description || '';
    lines.push(`\n### ${name}`);
    if (desc) lines.push(desc);
    const params = tool.input_schema || tool.parameters || tool.function?.parameters;
    if (params && params.properties) {
      lines.push('Parameters:');
      for (const [key, val] of Object.entries(params.properties)) {
        const required = params.required?.includes(key) ? ' (required)' : '';
        lines.push(`- ${key}: ${val.type || 'any'}${required} - ${val.description || ''}`);
      }
    }
  }

  return lines.join('\n');
}

function convertAnthropicMessages(messages, systemPrompt, tools) {
  const systemParts = [];

  if (systemPrompt) {
    const sysContent = typeof systemPrompt === 'string' ? systemPrompt :
      Array.isArray(systemPrompt) ? extractTextFromBlocks(systemPrompt) : '';
    const cleaned = cleanContent(sysContent);
    if (cleaned) systemParts.push(cleaned);
  }

  const toolPrompt = toolsToSystemPrompt(tools);
  if (toolPrompt) systemParts.push(toolPrompt);

  for (const m of messages) {
    if (m.role === 'system') {
      const text = typeof m.content === 'string' ? m.content :
        Array.isArray(m.content) ? extractTextFromBlocks(m.content) : '';
      const cleaned = cleanContent(text);
      if (cleaned) systemParts.push(cleaned);
    }
  }

  const result = [];
  if (systemParts.length > 0) {
    result.push({ role: 'system', content: systemParts.join('\n\n') });
  }

  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    if (m.role === 'system') { i++; continue; }

    if (typeof m.content === 'string') {
      const cleaned = cleanContent(m.content);
      if (cleaned) result.push({ role: m.role, content: cleaned });
      i++; continue;
    }

    if (!Array.isArray(m.content)) { i++; continue; }

    if (m.role === 'assistant') {
      const textPart = extractTextFromBlocks(m.content);
      const toolUses = m.content.filter(b => b.type === 'tool_use');

      if (toolUses.length === 0) {
        if (textPart.trim()) result.push({ role: 'assistant', content: textPart });
        i++; continue;
      }

      let combinedText = textPart || '';

      if (i + 1 < messages.length && messages[i + 1].role === 'user') {
        const nextBlocks = Array.isArray(messages[i + 1].content) ? messages[i + 1].content : [];
        const toolResults = nextBlocks.filter(b => b.type === 'tool_result');
        const nextText = extractTextFromBlocks(nextBlocks);

        if (toolResults.length > 0) {
          const toolLines = toolUses.map(tu => toolCallToTag(tu.name, tu.input));
          const resultLines = toolResults.map(tr => {
            const prefix = tr.is_error ? '[Tool Error]' : '[Tool Result]';
            return `${prefix}\n${extractToolResultText(tr)}`;
          });

          const parts = [];
          if (combinedText.trim()) parts.push(combinedText);
          parts.push(toolLines.join('\n\n'));
          parts.push(resultLines.join('\n\n'));
          result.push({ role: 'assistant', content: parts.join('\n\n') });

          const cleanedNext = cleanContent(nextText);
          if (cleanedNext) result.push({ role: 'user', content: cleanedNext });

          i += 2; continue;
        }
      }

      const toolLines = toolUses.map(tu => toolCallToTag(tu.name, tu.input));
      if (combinedText.trim()) combinedText += '\n\n';
      combinedText += toolLines.join('\n\n');
      if (combinedText.trim()) result.push({ role: 'assistant', content: combinedText });
      i++;

    } else if (m.role === 'user') {
      const textPart = extractTextFromBlocks(m.content);
      const toolResults = m.content.filter(b => b.type === 'tool_result');
      const cleanedText = cleanContent(textPart);

      if (cleanedText) {
        result.push({ role: 'user', content: cleanedText });
      } else if (toolResults.length > 0) {
        const resultText = toolResults.map(tr => {
          const prefix = tr.is_error ? '[Tool Error]' : '[Tool Result]';
          return `${prefix}\n${extractToolResultText(tr)}`;
        }).join('\n\n');
        result.push({ role: 'user', content: resultText });
      }
      i++;
    } else {
      const textPart = extractTextFromBlocks(m.content);
      const cleaned = cleanContent(textPart);
      if (cleaned) result.push({ role: m.role, content: cleaned });
      i++;
    }
  }

  let firstSys = -1;
  for (let j = 0; j < result.length; j++) {
    if (result[j] && result[j].role === 'system') {
      if (firstSys === -1) { firstSys = j; }
      else { result[firstSys].content += '\n\n' + result[j].content; result[j] = null; }
    }
  }

  return result.filter(Boolean);
}

function convertOpenAIMessages(messages, tools) {
  const systemParts = [];

  const toolPrompt = toolsToSystemPrompt(tools);
  if (toolPrompt) systemParts.push(toolPrompt);

  for (const m of messages) {
    if (m.role === 'system') {
      const text = typeof m.content === 'string' ? m.content :
        Array.isArray(m.content) ? m.content.map(c => c.text || c.content || '').join('\n') : '';
      const cleaned = cleanContent(text);
      if (cleaned) systemParts.push(cleaned);
    }
  }

  const result = [];
  if (systemParts.length > 0) {
    result.push({ role: 'system', content: systemParts.join('\n\n') });
  }

  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    if (m.role === 'system') { i++; continue; }

    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const text = typeof m.content === 'string' ? m.content :
        Array.isArray(m.content) ? m.content.map(c => c.text || c.content || '').join('\n') : '';
      const toolLines = m.tool_calls.map((tc) => {
        const fn = tc.function || {};
        let args;
        if (typeof fn.arguments === 'string') {
          try { args = JSON.parse(fn.arguments); } catch { args = { value: fn.arguments }; }
        } else {
          args = fn.arguments || {};
        }
        return toolCallToTag(fn.name || 'unknown', args);
      });
      const parts = [text, ...toolLines].filter(Boolean);

      let j = i + 1;
      const resultLines = [];
      while (j < messages.length && messages[j].role === 'tool') {
        const tr = messages[j];
        const out = typeof tr.content === 'string' ? tr.content :
          Array.isArray(tr.content) ? tr.content.map(c => c.text || c.content || '').join('\n') : '';
        resultLines.push(`[Tool Result]\n${out}`);
        j++;
      }
      if (resultLines.length > 0) {
        parts.push(resultLines.join('\n\n'));
        i = j;
      } else {
        i++;
      }

      const cleaned = cleanContent(parts.join('\n\n'));
      if (cleaned) result.push({ role: 'assistant', content: cleaned });
      continue;
    }

    if (m.role === 'tool') {
      const out = typeof m.content === 'string' ? m.content :
        Array.isArray(m.content) ? m.content.map(c => c.text || c.content || '').join('\n') : '';
      const cleaned = cleanContent(`[Tool Result]\n${out}`);
      if (cleaned) result.push({ role: 'user', content: cleaned });
      i++;
      continue;
    }

    let content = '';
    if (typeof m.content === 'string') content = m.content;
    else if (Array.isArray(m.content)) content = m.content.map(c => c.text || c.content || '').join('\n');
    const cleaned = cleanContent(content);
    if (cleaned) result.push({ role: m.role, content: cleaned });
    i++;
  }

  let firstSys = -1;
  for (let j = 0; j < result.length; j++) {
    if (result[j] && result[j].role === 'system') {
      if (firstSys === -1) { firstSys = j; }
      else { result[firstSys].content += '\n\n' + result[j].content; result[j] = null; }
    }
  }

  return result.filter(Boolean);
}

function estimateInputTokens(system, messages, tools) {
  let totalText = '';
  if (system) {
    if (typeof system === 'string') totalText += system;
    else if (Array.isArray(system)) {
      for (const b of system) totalText += b.text || '';
    }
  }
  if (Array.isArray(messages)) {
    for (const m of messages) {
      if (typeof m.content === 'string') totalText += m.content;
      else if (Array.isArray(m.content)) {
        for (const b of m.content) {
          totalText += b.text || '';
          if (b.input) totalText += JSON.stringify(b.input);
          if (b.content) {
            if (typeof b.content === 'string') totalText += b.content;
            else if (Array.isArray(b.content)) {
              for (const c of b.content) totalText += c.text || '';
            }
          }
        }
      }
    }
  }
  if (Array.isArray(tools)) {
    totalText += JSON.stringify(tools);
  }
  return estimateTokens(totalText);
}

function convertResponsesInput(input, instructions) {
  const messages = [];

  if (instructions) {
    const text = typeof instructions === 'string'
      ? instructions
      : (Array.isArray(instructions) ? extractTextFromBlocks(instructions) : JSON.stringify(instructions));
    const cleaned = cleanContent(text);
    if (cleaned) messages.push({ role: 'system', content: cleaned });
  }

  if (typeof input === 'string') {
    if (input.trim()) messages.push({ role: 'user', content: cleanContent(input) });
    return messages;
  }

  if (!Array.isArray(input)) return messages;

  for (const item of input) {
    if (typeof item === 'string') {
      if (item.trim()) messages.push({ role: 'user', content: cleanContent(item) });
      continue;
    }
    if (!item || typeof item !== 'object') continue;

    if (item.type === 'message' || item.role) {
      const role = item.role || 'user';
      let content = '';
      if (typeof item.content === 'string') content = item.content;
      else if (Array.isArray(item.content)) {
        content = item.content.map(c => (c && (c.text || c.content)) || '').join('\n');
      }
      const cleaned = cleanContent(content);
      if (cleaned) messages.push({ role, content: cleaned });
    }
    else if (item.type === 'function_call') {
      const name = item.name || 'unknown';
      let args;
      if (typeof item.arguments === 'object' && item.arguments !== null) {
        args = item.arguments;
      } else {
        const raw = String(item.arguments || '');
        try { args = JSON.parse(raw); } catch { args = { value: raw }; }
      }
      messages.push({ role: 'assistant', content: toolCallToTag(name, args) });
    }
    else if (item.type === 'function_call_output') {
      const output = typeof item.output === 'string' ? item.output : JSON.stringify(item.output || '');
      messages.push({ role: 'user', content: `[Tool Result]\n${cleanContent(output)}` });
    }
  }

  return messages;
}

function toResponsesUsage(usage) {
  if (!usage) return { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  return {
    input_tokens: usage.prompt_tokens || 0,
    output_tokens: usage.completion_tokens || 0,
    total_tokens: usage.total_tokens || 0,
    output_tokens_details: {
      reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens || 0,
    },
  };
}

function toResponsesFormat(chatResult, model) {
  const message = chatResult.choices?.[0]?.message || {};
  const text = message.content || '';
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

  const output = [];
  if (text) {
    output.push({
      id: `msg_${uuidv4()}`,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text }],
    });
  }
  for (const tc of toolCalls) {
    output.push({
      id: `fc_${uuidv4()}`,
      type: 'function_call',
      status: 'completed',
      name: tc.function?.name || '',
      arguments: tc.function?.arguments || '',
      call_id: tc.id || `call_${uuidv4()}`,
    });
  }
  if (output.length === 0) {
    output.push({
      id: `msg_${uuidv4()}`,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: '' }],
    });
  }

  return {
    id: `resp_${uuidv4()}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model: chatResult.model || model,
    output,
    usage: toResponsesUsage(chatResult.usage),
  };
}

function safeJSON(str) {
  try { return JSON.parse(str); } catch { return null; }
}

async function writeResponsesStream(chatStream, model, res) {
  const respId = `resp_${uuidv4()}`;
  const itemId = `msg_${uuidv4()}`;
  const created = Math.floor(Date.now() / 1000);

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const baseResponse = (status) => ({
    id: respId, object: 'response', created_at: created, status,
    model, output: [],
  });

  send('response.created', { type: 'response.created', response: baseResponse('in_progress') });
  send('response.in_progress', { type: 'response.in_progress', response: baseResponse('in_progress') });
  send('response.output_item.added', {
    type: 'response.output_item.added',
    output_index: 0,
    item: { id: itemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
  });
  send('response.content_part.added', {
    type: 'response.content_part.added',
    item_id: itemId, output_index: 0, content_index: 0,
    part: { type: 'output_text', text: '' },
  });

  let accumulated = '';
  let usage = null;
  const toolCalls = new Map(); // index -> { id, name, arguments, itemId, outputIndex }

  const ensureToolItem = (tc, index) => {
    if (!toolCalls.has(index)) {
      const call = {
        id: tc.id || `call_${uuidv4()}`,
        name: tc.function?.name || '',
        arguments: '',
        itemId: `fc_${uuidv4()}`,
        outputIndex: 1 + index,
      };
      toolCalls.set(index, call);
      send('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: call.outputIndex,
        item: {
          id: call.itemId, type: 'function_call', status: 'in_progress',
          name: call.name, arguments: '', call_id: call.id,
        },
      });
    }
    return toolCalls.get(index);
  };

  for await (const chunkLine of chatStream) {
    const line = chunkLine.trim();
    const m = line.match(/^data: (.+)$/);
    if (!m) continue;
    const payload = safeJSON(m[1]);
    if (!payload) continue;
    // usage chunk: choices 为空数组，仅携带 usage（done 前由 openai-format 输出）
    if (payload.choices && payload.choices.length === 0 && payload.usage) {
      usage = payload.usage;
      continue;
    }
    if (!payload.choices || !payload.choices[0]) continue;

    const delta = payload.choices[0].delta || {};
    if (delta.content) {
      accumulated += delta.content;
      send('response.output_text.delta', {
        type: 'response.output_text.delta',
        item_id: itemId, output_index: 0, content_index: 0,
        delta: delta.content,
      });
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const index = tc.index || 0;
        const call = ensureToolItem(tc, index);
        if (tc.function?.name && !call.name) {
          call.name = tc.function.name;
        }
        if (tc.function?.arguments) {
          call.arguments += tc.function.arguments;
          send('response.function_call_arguments.delta', {
            type: 'response.function_call_arguments.delta',
            item_id: call.itemId, output_index: call.outputIndex,
            delta: tc.function.arguments,
          });
        }
      }
    }
  }

  // 文本消息收尾
  send('response.output_text.done', {
    type: 'response.output_text.done',
    item_id: itemId, output_index: 0, content_index: 0,
    text: accumulated,
  });
  send('response.content_part.done', {
    type: 'response.content_part.done',
    item_id: itemId, output_index: 0, content_index: 0,
    part: { type: 'output_text', text: accumulated },
  });
  send('response.output_item.done', {
    type: 'response.output_item.done',
    output_index: 0,
    item: {
      id: itemId, type: 'message', status: 'completed', role: 'assistant',
      content: [{ type: 'output_text', text: accumulated }],
    },
  });

  // 工具调用收尾
  for (const [, call] of toolCalls) {
    send('response.function_call_arguments.done', {
      type: 'response.function_call_arguments.done',
      item_id: call.itemId, output_index: call.outputIndex,
      arguments: call.arguments,
    });
    send('response.output_item.done', {
      type: 'response.output_item.done',
      output_index: call.outputIndex,
      item: {
        id: call.itemId, type: 'function_call', status: 'completed',
        name: call.name, arguments: call.arguments, call_id: call.id,
      },
    });
  }

  const finalOutput = [];
  if (accumulated) {
    finalOutput.push({
      id: itemId, type: 'message', status: 'completed', role: 'assistant',
      content: [{ type: 'output_text', text: accumulated }],
    });
  }
  for (const [, call] of toolCalls) {
    finalOutput.push({
      id: call.itemId, type: 'function_call', status: 'completed',
      name: call.name, arguments: call.arguments, call_id: call.id,
    });
  }
  if (finalOutput.length === 0) {
    finalOutput.push({
      id: itemId, type: 'message', status: 'completed', role: 'assistant',
      content: [{ type: 'output_text', text: '' }],
    });
  }

  const finalResponse = {
    ...baseResponse('completed'),
    output: finalOutput,
    usage: toResponsesUsage(usage),
  };
  send('response.completed', { type: 'response.completed', response: finalResponse });
  send('response.done', { type: 'response.done', response: finalResponse });
}

/**
 * Start the Trae -> OpenAI/Anthropic proxy server.
 *
 * @param {object} [options] - Overrides for env-based config
 * @param {number} [options.port] - Listen port (default: env PORT or 9220)
 * @param {string} [options.host] - Listen host (default: env HOST or 127.0.0.1)
 * @param {string} [options.apiKey] - API key required by clients (default: env API_KEY)
 * @param {string} [options.edition] - Trae edition: cn/solo/sg/solo-sg (default: env TRAE_EDITION or cn)
 * @param {string} [options.manualToken] - Manual token fallback (default: env TRAE_MANUAL_TOKEN)
 * @param {string} [options.baseUrl] - Upstream API base URL (default: auto by edition)
 * @param {boolean} [options.quiet] - Suppress banner logs
 * @returns {{app: object, server: object, port: number, edition: string, baseUrl: string, authOk: boolean}}
 */
function startServer(options = {}) {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  const PORT = parseInt(options.port || process.env.PORT || '9220', 10);
  const HOST = options.host || process.env.HOST || '127.0.0.1';
  const rawApiKey = options.apiKey !== undefined ? options.apiKey : (process.env.API_KEY ?? '');
  const API_KEY = rawApiKey === '' ? 'trae-local-api' : rawApiKey;
  const AUTH_ENABLED = String(API_KEY).toLowerCase() !== 'none';
  const EDITION = (options.edition || process.env.TRAE_EDITION || 'cn').toLowerCase();
  const MANUAL_TOKEN = options.manualToken || process.env.TRAE_MANUAL_TOKEN || '';

  let BASE_URL = options.baseUrl || process.env.BASE_URL || DEFAULT_BASE_URLS[EDITION] || DEFAULT_BASE_URLS.cn;
  let effectiveEdition = EDITION;

  // Lightweight request accounting, surfaced via the returned handle (and the
  // DSH plugin's settings page). Deliberately allocation-free per request.
  const stats = {
    startedAt: Date.now(),
    requests: { chat: 0, messages: 0, countTokens: 0, responses: 0, models: 0, status: 0 },
    errors: 0,
    lastRequestAt: null,
    lastError: null,
  };
  function track(kind) {
    stats.lastRequestAt = Date.now();
    if (stats.requests[kind] !== undefined) stats.requests[kind] += 1;
  }
  function trackError(message) {
    stats.errors += 1;
    stats.lastError = { message: String(message).slice(0, 300), at: new Date().toISOString() };
  }

  function requireAuth(req, res, next) {
    if (!AUTH_ENABLED) return next();
    const authHeader = req.headers.authorization || '';
    const bearerToken = authHeader.replace(/^Bearer\s+/i, '').trim();
    const xApiKey = req.headers['x-api-key'] || '';
    const token = bearerToken || xApiKey;
    if (token !== API_KEY) {
      return sendAnthropicError(res, 401, 'authentication_error', 'Invalid API key');
    }
    next();
  }

  app.use((req, res, next) => {
    console.log(`[server] ${req.method} ${req.path}`);
    const origin = req.headers.origin || '';
    if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin)) {
      res.header('Access-Control-Allow-Origin', origin);
      res.header('Vary', 'Origin');
      res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.header('Access-Control-Allow-Headers', '*');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.get('/v1/status', requireAuth, (req, res) => {
    track('status');
    res.json({
      status: 'ok',
      edition: effectiveEdition,
      base_url: BASE_URL,
      has_token: !!auth.getToken(),
      host: HOST,
      port: PORT,
    });
  });

  app.get('/v1/models', requireAuth, async (req, res) => {
    track('models');
    try {
      const models = await traeClient.getModels(BASE_URL);
      res.json({ object: 'list', data: models });
    } catch (err) {
      return sendAnthropicError(res, 500, 'api_error', err.message);
    }
  });

  app.post('/v1/chat/completions', requireAuth, async (req, res) => {
    const { messages, model = 'auto', stream = false, tools, max_tokens } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return sendAnthropicError(res, 400, 'invalid_request_error', 'messages is required');
    }
    track('chat');

    console.log(`[server] OpenAI request: model=${model}, stream=${stream}, messages=${messages.length}`);

    const converted = convertOpenAIMessages(messages, tools);
    console.log(`[server] Converted: ${messages.length} -> ${converted.length} messages`);

    try {
      const { response: fetchResp, model: usedModel } = await traeClient.sendChatRequest(
        converted, model, stream, BASE_URL, { maxTokens: max_tokens }
      );

      if (stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        const sseStream = await handleOpenAIResponse(fetchResp, usedModel, true);
        for await (const chunk of sseStream) { res.write(chunk); }
        res.end();
      } else {
        const result = await handleOpenAIResponse(fetchResp, usedModel, false);
        res.json(result);
      }
    } catch (err) {
      console.error(`[server] Chat error: ${err.message}`);
      trackError(err.message);
      const mapped = mapUpstreamStatus(err.status || 502);
      return sendAnthropicError(res, mapped.status, mapped.type, `Trae API error: ${err.message}`);
    }
  });

  app.post('/v1/messages/count_tokens', requireAuth, (req, res) => {
    track('countTokens');
    const { messages, system, tools } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return sendAnthropicError(res, 400, 'invalid_request_error', 'messages is required');
    }
    const inputTokens = estimateInputTokens(system, messages, tools);
    res.json({ input_tokens: inputTokens });
  });

  app.post('/v1/messages', requireAuth, async (req, res) => {
    const { messages, model = 'auto', stream = false, max_tokens = 4096, system, tools } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return sendAnthropicError(res, 400, 'invalid_request_error', 'messages is required');
    }
    track('messages');

    const bodySize = JSON.stringify(req.body).length;
    console.log(`[server] Anthropic request: model=${model}, stream=${stream}, msgs=${messages.length}, tools=${tools?.length || 0}, body=${bodySize} bytes`);

    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      const types = Array.isArray(m.content) ? m.content.map(b => b.type).join('+') : typeof m.content;
      console.log(`[server]   in[${i}] role=${m.role}, types=${types}`);
    }

    const converted = convertAnthropicMessages(messages, system, tools);

    const totalSize = JSON.stringify(converted).length;
    console.log(`[server] Converted: ${messages.length} -> ${converted.length} messages, ${totalSize} bytes`);
    for (let i = 0; i < converted.length; i++) {
      const m = converted[i];
      const len = typeof m.content === 'string' ? m.content.length : 0;
      const preview = typeof m.content === 'string' ? m.content.substring(0, 80).replace(/\n/g, '\\n') : '';
      console.log(`[server]   out[${i}] role=${m.role}, len=${len}, preview=${preview}`);
    }

    const inputTokens = estimateInputTokens(system, messages, tools);

    try {
      const { response: fetchResp, model: usedModel } = await traeClient.sendChatRequest(
        converted, model, stream, BASE_URL, { maxTokens: max_tokens }
      );

      if (stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        const sseStream = await handleAnthropicResponse(fetchResp, usedModel, true, inputTokens);
        for await (const chunk of sseStream) { res.write(chunk); }
        res.end();
      } else {
        const result = await handleAnthropicResponse(fetchResp, usedModel, false, inputTokens);
        res.json(result);
      }
    } catch (err) {
      console.error(`[server] Anthropic error: ${err.message}`);
      trackError(err.message);
      const mapped = mapUpstreamStatus(err.status || 502);
      return sendAnthropicError(res, mapped.status, mapped.type, `Trae API error: ${err.message}`);
    }
  });

  app.post('/v1/responses', requireAuth, async (req, res) => {
    const { input, model = 'auto', stream = false, instructions, tools, max_output_tokens } = req.body;

    if (input === undefined || input === null) {
      return res.status(400).json({ error: { message: 'input is required', type: 'invalid_request_error' } });
    }
    track('responses');

    console.log(`[server] Responses request: model=${model}, stream=${stream}, input=${typeof input === 'string' ? 'str' : `array(${input.length})`}`);

    const converted = convertResponsesInput(input, instructions);
    const toolPrompt = toolsToSystemPrompt(tools);
    if (toolPrompt) {
      const sysIdx = converted.findIndex(m => m.role === 'system');
      if (sysIdx >= 0) converted[sysIdx].content += '\n\n' + toolPrompt;
      else converted.unshift({ role: 'system', content: toolPrompt });
    }
    console.log(`[server] Converted: -> ${converted.length} messages`);

    try {
      const { response: fetchResp, model: usedModel } = await traeClient.sendChatRequest(
        converted, model, stream, BASE_URL, { maxTokens: max_output_tokens }
      );

      if (stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        const chatStream = await handleOpenAIResponse(fetchResp, usedModel, true);
        await writeResponsesStream(chatStream, usedModel, res);
        res.end();
      } else {
        const chatResult = await handleOpenAIResponse(fetchResp, usedModel, false);
        res.json(toResponsesFormat(chatResult, usedModel));
      }
    } catch (err) {
      console.error(`[server] Responses error: ${err.message}`);
      trackError(err.message);
      const mapped = mapUpstreamStatus(err.status || 502);
      return res.status(mapped.status).json({ error: { message: `Trae API error: ${err.message}`, type: mapped.type } });
    }
  });

  app.use((req, res) => {
    console.log(`[server] Unknown route: ${req.method} ${req.path}`);
    res.status(404).json({ error: { message: `Not found: ${req.method} ${req.path}`, type: 'not_found' } });
  });

  // Initialize auth (tolerate failure — caller decides whether to exit)
  let authOk = false;
  try {
    auth.initAuth(EDITION, MANUAL_TOKEN);
    authOk = true;
  } catch (err) {
    console.error(`[server] Auth initialization failed: ${err.message}`);
    console.error('[server] Ensure a Trae IDE is installed and logged in, or run: npm run setup');
  }

  // auth.initAuth may auto-detect a different edition — sync BASE_URL accordingly
  if (!options.baseUrl && !process.env.BASE_URL) {
    effectiveEdition = (process.env.TRAE_EDITION || EDITION).toLowerCase();
    BASE_URL = DEFAULT_BASE_URLS[effectiveEdition] || DEFAULT_BASE_URLS.cn;
  }

  const server = app.listen(PORT, HOST, () => {
    if (!options.quiet) {
      console.log('');
      console.log(`=== Trae Local API Server v${pkg.version} ===`);
      console.log('');
    }
    console.log(`[server] Running on http://${HOST}:${PORT}`);
    console.log(`[server] Edition: ${effectiveEdition.toUpperCase()}`);
    console.log(`[server] Base URL: ${BASE_URL}`);
    console.log(`[server] API Key: ${AUTH_ENABLED ? '***' : '(auth disabled)'}`);
    console.log(`[server] Auth: ${authOk ? 'OK' : 'FAILED'}`);
    if (!options.quiet) {
      console.log('');
      console.log('Endpoints:');
      console.log(`  GET  http://localhost:${PORT}/v1/status`);
      console.log(`  GET  http://localhost:${PORT}/v1/models`);
      console.log(`  POST http://localhost:${PORT}/v1/chat/completions  (OpenAI)`);
      console.log(`  POST http://localhost:${PORT}/v1/messages          (Anthropic)`);
      console.log('');
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[server] Port ${PORT} is already in use — stop the other process or set PORT.`);
    } else {
      console.error(`[server] Server error: ${err.message}`);
    }
  });

  return { app, server, port: PORT, host: HOST, edition: effectiveEdition, baseUrl: BASE_URL, authOk, stats, apiKey: API_KEY, authEnabled: AUTH_ENABLED };
}

module.exports = { startServer, DEFAULT_BASE_URLS };