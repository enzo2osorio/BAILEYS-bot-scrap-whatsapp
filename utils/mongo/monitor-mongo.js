'use strict';
const { getServerStatus } = require('./singleton-mongo');

let monitorTimer = null;
let lastSample = null;

const SOFT = parseInt(process.env.MONGO_CONNECTION_SOFT_LIMIT || '380', 10); // aviso
const HARD = parseInt(process.env.MONGO_CONNECTION_HARD_LIMIT || '450', 10); // acción
const INTERVAL = parseInt(process.env.MONGO_CONNECTION_CHECK_INTERVAL_MS || '60000', 10);
const COOLDOWN = parseInt(process.env.MONGO_CONNECTION_COOLDOWN_MS || '180000', 10);
const HARD_ACTION = (process.env.MONGO_HARD_ACTION || 'pause').toLowerCase(); // pause | restart

function startMongoConnectionMonitor(hooks) {
  if (monitorTimer) return;
  monitorTimer = setInterval(async () => {
    const status = await getServerStatus();
    if (!status || !status.connections) return;
    const current = status.connections.current;
    const available = status.connections.available;
    lastSample = { current, available, at: new Date() };

    if (current >= SOFT && current < HARD) {
      console.log(`⚠️ Conexiones Mongo elevadas: ${current} (soft=${SOFT}, hard=${HARD})`);
    }

    if (current >= HARD && !global.__MONGO_CONN_THROTTLING) {
      console.log(`🚨 Conexiones Mongo superan HARD=${HARD} (current=${current}). Acción=${HARD_ACTION}`);
      global.__MONGO_CONN_THROTTLING = true;

      if (HARD_ACTION === 'pause') {
        // Pausar reconexiones Baileys sin cerrar Mongo (evita crear pools nuevos)
        try { await hooks.stopBaileysGracefully(); } catch {}
        setTimeout(async () => {
          console.log("🕘 Finalizando cooldown, intentando reanudar Baileys...");
          global.__MONGO_CONN_THROTTLING = false;
          try { await hooks.connectToWhatsApp(); } catch (e) { console.log("❌ Reanudar falló:", e.message); }
        }, COOLDOWN);
      } else if (HARD_ACTION === 'restart') {
        try {
          await hooks.stopBaileysGracefully();
          setTimeout(async () => {
            global.__MONGO_CONN_THROTTLING = false;
            await hooks.connectToWhatsApp();
          }, COOLDOWN);
        } catch (e) {
          console.log("❌ Restart falló:", e.message);
          global.__MONGO_CONN_THROTTLING = false;
        }
      }
    }
  }, INTERVAL);
}

function getLastMongoSample() {
  return lastSample;
}

function stopMongoConnectionMonitor() {
  if (monitorTimer) clearInterval(monitorTimer);
  monitorTimer = null;
}

module.exports = { startMongoConnectionMonitor, stopMongoConnectionMonitor, getLastMongoSample };