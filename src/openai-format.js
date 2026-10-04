/**
 * openai-format.js - Convert Trae SSE events to OpenAI-compatible format
 *
 * Supports:
 *   - text content chunks
 *   - tool_calls (parsed from <tool_call>...</tool_call> or [Called tool: name] text)
 *   - reasoning content wrapped in <think>...</think>
 *   - finish_reason = tool_calls when tool calls detected
 *   - token usage passthrough (from upstream token_usage event)
 */

const { v4: uuidv4 } = require('uuid');

const OPEN_TAG = '<tool_call>';
const CLOSE_TAG = '</tool_call>';
const CALLED_PREFIX = '[Called tool: ';
const RESULT_MARKER = '\n[Tool Result]';
const ERROR_MARKER = '\n[Tool Error]';
const CALLED_MARKER = '\n[Called tool: ';

// Extract the first complete JSON object/array from a string, or null.
function extractFirstJson(text) {
  const startIdx = text.search(/[{[]/);
  if (startIdx === -1) return null;
  let inStr = false;
  let escape = false;
  let depth = 0;
  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return text.substring(startIdx, i + 1);
    }
  }
  return null;
}

// Lenient JSON parse. Models frequently emit real (unescaped) newlines / tabs
// / carriage returns inside JSON string values — e.g. multi-line markdown
// passed to a `write` tool — which strict JSON.parse rejects and makes the
// whole <tool_call> fall through as plain text. Escape such characters inside
// string literals, then try parsing again.
function repairJson(text) {
  let out = '';
  let inStr = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escape) {
        if (ch === '\n') out += '\\n';
        else if (ch === '\r') out += '\\r';
        else if (ch === '\t') out += '\\t';
        else out += ch;
        escape = false;
      } else if (ch === '\\') {
        out += ch;
        escape = true;
      } else if (ch === '"') {
        inStr = false;
        out += ch;
      } else if (ch === '\n') {
        out += '\\n';
      } else if (ch === '\r') {
        out += '\\r';
      } else if (ch === '\t') {
        out += '\\t';
      } else {
        out += ch;
      }
    } else {
      if (ch === '"') {
        inStr = true;
        out += ch;
      } else {
        out += ch;
      }
    }
  }
  try { return JSON.parse(out); } catch { return null; }
}

// Find the position of a <think> or <thinking> opening tag (with optional
// trailing whitespace) starting from `from`.
function findThinkOpen(text, from) {
  let idx = text.indexOf('<think', from);
  while (idx !== -1) {
    const gt = text.indexOf('>', idx);
    const tagBody = gt === -1 ? text.substring(idx) : text.substring(idx, gt + 1);
    if (/^<think(ing)?\s*>$/.test(tagBody)) return idx;
    idx = text.indexOf('<think', idx + 5);
  }
  return -1;
}

function skipThinkOpen(text, idx) {
  const gt = text.indexOf('>', idx);
  return gt === -1 ? text.length : gt + 1;
}

const THINK_OPEN = '<think';
const THINK_CLOSE = '</think';

// If the tail of `text` is a prefix of a <think / </think tag, return how many
// characters should be held back so a tag split across chunks is not emitted
// as plain text.
function holdTagPrefix(text, tag) {
  const max = Math.min(tag.length - 1, text.length);
  for (let k = max; k >= 1; k--) {
    if (tag.startsWith(text.substring(text.length - k))) return k;
  }
  return 0;
}

// Streaming state machine that separates <think>...</think> blocks (or
// <thinking>...</thinking>) from regular assistant text. Models such as DSH
// emit their chain-of-thought inside such tags directly in the response text;
// clients choke on the raw tags, so we pull the reasoning out and expose it
// via a dedicated field instead.
class ThinkExtractor {
  constructor() {
    this.state = 'text'; // 'text' | 'think'
    this.thinkBuf = '';
    this.pendingOpen = '';
    this.pendingClose = '';
  }

  push(text) {
    if (this.pendingOpen) {
      text = this.pendingOpen + text;
      this.pendingOpen = '';
    }
    if (this.pendingClose) {
      text = this.pendingClose + text;
      this.pendingClose = '';
    }
    let content = '';
    let reasoning = '';
    let i = 0;
    while (i < text.length) {
      if (this.state === 'text') {
        const start = findThinkOpen(text, i);
        if (start === -1) {
          const rest = text.substring(i);
          const held = holdTagPrefix(rest, THINK_OPEN);
          if (held) {
            content += rest.substring(0, rest.length - held);
            this.pendingOpen = rest.substring(rest.length - held);
          } else {
            content += rest;
          }
          break;
        }
        content += text.substring(i, start);
        i = skipThinkOpen(text, start);
        this.state = 'think';
      } else {
        const end = text.indexOf('</think', i);
        if (end === -1) {
          const rest = text.substring(i);
          const held = holdTagPrefix(rest, THINK_CLOSE);
          if (held) {
            this.thinkBuf += rest.substring(0, rest.length - held);
            this.pendingClose = rest.substring(rest.length - held);
          } else {
            this.thinkBuf += rest;
          }
          break;
        }
        this.thinkBuf += text.substring(i, end);
        const gt = text.indexOf('>', end);
        reasoning += this.thinkBuf;
        this.thinkBuf = '';
        i = gt === -1 ? text.length : gt + 1;
        this.state = 'text';
      }
    }
    return { content, reasoning };
  }

  // Returns { text, think }: `text` is any deferred plain text (an unconfirmed
  // tag prefix), `think` is the unclosed reasoning buffer (dropped by callers).
  flush() {
    const text = this.pendingOpen || '';
    const think = this.thinkBuf + (this.pendingClose || '');
    this.pendingOpen = '';
    this.pendingClose = '';
    this.thinkBuf = '';
    this.state = 'text';
    return { text, think };
  }
}

function parseToolCalls(text) {
  const parser = new StreamingToolCallParser();
  parser.push(text);
  const blocks = parser.takeBlocks();
  return blocks.concat(parser.flush());
}

// Stream-friendly parser that recognises BOTH upstream tool-call text formats:
//   <tool_call>{"name":"...","arguments":{...}}</tool_call>
//   [Called tool: name]
//   {json args}
// The second form is what the model mimics from history messages, so we must
// recognise it too, otherwise tool calls pass through as plain text.
class StreamingToolCallParser {
  constructor() {
    this.buffer = '';
    this.state = 'text'; // 'text' | 'tag' | 'called-name' | 'called-args'
    this.currentName = null;
  }

  push(chunk) {
    this.buffer += chunk;
  }

  takeBlocks() {
    const blocks = [];
    let guard = 0;
    while (guard++ < 10000) {
      if (this.state === 'text') {
        const tagIdx = this.buffer.indexOf(OPEN_TAG);
        const calledIdx = this.buffer.indexOf(CALLED_PREFIX);
        let startIdx = -1;
        let marker = null;
        if (tagIdx === -1 && calledIdx === -1) {
          const partialIdx = this.findPartialPrefix();
          if (partialIdx >= 0) {
            if (partialIdx > 0) {
              blocks.push({ type: 'text', text: this.buffer.substring(0, partialIdx) });
            }
            this.buffer = this.buffer.substring(partialIdx);
            break;
          }
          if (this.buffer) blocks.push({ type: 'text', text: this.buffer });
          this.buffer = '';
          break;
        }
        if (tagIdx === -1) { startIdx = calledIdx; marker = 'called'; }
        else if (calledIdx === -1) { startIdx = tagIdx; marker = 'tag'; }
        else if (tagIdx < calledIdx) { startIdx = tagIdx; marker = 'tag'; }
        else { startIdx = calledIdx; marker = 'called'; }
        if (startIdx > 0) blocks.push({ type: 'text', text: this.buffer.substring(0, startIdx) });
        if (marker === 'tag') {
          this.buffer = this.buffer.substring(startIdx + OPEN_TAG.length);
          this.state = 'tag';
        } else {
          this.buffer = this.buffer.substring(startIdx + CALLED_PREFIX.length);
          this.state = 'called-name';
        }
      } else if (this.state === 'tag') {
        const endIdx = this.buffer.indexOf(CLOSE_TAG);
        if (endIdx === -1) break;
        const jsonStr = this.buffer.substring(0, endIdx).trim();
        this.buffer = this.buffer.substring(endIdx + CLOSE_TAG.length);
        this.emitTaggedBlock(blocks, jsonStr);
        this.state = 'text';
      } else if (this.state === 'called-name') {
        const closeIdx = this.buffer.indexOf(']');
        if (closeIdx === -1) break;
        this.currentName = this.buffer.substring(0, closeIdx).trim();
        this.buffer = this.buffer.substring(closeIdx + 1);
        this.state = 'called-args';
      } else if (this.state === 'called-args') {
        let bestIdx = -1;
        const scan = (marker) => {
          const idx = this.buffer.indexOf(marker);
          if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) bestIdx = idx;
        };
        scan(RESULT_MARKER);
        scan(ERROR_MARKER);
        scan(CALLED_MARKER);
        scan(OPEN_TAG);
        scan(CLOSE_TAG);
        if (bestIdx === -1) break;
        const argsStr = this.buffer.substring(0, bestIdx).trim();
        // 边界标记本身保留在 buffer 中，交给 text 状态继续处理（如 [Tool Result] 文本）
        this.buffer = this.buffer.substring(bestIdx);
        this.emitCalledTool(blocks, argsStr, false);
        this.state = 'text';
      }
    }
    return blocks;
  }

  emitTaggedBlock(blocks, jsonStr) {
    let parsed = null;
    try { parsed = JSON.parse(jsonStr); } catch { /* not json */ }
    if (!parsed) parsed = repairJson(jsonStr);
    if (parsed && parsed.name) {
      blocks.push({
        type: 'tool_use',
        name: parsed.name,
        input: parsed.arguments || parsed.input || parsed.parameters || {},
      });
    } else {
      blocks.push({ type: 'text', text: OPEN_TAG + jsonStr + CLOSE_TAG });
    }
  }

  emitCalledTool(blocks, argsStr, flushMode) {
    const trimmed = (argsStr || '').trim();
    let jsonStr = null;
    let rest = '';
    if (trimmed) {
      let parsed = null;
      try { parsed = JSON.parse(trimmed); } catch { /* not pure json */ }
      if (!parsed) parsed = repairJson(trimmed);
      if (parsed !== null) {
        jsonStr = trimmed;
      } else {
        const json = extractFirstJson(trimmed);
        if (json) {
          const startIdx = trimmed.indexOf(json);
          jsonStr = json;
          const before = trimmed.substring(0, startIdx).trim();
          const after = trimmed.substring(startIdx + json.length).trim();
          rest = [before, after].filter(Boolean).join('\n');
        }
      }
    }
    let input;
    if (jsonStr !== null) {
      try { input = JSON.parse(jsonStr); } catch { input = repairJson(jsonStr) || trimmed; }
    } else {
      input = trimmed;
    }
    blocks.push({ type: 'tool_use', name: this.currentName || 'unknown', input });
    if (rest) {
      if (flushMode) blocks.push({ type: 'text', text: rest });
      else this.buffer = rest + this.buffer;
    }
  }

  findPartialPrefix() {
    const tags = [OPEN_TAG, CALLED_PREFIX];
    let best = -1;
    for (const tag of tags) {
      const maxLen = Math.min(tag.length, this.buffer.length);
      for (let len = maxLen; len >= 1; len--) {
        const tail = this.buffer.substring(this.buffer.length - len);
        if (tag.startsWith(tail)) {
          const idx = this.buffer.length - len;
          if (best === -1 || idx < best) best = idx;
          break;
        }
      }
    }
    return best;
  }

  flush() {
    const blocks = [];
    if (this.state === 'tag') {
      // 模型可能省略了 </tool_call> 结束标签：若 buffer 中已含完整闭合的 JSON，
      // 尝试提取为工具调用，剩余散文保留为文本。
      const json = extractFirstJson(this.buffer);
      let parsed = null;
      if (json) {
        try { parsed = JSON.parse(json); } catch { /* not json */ }
        if (!parsed) parsed = repairJson(json);
      }
      if (parsed && parsed.name) {
        const startIdx = this.buffer.indexOf(json);
        const before = this.buffer.substring(0, startIdx);
        const after = this.buffer.substring(startIdx + json.length);
        const rest = (before + after).trim();
        blocks.push({
          type: 'tool_use',
          name: parsed.name,
          input: parsed.arguments || parsed.input || parsed.parameters || {},
        });
        if (rest) blocks.push({ type: 'text', text: rest });
      } else if (this.buffer) {
        blocks.push({ type: 'text', text: OPEN_TAG + this.buffer });
      }
      this.buffer = '';
      this.state = 'text';
    } else if (this.state === 'called-name') {
      if (this.buffer) blocks.push({ type: 'text', text: CALLED_PREFIX + this.buffer });
      this.buffer = '';
      this.state = 'text';
    } else if (this.state === 'called-args') {
      this.emitCalledTool(blocks, this.buffer, true);
      this.buffer = '';
      this.state = 'text';
    } else if (this.buffer) {
      blocks.push({ type: 'text', text: this.buffer });
      this.buffer = '';
    }
    return blocks;
  }
}

async function handleOpenAIResponse(fetchResponse, model, stream) {
  if (!stream) {
    return await collectNonStreaming(fetchResponse, model);
  }
  return streamGenerator(fetchResponse, model);
}

async function collectNonStreaming(fetchResponse, model) {
  const text = await fetchResponse.text();
  const events = parseSSE(text);

  let fullContent = '';
  let finishReason = 'stop';
  let reasoningContent = '';
  let usage = null;
  // 原生 tool_calls（SOLO 协议）：按 index 累积
  const nativeToolCalls = new Map();

  for (const { event, data } of events) {
    if (event === 'output') {
      const parsed = safeJSON(data);
      if (parsed) {
        if (parsed.reasoning_content) {
          reasoningContent += parsed.reasoning_content;
        }
        if (parsed.response) {
          fullContent += parsed.response;
        }
        if (Array.isArray(parsed.tool_calls)) {
          for (const tc of parsed.tool_calls) {
            const idx = typeof tc.index === 'number' ? tc.index : 0;
            const fn = tc.function_call || tc.function || {};
            if (!nativeToolCalls.has(idx)) {
              nativeToolCalls.set(idx, { id: '', name: '', arguments: '' });
            }
            const call = nativeToolCalls.get(idx);
            if (tc.id) call.id = tc.id;
            if (fn.name) call.name = fn.name;
            if (fn.arguments) call.arguments += fn.arguments;
          }
        }
        if (parsed.finish_reason) {
          finishReason = parsed.finish_reason;
        }
      }
    } else if (event === 'error') {
      // 上游在 SSE 流内返回错误（HTTP 仍是 200），必须抛出而不是静默返回空响应
      const parsedErr = safeJSON(data);
      const msg = (parsedErr && (parsedErr.message || parsedErr.msg)) || data.substring(0, 200);
      const code = (parsedErr && parsedErr.code) || 'unknown';
      throw new Error(`Trae upstream stream error (code=${code}): ${msg}`);
    } else if (event === 'token_usage') {
      const parsed = safeJSON(data);
      if (parsed && typeof parsed.prompt_tokens === 'number') {
        usage = {
          prompt_tokens: parsed.prompt_tokens,
          completion_tokens: parsed.completion_tokens || 0,
          total_tokens: parsed.total_tokens || 0,
          completion_tokens_details: {
            reasoning_tokens: parsed.reasoning_tokens || 0,
          },
        };
      }
    } else if (event === 'done') {
      const parsed = safeJSON(data);
      if (parsed && parsed.finish_reason) {
        finishReason = parsed.finish_reason;
      }
    }
  }

  // 提取 response 文本中的 <think>...</think> 块为 reasoning
  const thinkExtractor = new ThinkExtractor();
  const split = thinkExtractor.push(fullContent);
  const flushRes = thinkExtractor.flush();
  fullContent = split.content + (flushRes.text || '');
  if (split.reasoning) reasoningContent += split.reasoning;

  const blocks = parseToolCalls(fullContent);
  const toolCalls = [];
  let content = '';
  for (const block of blocks) {
    if (block.type === 'text') {
      content += block.text;
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: `call_${uuidv4().replace(/-/g, '').substring(0, 24)}`,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input) },
      });
    }
  }
  // 合入原生 tool_calls（优先于文本解析结果）
  if (nativeToolCalls.size > 0) {
    toolCalls.length = 0;
    content = fullContent;
    for (const [, call] of [...nativeToolCalls.entries()].sort((a, b) => a[0] - b[0])) {
      toolCalls.push({
        id: call.id || `call_${uuidv4().replace(/-/g, '').substring(0, 24)}`,
        type: 'function',
        function: { name: call.name, arguments: call.arguments || '{}' },
      });
    }
  }
  const hasToolUse = toolCalls.length > 0;

  return {
    id: `chatcmpl-${uuidv4()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content,
        ...(hasToolUse ? { tool_calls: toolCalls } : {}),
        ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
      },
      finish_reason: hasToolUse ? 'tool_calls' : finishReason,
    }],
    usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

async function* streamGenerator(fetchResponse, model) {
  const reader = fetchResponse.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });
  let buffer = '';
  let lastUsage = null;
  let currentEvent = null;
  const toolParser = new StreamingToolCallParser();
  const thinkExtractor = new ThinkExtractor();
  let toolIndex = 0;
  let outputtingToolCalls = false;
  let hasToolUse = false;

  const makeChunk = (delta, finishReason = null) => ({
    id: `chatcmpl-${uuidv4()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      delta,
      finish_reason: finishReason,
    }],
  });

  const emitContent = (text) => {
    if (!text) return;
    return `data: ${JSON.stringify(makeChunk({ content: text }))}\n\n`;
  };

  const emitReasoning = (text) => {
    if (!text) return;
    return `data: ${JSON.stringify(makeChunk({ reasoning_content: text }))}\n\n`;
  };

  const emitToolCall = (block) => {
    outputtingToolCalls = true;
    hasToolUse = true;
    const toolId = `call_${uuidv4().replace(/-/g, '').substring(0, 24)}`;
    let out = `data: ${JSON.stringify(makeChunk({
      tool_calls: [{
        index: toolIndex,
        id: toolId,
        type: 'function',
        function: { name: block.name, arguments: '' },
      }],
    }))}\n\n`;
    const argsStr = JSON.stringify(block.input);
    for (let i = 0; i < argsStr.length; i += 200) {
      out += `data: ${JSON.stringify(makeChunk({
        tool_calls: [{
          index: toolIndex,
          function: { arguments: argsStr.substring(i, i + 200) },
        }],
      }))}\n\n`;
    }
    toolIndex++;
    return out;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith('event:')) {
        currentEvent = trimmed.substring(6).trim();
        continue;
      }

      if (trimmed.startsWith('data:') && currentEvent) {
        const data = trimmed.substring(5).trim();
        const parsed = safeJSON(data);

        if (currentEvent === 'output' && parsed) {
          const reasoning = parsed.reasoning_content || '';
          const response = parsed.response || '';

          // 原生 tool_calls（SOLO 协议）：function_call 键，按 index 流式分段
          if (Array.isArray(parsed.tool_calls) && parsed.tool_calls.length > 0) {
            outputtingToolCalls = true;
            hasToolUse = true;
            for (const tc of parsed.tool_calls) {
              const fn = tc.function_call || tc.function || {};
              const deltaTc = { index: typeof tc.index === 'number' ? tc.index : 0 };
              if (tc.id) deltaTc.id = tc.id;
              if (tc.type) deltaTc.type = 'function';
              deltaTc.function = {
                ...(fn.name ? { name: fn.name } : {}),
                arguments: fn.arguments || '',
              };
              yield `data: ${JSON.stringify(makeChunk({ tool_calls: [deltaTc] }))}\n\n`;
            }
          }

          if (reasoning && !outputtingToolCalls) {
            const out = emitReasoning(reasoning);
            if (out) yield out;
          }

          if (response) {
            const split = thinkExtractor.push(response);
            if (split.reasoning && !outputtingToolCalls) {
              const out = emitReasoning(split.reasoning);
              if (out) yield out;
            }
            if (split.content) {
              toolParser.push(split.content);
              const blocks = toolParser.takeBlocks();
              for (const block of blocks) {
                if (block.type === 'text') {
                  if (outputtingToolCalls) continue;
                  const out = emitContent(block.text);
                  if (out) yield out;
                } else if (block.type === 'tool_use') {
                  yield emitToolCall(block);
                }
              }
            }
          }
        } else if (currentEvent === 'error') {
          // 上游在 SSE 流内返回错误（HTTP 仍是 200），必须抛出而不是静默返回空响应
          const msg = (parsed && (parsed.message || parsed.msg)) || data.substring(0, 200);
          const code = (parsed && parsed.code) || 'unknown';
          throw new Error(`Trae upstream stream error (code=${code}): ${msg}`);
        } else if (currentEvent === 'request_wait_in_queue' && parsed) {
          const pos = parsed.position || 0;
          yield `data: ${JSON.stringify(makeChunk({ content: `[Queued: position ${pos}]\n` }))}\n\n`;
        } else if (currentEvent === 'token_usage' && parsed && typeof parsed.prompt_tokens === 'number') {
          lastUsage = {
            prompt_tokens: parsed.prompt_tokens,
            completion_tokens: parsed.completion_tokens || 0,
            total_tokens: parsed.total_tokens || 0,
            completion_tokens_details: {
              reasoning_tokens: parsed.reasoning_tokens || 0,
            },
          };
        } else if (currentEvent === 'done') {
          const flushRes = thinkExtractor.flush();
          if (flushRes.text) {
            const out = emitContent(flushRes.text);
            if (out) yield out;
          }
          const finalBlocks = toolParser.flush();
          for (const block of finalBlocks) {
            if (block.type === 'text') {
              if (outputtingToolCalls) continue;
              const out = emitContent(block.text);
              if (out) yield out;
            } else if (block.type === 'tool_use') {
              yield emitToolCall(block);
            }
          }

          const finish = hasToolUse ? 'tool_calls' : (parsed.finish_reason || 'stop');
          yield `data: ${JSON.stringify(makeChunk({}, finish))}\n\n`;

          if (lastUsage) {
            yield `data: ${JSON.stringify({
              id: `chatcmpl-${uuidv4()}`,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [],
              usage: lastUsage,
            })}\n\n`;
          }
          yield 'data: [DONE]\n\n';
          return;
        }

        currentEvent = null;
      }
    }
  }

  // 流意外结束（无 done 事件）时补全
  const flushRes = thinkExtractor.flush();
  if (flushRes.text) {
    const out = emitContent(flushRes.text);
    if (out) yield out;
  }
  const finalBlocks = toolParser.flush();
  for (const block of finalBlocks) {
    if (block.type === 'text') {
      if (outputtingToolCalls) continue;
      const out = emitContent(block.text);
      if (out) yield out;
    } else if (block.type === 'tool_use') {
      yield emitToolCall(block);
    }
  }
  yield `data: ${JSON.stringify(makeChunk({}, hasToolUse ? 'tool_calls' : 'stop'))}\n\n`;
  yield 'data: [DONE]\n\n';
}

function parseSSE(text) {
  const events = [];
  const lines = text.split('\n');
  let currentEvent = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('event:')) {
      currentEvent = trimmed.substring(6).trim();
    } else if (trimmed.startsWith('data:') && currentEvent) {
      events.push({
        event: currentEvent,
        data: trimmed.substring(5).trim(),
      });
      currentEvent = null;
    }
  }

  return events;
}

function safeJSON(str) {
  try { return JSON.parse(str); } catch { return null; }
}

module.exports = { handleOpenAIResponse };
