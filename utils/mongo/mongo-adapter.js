'use strict';

const { MongoClient, Binary } = require('mongodb');
const { initAuthCreds } = require('@whiskeysockets/baileys');

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

/**
 * Persistencia de credenciales y llaves de Baileys en MongoDB.
 * Colecciones:
 *  - {prefix}_creds: { instanceId, data, updatedAt }
 *  - {prefix}_keys:  { instanceId, type, id, value, updatedAt }
 */
async function useMongoAuthState(options = {}) {
  const mongoUrl =
    options.mongoUrl ||
    process.env.MONGO_URI ||
    process.env.MONGO_URI;

  const dbName = options.dbName || process.env.MONGODB_DB || 'baileys';
  const collectionNamePrefix =
    options.collectionNamePrefix ||
    process.env.MONGODB_COLLECTION_PREFIX ||
    'waAuth';

  const instanceId = options.instanceId || process.env.BAILEYS_INSTANCE || 'default';

  if (!mongoUrl) {
    throw new Error('MONGO_URI/MONGO_URI no configurado.');
  }

  const client = new MongoClient(mongoUrl, {
    ignoreUndefined: true,
    maxPoolSize: 10,
  });

  await client.connect();
  const db = client.db(dbName);
  const credsCol = db.collection(`${collectionNamePrefix}_creds`);
  const keysCol = db.collection(`${collectionNamePrefix}_keys`);

  await credsCol.createIndex({ instanceId: 1 }, { unique: true });
  await keysCol.createIndex({ instanceId: 1, type: 1, id: 1 }, { unique: true });

  // Cargar creds
  const credsDoc = await credsCol.findOne({ instanceId });
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
    // get(type, ids) -> { id: value }
    get: async (type, ids) => {
      if (!Array.isArray(ids) || ids.length === 0) return {};
      const docs = await keysCol
        .find({ instanceId, type, id: { $in: ids } })
        .toArray();

      const result = {};
      for (const doc of docs) {
        result[doc.id] = deserializeDeep(doc.value);
      }
      return result;
    },

    // set({ [type]: { [id]: value|null } })
    set: async (data) => {
      if (!data) return;

      const ops = [];
      for (const [type, entries] of Object.entries(data)) {
        for (const [id, value] of Object.entries(entries || {})) {
          if (value) {
            const serialized = serializeDeep(value);
            ops.push({
              updateOne: {
                filter: { instanceId, type, id },
                update: { $set: { value: serialized, updatedAt: new Date() } },
                upsert: true,
              },
            });
          } else {
            ops.push({ deleteOne: { filter: { instanceId, type, id } } });
          }
        }
      }

      if (ops.length === 0) return;

      const session = client.startSession();
      try {
        let inTxn = false;
        try {
          session.startTransaction();
          inTxn = true;
        } catch (_) {
          // sin transacciones (standalone)
        }

        await keysCol.bulkWrite(ops, { ordered: false, session: inTxn ? session : undefined });
        if (inTxn) await session.commitTransaction();
      } catch (err) {
        try { await session.abortTransaction(); } catch (_) {}
        throw err;
      } finally {
        await session.endSession();
      }
    },
  };

  const state = { creds, keys };
  const saveCreds = async () => { await writeCreds(); };
  const close = async () => { await client.close(); };

  return { state, saveCreds, close };
}

async function clearMongoAuthState({ mongoUrl, dbName, collectionNamePrefix = 'waAuth', instanceId = 'default' }) {
  const client = new MongoClient(mongoUrl);
  try {
    await client.connect();
    const db = client.db(dbName);

    // Heurística: eliminar colecciones/documentos que correspondan a este instanceId
    const colls = await db.listCollections().toArray();
    const regex = new RegExp(`^${collectionNamePrefix}.*${instanceId}`, 'i');

    for (const c of colls) {
      if (regex.test(c.name)) {
        const coll = db.collection(c.name);
        // Intento 1: borrar por campo instanceId (si existe)
        const res = await coll.deleteMany({ instanceId }).catch(() => null);
        // Intento 2: si la colección queda vacía, dropearla
        const count = await coll.countDocuments().catch(() => 0);
        if (count === 0) {
          try { await coll.drop(); } catch (_) {}
        }
      }
    }
    return true;
  } catch (err) {
    console.log('⚠️ Error limpiando estado Mongo:', err?.message || err);
    return false;
  } finally {
    await client.close().catch(() => {});
  }
}

module.exports = { useMongoAuthState, clearMongoAuthState };