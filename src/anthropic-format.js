/**
 * anthropic-format.js - Convert Trae SSE events to Anthropic-compatible format
 *
 * Supports:
 *   - text content block
 *   - tool_use content block (parsed from <tool_call>...</tool_call> or [Called tool: name] text)
 *   - ping event (Anthropic official streaming spec)
 *   - stop_reason = tool_use when tool calls detected
 *   - token usage estimation
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

function estimateTokens(text) {
    if (!text) return 0;
    let tokens = 0;
    for (const ch of text) {
        const code = ch.charCodeAt(0);
        if (code > 0x2000) tokens += 1.5;
        else tokens += 0.25;
    }
    return Math.ceil(tokens);
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
            try { input = JSON.parse(jsonStr); } catch { input = trimmed; }
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
            if (this.buffer) blocks.push({ type: 'text', text: OPEN_TAG + this.buffer });
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

async function handleAnthropicResponse(fetchResponse, model, stream, inputTokens) {
    const inTokens = inputTokens || 0;
    if (!stream) {
        return await collectNonStreaming(fetchResponse, model, inTokens);
    }
    return streamGenerator(fetchResponse, model, inTokens);
}

async function collectNonStreaming(fetchResponse, model, inputTokens) {
    const text = await fetchResponse.text();
    const lines = text.split('\n');
    let fullContent = '';
    let finishReason = 'end_turn';
    let usageData = null;

    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('event:output')) continue;
        if (trimmed.startsWith('data:')) {
            const data = trimmed.substring(5).trim();
            try {
                const parsed = JSON.parse(data);
                if (parsed.response) fullContent += parsed.response;
                if (parsed.finish_reason) {
                    finishReason = parsed.finish_reason === 'stop' ? 'end_turn' : parsed.finish_reason;
                }
                if (typeof parsed.prompt_tokens === 'number') {
                    usageData = parsed;
                }
            } catch {}
        }
    }

    const blocks = parseToolCalls(fullContent);
    const content = [];
    let hasToolUse = false;

    for (const block of blocks) {
        if (block.type === 'text') {
            if (block.text.trim()) {
                content.push({ type: 'text', text: block.text });
            }
        } else if (block.type === 'tool_use') {
            content.push({
                type: 'tool_use',
                id: `toolu_${uuidv4().replace(/-/g, '')}`,
                name: block.name,
                input: block.input,
            });
            hasToolUse = true;
        }
    }

    if (content.length === 0) {
        content.push({ type: 'text', text: '' });
    }

    const outputTokens = estimateTokens(fullContent);

    return {
        id: `msg_${uuidv4().replace(/-/g, '')}`,
        type: 'message',
        role: 'assistant',
        content,
        model,
        stop_reason: hasToolUse ? 'tool_use' : finishReason,
        stop_sequence: null,
        usage: {
            input_tokens: usageData ? usageData.prompt_tokens : inputTokens,
            output_tokens: usageData ? usageData.completion_tokens : outputTokens,
            cache_creation_input_tokens: usageData ? (usageData.cache_creation_input_tokens || 0) : 0,
            cache_read_input_tokens: usageData ? (usageData.cache_read_input_tokens || 0) : 0,
        },
    };
}

async function* streamGenerator(fetchResponse, model, inputTokens) {
    const reader = fetchResponse.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const msgId = `msg_${uuidv4().replace(/-/g, '')}`;
    const parser = new StreamingToolCallParser();

    let blockIndex = -1;
    let currentBlockType = null;
    let totalOutputText = '';
    let hasToolUse = false;
    let finishReason = 'end_turn';
    let doneReceived = false;
    let usageData = null;

    const messageStart = `event: message_start\ndata: ${JSON.stringify({
        type: 'message_start',
        message: {
            id: msgId,
            type: 'message',
            role: 'assistant',
            content: [],
            model,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: inputTokens, output_tokens: 0 },
        },
    })}\n\n`;

    const pingEvent = `event: ping\ndata: ${JSON.stringify({ type: 'ping' })}\n\n`;

    function startTextBlock() {
        blockIndex++;
        currentBlockType = 'text';
        return `event: content_block_start\ndata: ${JSON.stringify({
            type: 'content_block_start',
            index: blockIndex,
            content_block: { type: 'text', text: '' },
        })}\n\n`;
    }

    function startToolUseBlock(name, id) {
        blockIndex++;
        currentBlockType = 'tool_use';
        return `event: content_block_start\ndata: ${JSON.stringify({
            type: 'content_block_start',
            index: blockIndex,
            content_block: { type: 'tool_use', id, name, input: {} },
        })}\n\n`;
    }

    function textDelta(text) {
        return `event: content_block_delta\ndata: ${JSON.stringify({
            type: 'content_block_delta',
            index: blockIndex,
            delta: { type: 'text_delta', text },
        })}\n\n`;
    }

    function inputJsonDelta(json) {
        return `event: content_block_delta\ndata: ${JSON.stringify({
            type: 'content_block_delta',
            index: blockIndex,
            delta: { type: 'input_json_delta', partial_json: json },
        })}\n\n`;
    }

    function closeCurrentBlock() {
        if (currentBlockType === null) return '';
        const out = `event: content_block_stop\ndata: ${JSON.stringify({
            type: 'content_block_stop',
            index: blockIndex,
        })}\n\n`;
        currentBlockType = null;
        return out;
    }

    function processBlocks(blocks) {
        let out = '';
        for (const block of blocks) {
            if (block.type === 'text') {
                if (!block.text) continue;
                if (currentBlockType !== 'text') {
                    out += closeCurrentBlock();
                    out += startTextBlock();
                }
                out += textDelta(block.text);
            } else if (block.type === 'tool_use') {
                out += closeCurrentBlock();
                const toolId = `toolu_${uuidv4().replace(/-/g, '')}`;
                out += startToolUseBlock(block.name, toolId);
                out += inputJsonDelta(JSON.stringify(block.input));
                out += closeCurrentBlock();
                hasToolUse = true;
            }
        }
        return out;
    }

    function buildUsage() {
        if (usageData) {
            return {
                output_tokens: usageData.completion_tokens || 0,
                cache_creation_input_tokens: usageData.cache_creation_input_tokens || 0,
                cache_read_input_tokens: usageData.cache_read_input_tokens || 0,
            };
        }
        return { output_tokens: estimateTokens(totalOutputText) };
    }

    yield messageStart;
    yield pingEvent;

    let currentEvent = null;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed === '') continue;
            if (trimmed.startsWith('event:')) {
                currentEvent = trimmed.substring(6).trim();
                continue;
            }
            if (!trimmed.startsWith('data:')) continue;

            const data = trimmed.substring(5).trim();

            if (currentEvent === 'done') {
                doneReceived = true;
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.finish_reason) {
                        finishReason = parsed.finish_reason === 'stop' ? 'end_turn' : parsed.finish_reason;
                    }
                } catch {}

                const finalBlocks = parser.flush();
                const out1 = processBlocks(finalBlocks);
                if (out1) yield out1;
                const closeOut = closeCurrentBlock();
                if (closeOut) yield closeOut;

                yield `event: message_delta\ndata: ${JSON.stringify({
                    type: 'message_delta',
                    delta: {
                        stop_reason: hasToolUse ? 'tool_use' : finishReason,
                        stop_sequence: null,
                    },
                    usage: buildUsage(),
                })}\n\n`;

                yield `event: message_stop\ndata: ${JSON.stringify({
                    type: 'message_stop',
                })}\n\n`;
                return;
            }

            try {
                const parsed = JSON.parse(data);
                if (parsed.response !== undefined && parsed.response !== null) {
                    const text = parsed.response;
                    if (text) {
                        totalOutputText += text;
                        parser.push(text);
                        const blocks = parser.takeBlocks();
                        const out = processBlocks(blocks);
                        if (out) yield out;
                    }
                }
                if (parsed.finish_reason) {
                    finishReason = parsed.finish_reason === 'stop' ? 'end_turn' : parsed.finish_reason;
                }
                if (typeof parsed.prompt_tokens === 'number') {
                    usageData = parsed;
                }
            } catch {}

            currentEvent = null;
        }
    }

    if (!doneReceived) {
        const finalBlocks = parser.flush();
        const out1 = processBlocks(finalBlocks);
        if (out1) yield out1;
        const closeOut = closeCurrentBlock();
        if (closeOut) yield closeOut;

        yield `event: message_delta\ndata: ${JSON.stringify({
            type: 'message_delta',
            delta: {
                stop_reason: hasToolUse ? 'tool_use' : finishReason,
                stop_sequence: null,
            },
            usage: buildUsage(),
        })}\n\n`;
        yield `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`;
    }
}

module.exports = { handleAnthropicResponse, parseToolCalls, estimateTokens };