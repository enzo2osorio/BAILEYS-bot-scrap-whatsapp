'use strict';

const { Binary } = require('mongodb');
const { initAuthCreds } = require('@whiskeysockets/baileys');
const { getDb, getClient } = require('./singleton-mongo');


// Helpers: detectar binarios y (de)serializar recursivamente
const isTypedArray = (v) =>
  v instanceof Uint8Array ||
  v instanceof Uint8ClampedArray ||
  v instanceof Int8Array ||
  v instanceof Uint16Array ||
  v instanceof Int16Array ||
  v instanceof Uint32Array ||
  v instanceof Int32Array ||
  v instanceof Float32Array ||
  v instanceof Float64Array ||
  v instanceof BigInt64Array ||
  v instanceof BigUint64Array;

const isBufferLike = (v) => Buffer.isBuffer(v) || isTypedArray(v);

// Serializar: Buffer/Uint8Array -> { $b64: '...' }
const serializeDeep = (input) => {
  if (input == null) return input;

  if (isBufferLike(input)) {
    const buf = Buffer.from(input);
    return { $b64: buf.toString('base64') };
  }

  if (Array.isArray(input)) {
    return input.map(serializeDeep);
  }

  if (typeof input === 'object') {
    // Si viene Binary de Mongo ya almacenado previamente
    if (input instanceof Binary || input?._bsontype === 'Binary') {
      const buf = Buffer.from(input.buffer);
      return { $b64: buf.toString('base64') };
    }

    const out = {};
    for (const [k, v] of Object.entries(input)) {
      out[k] = serializeDeep(v);
    }
    return out;
  }

  return input;
};

// Deserializar: { $b64: '...' } | Binary -> Buffer
const deserializeDeep = (input) => {
  if (input == null) return input;

  if (Array.isArray(input)) {
    return input.map(deserializeDeep);
  }

  if (typeof input === 'object') {
    // Caso Binary de Mongo
    if (input instanceof Binary || input?._bsontype === 'Binary') {
      return Buffer.from(input.buffer);
    }

    // Caso wrapper { $b64: '...' }
    if (
      Object.keys(input).length === 1 &&
      Object.prototype.hasOwnProperty.call(input, '$b64') &&
      typeof input.$b64 === 'string'
    ) {
      return Buffer.from(input.$b64, 'base64');
    }

    const out = {};
    for (const [k, v] of Object.entries(input)) {
      out[k] = deserializeDeep(v);
    }
    return out;
  }

  return input;
};


const ALLOWED_JIDS = (process.env.ALLOWED_JIDS || process.env.ALLOWED_GROUP_JIDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const ALLOWED_USER_JIDS = ALLOWED_JIDS.filter(j => j.endsWith('@s.whatsapp.net'));

function isAllowedJid(jid) {
  if (!ALLOWED_JIDS.length) return true; // modo permisivo si vacío
  return ALLOWED_JIDS.includes(jid);
}

// (retro compat si otros módulos llaman esto)
function isAllowedGroupJid(jid) {
  return isAllowedJid(jid);
}

const NON_EXPIRING_BASE_KEY_PREFIXES = new Set([
  'noiseKey',
  'signedIdentityKey',
  'advSecretKey',
  'app-state-sync-key',
  'app-state-sync-version',
  'sender-key-memory'
]);

// Puedes opcionalmente cachear participantes de grupos permitidos (placeholder)
const allowedSessionParticipants = new Set(ALLOWED_USER_JIDS); // por ahora sólo usuarios explícitos

function isRelevantKey(type, id) {
  if (NON_EXPIRING_BASE_KEY_PREFIXES.has(type)) return true;

  if (type === 'sender-key') {
    const groupJid = id.split('::')[0];
    return isAllowedJid(groupJid);        // solo guardar sender-key de grupos permitidos
  }

  if (type === 'session') {
    // Mantén todas las session keys (son pocas y necesarias para E2EE fluido)
    return true;
  }

  if (type === 'pre-key') return true;     // necesarias para iniciar sesiones
  if (type.startsWith('app-state')) return true;

  return false;
}

async function ensureKeysIndexes(keysCol) {
  try {
    await keysCol.createIndex({ instanceId: 1, type: 1, id: 1 }, { unique: true }).catch(()=>{});
    const ttlSec = parseInt(process.env.MONGO_KEYS_TTL_SECONDS || '7776000', 10);
    await keysCol.createIndex(
      { updatedAt: 1 },
      { expireAfterSeconds: ttlSec, partialFilterExpression: { keep: { $ne: true } } }
    ).catch(()=>{});
  } catch (e) {
    console.log('⚠️ Error creando índices keys:', e?.message || e);
  }
}


/**
 * Persistencia de credenciales y llaves de Baileys en MongoDB.
 * Colecciones:
 *  - {prefix}_creds: { instanceId, data, updatedAt }
 *  - {prefix}_keys:  { instanceId, type, id, value, updatedAt }
 */
async function useMongoAuthState(options = {}) {
  const dbName = options.dbName || process.env.MONGODB_DB || 'baileys';
  const collectionNamePrefix =
    options.collectionNamePrefix ||
    process.env.MONGODB_COLLECTION_PREFIX ||
    'waAuth';
  const instanceId = options.instanceId || process.env.BAILEYS_INSTANCE || 'default';

  // Asegura que el singleton esté conectado
  await getClient();
  const db = await getDb(dbName);
  const credsCol = db.collection(`${collectionNamePrefix}_creds`);
  const keysCol = db.collection(`${collectionNamePrefix}_keys`);

  await credsCol.createIndex({ instanceId: 1 }, { unique: true }).catch(()=>{});
  await keysCol.createIndex({ instanceId: 1, type: 1, id: 1 }, { unique: true }).catch(()=>{});
  await ensureKeysIndexes(keysCol);

  const credsDoc = await credsCol.findOne({ instanceId }).catch(()=>null);
  const creds = credsDoc?.data ? deserializeDeep(credsDoc.data) : initAuthCreds();

  const writeCreds = async () => {
    const serialized = serializeDeep(creds);
    await credsCol.updateOne(
      { instanceId },
      { $set: { data: serialized, updatedAt: new Date() } },
      { upsert: true }
    );
  };

  const keys = {
  get: async (type, ids) => {
    if (!Array.isArray(ids) || !ids.length) return {};
    const docs = await keysCol.find({ instanceId, type, id: { $in: ids } }).toArray();
    const out = {};
    for (const d of docs) out[d.id] = deserializeDeep(d.value);
    return out;
  },
  set: async (data) => {
    if (!data) return;
    const ops = [];
    const now = new Date();

    for (const [type, entries] of Object.entries(data)) {
      for (const [id, value] of Object.entries(entries || {})) {
        const relevant = isRelevantKey(type, id);
        if (value && relevant) {
          const keep = NON_EXPIRING_BASE_KEY_PREFIXES.has(type);
            ops.push({
              updateOne: {
                filter: { instanceId, type, id },
                update: {
                  $set: {
                    value: serializeDeep(value),
                    updatedAt: now,
                    keep: keep ? true : undefined
                  }
                },
                upsert: true
              }
            });
        } else if (!value && relevant) {
          ops.push({ deleteOne: { filter: { instanceId, type, id } } });
        } else {
          // Ignorar silenciosamente claves irrelevantes
        }
      }
    }
    if (ops.length) {
      try {
        await keysCol.bulkWrite(ops, { ordered: false });
      } catch (e) {
        console.log('⚠️ Error bulkWrite keys filtradas:', e?.message || e);
      }
    }
  }
};

  const state = { creds, keys };
  const saveCreds = async () => { await writeCreds(); };
  const close = async () => { /* no cerrar singleton aquí */ };

  return { state, saveCreds, close };
}

async function clearMongoAuthState({
  dbName = process.env.MONGODB_DB || 'baileysss',
  collectionNamePrefix = process.env.MONGODB_COLLECTION_PREFIX || 'waAuthh',
  instanceId = process.env.BAILEYS_INSTANCE || 'default'
  // se ignora mongoUrl (ya usamos singleton)
} = {}) {
  try {
    await getClient(); // asegura singleton inicializado
    const db = await getDb(dbName);
    const credsCol = db.collection(`${collectionNamePrefix}_creds`);
    const keysCol  = db.collection(`${collectionNamePrefix}_keys`);

    const delCreds = await credsCol.deleteOne({ instanceId }).catch(()=>null);
    const delKeys  = await keysCol.deleteMany({ instanceId }).catch(()=>null);

    return {
      success: true,
      deletedCreds: delCreds?.deletedCount || 0,
      deletedKeys: delKeys?.deletedCount || 0
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

module.exports = { useMongoAuthState, clearMongoAuthState };