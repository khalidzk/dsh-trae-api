/**
 * dsh-trae-api - DeepSeek Harness plugin entry (host half)
 *
 * When this plugin is mounted in a profile, it starts the Trae -> OpenAI /
 * Anthropic compatible proxy server so any local agent (Claude Code, Cursor,
 * Cline, ...) can consume Trae Work CN credits through http://localhost:PORT.
 *
 * Plugin config (cordis.patch.yml insert row -> config):
 *   port:        listen port (default: env PORT or 9220)
 *   apiKey:      API key required by clients (default: env API_KEY)
 *   edition:     Trae edition cn/solo/sg/solo-sg (default: env TRAE_EDITION or cn)
 *   manualToken: manual token fallback (default: env TRAE_MANUAL_TOKEN)
 *   baseUrl:     upstream API base URL (default: auto by edition)
 *   quiet:       suppress banner logs
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { startServer } = require('../src/server-core.js');

export const name = 'dsh-trae-api';

export function apply(ctx, config = {}) {
  const handle = startServer({
    port: config.port,
    apiKey: config.apiKey,
    edition: config.edition,
    manualToken: config.manualToken,
    baseUrl: config.baseUrl,
    quiet: config.quiet,
  });

  ctx.logger?.info(
    `[dsh-trae-api] Trae API proxy listening on http://localhost:${handle.port} ` +
    `(edition=${handle.edition}, auth=${handle.authOk ? 'OK' : 'FAILED'})`
  );

  ctx.effect(() => () => {
    handle.server.close();
    ctx.logger?.info('[dsh-trae-api] Trae API proxy stopped');
  });
}