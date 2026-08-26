/**
 * check-upstream.js - 直接调用 Trae 上游 API 并打印原始响应
 *
 * 目的：确认上游返回的数据中是否包含 token 使用量 / 缓存命中字段
 *
 * Usage: node src/check-upstream.js
 */

require('dotenv').config();
const auth = require('./auth');
const traeClient = require('./trae-client');

const KEYWORDS = [
  'usage', 'token', 'prompt_tokens', 'completion_tokens', 'total_tokens',
  'input_tokens', 'output_tokens', 'cache', 'cache_read', 'cache_creation',
  'cost', 'credits',
];

async function main() {
  const edition = process.env.TRAE_EDITION || 'sg';
  auth.initAuth(edition, process.env.TRAE_MANUAL_TOKEN || '');

  if (!auth.getToken()) {
    console.error('No token available. Run: npm run setup');
    process.exit(1);
  }

  // 注意：chat 请求的 base URL 与 token 刷新的 host 不同
  // (与 server-core.js 逻辑一致: BASE_URL 环境变量 > edition 默认值)
  const DEFAULT_BASE_URLS = {
    cn: 'https://trae-api-cn.mchost.guru',
    solo: 'https://trae-api-cn.mchost.guru',
    sg: 'https://a0ai-api-sg.byteintlapi.com',
    'solo-sg': 'https://a0ai-api-sg.byteintlapi.com',
  };
  const baseUrl = process.env.BASE_URL || DEFAULT_BASE_URLS[edition] || DEFAULT_BASE_URLS.cn;
  const model = 'claude-sonnet-4-6';

  console.log(`[check] edition=${edition} host=${baseUrl} model=${model}`);
  console.log('');

  // 最小化消耗的探针请求
  const messages = [{ role: 'user', content: 'Reply with exactly "OK"' }];

  const { response, model: usedModel, endpoint } = await traeClient.sendChatRequest(
    messages, model, false, baseUrl
  );

  console.log(`[check] OK endpoint: ${endpoint}, model: ${usedModel}`);
  console.log('');

  console.log('=== Response Headers ===');
  for (const [k, v] of response.headers.entries()) {
    console.log(`  ${k}: ${v}`);
  }
  console.log('');

  const raw = await response.text();

  console.log('=== RAW RESPONSE BODY (full) ===');
  console.log(raw);
  console.log('=== END BODY ===');
  console.log('');

  console.log('=== Keyword scan (count of occurrences) ===');
  let anyHit = false;
  for (const kw of KEYWORDS) {
    const matches = raw.match(new RegExp(kw, 'gi'));
    const count = matches ? matches.length : 0;
    if (count > 0) anyHit = true;
    console.log(`  ${kw}: ${count}`);
  }
  console.log('');
  console.log(anyHit
    ? '>>> 上游响应中包含上述关键词，请查看原始 body 确认字段'
    : '>>> 上游响应中未发现 usage/token/cache 相关字段');
}

main().catch((err) => {
  console.error('[check] Failed:', err.message);
  process.exit(1);
});
