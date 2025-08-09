const {
  default: makeWASocket,
  DisconnectReason,
  makeInMemoryStore,
  downloadMediaMessage,
  getContentType,
  Browsers,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const dns = require('dns');
const NodeCache = require('node-cache'); // <- agregado
dns.setDefaultResultOrder?.('ipv4first');
const { useMongoAuthState, clearMongoAuthState } = require('./utils/mongo/mongo-adapter.js'); // <- usar nuestro adaptador
const log = (pino = require("pino"));
const { Boom } = require("@hapi/boom");
const path = require("path");
const fs = require("fs");
const express = require("express");
const fileUpload = require("express-fileupload");
const cors = require("cors");
const bodyParser = require("body-parser");
const dotenv = require("dotenv");
const openAI = require("openai");
const vision = require("@google-cloud/vision");
const destinatarios = require('./similarDestinatarios.js');
const matchDestinatario = require('./utils/findMatchDestinatario.js');
const supabase = require('./supabase.js');
const { initInstanceLock, getActiveLockInfo } = require('./utils/mongo/lock-mongo.js');
const { uploadFileToSupabase, downloadFileFromSupabase, cleanupTempFile } = require('./utils/supabaseStorage.js');
const saveDataFirstFlow = require("./saveDataFirstFlow.js");
const getCategorias = require('./utils/getCategorias.js');
const getSubcategorias = require('./utils/getSubcategorias.js');
const getMetodosPago = require('./utils/getMetodosPago.js');
const saveNewDestinatario = require('./utils/saveNewDestinatario.js');
const matchMetodoPago = require('./utils/findMatchMetodoPago.js');

dotenv.config();

let instanceLockRelease = null;
// TODO: AGREGAR ESTADOS PARA MANEJAR EL METODO DE PAGO PARECIDO AL MANEJO DE DESTINATARIO.
// 🔄 SISTEMA DE ESTADO PERSISTENTE POR USUARIO
const stateMap = new Map();
const TIMEOUT_DURATION = 3 * 60 * 1000; // 3 minutos en milisegundos
// --- añadidos para control de envío inicial, keep-alive y reconexión simple ---
let readyToSendAt = 0;             // ventana para retrasar el primer envío tras "open"
let keepAliveTimer = null;       
let WA_VERSION = null;
let WA_IS_LATEST = false;
let isConnecting = false;
let reconnectTimer = null;


const delay = (ms) => new Promise(r => setTimeout(r, ms));

function startKeepAlive() {
  clearInterval(keepAliveTimer);
  const digits = (process.env.MY_NUMBER || process.env.NUMBER_1_ALLOWED || '').replace(/\D/g, '');
  if (!digits) return;
  const jid = `${digits}@s.whatsapp.net`;
  keepAliveTimer = setInterval(async () => {
    try {
      if (!sock?.user) return;
      await sock.onWhatsApp(jid);  // ping ligero, no notifica
    } catch (_) { /* silencioso */ }
  }, 10 * 60 * 1000); // cada 10 minutos
}
function stopKeepAlive() { clearInterval(keepAliveTimer); keepAliveTimer = null; }

function scheduleReconnect(ms = 10000) {
  if (isConnecting || reconnectTimer) return;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try { await connectToWhatsApp(); } catch (e) { /* logea adentro */ }
  }, ms);
}

// Estados posibles del flujo
const STATES = {
  IDLE: "idle",
  AWAITING_DESTINATARIO_CONFIRMATION: "awaiting_destinatario_confirmation",
  AWAITING_DESTINATARIO_SECOND_TRY: "awaiting_destinatario_second_try",
  AWAITING_DESTINATARIO_CHOOSING_IN_LIST_OR_ADDING_NEW: "awaiting_destinatario_choosing_in_list_or_adding_new", 
  AWAITING_NEW_DESTINATARIO_NAME: "awaiting_new_destinatario_name",
  AWAITING_DESTINATARIO_ALIASES: "awaiting_destinatario_aliases", 
  AWAITING_DESTINATARIO_FUZZY_CONFIRMATION: "awaiting_destinatario_fuzzy_confirmation", 
  AWAITING_CATEGORY_SELECTION: "awaiting_category_selection",
  AWAITING_SUBCATEGORY_SELECTION: "awaiting_subcategory_selection",
  AWAITING_MEDIO_PAGO_CONFIRMATION: "awaiting_medio_pago_confirmation",
  AWAITING_MEDIO_PAGO_SELECTION: "awaiting_medio_pago_selection",
    AWAITING_NEW_METODO_PAGO_NAME: "awaiting_new_metodo_pago_name",
  AWAITING_SAVE_CONFIRMATION: "awaiting_save_confirmation",
  AWAITING_MODIFICATION_SELECTION: "awaiting_modification_selection",
  AWAITING_DESTINATARIO_MODIFICATION: "awaiting_destinatario_modification",
  AWAITING_MONTO_MODIFICATION: "awaiting_monto_modification",
  AWAITING_FECHA_MODIFICATION: "awaiting_fecha_modification",
  AWAITING_TIPO_MOVIMIENTO_MODIFICATION: "awaiting_tipo_movimiento_modification",
  AWAITING_MEDIO_PAGO_MODIFICATION: "awaiting_medio_pago_modification"
};

const { session } = { session: "session_auth_info" };
const app = express();
app.use(
  fileUpload({
    createParentPath: true,
  })
);

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
const server = require("http").createServer(app);
const io = require("socket.io")(server);
const port = process.env.PORT || 8000;
const qrcode = require("qrcode");
const checkSimilarDestinatario = require("./utils/checkSimilarDestinatario.js");
const saveDestinatarioAliases = require("./utils/saveDestinatarioAliases.js");
const checkDuplicateAliases = require("./utils/checkDuplicateAliases.js");
const { closeClient } = require("./utils/mongo/singleton-mongo.js");

app.use("/assets", express.static(__dirname + "/client/assets"));

app.get("/scan", (req, res) => {
  res.sendFile("./client/index.html", {
    root: __dirname,
  });
});

app.get("/", (req, res) => {
  console.log("Server is running again");
  res.send("server working");
});

app.get('/lock-info', async (req, res) => {
  try {
    const doc = await getActiveLockInfo({
      mongoUrl: process.env.MONGO_URI,
      dbName: process.env.MONGODB_DB || 'baileysss',
      collectionName: process.env.MONGODB_LOCKS_COLL || 'wa_instance_locks',
      instanceId: process.env.BAILEYS_INSTANCE || 'default'
    });
    res.json({ success: true, lock: doc || null });
  } catch (e) {
    res.status(500).json({ success: false, error: e?.message || String(e) });
  }
});

// 🧹 Ruta para limpiar sesión con clave de acceso
app.get("/clear-session/:accessKey", async (req, res) => {
  try {
    const { accessKey } = req.params;
    
    // Verificar clave de acceso
    const validAccessKey = process.env.SESSION_CLEAR_KEY || "default-clear-key-12345";
    
    if (accessKey !== validAccessKey) {
      console.log(`🚫 Intento de acceso no autorizado a /clear-session con clave: ${accessKey}`);
      return res.status(401).json({
        success: false,
        message: "❌ Clave de acceso inválida"
      });
    }

    console.log("🧹 Iniciando limpieza de sesión autorizada...");

    // 1. Cerrar conexión actual de forma segura si existe
    let socketWasClosed = false;
    if (sock) {
      try {
        if (typeof sock.logout === 'function') {
          console.log("🔌 Cerrando sesión de WhatsApp...");
          await sock.logout();
          socketWasClosed = true;
        } else if (typeof sock.end === 'function') {
          console.log("🔌 Cerrando conexión actual...");
          sock.end();
          socketWasClosed = true;
        }
      } catch (logoutError) {
        console.log("⚠️ Error en logout (continuando con limpieza):", logoutError.message);
      }
    } else {
      console.log("ℹ️ No hay conexión activa para cerrar");
    }

    // 2. Limpiar variables globales inmediatamente
    qrDinamic = null;
    sock = null;

    // 3. Limpiar carpeta de sesión de WhatsApp
    const sessionPath = path.join(__dirname, "session_auth_info");
    let sessionFolderRemoved = false;
    
    if (fs.existsSync(sessionPath)) {
      console.log("🗑️ Eliminando carpeta de sesión de WhatsApp...");
      fs.rmSync(sessionPath, { recursive: true, force: true });
      sessionFolderRemoved = true;
      console.log("✅ Carpeta de sesión eliminada");
    } else {
      console.log("ℹ️ Carpeta de sesión no existe");
    }

    // 4. Limpiar store de Baileys si existe
    const storePath = path.join(__dirname, "baileys_store.json");
    let baileysStoreRemoved = false;
    
    if (fs.existsSync(storePath)) {
      fs.unlinkSync(storePath);
      baileysStoreRemoved = true;
      console.log("✅ Store de Baileys eliminado");
    }

    // 5. Actualizar cliente web si está conectado
    if (soket) {
      updateQR("loading");
    }

    // 6. Respuesta exitosa
    res.status(200).json({
      success: true,
      message: "✅ Sesión de WhatsApp limpiada exitosamente. Puedes escanear un nuevo QR manualmente.",
      timestamp: new Date().toISOString(),
      cleaned: {
        socketClosed: socketWasClosed,
        sessionFolderRemoved: sessionFolderRemoved,
        baileysStoreRemoved: baileysStoreRemoved
      },
      next_steps: [
        "1. Ve a http://localhost:8000/scan",
        "2. Escanea el nuevo QR code con tu WhatsApp",
        "3. El bot estará listo para usar"
      ]
    });

    console.log("🎯 Sesión limpiada. Listo para nuevo QR manual.");

  } catch (error) {
    console.error("❌ Error limpiando sesión:", error.message);
    
    res.status(500).json({
      success: false,
      message: "❌ Error interno limpiando sesión",
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// 🔍 Ruta adicional para verificar estado de la sesión
app.get("/session-status/:accessKey", (req, res) => {
  try {
    const { accessKey } = req.params;
    
    // Verificar clave de acceso
    const validAccessKey = process.env.SESSION_CLEAR_KEY || "default-clear-key-12345";
    
    if (accessKey !== validAccessKey) {
      return res.status(401).json({
        success: false,
        message: "❌ Clave de acceso inválida"
      });
    }

    const sessionPath = path.join(__dirname, "session_auth_info");
    const storePath = path.join(__dirname, "baileys_store.json");
    const tempCredPath = path.join(__dirname, 'gcloud-creds.json');

    res.status(200).json({
      success: true,
      message: "✅ Estado de la sesión",
      timestamp: new Date().toISOString(),
      session: {
        connected: isConnected(),
        hasUser: sock?.user ? true : false,
        userId: sock?.user?.id || null,
        userName: sock?.user?.name || null,
        sessionFolderExists: fs.existsSync(sessionPath),
        baileysStoreExists: fs.existsSync(storePath),
        googleCredentialsExists: fs.existsSync(tempCredPath),
        qrAvailable: qrDinamic ? true : false
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: "❌ Error obteniendo estado",
      error: error.message
    });
  }
});

// Agregar nueva ruta de diagnóstico después de las rutas existentes
app.get("/connection-diagnostics/:accessKey", (req, res) => {
  try {
    const { accessKey } = req.params;
    const validAccessKey = process.env.SESSION_CLEAR_KEY || "default-clear-key-12345";
    if (accessKey !== validAccessKey) {
      return res.status(401).json({ success: false, message: "❌ Clave de acceso inválida" });
    }

    const diagnostics = {
      timestamp: new Date().toISOString(),
      connection: {
        isConnected: isConnected(),
        hasSocket: !!sock,
        hasUser: !!sock?.user,
        userInfo: sock?.user ? { id: sock.user.id, name: sock.user.name } : null,
        readyState: sock?.ws?.readyState ?? 'N/A'
      },
      session: {
        qrAvailable: !!qrDinamic,
        sessionFolderExists: fs.existsSync(path.join(__dirname, "session_auth_info")),
        storeExists: fs.existsSync(path.join(__dirname, "baileys_store.json"))
      },
      system: {
        uptime: process.uptime(),
        memoryUsage: process.memoryUsage(),
        nodeVersion: process.version,
        platform: process.platform
      },
      errors: {
        lastMacErrorLog: global.lastMacErrorLog || null,
        lastCallbackErrorLog: global.lastCallbackErrorLog || null,
        macErrorCount: global.macErrorCount || 0
      },
      healthChecks: {
        lastHealthLog: null,
        healthCheckActive: false
      }
    };

    res.status(200).json({ success: true, message: "📊 Diagnóstico de conexión", diagnostics });
  } catch (error) {
    res.status(500).json({ success: false, message: "❌ Error obteniendo diagnóstico", error: error.message });
  }
});

let sock;
let qrDinamic;
let soket;

// Variable temporal para almacenar mensajes en memoria
let messageStore = {};
let contactStore = {};
let chatStore = {};

async function ensureSingleInstanceLock() {
  const leaseMs = parseInt(process.env.LOCK_LEASE_MS || '60000', 10);
  const renewMs = parseInt(process.env.LOCK_RENEW_MS || '30000', 10);
  const instanceId = process.env.BAILEYS_INSTANCE || 'default';
  const mongoUrl = process.env.MONGO_URI;
  const dbName = process.env.MONGODB_DB || 'baileysss';

  if (!mongoUrl) {
    console.error('❌ MONGO_URI no definido. Revisa tu .env');
    process.exit(1);
  }

  try {
    const lock = await initInstanceLock({
      mongoUrl,
      dbName,
      collectionName: process.env.MONGODB_LOCKS_COLL || 'wa_instance_locks',
      instanceId,
      leaseMs,
      renewEveryMs: renewMs,
      meta: { processArgv: process.argv.slice(0, 3).join(' ') }
    });
    instanceLockRelease = lock.release;
    console.log(`🔒 Lock adquirido para instanceId="${instanceId}" por ${lock.info.ownerId}`);
  } catch (e) {
    console.log("⚠️ No se pudo obtener el lock:", e?.message || e);
    try {
      const doc = await getActiveLockInfo({
        mongoUrl,
        dbName,
        collectionName: process.env.MONGODB_LOCKS_COLL || 'wa_instance_locks',
        instanceId
      });
      if (doc) {
        console.log(`👀 Lock actual:
  instanceId: ${doc.instanceId}
  ownerId: ${doc.ownerId}
  acquiredAt: ${doc.acquiredAt}
  expiresAt: ${doc.expiresAt}
  meta: ${JSON.stringify(doc.meta || {}, null, 2)}
`);
      } else {
        console.log("ℹ️ No hay lock activo.");
      }
    } catch (infoErr) {
      console.log("⚠️ No se pudo consultar lock actual:", infoErr?.message || infoErr);
    }
    // Salir para no correr dos instancias
    process.exit(1);
  }
}


// Liberar lock al salir
for (const sig of ['SIGINT','SIGTERM','SIGHUP','SIGBREAK']) {
  process.on(sig, async () => {
    try { await instanceLockRelease?.(); } catch (_) {}
    process.exit(0);
  });
}

async function getAuthStateWithRetry() {
  const max = 5;
  let lastErr;
  for (let i = 0; i < max; i++) {
    try {
      return await useMongoAuthState({
        mongoUrl: process.env.MONGO_URI,
        dbName: process.env.MONGODB_DB || 'baileysss',
        collectionNamePrefix: process.env.MONGODB_COLLECTION_PREFIX || 'waAuthh',
        instanceId: process.env.BAILEYS_INSTANCE || 'default'
      });
    } catch (err) {
      lastErr = err;
      const msg = err?.message || '';
      if (!/querySrv|ETIMEOUT|ENOTFOUND|EAI_AGAIN/i.test(msg)) throw err;
      const delay = Math.min(30000, 2000 * (i + 1));
      console.log(`⚠️ Mongo DNS error (${msg}). Reintentando en ${Math.round(delay/1000)}s...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// Función para crear el store de Baileys
const initStore = () => {
  try {
    if (typeof makeInMemoryStore === "function") {
      const store = makeInMemoryStore({ logger: log({ level: "debug" }) });
      store.readFromFile("./baileys_store.json");

      // Guardar el store cada 10 segundos
      setInterval(() => {
        store.writeToFile("./baileys_store.json");
      }, 10_000);

      return store;
    }
  } catch (error) {
    console.log("makeInMemoryStore no disponible, usando store manual");
  }
  return null;
};

  const store = initStore();

// 🔄 FUNCIONES PARA MANEJO DE ESTADO PERSISTENTE
const setUserState = (jid, state, data = {}) => {
  // Limpiar timeout anterior si existe
  const currentState = stateMap.get(jid);
  if (currentState?.timeout) {
    console.log("current state timeout");
    clearTimeout(currentState.timeout);
  }

  // Crear nuevo timeout
  const timeout = setTimeout(() => {
    clearUserState(jid);
    safeSendMessage(jid, {
      text: "⏰ El flujo se ha cancelado por inactividad (3 minutos). Envía un nuevo comprobante para comenzar nuevamente."
    }).catch(console.error);
  }, TIMEOUT_DURATION);

  stateMap.set(jid, {
    state,
    data,
    timestamp: Date.now(),
    timeout
  });

  console.log(`🔄 Estado de ${jid} cambiado a: ${state}`);
};

const getUserState = (jid) => {
  return stateMap.get(jid) || { state: STATES.IDLE, data: {}, timestamp: null, timeout: null };
};

const clearUserState = (jid) => {
  const currentState = stateMap.get(jid);
  if (currentState?.timeout) {
    clearTimeout(currentState.timeout);
  }
  stateMap.delete(jid);
  console.log(`🧹 Estado de ${jid} limpiado`);
};


// 📨 FUNCIONES PARA MENSAJES (botones eliminados, solo texto ahora)
// Función para limpiar sesiones corruptas
// Mejorar la función clearCorruptedSession
const clearCorruptedSession = async () => {
try {
    console.log("🧹 Iniciando limpieza completa de sesión corrupta...");
    if (sock) {
      try {
        if (typeof sock.logout === 'function') await sock.logout();
        else if (typeof sock.end === 'function') sock.end();
      } catch (logoutError) {
        console.log("⚠️ Error en logout durante limpieza:", logoutError.message);
      }
    }

    qrDinamic = null;
    sock = null;

    // Borrar storage local
    const sessionPath = path.join(__dirname, "session_auth_info");
    if (fs.existsSync(sessionPath)) {
      console.log("🗑️ Eliminando carpeta de sesión...");
      fs.rmSync(sessionPath, { recursive: true, force: true });
      console.log("✅ Carpeta de sesión eliminada");
    }
    const storePath = path.join(__dirname, "baileys_store.json");
    if (fs.existsSync(storePath)) {
      fs.unlinkSync(storePath);
      console.log("✅ Store de Baileys limpiado");
    }

    // Borrar estado en Mongo (crítico para 428)
    await clearMongoAuthState({
      mongoUrl: process.env.MONGO_URI,
      dbName: process.env.MONGODB_DB || 'baileysss',
      collectionNamePrefix: process.env.MONGODB_COLLECTION_PREFIX || 'waAuthh',
      instanceId: process.env.BAILEYS_INSTANCE || 'default'
    });

    stateMap.clear();
    console.log("✅ Estados de usuarios limpiados");

    global.reconnectAttempts = 0;
    global.macErrorCount = 0;

    if (soket) updateQR("qr"); // mostrar QR tras limpiar
    console.log("✅ Limpieza completa terminada - Se requerirá nuevo QR");

  } catch (error) {
    console.error("❌ Error en limpieza de sesión:", error.message);
  }
};

// �️ CONTADOR DE ERRORES MAC PARA AUTO-LIMPIEZA
let macErrorCount = 0;
let lastMacErrorReset = Date.now();

// �🔧 FUNCIÓN MEJORADA PARA MANEJAR ERRORES DE DESCIFRADO
const handleDecryptionError = (error, jid) => {
  if (error.message?.includes("Bad MAC")) {
    macErrorCount++;
    
    // Reset contador cada 5 minutos
    if (Date.now() - lastMacErrorReset > 300000) {
      macErrorCount = 0;
      lastMacErrorReset = Date.now();
    }
    
    // Si hay más de 100 errores MAC en 5 minutos, algo está mal
    if (macErrorCount > 100) {
      console.log(`⚠️ Demasiados errores MAC (${macErrorCount}) - puede necesitar limpiar sesión`);
      console.log(`💡 Si el problema persiste, ejecuta: POST /clear-session`);
      macErrorCount = 0; // Reset para evitar spam
    }
    
    return true; // Indica que el error fue manejado
  }
  if (error.message?.includes("Failed to decrypt")) {
    return true;
  }
  return false; // Error no manejado
};

// 🛡️ FUNCIÓN PARA MANEJAR ERRORES DE SESIÓN
const handleSessionError = async (error) => {
  console.log("🔍 Analizando error de sesión:", error.message);
  
  if (error.message?.includes("Bad MAC") || 
      error.message?.includes("Session error") ||
      error.message?.includes("Failed to decrypt")) {
    
    console.log("⚠️ Detectados múltiples errores de MAC - posible sesión corrupta");
    console.log("🔄 Esto es normal durante la sincronización inicial o reconexión");
    
    // No cerrar la sesión inmediatamente por errores MAC
    // Solo registrar y continuar
    return false; // No requiere reconexión
  }
  
  return true; // Otros errores pueden requerir reconexión
};

const isSocketReady = () => {
  if (!sock) return false;
  const wsState = sock.ws?.readyState;
  if (typeof wsState === 'number') return wsState === 1; // OPEN
  // Fallback: si hay user, asumimos utilizable para enviar
  return !!sock.user;
};

const safeSendMessage = async (jid, content, options) => {
  // espera si aún no pasan los 30s de estabilización tras "open"
  if (Date.now() < readyToSendAt) {
    const wait = Math.max(0, readyToSendAt - Date.now());
    if (wait > 0) await delay(wait);
  }

  const s = sock;
  if (!s || typeof s.sendMessage !== 'function') {
    console.log("⚠️ No se envía: socket no inicializado");
    return;
  }
  try {
    return await s.sendMessage(jid, content, options);
  } catch (err) {
    console.log("❌ sendMessage falló:", err?.message || String(err));
    // reconexión simple si aplica
    const msg = err?.message || '';
    if (/Connection Closed|not connected|Restart Required/i.test(msg)) {
      scheduleReconnect(5000);
    }
  }
};



const P = require("pino")({
  level: "silent",
});

async function connectToWhatsApp() {

  if (isConnecting) {
    console.log("⏳ Ya hay una conexión en curso");
    return;
  }
  if (sock && sock.ws && sock.ws.readyState === 1) {
    console.log("✅ Socket ya conectado");
    return;
  }
  isConnecting = true;

  clearTimeout(reconnectTimer); 
reconnectTimer = null;

const msgRetryCounterCache = new NodeCache();

    try {

      if (sock) {
      try { sock.ev.removeAllListeners(); } catch (_) {}
      try { sock.ws?.close(); } catch (_) {}
    }

    const { state, saveCreds /*, close*/ } = await getAuthStateWithRetry();
    const { version, isLatest } = await fetchLatestBaileysVersion();
          WA_VERSION = version;
          WA_IS_LATEST = isLatest;
  sock = makeWASocket({
      auth: {
         creds: state.creds,
         keys: makeCacheableSignalKeyStore(state.keys, P),
      },
      version: WA_VERSION,
      logger: log({ level: "silent" }),
      markOnlineOnConnect: false,
      browser: Browsers.ubuntu("Chrome"),
      syncFullHistory: false,
      retryRequestDelayMs: 5000,
      maxMsgRetryCount: 1,
      fireInitQueries: false,
      emitOwnEvents: false,
      printQRInTerminal: false,
      connectTimeoutMs: 30000,
      defaultQueryTimeoutMs: 20000,
      keepAliveIntervalMs: 60000,
      msgRetryCounterCache,
    });

  // Vincular el store al socket si está disponible
  if (store) {
    store.bind(sock.ev);
  }

  // 🛡️ LISTENER PARA CAPTURAR ERRORES MAC Y EVITAR SPAM EN CONSOLA
  const originalEmit = sock.ev.emit;
  sock.ev.emit = function(event, ...args) {
    try {
      return originalEmit.call(this, event, ...args);
    } catch (error) {
      if (error.message?.includes("Bad MAC") || 
          error.message?.includes("Failed to decrypt")) {
        // Silenciosamente ignorar errores MAC para evitar spam
        return;
      }
      // Re-lanzar otros errores
      throw error;
    }
  };

  // 🛡️ AGREGAR MANEJO DE ERRORES GLOBAL PARA EL SOCKET
  sock.ev.on('error', async (error) => {
    // Filtrar errores MAC normales durante sincronización
    
    if (error.message?.includes("Bad MAC") || 
        error.message?.includes("Failed to decrypt")) {
      // Solo log cada 30 segundos para evitar spam
      if (!global.lastSocketErrorLog || Date.now() - global.lastSocketErrorLog > 30000) {
        console.log("⚠️ Errores de descifrado en socket (normal durante sincronización)");
        global.lastSocketErrorLog = Date.now();
      }
      return;
    }
    
    // Filtrar errores de callback relacionados con protocolMessage
    if (error.message?.includes('The "cb" argument must be of type function')) {
      console.log("⏭️ Error de callback en socket (probablemente protocolMessage)");
      return;
    }
    
    console.error("⚠️ Error en socket:", error.message);
    
    // Verificar si necesita reconexión
    const needsReconnect = await handleSessionError(error);
    if (needsReconnect) {
      console.log("🔄 Error crítico detectado, programando reconexión...");
      scheduleReconnect(5000);
    }
  });

  //  LISTENER PRINCIPAL - MENSAJES NUEVOS CON SISTEMA DE ESTADO PERSISTENTE
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
      
    for (const msg of messages) {
      try {
        if (!msg.message || !msg.key?.remoteJid) continue;

        const jid = msg?.key?.remoteJid;
        const messageId = msg?.key?.id;
        if (!jid || !messageId) {
          console.log("⚠️ Mensaje sin jid/id, ignorando");
          return;
        }
        console.log(`🔍 Mensaje recibido de: ${jid}`);
        const senderName = contactStore[jid]?.name || jid.split("@")[0];
        const messageType = getContentType(msg.message);
        
        // 🚫 Filtrar mensajes de protocolo y otros tipos no relevantes
        if (messageType === "protocolMessage" || 
            messageType === "reactionMessage" || 
            messageType === "senderKeyDistributionMessage") {
          console.log(`⏭️ Ignorando mensaje de tipo: ${messageType}`);
          continue;
        }
        
        console.log({messageType})
        if (jid === process.env.NUMBER_1_ALLOWED || jid === process.env.MY_NUMBER) {

        // 🔄 Verificar estado actual del usuario
          const userState = getUserState(jid);
          console.log(`🔍 Estado actual de ${senderName}: ${userState.state}`);

          // Esta sección ya no es necesaria - ahora usamos números en lugar de botones

          // 📝 MANEJO DE MENSAJES DE TEXTO SEGÚN ESTADO
          if (messageType === "conversation" || messageType === "extendedTextMessage") {
            const textMessage = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
            
            // Manejar confirmaciones numeradas para destinatarios
            if (userState.state === STATES.AWAITING_DESTINATARIO_CONFIRMATION) {
              await handleDestinationConfirmation(jid, textMessage, userState, msg);
              continue;
            }
            
            if (userState.state === STATES.AWAITING_DESTINATARIO_SECOND_TRY) {
              await handleSecondDestinationConfirmation(jid, textMessage, userState, msg);
              continue;
            }
            if (userState.state === STATES.AWAITING_DESTINATARIO_CHOOSING_IN_LIST_OR_ADDING_NEW) {
              await handleChoosingInListOrAddingNew(jid, textMessage, userState, msg);
              continue;
            }
            
            if (userState.state === STATES.AWAITING_NEW_DESTINATARIO_NAME) {
              await handleNewDestinatarioName(jid, textMessage, userState, msg);
              continue;
            }

            if (userState.state === STATES.AWAITING_DESTINATARIO_FUZZY_CONFIRMATION) {
              await handleDestinatarioFuzzyConfirmation(jid, textMessage, userState, msg);
              continue;
            }

            // 🆕 NUEVO HANDLER  
            if (userState.state === STATES.AWAITING_DESTINATARIO_ALIASES) {
              await handleDestinatarioAliases(jid, textMessage, userState, msg);
              continue;
            }
            
            if (userState.state === STATES.AWAITING_CATEGORY_SELECTION) {
              await handleCategoryNumberSelection(jid, textMessage, userState, msg);
              continue;
            }
            
            if (userState.state === STATES.AWAITING_SUBCATEGORY_SELECTION) {
              await handleSubcategoryNumberSelection(jid, textMessage, userState, msg);
              continue;
            }
            
            if (userState.state === STATES.AWAITING_SAVE_CONFIRMATION) {
              await handleSaveConfirmation(jid, textMessage, userState, msg);
              continue;
            }

            if (userState.state === STATES.AWAITING_MEDIO_PAGO_CONFIRMATION) {
              await handleMedioPagoConfirmation(jid, textMessage, userState, msg);
              continue;
            }
            
            if (userState.state === STATES.AWAITING_MEDIO_PAGO_SELECTION) {
              await handleMedioPagoSelection(jid, textMessage, userState, msg);
              continue;
            }

            if (userState.state === STATES.AWAITING_NEW_METODO_PAGO_NAME) {
              await handleNewMetodoPagoName(jid, textMessage, userState, msg);
              continue;
            }
            
            if (userState.state === STATES.AWAITING_MODIFICATION_SELECTION) {
              await handleModificationSelection(jid, textMessage, userState, msg);
              continue;
            }
            
            if (userState.state === STATES.AWAITING_DESTINATARIO_MODIFICATION) {
              await handleChoosingInListOrAddingNew(jid, textMessage, userState, msg);
              continue;
            }
            
            if (userState.state === STATES.AWAITING_MONTO_MODIFICATION) {
              await handleMontoModification(jid, textMessage, userState, msg);
              continue;
            }
            
            if (userState.state === STATES.AWAITING_FECHA_MODIFICATION) {
              await handleFechaModification(jid, textMessage, userState, msg);
              continue;
            }
            
            if (userState.state === STATES.AWAITING_TIPO_MOVIMIENTO_MODIFICATION) {
              await handleTipoMovimientoModification(jid, textMessage, userState, msg);
              continue;
            }
            
            if (userState.state === STATES.AWAITING_MEDIO_PAGO_MODIFICATION) {
              await handleMedioPagoModification(jid, textMessage, userState, msg);
              continue;
            }
          }

          // 🖼️ PROCESAMIENTO INICIAL DE COMPROBANTES (solo si está en estado IDLE)
          if (userState.state === STATES.IDLE) {
            let captureMessage = "";
            let caption = "";
            let imagePath = "";

            if (messageType === "imageMessage") {
              caption = msg.message.imageMessage.caption || "";

              // 🖼️ Descargar imagen primero
              imagePath = await downloadImageMessage(msg, senderName, messageId);
              console.log(`📥 Imagen descargada en: ${imagePath}`);
              
              // 🔍 Extraer texto desde imagen
              const extractedText = await extractTextFromImage(imagePath);

              // 💡 Combinar caption + texto OCR
              captureMessage = [caption, extractedText].filter(Boolean).join("\n\n");
            } else if (messageType === "documentWithCaptionMessage") {
              // 📄 Manejo de documentos (PDFs, etc.)
              const documentCaption = msg.message.documentWithCaptionMessage.caption || "";
              const fileName = msg.message.documentWithCaptionMessage.message?.documentMessage?.fileName || "";
              console.log(`📄 Documento recibido: ${fileName}`);
              
              // 📥 Descargar documento
              const documentPath = await downloadDocumentMessage(msg, senderName, messageId);
              
              if (documentPath) {
                // 🔍 Intentar extraer texto del documento
                const extractedDocumentText = await extractTextFromDocument(documentPath, fileName);
                captureMessage = [documentCaption, extractedDocumentText].filter(Boolean).join("\n\n");
              } else {
                // Si no se pudo descargar, usar solo el caption
                captureMessage = documentCaption;
              }
            } else if (messageType === "conversation") {
              captureMessage = msg.message.conversation || "";
            } else if (messageType === "extendedTextMessage") {
              captureMessage = msg.message.extendedTextMessage.text || "";
            }

            // 🧠 Procesar con OpenAI si hay algo que analizar
            if (captureMessage.trim()) {
              await processInitialMessage(jid, captureMessage, caption, msg);
            }
          } else {
            // Si el usuario tiene un estado activo pero envía algo inesperado
            await safeSendMessage(jid, {
              text: "⚠️ Tienes un flujo activo. Responde a la pregunta anterior o espera 3 minutos para que se cancele automáticamente."
            });
          }
        }
      } catch (err) {
        // Filtrar errores conocidos que no afectan el funcionamiento
        if (err.message?.includes("Bad MAC")) {
          console.log(`⚠️ Bad MAC en mensaje ${msg.key?.id}`);
        } else if (err.message?.includes('The "cb" argument must be of type function')) {
          console.log(`⏭️ Error de callback en mensaje ${msg.key?.id} (probablemente protocolMessage)`);
        } else if (err.message?.includes("protocolMessage")) {
          console.log(`⏭️ Error relacionado con protocolMessage en ${msg.key?.id}`);
        } else {
          console.error(`❌ Error procesando mensaje ${msg.key?.id}:`, err.message);
          // Log adicional para debugging si es necesario
          if (process.env.NODE_ENV === 'development') {
            console.error('Stack completo:', err.stack);
          }
        }
      }
    }
  });

  sock.ev.on("connection.update", async (update) => {
  const { connection, lastDisconnect, qr } = update;
  qrDinamic = qr;
  
  if (connection === "close") {
     stopKeepAlive();
    const err = lastDisconnect?.error;
    const reason =
      (err?.output?.statusCode) ??
      (err?.data?.statusCode) ??
      (err?.statusCode) ??
      undefined;            
    let shouldReconnect = true;
    let reconnectDelay = 5000;
    let shouldCleanSession = false; // 🆕 Flag específico para limpieza
    
    console.log(`🔍 Conexión cerrada - Código: ${reason} | Error: ${lastDisconnect?.error?.message || 'Desconocido'}`);
    
    switch (reason) {
      // 🚫 ERRORES QUE REQUIEREN LIMPIEZA DE SESIÓN (CRÍTICOS)
      case DisconnectReason.badSession:
        console.log("❌ Sesión corrupta detectada - REQUIERE limpieza");
        shouldCleanSession = true;
        shouldReconnect = true;
        reconnectDelay = 5000;
        break;
        
      case 428:
  console.log("🚫 Error 428: Connection Terminated - Sesión inválida detectada - REQUIERE limpieza");
  shouldCleanSession = true;
  shouldReconnect = true;
  reconnectDelay = 10000;

  // Notificación (rate limited 30 min)
  if (!global.last428NotifyAt || Date.now() - global.last428NotifyAt > 30 * 60 * 1000) {
    const notifyJid = process.env.MY_NUMBER || process.env.NUMBER_1_ALLOWED;
    if (notifyJid) {
      await safeSendMessage(notifyJid, {
        text: "⚠️ La sesión de WhatsApp del bot fue invalidada (428). Se requerirá reescanear el QR en /scan."
      });
      global.last428NotifyAt = Date.now();
    }
  }
  break;

      // 🔄 ERRORES QUE NO REQUIEREN LIMPIEZA (TEMPORALES O EXTERNOS)
       case 440:
  console.log("🔄 Error 440: Conflict - Otra instancia activa detectada");
  console.log("⚠️ NO limpiando sesión - solo esperando a que la otra instancia se desconecte");
  shouldCleanSession = false;
  shouldReconnect = true;
  reconnectDelay = 30000;


  // Depuración: ¿quién tiene el lock ahora?
  try {
  const doc = await getActiveLockInfo({
    instanceId: process.env.BAILEYS_INSTANCE || 'default'
  });
  if (doc) {
    console.log(`👤 Lock holder:
    
ownerId: ${doc.ownerId}
acquiredAt: ${doc.acquiredAt}
expiresAt: ${doc.expiresAt}
meta: ${JSON.stringify(doc.meta || {}, null, 2)}
`);
  } else {
    console.log("ℹ️ No se encontró lock activo (posible expiración).");
  }
} catch (e) {
  console.log("⚠️ No se pudo consultar lock holder:", e?.message || e);
}
  break;
        
      case DisconnectReason.connectionReplaced:
        console.log("🔄 Conexión reemplazada por otra sesión");
        console.log("⚠️ NO limpiando sesión - puede ser temporal");
        shouldCleanSession = false;
        shouldReconnect = true;
        reconnectDelay = 60000; // Esperar 1 minuto antes de intentar reconectar
        break;
        
      case 401:
        console.log("🚪 Error 401: Intentional Logout");
        console.log("⚠️ NO limpiando sesión automáticamente - puede ser temporal");
        shouldCleanSession = false;
        shouldReconnect = true;
        reconnectDelay = 45000; // Esperar 45 segundos
        
        // 🧠 SOLO limpiar si hay múltiples intentos fallidos
        if (!global.logoutAttempts) global.logoutAttempts = 0;
        global.logoutAttempts++;
        
        if (global.logoutAttempts > 5) {
          console.log("🚨 Múltiples errores 401 - ahora SÍ limpiando sesión");
          shouldCleanSession = true;
          global.logoutAttempts = 0;
        } else {
          console.log(`🔄 Intento ${global.logoutAttempts}/5 - preservando sesión`);
        }
        break;

      case DisconnectReason.loggedOut:
        console.log("🚪 Sesión cerrada remotamente");
        console.log("⚠️ Evaluando si realmente necesita limpieza...");
        
        // Solo limpiar si hay evidencia de que la sesión está corrupta
        if (!global.remoteLogoutAttempts) global.remoteLogoutAttempts = 0;
        global.remoteLogoutAttempts++;
        
        if (global.remoteLogoutAttempts > 3) {
          console.log("🚨 Múltiples remote logouts - limpiando sesión");
          shouldCleanSession = true;
          global.remoteLogoutAttempts = 0;
        } else {
          console.log(`🔄 Remote logout ${global.remoteLogoutAttempts}/3 - preservando sesión`);
          shouldCleanSession = false;
        }
        
        shouldReconnect = true;
        reconnectDelay = 20000;
        break;
        
      // 🔄 ERRORES DE RED/TEMPORALES (NO REQUIEREN LIMPIEZA)
      case DisconnectReason.connectionClosed:
        console.log("🔌 Conexión cerrada por el servidor - NO limpiando sesión");
        shouldCleanSession = false;
        shouldReconnect = true;
        reconnectDelay = 5000;
        break;
        
      case DisconnectReason.connectionLost:
        console.log("📶 Conexión perdida - NO limpiando sesión");
        shouldCleanSession = false;
        shouldReconnect = true;
        reconnectDelay = 8000;
        break;
        
      case DisconnectReason.timedOut:
        console.log("⏰ Timeout de conexión - NO limpiando sesión");
        shouldCleanSession = false;
        shouldReconnect = true;
        reconnectDelay = 15000;
        break;
        
      case DisconnectReason.restartRequired:
        console.log("🔄 WhatsApp requiere reinicio - NO limpiando sesión");
        shouldCleanSession = false;
        shouldReconnect = true;
        reconnectDelay = 3000;
        break;
        
      // 🌐 ERRORES DE SERVIDOR (NO REQUIEREN LIMPIEZA)
      case 503:
        console.log("🌐 Error 503: Stream Errored - problema temporal del servidor");
        shouldCleanSession = false;
        shouldReconnect = true;
        reconnectDelay = 20000;
        break;
        
      case 500:
        console.log("⚠️ Error 500: Error interno del servidor WhatsApp");
        shouldCleanSession = false;
        shouldReconnect = true;
        reconnectDelay = 25000;
        break;
        
      case 408:
        console.log("⏰ Error 408: Request Timeout");
        shouldCleanSession = false;
        shouldReconnect = true;
        reconnectDelay = 12000;
        break;
        
      case 429:
        console.log("🚫 Error 429: Rate Limited - esperando más tiempo...");
        shouldCleanSession = false;
        shouldReconnect = true;
        reconnectDelay = 90000; // 1.5 minutos para rate limiting
        break;
        
      default:
        console.log(`❓ Código de desconexión desconocido: ${reason}`);
        console.log(`📋 Error completo: ${lastDisconnect?.error?.message || 'Sin detalles'}`);
        
        // 🧠 ANÁLISIS INTELIGENTE DEL ERROR
        const errorMessage = lastDisconnect?.error?.message || '';
        shouldCleanSession = false; // Por defecto NO limpiar
        
        if (errorMessage.includes('Bad MAC')) {
          console.log("🔐 Error de MAC detectado - SÍ limpiando sesión");
          shouldCleanSession = true;
          reconnectDelay = 8000;
        } else if (errorMessage.includes('Stream Errored')) {
          console.log("🌊 Error de stream - NO limpiando sesión");
          reconnectDelay = 20000;
        } else if (errorMessage.includes('timeout')) {
          console.log("⏰ Timeout detectado - NO limpiando sesión");
          reconnectDelay = 15000;
        } else if (errorMessage.includes('network') || errorMessage.includes('ECONNRESET')) {
          console.log("📶 Error de red - NO limpiando sesión");
          reconnectDelay = 10000;
        } else {
          console.log("❓ Error no identificado - NO limpiando sesión por precaución");
          reconnectDelay = 30000;
        }
        
        shouldReconnect = true;
        break;
    }
    
    // 🧹 LIMPIAR SESIÓN SOLO SI ES ABSOLUTAMENTE NECESARIO
    if (shouldCleanSession) {
      console.log("🚨 LIMPIEZA DE SESIÓN REQUERIDA - procediendo...");
      await clearCorruptedSession();
    } else {
      console.log("✅ SESIÓN PRESERVADA - no se anula 'sock'");
    }

    
    // 🔄 EJECUTAR RECONEXIÓN SI ES NECESARIA
     if (shouldReconnect) {
      // elimina la llamada duplicada
      // scheduleReconnect(10000);  // <- quitar
      if (!global.reconnectAttempts) global.reconnectAttempts = 0;
      global.reconnectAttempts++;

      if (global.reconnectAttempts > 15) {
        console.log("🛑 Demasiados intentos de reconexión - pausando por 10 minutos");
        setTimeout(() => {
          global.reconnectAttempts = 0;
          console.log("🔄 Reiniciando contador de intentos, intentando reconectar...");
          scheduleReconnect(0);         // <- usa scheduler
        }, 600000);
        return;
      }

      console.log(`🔄 Intento ${global.reconnectAttempts}/15 - Reconectando en ${Math.round(reconnectDelay/1000)} segundos...`);
      if (soket) updateQR(shouldCleanSession ? "loading" : "connecting");

      scheduleReconnect(reconnectDelay); // <- una sola programación de reconexión
    } else {
      console.log("🛑 Reconexión automática deshabilitada para este tipo de error");
    }
    
  } else if (connection === "open") {
     readyToSendAt = Date.now() + 30000;
        console.log(`✅ Conexión WhatsApp establecida. WA version=${WA_VERSION?.join('.')} isLatest=${WA_IS_LATEST}`);
        startKeepAlive();
    // Resetear TODOS los contadores al conectar exitosamente
    global.reconnectAttempts = 0;
    global.logoutAttempts = 0;
    global.remoteLogoutAttempts = 0;
    
    // startConnectionHealthCheck();
    global.macErrorCount = 0;
    global.lastMacErrorReset = Date.now();
    
    if (soket) {
      updateQR("connected");
    }
    
    if (sock?.user) {
      console.log(`👤 Usuario conectado: ${sock.user.name} (${sock.user.id})`);
    }
    
  } else if (connection === "connecting") {
    console.log("🔄 Conectando a WhatsApp...");
    if (soket) {
      updateQR("loading");
    }
  }
});

  sock.ev.on("creds.update", saveCreds);
    } catch (error) {
      console.log("❌ Error en connectToWhatsApp:", error?.message || error);
  if (process.env.NODE_ENV === 'development' && error?.stack) {
    console.log(error.stack);
  };
    } finally {
    isConnecting = false;
  }



  // 🔄 FUNCIONES DE MANEJO DE FLUJO CONVERSACIONAL

  // 🧠 Procesar mensaje inicial con OpenAI
  const processInitialMessage = async (jid, captureMessage, caption, quotedMsg) => {
    try {
      const client = new openAI({
        apiKey: process.env.OPENAI_API_KEY
      });

      const response = await client.chat.completions.create({
        model: "gpt-4o",
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `
Eres un asistente que interpreta comprobantes de pago, documentos financieros y mensajes breves para extraer información contable en formato estructurado.

### 📥 Entrada:
Recibirás **un único texto combinado** que puede tener las siguientes secciones:
1. **Caption/Mensaje**: Texto ingresado manualmente por el usuario en WhatsApp (suele estar al inicio).
2. **OCR de imagen**: Texto extraído automáticamente de imágenes mediante reconocimiento óptico de caracteres.
3. **Contenido de documento**: Texto extraído de documentos PDF, facturas digitales, etc.
4. **Indicadores de documento**: Mensajes como "[Documento PDF recibido: factura.pdf]" cuando no se pudo extraer texto.

Todas las partes estarán separadas por **dos saltos de línea** (\n\n) y se deben considerar **en conjunto** para extraer la información.

Ejemplo de entrada con documento:

Pago a proveedor - Mes de Julio

[Documento PDF recibido: factura_julio_2025.pdf]

Transferencia realizada
CBU: 000123456789
Alias: proveedor.com
Monto: $15.500
Fecha: 27/07/2025
Hora: 14:30

### 🎯 Tu objetivo:
Analizar todo el texto recibido y construir un objeto JSON con los siguientes campos:

{
  "nombre": string | null,          // Nombre de la persona o entidad involucrada
  "monto": number | null,           // Monto en pesos argentinos, sin símbolos
  "fecha": string | null,           // Formato: "dd/mm/yyyy"
  "hora": string | null,            // Formato: "hh:mm" (24 horas)
  "tipo_movimiento": string | null, // Solo "ingreso" o "egreso"
  "medio_pago": string | null,      // Ej: "Mercado Pago", "Transferencia", "Efectivo"
  "referencia": string | null,      // Código de referencia si existe
  "numero_operacion": string | null,// Número de operación o comprobante
  "observacion": string | null      // Notas o contexto adicional
}

### Indicaciones clave:

- **"tipo_movimiento"** puede ser solo: "ingreso" o "egreso".
  
- La **fecha** debe estar en formato "dd/mm/yyyy" y la hora en "hh:mm" (24 horas).
  
- El **proveedor** es generalmente quien **recibe el dinero** cuando se trata de un **egreso**, y es muy importante identificarlo.

### Criterios para deducir el tipo de movimiento:

- Si el remitente (quien envía el dinero) es **Erica Romina Davila** o **Nicolas Olave**, es muy probable que sea un **egreso**.
  
- Si el receptor (quien recibe el dinero) es **Erica Romina Davila** o **Nicolas Olave**, es probable que sea un **ingreso**.

- Si en alguna parte del texto se menciona "pago", "pagaste a", "transferencia" o similares, es probable que sea un **egreso**.
- Si en alguna parte del texto se relaciona fuertemente "pagador" con "Olave" o "Davila", es probable que sea un **egreso**.


- Si en alguna parte del texto se menciona "devolucion", "reembolso" o similares, es probable que sea un **ingreso**.

> Estos criterios no son absolutos: en algunos casos puede haber excepciones.

### Manejo de documentos:

- Si recibes un **documento PDF** (indicado por "[Documento PDF recibido: nombre.pdf]"), significa que el usuario envió un archivo adjunto.
- En estos casos, prioriza la información del **caption/mensaje del usuario** y cualquier texto extraído del documento.
- Si el documento no pudo ser procesado completamente, solicita al usuario que incluya **fecha** y **tipo de movimiento** en el mensaje de acompañamiento.
- Los PDFs suelen contener facturas, recibos o comprobantes oficiales, así que trata de identificar **números de factura** o **códigos de referencia**.

### Contexto adicional:

- El sistema se utiliza en Mar del Plata, Argentina. El dinero está expresado en pesos argentinos.
- Si hay dudas razonables sobre algún campo, trata de devolver algun resultado adecuado, pero si no hay exacta certeza, devuelve null.
- Usa el campo "observacion" para notas relevantes, alias de nombres, u otra información contextual.

Responde únicamente con el JSON, sin texto adicional.
`
                },
                {
                  role: "user",
                  content: captureMessage
                }
              ]
            });

            const jsonString = response.choices[0].message.content.trim();
            console.log("🤖 Respuesta OpenAI estructurada:", jsonString)

            let data;
            try {
              data = JSON.parse(jsonString);
            } catch (err) {
              console.error("Error al parsear JSON de OpenAI:", err);
              data = {};
            }

      const destinatarioName = data.nombre || "Desconocido";
      console.log({ destinatarioName });

      // Buscar coincidencia de destinatario (IMPORTANTE: usar await porque es async)
      const destinatarioMatch = await matchDestinatario(destinatarioName);
          
      if (destinatarioMatch.clave) {
        console.log("✅ Destinatario encontrado:", { destinatarioMatch });
        
        // Guardar estado y datos
        setUserState(jid, STATES.AWAITING_DESTINATARIO_CONFIRMATION, {
          structuredData: data,
          destinatarioMatch,
          caption,
          originalData: data
        });

        // Enviar pregunta de confirmación con lista numerada
        await safeSendMessage(jid, {
          text: `✅ El destinatario es *${destinatarioMatch.clave}*\n\n¿Es correcto?\n\n1. Sí\n2. No\n3. Cancelar\n\nEscribe el número de tu opción:`
        }, { quoted: quotedMsg });

      } else {
        console.log("❌ No se encontró destinatario, intentando con caption...");
        // No se encontró coincidencia, intentar con caption
        await trySecondDestinatarioMatch(jid, caption, data, quotedMsg);
      }

    } catch (error) {
      console.error("❌ Error con OpenAI:", error.message);
      await safeSendMessage(jid, {
        text: "Ocurrió un error interpretando el mensaje."
      }, { quoted: quotedMsg });
    }
  };

  // 🔍 Segundo intento de coincidencia con caption
  const trySecondDestinatarioMatch = async (jid, caption, structuredData, quotedMsg) => {
    const nameInCaption = caption.split('-')[0].trim();
    const destinatarioFromCaption = await matchDestinatario(nameInCaption, destinatarios);
    
    if (destinatarioFromCaption.clave) {
      console.log("✅ Destinatario encontrado en segundo intento:", { destinatarioFromCaption });
      
      setUserState(jid, STATES.AWAITING_DESTINATARIO_SECOND_TRY, {
        structuredData,
        destinatarioMatch: destinatarioFromCaption,
        caption,
        originalData: structuredData
      });

      await safeSendMessage(jid, {
        text: `🔍 Segundo intento: El destinatario es *${destinatarioFromCaption.clave}*\n\n¿Es correcto?\n\n1. Sí\n2. No\n3. Cancelar\n\nEscribe el número de tu opción:`
      }, { quoted: quotedMsg });
    } else {
      console.log("❌ No se encontró destinatario en segundo intento, mostrando lista completa...");
      // Mostrar lista completa de destinatarios en lugar de crear uno nuevo directamente
      await showAllDestinatariosList(jid, structuredData);
    }
  };

  // 📝 Iniciar flujo de nuevo destinatario
  const startNewDestinatarioFlow = async (jid, structuredData) => {
    setUserState(jid, STATES.AWAITING_NEW_DESTINATARIO_NAME, {
      structuredData: structuredData.isModification ? null : structuredData,
      finalStructuredData: structuredData.isModification ? structuredData : null,
      isModification: structuredData.isModification || false,
      originalData: structuredData
    });

    await safeSendMessage(jid, {
      text: "🆕 Vamos a crear un nuevo destinatario.\n\nEscribe el nombre canónico del destinatario:"
    });
  };

  // 🔘 Manejar confirmación de destinatario (primera vez)
  const handleDestinationConfirmation = async (jid, textMessage, userState, quotedMsg) => {
    const option = parseInt(textMessage.trim());
    
    if (isNaN(option) || option < 1 || option > 3) {
      await safeSendMessage(jid, { text: "⚠️ Por favor, escribe un número válido (1, 2 o 3)." });
      return;
    }

    switch (option) {
      case 1: // Sí
        await proceedToFinalConfirmation(jid, userState.data.destinatarioMatch.clave, userState.data.structuredData);
        break;
      case 2: // No
        await trySecondDestinatarioMatch(jid, userState.data.caption, userState.data.structuredData, quotedMsg);
        break;
      case 3: // Cancelar
        await safeSendMessage(jid, { text: "❌ Operación cancelada." });
        clearUserState(jid);
        break;
    }
  };

  // 🔘 Manejar confirmación de destinatario (segundo intento)
  const handleSecondDestinationConfirmation = async (jid, textMessage, userState, quotedMsg) => {
    const option = parseInt(textMessage.trim());
    
    if (isNaN(option) || option < 1 || option > 3) {
      await safeSendMessage(jid, { text: "⚠️ Por favor, escribe un número válido (1, 2 o 3)." });
      return;
    }

    switch (option) {
      case 1: // Sí
        await proceedToFinalConfirmation(jid, userState.data.destinatarioMatch.clave, userState.data.structuredData);
        break;
      case 2: // No
        await showAllDestinatariosList(jid, userState.data.structuredData);
        break;
      case 3: // Cancelar
        await safeSendMessage(jid, { text: "❌ Operación cancelada." });
        clearUserState(jid);
        break;
    }
  };



  // 📋 Mostrar lista completa de destinatarios
  const showAllDestinatariosList = async (jid, structuredData) => {
    try {
      // Obtener todos los destinatarios de la base de datos
      const { data: allDestinatarios, error } = await supabase
        .from('destinatarios')
        .select('id, name')
        .order('name');

      if (error) {
        console.error("Error obteniendo destinatarios:", error);
        await safeSendMessage(jid, { text: "❌ Error obteniendo la lista de destinatarios." });
        clearUserState(jid);
        return;
      }

      if (!allDestinatarios || allDestinatarios.length === 0) {
        await safeSendMessage(jid, { text: "📋 No hay destinatarios registrados. Procederemos a crear uno nuevo." });
        await startNewDestinatarioFlow(jid, structuredData);
        return;
      }

      // Crear lista numerada (empezando desde 2)
      let destinatarioList = "0. ❌ Cancelar\n1. ➕ Nuevo destinatario\n";
      allDestinatarios.forEach((dest, index) => {
        destinatarioList += `${index + 2}. ${dest.name}\n`;
      });

      // Guardar estado con los destinatarios disponibles
      setUserState(jid, STATES.AWAITING_DESTINATARIO_CHOOSING_IN_LIST_OR_ADDING_NEW, {
        structuredData,
        allDestinatarios,
        originalData: structuredData
      });

      await safeSendMessage(jid, {
        text: `📋 *Lista completa de destinatarios:*\n\n${destinatarioList}\nEscribe el número del destinatario que corresponde:`
      });

    } catch (error) {
      console.error("Error en showAllDestinatariosList:", error);
      await safeSendMessage(jid, { text: "❌ Error mostrando la lista de destinatarios." });
      clearUserState(jid);
    }
  };

  const handleMedioPagoSelection = async (jid, textMessage, userState, quotedMsg) => {
  const option = parseInt(textMessage.trim());
  console.log(`🔍 Opción de método de pago seleccionada: ${option}`);
  
  const allMetodosPago = userState.data.allMetodosPago;
  const maxOption = allMetodosPago.length + 1; // +1 por la opción "crear nuevo"

  if (isNaN(option) || option < 0 || option > maxOption) {
    await safeSendMessage(jid, { 
      text: `⚠️ Por favor, escribe un número válido (0 a ${maxOption}).` 
    });
    return;
  }

  if (option === 0) {
    // Cancelar
    await safeSendMessage(jid, { text: "❌ Operación cancelada." });
    clearUserState(jid);
    return;
  }

  if (option === 1) {
    // Crear nuevo método de pago
    await startNewMetodoPagoFlow(jid, userState.data.structuredData);
    return;
  }

  // Método de pago seleccionado (índices 2 en adelante)
  const selectedIndex = option - 2; // Convertir a índice del array (0-based)
  if (selectedIndex >= 0 && selectedIndex < allMetodosPago.length) {
    const selectedMetodoPago = allMetodosPago[selectedIndex];
    console.log(`✅ Método de pago seleccionado: ${selectedMetodoPago.name}`);

    await proceedToFinalConfirmationWithMetodoPago(jid, selectedMetodoPago.name, userState.data.structuredData);
  } else {
    await safeSendMessage(jid, { text: "⚠️ Opción no válida. Intenta nuevamente." });
  }
};

const startNewMetodoPagoFlow = async (jid, structuredData) => {
  setUserState(jid, STATES.AWAITING_NEW_METODO_PAGO_NAME, {
    structuredData,
    originalData: structuredData
  });

  await safeSendMessage(jid, {
    text: "💳 Vamos a crear un nuevo método de pago.\n\nEscribe el nombre del nuevo método de pago:"
  });
};

// 📝 Manejar nombre de nuevo método de pago
const handleNewMetodoPagoName = async (jid, textMessage, userState, quotedMsg) => {
  const nombreMetodoPago = textMessage.trim();
  
  if (!nombreMetodoPago) {
    await safeSendMessage(jid, { text: "⚠️ Por favor, ingresa un nombre válido." });
    return;
  }

  // Guardar nuevo método de pago en la base de datos
  const newMetodoPago = await saveNewMetodoPago(nombreMetodoPago);

  if (!newMetodoPago) {
    await safeSendMessage(jid, { text: "❌ Error guardando el método de pago. Intenta más tarde." });
    clearUserState(jid);
    return;
  }

  await safeSendMessage(jid, { 
    text: `✅ Método de pago *${nombreMetodoPago}* creado exitosamente.` 
  });

  const graceful = async (signal) => {
  console.log(`\n${signal} recibido. Cerrando conexiones Mongo...`);
  await closeClient().catch(()=>{});
  process.exit(0);
};

  // Verificar si estamos en modo modificación
  const isModification = userState.data.isModification || userState.data.finalStructuredData;
  
  if (isModification) {
    // Actualizar método de pago en modificación
    const updatedData = {
      ...userState.data.finalStructuredData,
      medio_pago: nombreMetodoPago
    };
    console.log('🔧 Nuevo método de pago creado en modificación:', nombreMetodoPago);
    await proceedToFinalConfirmationFromModification(jid, updatedData);
  } else {
    // Flujo normal
    await proceedToFinalConfirmationWithMetodoPago(jid, nombreMetodoPago, userState.data.structuredData);
  }
};

// 💾 Guardar nuevo método de pago en Supabase
const saveNewMetodoPago = async (name) => {
  try {
    console.log(`💾 Guardando nuevo método de pago: ${name}`);
    
    const { data, error } = await supabase
      .from('metodos_pago')
      .insert([{ name: name }])
      .select()
      .single();
    
    if (error) {
      console.error("❌ Error guardando método de pago:", error);
      return null;
    }
    
    console.log("✅ Método de pago guardado:", data);
    return data;
  } catch (error) {
    console.error('❌ Error en saveNewMetodoPago:', error.message);
    return null;
  }
};

  const proceedToFinalConfirmationWithMetodoPago = async (jid, metodoPagoName, structuredData) => {
  const finalData = normalizeDateTime({
    ...structuredData,
    medio_pago: metodoPagoName
  });

  setUserState(jid, STATES.AWAITING_SAVE_CONFIRMATION, {
    finalStructuredData: finalData
  });

  await safeSendMessage(jid, {
    text: `📋 *Datos del comprobante:*\n\n` +
    `👤 *Destinatario:* ${finalData.nombre}\n` +
    `💰 *Monto:* $${finalData.monto || 'No especificado'}\n` +
    `📅 *Fecha:* ${finalData.fecha || 'No especificada'}\n` +
    `🕐 *Hora:* ${finalData.hora || 'No especificada'}\n` +
    `📊 *Tipo:* ${finalData.tipo_movimiento || 'No especificado'}\n` +
    `💳 *Método de pago:* ${finalData.medio_pago}\n\n` +
    `¿Deseas guardar estos datos?\n\n1. 💾 Guardar\n2. ✏️ Modificar\n3. ❌ Cancelar\n\nEscribe el número de tu opción:`
  });
};


  const pad2 = (n) => String(n).padStart(2, '0');

  const normalizeDateTime = (data) => {
    // data.fecha: dd/mm/yyyy (opcional)
    // data.hora:  HH:mm       (opcional)
    const now = new Date();

    // Parse fecha dd/mm/yyyy o dd-mm-yyyy
    let d, m, y;
    if (typeof data.fecha === 'string') {
      const fm = data.fecha.match(/^\s*(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\s*$/);
      if (fm) {
        d = parseInt(fm[1], 10);
        m = parseInt(fm[2], 10);
        y = parseInt(fm[3], 10);
      }
    }
    if (d == null || m == null || y == null) {
      // si no hay fecha, usar hoy
      d = now.getDate();
      m = now.getMonth() + 1;
      y = now.getFullYear();
    }

    // Parse hora HH:mm (si no hay, usar 00:00)
    let hh = 0, mm = 0;
    if (typeof data.hora === 'string') {
      const hm = data.hora.match(/^\s*(\d{1,2}):(\d{2})\s*$/);
      if (hm) {
        hh = Math.min(23, parseInt(hm[1], 10));
        mm = Math.min(59, parseInt(hm[2], 10));
      } else if (!data.hora) {
        // si hora está ausente explícitamente, dejaremos 00:00
      }
    } else if (data.hora) {
      // si viene en otro formato no válido, también 00:00
    }

    const localDate = new Date(y, m - 1, d, hh, mm, 0, 0); // zona local del server
    const fechaStr = `${pad2(d)}/${pad2(m)}/${y}`;
    const horaStr = `${pad2(hh)}:${pad2(mm)}`;
    const iso = localDate.toISOString(); // listo para timestamptz

    return {
      ...data,
      fecha: fechaStr,
      hora: horaStr,
      fecha_iso: iso // para guardar en BD como timestamptz
    };
  };


  // 🔄 Manejar selección de la lista completa de destinatarios
  const handleChoosingInListOrAddingNew = async (jid, textMessage, userState, quotedMsg) => {
    const option = parseInt(textMessage.trim());
    const allDestinatarios = userState.data.allDestinatarios;
    const maxOption = allDestinatarios.length + 1; // +1 porque empezamos desde el índice 2
    const isModification = userState.data.isModification || false;

    if (isNaN(option) || option < 0 || option > maxOption) {
      await safeSendMessage(jid, { 
        text: `⚠️ Por favor, escribe un número válido (0 a ${maxOption}).` 
      });
      return;
    }

    switch (option) {
      case 0: // Cancelar
        if (isModification) {
          await proceedToFinalConfirmationFromModification(jid, userState.data.finalStructuredData);
        } else {
          await safeSendMessage(jid, { text: "❌ Operación cancelada." });
          clearUserState(jid);
        }
        break;
        
      case 1: // Nuevo destinatario
        const dataForNewDestinatario = isModification 
          ? { ...userState.data.finalStructuredData, isModification: true }
          : userState.data.structuredData;
        await startNewDestinatarioFlow(jid, dataForNewDestinatario);
        break;
        
      default: // Destinatario seleccionado (índices 2 en adelante)
        const selectedIndex = option - 2; // Convertir a índice del array (0-based)
        if (selectedIndex >= 0 && selectedIndex < allDestinatarios.length) {
          const selectedDestinatario = allDestinatarios[selectedIndex];
          console.log(`✅ Destinatario seleccionado: ${selectedDestinatario.name}`);

          if (isModification) {
            // Actualizar destinatario en modificación
            const updatedData = {
              ...userState.data.finalStructuredData,
              nombre: selectedDestinatario.name
            };
            console.log('🔧 Destinatario actualizado en modificación:', {
              anterior: userState.data.finalStructuredData.nombre,
              nuevo: selectedDestinatario.name,
              updatedData: updatedData
            });
            await safeSendMessage(jid, { text: `✅ Destinatario actualizado a: ${selectedDestinatario.name}` });
            await proceedToFinalConfirmationFromModification(jid, updatedData);
          } else {
            // Flujo normal
            await proceedToFinalConfirmation(jid, selectedDestinatario.name, userState.data.structuredData);
          }
        } else {
          await safeSendMessage(jid, { text: "⚠️ Opción no válida. Intenta nuevamente." });
        }
        break;
    }
  };

  // 🔘 Manejar confirmación de guardado
  const handleSaveConfirmation = async (jid, textMessage, userState, quotedMsg) => {
    const option = parseInt(textMessage.trim());
    
    if (isNaN(option) || option < 1 || option > 3) {
      await safeSendMessage(jid, { text: "⚠️ Por favor, escribe un número válido (1, 2 o 3)." });
      return;
    }

    switch (option) {
      case 1: // Guardar
        await saveComprobante(jid, userState.data);
        break;
      case 2: // Modificar
        await showModificationMenu(jid, userState.data);
        break;
      case 3: // Cancelar
        await safeSendMessage(jid, { text: "❌ Operación cancelada." });
        clearUserState(jid);
        break;
    }
  };


  // Reemplazar la función handleNewDestinatarioName (línea ~1275)
// Reemplazar la función handleNewDestinatarioName
const handleNewDestinatarioName = async (jid, textMessage, userState, quotedMsg) => {
  const nombreCanonico = textMessage.trim();
  
  if (!nombreCanonico) {
    await safeSendMessage(jid, { text: "⚠️ Por favor, ingresa un nombre válido." });
    return;
  }

  console.log(`🔍 Procesando nuevo destinatario: "${nombreCanonico}"`);
  
  // 🎯 VERIFICAR SI EXISTE UN DESTINATARIO SIMILAR
  const similarMatch = await checkSimilarDestinatario(nombreCanonico);
  
  if (similarMatch) {
    // 🎯 NUEVA LÓGICA: Coincidencia exacta - usar automáticamente
    if (similarMatch.isExactMatch) {
      console.log(`🎯 Coincidencia exacta encontrada: ${similarMatch.destinatario.name} - usando automáticamente`);
      
      await safeSendMessage(jid, {
        text: `🎯 El destinatario "*${nombreCanonico}*" ya existe en el sistema.\n\n` +
        `✅ Se usará el destinatario existente: *${similarMatch.destinatario.name}*\n\n` +
        `💡 Se realizó una búsqueda en el sistema y se encontró una coincidencia exacta.`
      });

      // Verificar si estamos en modo modificación
      const isModification = userState.data.isModification || userState.data.finalStructuredData;
      
      if (isModification) {
        // Actualizar destinatario en modificación
        const updatedData = {
          ...userState.data.finalStructuredData,
          nombre: similarMatch.destinatario.name
        };
        console.log('🔧 Destinatario exacto encontrado en modificación:', similarMatch.destinatario.name);
        await safeSendMessage(jid, { text: `✅ Destinatario actualizado a: ${similarMatch.destinatario.name}` });
        await proceedToFinalConfirmationFromModification(jid, updatedData);
      } else {
        // Flujo normal - proceder a verificar método de pago
        await proceedToFinalConfirmation(jid, similarMatch.destinatario.name, userState.data.structuredData);
      }
      return;
    }
    
    // 🔍 LÓGICA EXISTENTE: Coincidencia similar - preguntar al usuario
    console.log(`🔍 Destinatario similar encontrado: ${similarMatch.destinatario.name} (score: ${similarMatch.score})`);
    
    setUserState(jid, STATES.AWAITING_DESTINATARIO_FUZZY_CONFIRMATION, {
      ...userState.data,
      nombreCanonicoNuevo: nombreCanonico,
      destinatarioSimilar: similarMatch.destinatario
    });
    
    await safeSendMessage(jid, {
      text: `🔍 Revisando todo el listado de destinatarios, he encontrado uno parecido:\n\n` +
      `*${similarMatch.destinatario.name}*\n\n` +
      `¿Qué deseas hacer?\n\n` +
      `1. ✅ Usar "${similarMatch.destinatario.name}"\n` +
      `2. ➕ Crear nuevo "${nombreCanonico}"\n` +
      `3. ❌ Cancelar\n\n` +
      `Escribe el número de tu opción:`
    });
    
  } else {
    // No hay destinatarios similares, proceder directamente a pedir aliases
    console.log(`✅ No hay destinatarios similares, procediendo con: "${nombreCanonico}"`);
    await proceedToAliasesInput(jid, nombreCanonico, userState.data);
  }
};

   const handleMedioPagoConfirmation = async (jid, textMessage, userState, quotedMsg) => {
    const option = parseInt(textMessage.trim());
    
    if (isNaN(option) || option < 1 || option > 3) {
      await safeSendMessage(jid, { text: "⚠️ Por favor, escribe un número válido (1, 2 o 3)." });
      return;
    }

    switch (option) {
      case 1: // Sí
        await proceedToFinalConfirmationWithMetodoPago(jid, userState.data.metodoPagoMatch.name, userState.data.structuredData);
        break;
      case 2: // No
        await showAllMetodosPagoList(jid, userState.data.structuredData);
        break;
      case 3: // Cancelar
        await safeSendMessage(jid, { text: "❌ Operación cancelada." });
        clearUserState(jid);
        break;
    }
  };

// 🔘 Manejar confirmación de destinatario similar (fuzzy matching)
const handleDestinatarioFuzzyConfirmation = async (jid, textMessage, userState, quotedMsg) => {
  const option = parseInt(textMessage.trim());
  
  if (isNaN(option) || option < 1 || option > 3) {
    await safeSendMessage(jid, { text: "⚠️ Por favor, escribe un número válido (1, 2 o 3)." });
    return;
  }

  switch (option) {
    case 1: // Usar destinatario existente
      const destinatarioExistente = userState.data.destinatarioSimilar;
      console.log(`✅ Usuario eligió destinatario existente: ${destinatarioExistente.name}`);
      
      // Verificar si estamos en modo modificación
      const isModification = userState.data.isModification || userState.data.finalStructuredData;
      
      if (isModification) {
        // Actualizar destinatario en modificación
        const updatedData = {
          ...userState.data.finalStructuredData,
          nombre: destinatarioExistente.name
        };
        console.log('🔧 Destinatario existente seleccionado en modificación:', destinatarioExistente.name);
        await safeSendMessage(jid, { text: `✅ Destinatario actualizado a: ${destinatarioExistente.name}` });
        await proceedToFinalConfirmationFromModification(jid, updatedData);
      } else {
        // Flujo normal - proceder a verificar método de pago
        await proceedToFinalConfirmation(jid, destinatarioExistente.name, userState.data.structuredData);
      }
      break;
      
    case 2: // Crear nuevo destinatario
      const nombreNuevo = userState.data.nombreCanonicoNuevo;
      console.log(`✅ Usuario eligió crear nuevo destinatario: ${nombreNuevo}`);
      await proceedToAliasesInput(jid, nombreNuevo, userState.data);
      break;
      
    case 3: // Cancelar
      await safeSendMessage(jid, { text: "❌ Operación cancelada." });
      clearUserState(jid);
      break;
  }
};


// Agregar después de handleDestinatarioFuzzyConfirmation
// 📝 Proceder a solicitar aliases del destinatario
const proceedToAliasesInput = async (jid, nombreCanonico, userData) => {
  // Actualizar datos con el nombre
  const updatedData = { 
    ...userData, 
    newDestinatarioName: nombreCanonico 
  };

  setUserState(jid, STATES.AWAITING_DESTINATARIO_ALIASES, updatedData);

  await safeSendMessage(jid, {
    text: `✅ Nombre guardado: *${nombreCanonico}*\n\n` +
    `📝 Ahora, si deseas puedes agregar "seudónimos" para *${nombreCanonico}*, escribe los nombres separados por una coma, sigue el siguiente ejemplo:\n\n` +
    `*Nombre canónico:* Confitería Alamos\n` +
    `*Aliases:* Confitería, Alamos, Los Alamos, Iván Alamos...\n\n` +
    `Esto servirá para mejorar la precisión al momento de filtrar los nombres de cada destinatario.\n\n` +
    `💡 Si no deseas agregar aliases, escribe "skip" o "0" para continuar.`
  });
};


// Agregar después de proceedToAliasesInput
// 📝 Manejar entrada de aliases del destinatario
// Reemplazar la función handleDestinatarioAliases (línea ~1310)
const handleDestinatarioAliases = async (jid, textMessage, userState, quotedMsg) => {
  const input = textMessage.trim();
  
  // Verificar si el usuario quiere saltarse los aliases
  if (input.toLowerCase() === "skip" || input === "0") {
    console.log(`⏭️ Usuario decidió saltarse aliases para: ${userState.data.newDestinatarioName}`);
    await proceedToCategorySelection(jid, userState.data, []);
    return;
  }
  
  // Procesar aliases separados por coma
  const aliases = input.split(',')
    .map(alias => alias.trim())
    .filter(alias => alias.length > 0);
  
  if (aliases.length === 0) {
    await safeSendMessage(jid, { 
      text: "⚠️ No se detectaron aliases válidos. Separa los nombres con comas o escribe 'skip' para continuar sin aliases." 
    });
    return;
  }
  
  console.log(`📝 ${aliases.length} aliases procesados para ${userState.data.newDestinatarioName}:`, aliases);
  
  // 🔍 VERIFICAR DUPLICADOS ANTES DE GUARDAR
  const { validAliases, duplicates, errors } = await checkDuplicateAliases(aliases);
  
  // Construir mensaje de respuesta
  let responseMessage = "";
  
  if (validAliases.length > 0) {
    responseMessage += `✅ ${validAliases.length} seudónimos válidos:\n• ${validAliases.join('\n• ')}\n\n`;
  }
  
  if (duplicates.length > 0) {
    responseMessage += `⚠️ ${duplicates.length} seudónimos ya existen (ignorados):\n• ${duplicates.join('\n• ')}\n\n`;
  }
  
  if (errors.length > 0) {
    responseMessage += `❌ ${errors.length} seudónimos con errores (ignorados):\n• ${errors.join('\n• ')}\n\n`;
  }
  
  if (validAliases.length === 0) {
    responseMessage += "⚠️ No hay seudónimos nuevos para agregar.\n\n";
  }
  
  responseMessage += "Continuando con las categorías...";
  
  await safeSendMessage(jid, { text: responseMessage });
  
  // Proceder a selección de categoría con solo los aliases válidos
  await proceedToCategorySelection(jid, userState.data, validAliases);
};



  const showAllMetodosPagoList = async (jid, structuredData) => {
  try {
    const metodosPago = await getMetodosPago();

    if (metodosPago.length === 0) {
      await safeSendMessage(jid, { text: "❌ No hay métodos de pago registrados en el sistema." });
      clearUserState(jid);
      return;
    }

    // Crear lista numerada empezando desde 2
    let metodosList = "0. ❌ Cancelar\n1. ➕ Crear nuevo método de pago\n";
    metodosPago.forEach((metodo, index) => {
      metodosList += `${index + 2}. ${metodo.name}\n`;
    });

    // Guardar estado con los métodos disponibles
    setUserState(jid, STATES.AWAITING_MEDIO_PAGO_SELECTION, {
      structuredData,
      allMetodosPago: metodosPago,
      originalData: structuredData
    });

    await safeSendMessage(jid, {
      text: `💳 *Lista completa de métodos de pago:*\n\n${metodosList}\nEscribe el número del método de pago que corresponde:`
    });

  } catch (error) {
    console.error("Error en showAllMetodosPagoList:", error);
    await safeSendMessage(jid, { text: "❌ Error mostrando la lista de métodos de pago." });
    clearUserState(jid);
  }
};

  // Agregar después de handleDestinatarioAliases
// 📂 Proceder a selección de categoría con aliases
const proceedToCategorySelection = async (jid, userData, aliases) => {
  // Actualizar datos con aliases
  const updatedData = { 
    ...userData, 
    destinatarioAliases: aliases 
  };

  setUserState(jid, STATES.AWAITING_CATEGORY_SELECTION, updatedData);

  // Obtener y mostrar categorías
  const categorias = await getCategorias();
  
  if (categorias.length === 0) {
    await safeSendMessage(jid, { text: "❌ No se pudieron cargar las categorías. Intenta más tarde." });
    clearUserState(jid);
    return;
  }

  // Crear lista numerada de categorías
  const categoryList = categorias.map((cat, index) => 
    `${index + 1}. ${cat.name}`
  ).join('\n');

  // Guardar categorías en el estado para mapear el número luego
  const updatedDataWithCategories = {
    ...updatedData,
    availableCategories: categorias
  };
  setUserState(jid, STATES.AWAITING_CATEGORY_SELECTION, updatedDataWithCategories);

  await safeSendMessage(jid, {
    text: `📂 Elige una categoría escribiendo el número:\n\n${categoryList}\n\nEscribe solo el número de la categoría que deseas.`
  });
};

  // � Manejar selección numérica de categoría
  const handleCategoryNumberSelection = async (jid, textMessage, userState, quotedMsg) => {
    const categoryNumber = parseInt(textMessage.trim());
    
    if (isNaN(categoryNumber) || categoryNumber < 1) {
      await safeSendMessage(jid, { text: "⚠️ Por favor, escribe un número válido de la lista." });
      return;
    }

    const categories = userState.data.availableCategories;
    if (!categories || categoryNumber > categories.length) {
      await safeSendMessage(jid, { text: "⚠️ Número fuera de rango. Elige un número de la lista." });
      return;
    }

    const selectedCategory = categories[categoryNumber - 1];
    console.log(`✅ Categoría seleccionada: ${selectedCategory.nombre} (ID: ${selectedCategory.id})`);
    
    await handleCategorySelection(jid, selectedCategory.id, userState.data);
  };

  // 🔢 Manejar selección numérica de subcategoría
   const handleSubcategoryNumberSelection = async (jid, textMessage, userState, quotedMsg) => {
    const subcategoryNumber = parseInt(textMessage.trim());
    
    if (isNaN(subcategoryNumber) || subcategoryNumber < 1) {
      await safeSendMessage(jid, { text: "⚠️ Por favor, escribe un número válido de la lista." });
      return;
    }

    const subcategories = userState.data.availableSubcategories;
    if (!subcategories || subcategoryNumber > subcategories.length) {
      await safeSendMessage(jid, { text: "⚠️ Número fuera de rango. Elige un número de la lista." });
      return;
    }

    const selectedSubcategory = subcategories[subcategoryNumber - 1];
    console.log(`✅ Subcategoría seleccionada: ${selectedSubcategory.nombre} (ID: ${selectedSubcategory.id})`);
    
    await handleSubcategorySelection(jid, selectedSubcategory.id, userState.data);
  };

  // �📂 Manejar selección de categoría
  const handleCategorySelection = async (jid, categoriaId, userData) => {
    const subcategorias = await getSubcategorias(categoriaId);
    
    if (subcategorias.length === 0) {
      await safeSendMessage(jid, { text: "⚠️ No hay subcategorías disponibles para esta categoría." });
      return;
    }

    const updatedData = { 
      ...userData, 
      selectedCategoriaId: categoriaId,
      availableSubcategories: subcategorias 
    };

    setUserState(jid, STATES.AWAITING_SUBCATEGORY_SELECTION, updatedData);

    // Crear lista numerada de subcategorías
    const subcategoryList = subcategorias.map((subcat, index) => 
      `${index + 1}. ${subcat.name}`
    ).join('\n');

    await safeSendMessage(jid, {
      text: `� Ahora elige una subcategoría escribiendo el número:\n\n${subcategoryList}\n\nEscribe solo el número de la subcategoría que deseas.`
    });
  };

  // 📁 Manejar selección de subcategoría
  // Reemplazar la función handleSubcategorySelection (línea ~1350)
const handleSubcategorySelection = async (jid, subcategoriaId, userData) => {
  // Guardar nuevo destinatario
  const newDestinatario = await saveNewDestinatario(
    userData.newDestinatarioName,
    userData.selectedCategoriaId,
    subcategoriaId
  );

  if (!newDestinatario) {
    await safeSendMessage(jid, { text: "❌ Error guardando el destinatario. Intenta más tarde." });
    clearUserState(jid);
    return;
  }

  console.log(`✅ Destinatario creado: ${userData.newDestinatarioName} (ID: ${newDestinatario.id})`);

  // 🆕 GUARDAR ALIASES SI EXISTEN
  if (userData.destinatarioAliases && userData.destinatarioAliases.length > 0) {
    console.log(`📝 Guardando ${userData.destinatarioAliases.length} aliases...`);
    const aliasesGuardados = await saveDestinatarioAliases(newDestinatario.id, userData.destinatarioAliases);
    
    if (aliasesGuardados) {
      console.log(`✅ Aliases guardados para destinatario: ${userData.newDestinatarioName}`);
    } else {
      console.warn(`⚠️ Error guardando aliases, pero destinatario creado exitosamente`);
    }
  }

  await safeSendMessage(jid, { 
    text: `✅ Destinatario *${userData.newDestinatarioName}* creado exitosamente${userData.destinatarioAliases?.length ? ` con ${userData.destinatarioAliases.length} seudónimos` : ''}.` 
  });

  // Verificar si estamos en modo modificación
  const isModification = userData.isModification || userData.finalStructuredData;
  
  if (isModification) {
    // Actualizar destinatario en los datos existentes para modificación
    const updatedData = {
      ...userData.finalStructuredData,
      nombre: userData.newDestinatarioName
    };
    console.log('🔧 Nuevo destinatario creado en modificación:', userData.newDestinatarioName);
    await proceedToFinalConfirmationFromModification(jid, updatedData);
  } else {
    // Flujo normal - verificar método de pago después de crear nuevo destinatario
    await proceedToFinalConfirmation(jid, userData.newDestinatarioName, userData.structuredData);
  }
};

  // ✅ Proceder a confirmación final
  const proceedToFinalConfirmation = async (jid, destinatarioName, structuredData) => {
    const dataWithDestinatario = {
      ...structuredData,
      nombre: destinatarioName
    };

    console.log(`🔍 Verificando método de pago: "${dataWithDestinatario.medio_pago}"`);
    
    // Buscar coincidencia de método de pago
    const metodoPagoMatch = await matchMetodoPago(dataWithDestinatario.medio_pago);
    
    if (metodoPagoMatch.name) {
      console.log("✅ Método de pago encontrado:", { metodoPagoMatch });
      
      // Guardar estado y datos
      setUserState(jid, STATES.AWAITING_MEDIO_PAGO_CONFIRMATION, {
        structuredData: dataWithDestinatario,
        metodoPagoMatch,
        originalData: dataWithDestinatario
      });

      // Enviar pregunta de confirmación
      await safeSendMessage(jid, {
        text: `💳 El método de pago es *${metodoPagoMatch.name}*\n\n¿Es correcto?\n\n1. Sí\n2. No\n3. Cancelar\n\nEscribe el número de tu opción:`
      });

    } else {
      console.log("❌ No se encontró método de pago, mostrando lista completa...");
      // No se encontró coincidencia, mostrar lista completa
      await showAllMetodosPagoList(jid, dataWithDestinatario);
    }
  };

  // 💾 Guardar comprobante final
  const saveComprobante = async (jid, userData) => {
  try {
    const normalized = normalizeDateTime(userData.finalStructuredData || {});

    // Mantener compatibilidad: fecha (dd/mm/yyyy) y hora (HH:mm)
    const payload = {
      ...normalized,
      fecha: normalized.fecha,      // dd/mm/yyyy (lo que espera saveDataFirstFlow)
      hora: normalized.hora,        // HH:mm
      fecha_iso: normalized.fecha_iso // opcional por si luego la usas como timestamptz
    };

    const result = await saveDataFirstFlow(payload);
    if (result.success) {
      await safeSendMessage(jid, { text: "✅ Comprobante guardado exitosamente." });
    } else {
      await safeSendMessage(jid, { text: "❌ Error guardando el comprobante. Intenta más tarde." });
    }
    clearUserState(jid);
  } catch (error) {
    console.error("Error guardando comprobante:", error);
    await safeSendMessage(jid, { text: "❌ Error guardando el comprobante." });
    clearUserState(jid);
  }
};

  // 📝 Mostrar menú de modificación
  const showModificationMenu = async (jid, userData) => {
    setUserState(jid, STATES.AWAITING_MODIFICATION_SELECTION, userData);

    await safeSendMessage(jid, {
      text: `📝 ¿Qué deseas modificar?\n\n` +
      `0. ❌ Cancelar\n` +
      `1. 👤 Destinatario\n` +
      `2. 💰 Monto\n` +
      `3. 📅 Fecha\n` +
      `4. 📊 Tipo de movimiento\n` +
      `5. 💳 Medio de pago\n\n` +
      `Escribe el número de tu opción:`
    });
  };

  // 🔘 Manejar selección de modificación
  const handleModificationSelection = async (jid, textMessage, userState, quotedMsg) => {
    const option = parseInt(textMessage.trim());
    
    if (isNaN(option) || option < 0 || option > 5) {
      await safeSendMessage(jid, { text: "⚠️ Por favor, escribe un número válido (0 a 5)." });
      return;
    }

    switch (option) {
      case 0: // Cancelar - volver a confirmación
        await proceedToFinalConfirmationFromModification(jid, userState.data.finalStructuredData);
        break;
      case 1: // Destinatario
        await showDestinatariosForModification(jid, userState.data);
        break;
      case 2: // Monto
        setUserState(jid, STATES.AWAITING_MONTO_MODIFICATION, userState.data);
        await safeSendMessage(jid, {
          text: "💰 Escribe el nuevo monto (solo números, sin puntos, sin comas, sin símbolos):\n\nEjemplo: 14935\n\nEscribe 0 para cancelar."
        });
        break;
      case 3: // Fecha
        setUserState(jid, STATES.AWAITING_FECHA_MODIFICATION, userState.data);
        await safeSendMessage(jid, {
          text: "📅 Escribe la nueva fecha en formato dd/mm/yyyy:\n\nEjemplo: 15/08/2025\n\nEscribe 0 para cancelar."
        });
        break;
      case 4: // Tipo de movimiento
        setUserState(jid, STATES.AWAITING_TIPO_MOVIMIENTO_MODIFICATION, userState.data);
        await safeSendMessage(jid, {
          text: "📊 Escribe el tipo de movimiento:\n\n1. ingreso\n2. egreso\n\nEscribe 0 para cancelar."
        });
        break;
      case 5: // Medio de pago
        await showMediosPagoForModification(jid, userState.data);
        break;
    }
  };

  // 👤 Mostrar destinatarios para modificación
  const showDestinatariosForModification = async (jid, userData) => {
    try {
      const { data: allDestinatarios, error } = await supabase
        .from('destinatarios')
        .select('id, name')
        .order('name');

      if (error) {
        console.error("Error obteniendo destinatarios:", error);
        await safeSendMessage(jid, { text: "❌ Error obteniendo la lista de destinatarios." });
        await proceedToFinalConfirmationFromModification(jid, userData.finalStructuredData);
        return;
      }

      if (!allDestinatarios || allDestinatarios.length === 0) {
        await safeSendMessage(jid, { text: "📋 No hay destinatarios registrados." });
        await proceedToFinalConfirmationFromModification(jid, userData.finalStructuredData);
        return;
      }

      let destinatarioList = "0. ❌ Cancelar\n1. ➕ Nuevo destinatario\n";
      allDestinatarios.forEach((dest, index) => {
        destinatarioList += `${index + 2}. ${dest.name}\n`;
      });

      setUserState(jid, STATES.AWAITING_DESTINATARIO_MODIFICATION, {
        ...userData,
        allDestinatarios,
        isModification: true
      });

      await safeSendMessage(jid, {
        text: `👤 *Selecciona el nuevo destinatario:*\n\n${destinatarioList}\nEscribe el número del destinatario:`
      });

    } catch (error) {
      console.error("Error en showDestinatariosForModification:", error);
      await safeSendMessage(jid, { text: "❌ Error mostrando destinatarios." });
      await proceedToFinalConfirmationFromModification(jid, userData.finalStructuredData);
    }
  };

  // 💳 Mostrar métodos de pago para modificación
  const showMediosPagoForModification = async (jid, userData) => {
  try {
    const metodosPago = await getMetodosPago();
    
    if (metodosPago.length === 0) {
      await safeSendMessage(jid, { text: "❌ No se pudieron cargar los métodos de pago." });
      await proceedToFinalConfirmationFromModification(jid, userData.finalStructuredData);
      return;
    }

    let metodosList = "0. ❌ Cancelar\n1. ➕ Crear nuevo método de pago\n";
    metodosPago.forEach((metodo, index) => {
      metodosList += `${index + 2}. ${metodo.name}\n`;
    });

    setUserState(jid, STATES.AWAITING_MEDIO_PAGO_MODIFICATION, {
      ...userData,
      availableMetodosPago: metodosPago
    });

    await safeSendMessage(jid, {
      text: `💳 *Selecciona el nuevo método de pago:*\n\n${metodosList}\nEscribe el número del método de pago:`
    });

  } catch (error) {
    console.error("Error en showMediosPagoForModification:", error);
    await safeSendMessage(jid, { text: "❌ Error mostrando métodos de pago." });
    await proceedToFinalConfirmationFromModification(jid, userData.finalStructuredData);
  }
};

  // 💰 Manejar modificación de monto
  const handleMontoModification = async (jid, textMessage, userState, quotedMsg) => {
    const input = textMessage.trim();
    
    if (input === "0") {
      await proceedToFinalConfirmationFromModification(jid, userState.data.finalStructuredData);
      return;
    }

    const monto = parseFloat(input);
    if (isNaN(monto) || monto <= 0) {
      await safeSendMessage(jid, { text: "⚠️ Por favor, ingresa un monto válido (solo números)." });
      return;
    }

    // Actualizar monto en los datos
    const updatedData = {
      ...userState.data.finalStructuredData,
      monto: monto
    };

    await safeSendMessage(jid, { text: `✅ Monto actualizado a: $${monto}` });
    await proceedToFinalConfirmationFromModification(jid, updatedData);
  };

  // 📅 Manejar modificación de fecha
  const handleFechaModification = async (jid, textMessage, userState, quotedMsg) => {
    const input = textMessage.trim();
    
    if (input === "0") {
      await proceedToFinalConfirmationFromModification(jid, userState.data.finalStructuredData);
      return;
    }

    // Validar formato dd/mm/yyyy
    const fechaRegex = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
    if (!fechaRegex.test(input)) {
      await safeSendMessage(jid, { text: "⚠️ Formato incorrecto. Usa dd/mm/yyyy (ej: 15/08/2025)" });
      return;
    }

    // Actualizar fecha en los datos
    const updatedData = {
      ...userState.data.finalStructuredData,
      fecha: input
    };

    await safeSendMessage(jid, { text: `✅ Fecha actualizada a: ${input}` });
    await proceedToFinalConfirmationFromModification(jid, updatedData);
  };

  // 📊 Manejar modificación de tipo de movimiento
  const handleTipoMovimientoModification = async (jid, textMessage, userState, quotedMsg) => {
    const option = parseInt(textMessage.trim());
    
    if (option === 0) {
      await proceedToFinalConfirmationFromModification(jid, userState.data.finalStructuredData);
      return;
    }

    if (isNaN(option) || option < 1 || option > 2) {
      await safeSendMessage(jid, { text: "⚠️ Por favor, escribe 1 (ingreso), 2 (egreso) o 0 (cancelar)." });
      return;
    }

    const tipoMovimiento = option === 1 ? "ingreso" : "egreso";
    
    // Actualizar tipo de movimiento en los datos
    const updatedData = {
      ...userState.data.finalStructuredData,
      tipo_movimiento: tipoMovimiento
    };

    await safeSendMessage(jid, { text: `✅ Tipo de movimiento actualizado a: ${tipoMovimiento}` });
    await proceedToFinalConfirmationFromModification(jid, updatedData);
  };

  // 💳 Manejar modificación de método de pago
 const handleMedioPagoModification = async (jid, textMessage, userState, quotedMsg) => {
  const option = parseInt(textMessage.trim());
  
  if (option === 0) {
    await proceedToFinalConfirmationFromModification(jid, userState.data.finalStructuredData);
    return;
  }

  const metodosPago = userState.data.availableMetodosPago;
  const maxOption = metodosPago.length + 1; // +1 por la opción "crear nuevo"

  if (isNaN(option) || option < 1 || option > maxOption) {
    await safeSendMessage(jid, { 
      text: `⚠️ Por favor, escribe un número válido (0 a ${maxOption}).` 
    });
    return;
  }

  if (option === 1) {
    // Crear nuevo método de pago en modificación
    setUserState(jid, STATES.AWAITING_NEW_METODO_PAGO_NAME, {
      structuredData: null,
      finalStructuredData: userState.data.finalStructuredData,
      isModification: true,
      originalData: userState.data.finalStructuredData
    });

    await safeSendMessage(jid, {
      text: "💳 Vamos a crear un nuevo método de pago.\n\nEscribe el nombre del nuevo método de pago:"
    });
    return;
  }

  const selectedMetodo = metodosPago[option - 2]; // -2 porque empezamos desde índice 2
  
  // Actualizar método de pago en los datos
  const updatedData = {
    ...userState.data.finalStructuredData,
    medio_pago: selectedMetodo.name
  };

  await safeSendMessage(jid, { text: `✅ Método de pago actualizado a: ${selectedMetodo.name}` });
  await proceedToFinalConfirmationFromModification(jid, updatedData);
};

  // ✅ Volver a confirmación final desde modificación
 const proceedToFinalConfirmationFromModification = async (jid, finalData) => {
  console.log('🔧 Datos recibidos en proceedToFinalConfirmationFromModification:', finalData);

  const normalized = normalizeDateTime(finalData);

  setUserState(jid, STATES.AWAITING_SAVE_CONFIRMATION, {
    finalStructuredData: normalized
  });

  await safeSendMessage(jid, {
    text: `📋 *Datos del comprobante (actualizados):*\n\n` +
    `👤 *Destinatario:* ${normalized.nombre || 'No especificado'}\n` +
    `💰 *Monto:* $${normalized.monto || 'No especificado'}\n` +
    `📅 *Fecha:* ${normalized.fecha || 'No especificada'}\n` +
    `🕐 *Hora:* ${normalized.hora || 'No especificada'}\n` +
    `📊 *Tipo:* ${normalized.tipo_movimiento || 'No especificado'}\n` +
    `💳 *Medio de pago:* ${normalized.medio_pago || 'No especificado'}\n\n` +
    `¿Deseas guardar estos datos?\n\n1. 💾 Guardar\n2. ✏️ Modificar\n3. ❌ Cancelar\n\nEscribe el número de tu opción:`
  });
};

  // Reemplazar el event handler connection.update (línea ~1800)


  // sock.ev.on(
  //   "messaging-history.set",
  //   async ({ chats, contacts, messages, syncType }) => {
  //     console.log("syncType:", syncType);
  //     console.log(`Chats ${chats.length}, msgs ${messages.length}`);
  //     await fs.promises.writeFile(
  //       "history.json",
  //       JSON.stringify({ chats, contacts, messages }, null, 2)
  //     );
  //     for (const m of messages) {
  //       console.log(
  //         `msg ${m.key.id} from ${m.key.remoteJid}`,
  //         m.message?.imageMessage ? "📷" : ""
  //       );
  //       if (m.message?.imageMessage) {
  //         const buf = await downloadMediaMessage(m, "buffer");
  //         await fs.promises.writeFile(`img-${m.key.id}.jpg`, buf);
  //       }
  //     }
  //   }
  // );
}





async function downloadDocumentMessage(message, senderName, messageId) {
  try {
    const buffer = await downloadMediaMessage(
      message,
      "buffer",
      {},
      {
        logger: console,
        reuploadRequest: sock.updateMediaMessage,
      }
    );

    if (buffer) {
      // Obtener el JID del remitente para crear carpeta específica
      const senderJid = message.key.remoteJid || senderName;
      const sanitizedJid = senderJid.replace(/[@.:]/g, "_");

      // Crear directorio de descargas organizado por usuario
      const downloadsDir = path.join(__dirname, "downloads");
      const userDownloadsDir = path.join(downloadsDir, sanitizedJid);
      await fs.promises.mkdir(userDownloadsDir, { recursive: true });

      // Obtener información del archivo
      const timestamp = message.messageTimestamp || Math.floor(Date.now() / 1000);
      
      // Determinar la estructura correcta del documento
      let documentData = null;
      if (message.message.documentMessage) {
        // Documento directo
        documentData = message.message.documentMessage;
      } else if (message.message.documentWithCaptionMessage?.message?.documentMessage) {
        // Documento con caption
        documentData = message.message.documentWithCaptionMessage.message.documentMessage;
      }
      
      const fileName = documentData?.fileName || `document_${messageId}`;
      const mimetype = documentData?.mimetype || "application/octet-stream";

      // Determinar extensión
      let extension = path.extname(fileName);
      if (!extension) {
        if (mimetype.includes("pdf")) extension = ".pdf";
        else if (mimetype.includes("doc")) extension = ".doc";
        else if (mimetype.includes("excel") || mimetype.includes("sheet")) extension = ".xlsx";
        else extension = ".bin";
      }

      // Crear nombre de archivo único
      const finalFileName = `${timestamp}_${messageId}_${path.basename(fileName, path.extname(fileName))}${extension}`;
      const filePath = path.join(userDownloadsDir, finalFileName);

      // Guardar archivo
      await fs.promises.writeFile(filePath, buffer);

      console.log(`📄 Documento guardado: ${sanitizedJid}/${finalFileName}`);
      console.log(`📝 Tipo: ${mimetype}, Tamaño: ${buffer.length} bytes`);

      return filePath; // Retornar ruta absoluta
    }

    return null;
  } catch (error) {
    console.error(`Error descargando documento ${messageId}:`, error.message);
    return null;
  }
}


// 🖼️ FUNCIÓN PARA DESCARGAR IMAGEN DE MENSAJE
async function downloadImageMessage(message, senderName, messageId) {
  try {
    const buffer = await downloadMediaMessage(
      message,
      "buffer",
      {},
      {
        logger: console,
        reuploadRequest: sock.updateMediaMessage,
      }
    );

    if (buffer) {
      // Obtener el JID del remitente para crear carpeta específica
      const senderJid = message.key.remoteJid || senderName;
      const sanitizedJid = senderJid.replace(/[@.:]/g, "_");

      // Obtener información del archivo
      const timestamp = message.messageTimestamp || Math.floor(Date.now() / 1000);
      const mimetype = message.message.imageMessage.mimetype || "image/jpeg";

      let extension = ".jpg";
      if (mimetype.includes("png")) extension = ".png";
      else if (mimetype.includes("jpeg")) extension = ".jpeg";
      else if (mimetype.includes("webp")) extension = ".webp";

      // Crear nombre de archivo único
      const fileName = `${timestamp}_${messageId}${extension}`;

      // Subir a Supabase Storage
      const uploadResult = await uploadFileToSupabase(
        buffer, 
        fileName, 
        'whatsapp-images-2', 
        sanitizedJid
      );

      if (uploadResult.success) {
        console.log(`📸 Imagen subida a Supabase: ${uploadResult.url}`);
        return uploadResult.url; // Retornar URL de Supabase
      } else {
        console.error(`❌ Error subiendo imagen: ${uploadResult.error}`);
        return null;
      }
    }

    return null;
  } catch (error) {
    console.error(`Error procesando imagen ${messageId}:`, error.message);
    return null;
  }
}

// �📁 FUNCIÓN GENERAL PARA DESCARGAR CUALQUIER MEDIA ORGANIZADA POR USUARIO
async function downloadMediaByUser(message, messageType, senderJid, messageId) {
  try {
    const buffer = await downloadMediaMessage(
      message,
      "buffer",
      {},
      {
        logger: console,
        reuploadRequest: sock.updateMediaMessage,
      }
    );

    if (buffer) {
      // Sanitizar JID para crear carpeta específica
      const sanitizedJid = senderJid.replace(/[@.:]/g, "_");

      // Crear directorio de descargas organizado por usuario
      const downloadsDir = path.join(__dirname, "downloads");
      const userDownloadsDir = path.join(downloadsDir, sanitizedJid);
      await fs.promises.mkdir(userDownloadsDir, { recursive: true });

      // Obtener información del archivo según el tipo
      const timestamp =
        message.messageTimestamp || Math.floor(Date.now() / 1000);
      let extension = "";
      let prefix = "";
      let mimetype = "";

      switch (messageType) {
        case "imageMessage":
          mimetype = message.message.imageMessage.mimetype || "image/jpeg";
          prefix = "img";
          if (mimetype.includes("png")) extension = ".png";
          else if (mimetype.includes("gif")) extension = ".gif";
          else if (mimetype.includes("webp")) extension = ".webp";
          else extension = ".jpg";
          break;

        case "videoMessage":
          mimetype = message.message.videoMessage.mimetype || "video/mp4";
          prefix = "vid";
          if (mimetype.includes("webm")) extension = ".webm";
          else if (mimetype.includes("avi")) extension = ".avi";
          else if (mimetype.includes("mov")) extension = ".mov";
          else extension = ".mp4";
          break;

        case "audioMessage":
          mimetype = message.message.audioMessage.mimetype || "audio/ogg";
          prefix = "aud";
          if (mimetype.includes("mp3")) extension = ".mp3";
          else if (mimetype.includes("wav")) extension = ".wav";
          else if (mimetype.includes("m4a")) extension = ".m4a";
          else extension = ".ogg";
          break;

        case "documentMessage":
          const fileName =
            message.message.documentMessage.fileName || "document";
          mimetype =
            message.message.documentMessage.mimetype ||
            "application/octet-stream";
          prefix = "doc";
          extension = path.extname(fileName) || ".bin";
          break;

        default:
          prefix = "media";
          extension = ".bin";
      }

      // Crear nombre de archivo único
      const fileName = `${prefix}_${timestamp}_${messageId}${extension}`;
      const filePath = path.join(userDownloadsDir, fileName);

      // Guardar archivo
      await fs.promises.writeFile(filePath, buffer);

      console.log(`📁 ${messageType} guardado: ${sanitizedJid}/${fileName}`);

      return filePath;
    }

    return null;
  } catch (error) {
    console.error(
      `Error descargando ${messageType} ${messageId}:`,
      error.message
    );
    return null;
  }
}


const isConnected = () => {
  return sock?.user ? true : false;
};

// 🔧 Cliente de Vision (compatible con Render y variables de entorno JSON)
let visionClient = null;
try {
  // 🌐 Manejo para Render: Crear archivo temporal desde JSON en variable de entorno
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
    console.log("🔧 Configurando credenciales de Google desde variable de entorno JSON...");
    
    // Crear archivo temporal con las credenciales
    const tempCredPath = path.join(__dirname, 'gcloud-creds.json');
    fs.writeFileSync(tempCredPath, process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
    
    // Setear la ruta del archivo temporal para que Google Vision lo use
    process.env.GOOGLE_APPLICATION_CREDENTIALS = tempCredPath;
    
    visionClient = new vision.ImageAnnotatorClient();
    console.log("✅ Google Vision cliente inicializado desde variable de entorno JSON (Render).");
    
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    // 📁 Manejo tradicional: archivo de credenciales local
    const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (!fs.existsSync(credentialsPath)) {
      console.error(`❌ Archivo de credenciales no encontrado en: ${credentialsPath}`);
      console.log("⚠️ GOOGLE_APPLICATION_CREDENTIALS configurada, pero el archivo no existe.");
    } else {
      visionClient = new vision.ImageAnnotatorClient();
      console.log("✅ Google Vision cliente inicializado con credenciales de archivo local.");
    }
  } else {
    console.log("⚠️ Credenciales de Google no configuradas - OCR deshabilitado.");
    console.log("💡 Para Render: Configura GOOGLE_APPLICATION_CREDENTIALS_JSON con el contenido del JSON");
    console.log("💡 Para local: Configura GOOGLE_APPLICATION_CREDENTIALS con la ruta al archivo JSON");
  }
} catch (error) {
  console.warn("⚠️ Error inicializando Google Vision:", error.message);
  console.log("💡 Verifica que las credenciales de Google Cloud están configuradas correctamente.");
}

const extractTextFromImage = async (imageUrl) => {
  try {
    if (!visionClient) {
      console.log("⚠️ Google Vision no disponible - retornando texto vacío");
      return "";
    }

    // Verificar si es URL de Supabase (pública)
    if (imageUrl.includes('supabase')) {
      console.log(`🔍 Analizando imagen directamente desde Supabase: ${imageUrl}`);
      
      // Usar la URL directamente con Google Vision
      const [result] = await visionClient.textDetection(imageUrl);
      const detections = result.textAnnotations;
      
      if (detections && detections.length > 0) {
        const fullText = detections[0].description || "";
        console.log(`📄 Texto detectado desde URL (${fullText.length} caracteres):`, fullText.substring(0, 200) + "...");
        return fullText;
      } else {
        console.log("📄 No se detectó texto en la imagen");
        return "";
      }
    } else {
      // Retrocompatibilidad para rutas locales
      const tempFilePath = imageUrl.startsWith('../') ? `./${imageUrl.substring(3)}` : imageUrl;
      
      if (!fs.existsSync(tempFilePath)) {
        console.error(`❌ Archivo de imagen no encontrado: ${tempFilePath}`);
        return "";
      }

      console.log(`🔍 Analizando imagen local: ${tempFilePath}`);
      const [result] = await visionClient.textDetection(tempFilePath);
      const detections = result.textAnnotations;
      
      if (detections && detections.length > 0) {
        const fullText = detections[0].description || "";
        console.log(`📄 Texto detectado (${fullText.length} caracteres):`, fullText.substring(0, 200) + "...");
        return fullText;
      } else {
        console.log("📄 No se detectó texto en la imagen");
        return "";
      }
    }
  } catch (err) {
    console.error("❌ Error en Vision OCR:", err.message);
    
    // Si falla con URL, podrías implementar fallback a descarga temporal
    if (imageUrl.includes('supabase')) {
      console.log("⚠️ Falló análisis directo de URL, intentando descarga temporal...");
      return await extractTextFromImageFallback(imageUrl);
    }
    
    return "";
  }
};

const extractTextFromImageFallback = async (imageUrl) => {
  let tempFilePath = null;
  
  try {
    console.log("🔄 Usando método de fallback para análisis de imagen");
    
    // Extraer bucket y path de la URL
    const urlParts = imageUrl.split('/');
    const bucket = 'whatsapp-images-2';
    const pathIndex = urlParts.findIndex(part => part === bucket) + 1;
    const filePath = urlParts.slice(pathIndex).join('/');
    
    tempFilePath = await downloadFileFromSupabase(bucket, filePath);
    if (!tempFilePath) {
      console.error(`❌ No se pudo descargar imagen desde Supabase`);
      return "";
    }

    console.log(`🔍 Analizando imagen temporal: ${tempFilePath}`);
    const [result] = await visionClient.textDetection(tempFilePath);
    const detections = result.textAnnotations;
    
    if (detections && detections.length > 0) {
      const fullText = detections[0].description || "";
      console.log(`📄 Texto detectado con fallback (${fullText.length} caracteres)`);
      return fullText;
    }
    
    return "";
  } catch (err) {
    console.error("❌ Error en fallback OCR:", err.message);
    return "";
  } finally {
    if (tempFilePath) {
      await cleanupTempFile(tempFilePath);
    }
  }
};


const extractTextFromDocument = async (documentPath, fileName) => {
  try {
    console.log(`📄 Intentando extraer texto de documento: ${fileName}`);
    
    const fileExtension = path.extname(fileName).toLowerCase();
    
    // 🔍 Estrategia 1: Para PDFs, intentar con pdf-parse si está disponible
    if (fileExtension === '.pdf') {
      try {
        // Intentar cargar pdf-parse dinámicamente
        const pdfParse = require('pdf-parse');
        const dataBuffer = await fs.promises.readFile(documentPath);
        const pdfData = await pdfParse(dataBuffer);
        
        if (pdfData.text && pdfData.text.trim()) {
          console.log(`✅ Texto extraído de PDF (${pdfData.text.length} caracteres):`, pdfData.text.substring(0, 200) + "...");
          return pdfData.text;
        }
      } catch (pdfError) {
        console.log("⚠️ pdf-parse no disponible o falló, intentando con Vision API...");
      }
    }
    
    // 🔍 Estrategia 2: Convertir a imagen y usar Google Vision (para PDFs y otros)
    if (visionClient && fileExtension === '.pdf') {
      try {
        // Para PDFs, Google Vision puede procesarlos directamente
        console.log(`🔍 Analizando PDF con Google Vision: ${documentPath}`);
        const [result] = await visionClient.textDetection(documentPath);
        const detections = result.textAnnotations;
        
        if (detections && detections.length > 0) {
          const fullText = detections[0].description || "";
          console.log(`📄 Texto detectado en PDF (${fullText.length} caracteres):`, fullText.substring(0, 200) + "...");
          return fullText;
        }
      } catch (visionError) {
        console.log("⚠️ Google Vision falló con PDF:", visionError.message);
      }
    }
    
    // 🔍 Estrategia 3: Para otros tipos de documento, mensaje informativo
    if (fileExtension !== '.pdf') {
      console.log(`ℹ️ Tipo de documento no soportado para extracción: ${fileExtension}`);
      return `[Documento ${fileExtension.toUpperCase()} recibido: ${fileName}]`;
    }
    
    console.log("📄 No se pudo extraer texto del documento");
    return `[Documento PDF recibido: ${fileName}]`;
    
  } catch (error) {
    console.error("❌ Error extrayendo texto de documento:", error.message);
    return `[Error procesando documento: ${fileName}]`;
  }
};

// Función para obtener el historial de mensajes de un chat específico
const getChatHistory = async (jid, limit = 50) => {
  try {
    if (!sock) {
      throw new Error("Socket no conectado");
    }

    // Obtener mensajes de nuestro store temporal (incluye historial)
    const messages = messageStore[jid] || [];
    const limitedMessages = messages.slice(-limit).reverse();

    // Procesar mensajes para agregar información útil
    const processedMessages = limitedMessages.map((msg) => {
      const processed = { ...msg };

      // Agregar información del tipo de mensaje
      if (msg.message) {
        const messageType = getContentType(msg.message);
        processed.messageType = messageType;

        // Si es una imagen, agregar información de descarga
        if (messageType === "imageMessage") {
          processed.mediaInfo = {
            type: "image",
            mimetype: msg.message.imageMessage?.mimetype,
            url: msg.message.imageMessage?.url,
            caption: msg.message.imageMessage?.caption,
            hasMedia: true,
          };
        }

        // Si es un video
        if (messageType === "videoMessage") {
          processed.mediaInfo = {
            type: "video",
            mimetype: msg.message.videoMessage?.mimetype,
            url: msg.message.videoMessage?.url,
            caption: msg.message.videoMessage?.caption,
            hasMedia: true,
          };
        }

        // Si es un documento
        if (messageType === "documentMessage") {
          processed.mediaInfo = {
            type: "document",
            mimetype: msg.message.documentMessage?.mimetype,
            fileName: msg.message.documentMessage?.fileName,
            hasMedia: true,
          };
        }

        // Si es audio
        if (messageType === "audioMessage") {
          processed.mediaInfo = {
            type: "audio",
            mimetype: msg.message.audioMessage?.mimetype,
            hasMedia: true,
          };
        }
      }

      return processed;
    });

    return processedMessages;
  } catch (error) {
    console.error("Error obteniendo historial:", error);
    return [];
  }
};

// Función para cargar mensajes con paginación (como el ejemplo que proporcionaste)
const loadMessagesWithPagination = async (jid, count = 25, cursor = null) => {
  try {
    if (!sock || !sock.loadMessages) {
      throw new Error("loadMessages no disponible");
    }

    const messages = await sock.loadMessages(jid, count, cursor);

    // Agregar los mensajes al store
    if (messages && messages.length > 0) {
      if (!messageStore[jid]) {
        messageStore[jid] = [];
      }

      messages.forEach((msg) => {
        const existingMsg = messageStore[jid].find(
          (m) => m.key.id === msg.key.id
        );
        if (!existingMsg) {
          messageStore[jid].unshift(msg); // Agregar al inicio (son más antiguos)
        }
      });

      // Reordenar por timestamp
      messageStore[jid].sort(
        (a, b) => (a.messageTimestamp || 0) - (b.messageTimestamp || 0)
      );
    }

    return messages;
  } catch (error) {
    console.error("Error cargando mensajes con paginación:", error);
    return [];
  }
};

// Función para descargar todas las imágenes de un chat
const downloadAllImagesFromChat = async (jid, maxImages = 50) => {
  try {
    if (!sock) {
      throw new Error("Socket no conectado");
    }

    const messages = messageStore[jid] || [];
    const imageMessages = messages
      .filter((msg) => msg.message?.imageMessage)
      .slice(0, maxImages);

    const downloadedImages = [];

    for (const msg of imageMessages) {
      try {
        const buffer = await downloadMediaMessage(
          msg,
          "buffer",
          {},
          {
            logger: console,
            reuploadRequest: sock.updateMediaMessage,
          }
        );

        if (buffer) {
          const fileName = `img_${msg.key.id}.jpg`;
          const filePath = path.join(__dirname, "downloads", fileName);

          // Crear directorio si no existe
          if (!fs.existsSync(path.join(__dirname, "downloads"))) {
            fs.mkdirSync(path.join(__dirname, "downloads"));
          }

          await fs.promises.writeFile(filePath, buffer);

          downloadedImages.push({
            messageId: msg.key.id,
            fileName: fileName,
            filePath: filePath,
            caption: msg.message.imageMessage?.caption || "",
            timestamp: msg.messageTimestamp,
          });
        }
      } catch (error) {
        console.error(`Error descargando imagen ${msg.key.id}:`, error);
      }
    }

    return downloadedImages;
  } catch (error) {
    console.error("Error descargando imágenes:", error);
    return [];
  }
};

// Función para obtener información de todos los chats
const getAllChats = () => {
  try {
    // Usar chatStore del historial si está disponible
    if (Object.keys(chatStore).length > 0) {
      return Object.values(chatStore).map((chat) => ({
        id: chat.id,
        name: chat.name || contactStore[chat.id]?.name || chat.id.split("@")[0],
        unreadCount: chat.unreadCount || 0,
        lastMessageTime: chat.conversationTimestamp,
        isGroup: chat.id.includes("@g.us"),
        messageCount: messageStore[chat.id]?.length || 0,
      }));
    }

    // Fallback al store de mensajes
    const chats = Object.keys(messageStore).map((jid) => ({
      id: jid,
      name:
        contactStore[jid]?.name ||
        (jid.includes("@g.us") ? "Grupo" : jid.split("@")[0]),
      messageCount: messageStore[jid].length,
      isGroup: jid.includes("@g.us"),
      lastMessageTime:
        messageStore[jid][messageStore[jid].length - 1]?.messageTimestamp,
    }));

    return chats;
  } catch (error) {
    console.error("Error obteniendo chats:", error);
    return [];
  }
};

// Función para obtener el JID de tu propio número (para chat contigo mismo)
const getMyJid = () => {
  const myNumber = "";
  console.log({ myNumber });
  return myNumber;
};


function formatFileSize(bytes) {
  if (bytes === 0) return "0 Bytes";

  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}


io.on("connection", async (socket) => {
  soket = socket;
  if (isConnected()) {
    updateQR("connected");
  } else if (qrDinamic) {
    updateQR("qr");
  }
});

const updateQR = (data) => {
  switch (data) {
    case "qr":
      qrcode.toDataURL(qrDinamic, (err, url) => {
        soket?.emit("qr", url);
        soket?.emit("log", "QR recibido , scan");
      });
      break;
    case "connected":
      soket?.emit("qrstatus", "./assets/check.svg");
      soket?.emit("log", " usaario conectado");
      const { id, name } = sock?.user;
      var userinfo = id + " " + name;
      soket?.emit("user", userinfo);

      break;
    case "loading":
      soket?.emit("qrstatus", "./assets/loader.gif");
      soket?.emit("log", "Cargando ....");

      break;
    default:
      break;
  }
};

// 🚀 FUNCIÓN DE INICIO SIMPLIFICADA Y ROBUSTA
const startApp = async () => {
  try {
    console.log("🚀 Iniciando WhatsApp Bot con OCR y OpenAI...");
    console.log("⚠️ Los errores 'Bad MAC' son normales durante la conexión inicial");
     await ensureSingleInstanceLock();
    // Verificar variables de entorno (sin detener la ejecución)
    if (!process.env.OPENAI_API_KEY) {
      console.warn("⚠️ OPENAI_API_KEY no configurada - IA deshabilitada");
    }
    
    if (!process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      console.warn("⚠️ Credenciales de Google no configuradas - OCR deshabilitado");
      console.warn("💡 Configura GOOGLE_APPLICATION_CREDENTIALS_JSON (para Render) o GOOGLE_APPLICATION_CREDENTIALS (para local)");
    }
    
    console.log("📱 Conectando a WhatsApp...");
    connectToWhatsApp().catch(err => {
      console.log("⚠️ Error en conexión inicial (se reintentará automáticamente):", err.message);
    });
    
    
    console.log(`🌐 Iniciando servidor en puerto ${port}...`);
    server.listen(port, () => {
      console.log(`✅ Servidor activo en puerto: ${port}`);
      console.log(`📱 Panel: http://localhost:${port}/scan`);
      console.log(`🔗 Estado: http://localhost:${port}/session-health`);
      console.log(`📊 Logs: http://localhost:${port}/messages-log`);
      console.log("🤖 Bot iniciado - esperando conexión a WhatsApp");
    });
    
  } catch (error) {
    console.error("❌ Error crítico en inicio:", error.message);
    setTimeout(startApp, 10000);
  }
};

['SIGINT','SIGTERM'].forEach(sig => process.on(sig, () => graceful(sig)));

process.on('uncaughtException', async (err) => { console.error(err); await closeClient(); process.exit(1); });
process.on('unhandledRejection', async (err) => { console.error(err); await closeClient(); process.exit(1); });


startApp();