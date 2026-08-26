/**
 * server.js - Standalone entry point for the Trae -> OpenAI/Anthropic proxy.
 *
 * Run: npm start  (or: node src/server.js)
 */

const { startServer } = require('./server-core');

const handle = startServer();

handle.server.on('error', (err) => {
  const msg = err.code === 'EADDRINUSE'
    ? `Port ${handle.port} is already in use.`
    : err.message;
  console.error(`[startup] ${msg}`);
  process.exit(1);
});

if (!handle.authOk) {
  console.error('[startup] Auth initialization failed. Ensure a Trae IDE is installed and logged in.');
  console.error('[startup] Run: npm run setup  to regenerate credentials.');
  process.exit(1);
}