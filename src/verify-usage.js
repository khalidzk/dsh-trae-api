/**
 * verify-usage.js - 验证 token 用量透传（4 条链路）
 *
 * Usage: node src/verify-usage.js
 * 每次运行消耗约 400 个上游 token
 */

require('dotenv').config();
const auth = require('./auth');
const traeClient = require('./trae-client');
const { handleOpenAIResponse } = require('./openai-format');
const { handleAnthropicResponse } = require('./anthropic-format');

const DEFAULT_BASE_URLS = {
  cn: 'https://trae-api-cn.mchost.guru',
  solo: 'https://trae-api-cn.mchost.guru',
  sg: 'https://a0ai-api-sg.byteintlapi.com',
  'solo-sg': 'https://a0ai-api-sg.byteintlapi.com',
};

async function main() {
  const edition = process.env.TRAE_EDITION || 'sg';
  auth.initAuth(edition, process.env.TRAE_MANUAL_TOKEN || '');
  const baseUrl = process.env.BASE_URL || DEFAULT_BASE_URLS[edition] || DEFAULT_BASE_URLS.cn;
  const model = 'claude-sonnet-4-6';
  const messages = [{ role: 'user', content: 'Reply with exactly "OK"' }];

  // 1. OpenAI 非流式
  console.log('=== 1. OpenAI non-streaming ===');
  let r = await traeClient.sendChatRequest(messages, model, false, baseUrl);
  const openaiResult = await handleOpenAIResponse(r.response, r.model, false);
  console.log('usage:', JSON.stringify(openaiResult.usage));
  console.log('content:', JSON.stringify(openaiResult.choices[0].message.content));

  // 2. OpenAI 流式
  console.log('\n=== 2. OpenAI streaming ===');
  r = await traeClient.sendChatRequest(messages, model, true, baseUrl);
  const stream = await handleOpenAIResponse(r.response, r.model, true);
  let usageChunk = null;
  for await (const line of stream) {
    const m = line.trim().match(/^data: (.+)$/);
    if (!m || m[1] === '[DONE]') continue;
    const payload = JSON.parse(m[1]);
    if (payload.choices && payload.choices.length === 0 && payload.usage) {
      usageChunk = payload.usage;
    }
  }
  console.log('usage chunk:', JSON.stringify(usageChunk));

  // 3. Anthropic 非流式
  console.log('\n=== 3. Anthropic non-streaming ===');
  r = await traeClient.sendChatRequest(messages, model, false, baseUrl);
  const anthResult = await handleAnthropicResponse(r.response, r.model, false, 0);
  console.log('usage:', JSON.stringify(anthResult.usage));

  // 4. Anthropic 流式
  console.log('\n=== 4. Anthropic streaming ===');
  r = await traeClient.sendChatRequest(messages, model, true, baseUrl);
  const anthStream = await handleAnthropicResponse(r.response, r.model, true, 0);
  let deltaUsage = null;
  for await (const line of anthStream) {
    const dataLine = line.trim().split('\n').pop();
    const m = dataLine.match(/^data: (.+)$/);
    if (!m) continue;
    const payload = JSON.parse(m[1]);
    if (payload.type === 'message_delta' && payload.usage) {
      deltaUsage = payload.usage;
    }
  }
  console.log('message_delta usage:', JSON.stringify(deltaUsage));

  console.log('\nDone.');
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
