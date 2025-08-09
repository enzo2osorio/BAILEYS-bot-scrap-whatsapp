'use strict';

const { MongoClient } = require('mongodb');
const os = require('os');
const { randomUUID } = require('crypto');
const { getDb } = require('../db/mongo');

const DEFAULT_COLL = 'wa_instance_locks';

function validateMongoUrl(mongoUrl) {
  if (!mongoUrl || typeof mongoUrl !== 'string') {
    throw new Error('MONGO_URI no está definido o no es string');
  }
  const ok = mongoUrl.startsWith('mongodb://') || mongoUrl.startsWith('mongodb+srv://');
  if (!ok) throw new Error('MONGO_URI inválido (debe empezar con mongodb:// o mongodb+srv://)');
}

async function getColl(mongoUrl, dbName, collectionName) {
  validateMongoUrl(mongoUrl);
  const client = new MongoClient(mongoUrl, {
    maxPoolSize: 2,
    serverSelectionTimeoutMS: 8000
  });
  await client.connect();
  const db = client.db(dbName);
  const coll = db.collection(collectionName);

  // Índices
  await coll.createIndex({ instanceId: 1 }, { unique: true }).catch(() => {});
  await coll.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }).catch(() => {});

  return { client, coll };
}

async function initInstanceLock({
  mongoUrl,
  dbName,
  collectionName = DEFAULT_COLL,
  instanceId = 'default',
  leaseMs = 60000,
  renewEveryMs = 30000,
  meta = {}
}) {
  const ownerId = `${os.hostname()}-${process.pid}-${randomUUID()}`;
  const startedAt = new Date();
  const { client, coll } = await getColl(mongoUrl, dbName, collectionName);

  const baseMeta = {
    host: os.hostname(),
    pid: process.pid,
    node: process.version,
    platform: process.platform,
    app: process.env.npm_package_name || 'baileys-bot',
    env: process.env.NODE_ENV || 'development',
    commit: process.env.GIT_COMMIT || null,
    startedAt,
    ...meta
  };

  const now = Date.now();
  const existing = await coll.findOne({ instanceId }).catch(() => null);

  if (!existing) {
    // Primer dueño: insertar documento
    try {
      await coll.insertOne({
        instanceId,
        ownerId,
        acquiredAt: new Date(),
        expiresAt: new Date(now + leaseMs),
        meta: baseMeta
      });
    } catch (e) {
      // Otro insert ganó la carrera
      const doc = await coll.findOne({ instanceId }).catch(() => null);
      await client.close().catch(() => {});
      const err = new Error(`Lock en uso por ${doc?.ownerId || 'desconocido'} para instanceId=${instanceId}`);
      err.code = 'LOCK_HELD';
      err.lockInfo = doc || null;
      throw err;
    }
  } else {
    // Ya existe un lock: si expiró, tomarlo; si no, rechazar
    if (existing.expiresAt && existing.expiresAt <= new Date(now)) {
      const upd = await coll.updateOne(
        { instanceId, expiresAt: { $lte: new Date(now) } },
        {
          $set: {
            ownerId,
            acquiredAt: new Date(),
            expiresAt: new Date(now + leaseMs),
            meta: baseMeta
          }
        }
      );
      if (upd.matchedCount === 0) {
        // Alguien lo renovó entre read y update
        await client.close().catch(() => {});
        const doc = await (async () => coll.findOne({ instanceId }).catch(() => null))();
        const err = new Error(`Lock en uso por ${doc?.ownerId || 'desconocido'} para instanceId=${instanceId}`);
        err.code = 'LOCK_HELD';
        err.lockInfo = doc || null;
        throw err;
      }
    } else {
      await client.close().catch(() => {});
      const err = new Error(`Lock en uso por ${existing.ownerId} para instanceId=${instanceId}`);
      err.code = 'LOCK_HELD';
      err.lockInfo = existing;
      throw err;
    }
  }

  // Renovación periódica
  const renewTimer = setInterval(async () => {
    try {
      await coll.updateOne(
        { instanceId, ownerId },
        { $set: { expiresAt: new Date(Date.now() + leaseMs) } }
      );
    } catch (e) {
      console.log('⚠️ Error renovando lock:', e?.message || e);
    }
  }, renewEveryMs).unref();

  const release = async () => {
    clearInterval(renewTimer);
    try { await coll.deleteOne({ instanceId, ownerId }); } catch (_) {}
    try { await client.close(); } catch (_) {}
  };

  return { release, info: { instanceId, ownerId, meta: baseMeta } };
}

async function getActiveLockInfo({ collectionName = process.env.MONGODB_LOCKS_COLL || 'wa_instance_locks', instanceId = 'default' }) {
  const db = await getDb();
  const coll = db.collection(collectionName);
  return await coll.findOne({ instanceId, expiresAt: { $gt: new Date() } });
}

async function setLock({ collectionName = process.env.MONGODB_LOCKS_COLL || 'wa_instance_locks', instanceId = 'default', ownerId, ttlMs = 60000, meta = {} }) {
  const db = await getDb();
  const coll = db.collection(collectionName);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);
  await coll.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }).catch(() => {}); // TTL
  return await coll.updateOne(
    { instanceId },
    { $set: { instanceId, ownerId, acquiredAt: now, expiresAt, meta } },
    { upsert: true }
  );
}

module.exports = { initInstanceLock, getActiveLockInfo, setLock };