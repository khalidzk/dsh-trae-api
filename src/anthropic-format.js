/**
 * anthropic-format.js - Convert Trae SSE events to Anthropic-compatible format
 *
 * Supports:
 *   - text content block
 *   - tool_use content block (parsed from <tool_call>...</tool_call>)
 *   - ping event (Anthropic official streaming spec)
 *   - stop_reason = tool_use when tool calls detected
 *   - token usage estimation
 */

const { v4: uuidv4 } = require('uuid');

const OPEN_TAG = '<tool_call>';
const CLOSE_TAG = '</tool_call>';

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
    const result = [];
    const regex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
    let lastIndex = 0;
    let match;

    while ((match = regex.exec(text)) !== null) {
        if (match.index > lastIndex) {
            const before = text.substring(lastIndex, match.index);
            if (before.trim()) result.push({ type: 'text', text: before });
        }
        try {
            const parsed = JSON.parse(match[1]);
            if (parsed.name) {
                result.push({
                    type: 'tool_use',
                    name: parsed.name,
                    input: parsed.arguments || parsed.input || parsed.parameters || {},
                });
            } else {
                result.push({ type: 'text', text: match[0] });
            }
        } catch (e) {
            result.push({ type: 'text', text: match[0] });
        }
        lastIndex = regex.lastIndex;
    }

    if (lastIndex < text.length) {
        const after = text.substring(lastIndex);
        if (after.trim()) result.push({ type: 'text', text: after });
    }

    return result;
}

class StreamingToolCallParser {
    constructor() {
        this.buffer = '';
        this.inToolCall = false;
    }

    push(chunk) {
        this.buffer += chunk;
    }

    takeBlocks() {
        const blocks = [];

        while (true) {
            if (this.inToolCall) {
                const endIdx = this.buffer.indexOf(CLOSE_TAG);
                if (endIdx === -1) break;
                const jsonStr = this.buffer.substring(0, endIdx).trim();
                this.buffer = this.buffer.substring(endIdx + CLOSE_TAG.length);
                try {
                    const parsed = JSON.parse(jsonStr);
                    if (parsed.name) {
                        blocks.push({
                            type: 'tool_use',
                            name: parsed.name,
                            input: parsed.arguments || parsed.input || parsed.parameters || {},
                        });
                    } else {
                        blocks.push({ type: 'text', text: OPEN_TAG + jsonStr + CLOSE_TAG });
                    }
                } catch (e) {
                    blocks.push({ type: 'text', text: OPEN_TAG + jsonStr + CLOSE_TAG });
                }
                this.inToolCall = false;
            } else {
                const startIdx = this.buffer.indexOf(OPEN_TAG);
                if (startIdx === -1) {
                    const lastLt = this.buffer.lastIndexOf('<');
                    if (lastLt !== -1) {
                        const tail = this.buffer.substring(lastLt);
                        if (OPEN_TAG.startsWith(tail)) {
                            if (lastLt > 0) {
                                blocks.push({ type: 'text', text: this.buffer.substring(0, lastLt) });
                            }
                            this.buffer = tail;
                            break;
                        }
                    }
                    if (this.buffer) {
                        blocks.push({ type: 'text', text: this.buffer });
                    }
                    this.buffer = '';
                    break;
                }
                if (startIdx > 0) {
                    blocks.push({ type: 'text', text: this.buffer.substring(0, startIdx) });
                }
                this.buffer = this.buffer.substring(startIdx + OPEN_TAG.length);
                this.inToolCall = true;
            }
        }
        return blocks;
    }

    flush() {
        const blocks = [];
        if (this.inToolCall) {
            blocks.push({ type: 'text', text: OPEN_TAG + this.buffer });
            this.buffer = '';
            this.inToolCall = false;
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