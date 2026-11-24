'use strict';
/**
 * One customer's terminal in its own process, started by supervisor.js. Settings and the private gateway token
 * arrive over IPC, never in arguments or the environment. Without its parent the process stops itself.
 */
const { createTerminal } = require('../app');

let t = null;
let stopping = false;

async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  setTimeout(() => process.exit(code || 1), 25000).unref();
  try { if (t) await t.stop(); } catch (e) { console.error(`[tenant] ${e.message}`); }
  process.exit(code);
}

process.on('message', async (m) => {
  if (!m) return;
  if (m.type === 'ping') { process.send({ type: 'pong' }); return; }
  if (m.type === 'stop') { stop(); return; }
  if (m.type === 'telegram-chat') { if (t) t.setTelegramChat(m.chatId); return; }
  if (m.type === 'telegram-update') { if (t) t.telegram.update(m.update); return; }
  if (m.type !== 'start' || t) return;
  try {
    t = createTerminal({ dataDir: m.dataDir, host: '127.0.0.1', port: 0, env: m.services || {}, gatewayToken: m.token, postgres: m.postgres || null, telegramRelay: m.telegram || null, publicData: !!m.publicData, labModel: m.labModel || null });
    const port = await t.start();
    process.send({ type: 'ready', port });
  } catch (e) {
    console.error(`[tenant] start failed: ${e.message}`);
    process.exit(1);
  }
});
process.on('disconnect', () => stop(1));
process.on('SIGTERM', () => stop());
process.on('SIGINT', () => { /* the gateway decides when to stop */ });
process.on('uncaughtException', (e) => { console.error(`[tenant] ${e && e.stack}`); stop(1); });
process.on('unhandledRejection', (e) => {
  const m = e && e.message ? e.message : String(e);
  if (t) t.activity.error(`Unhandled error: ${m}`, { source: 'process' }); else console.error(`[tenant] ${m}`);
});
