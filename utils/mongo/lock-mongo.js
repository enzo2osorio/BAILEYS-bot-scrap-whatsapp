'use strict';

const os = require('os');
const { randomUUID } = require('crypto');
const { getDb } = require('./singleton-mongo');

const DEFAULT_COLL = process.env.MONGODB_LOCKS_COLL || 'wa_instance_locks';

async function ensureIndexes(coll) {
  await Promise.all([
    coll.createIndex({ instanceId: 1 }, { unique: true }).catch(()=>{}),
    coll.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }).catch(()=>{})
  ]);
}

async function initInstanceLock({
  collectionName = DEFAULT_COLL,
  instanceId = 'default',
  leaseMs = 60000,
  renewEveryMs = 30000,
  meta = {}
}) {
  const db = await getDb();
  const coll = db.collection(collectionName);
  await ensureIndexes(coll);

  const ownerId = `${os.hostname()}-${process.pid}-${randomUUID()}`;
  const startedAt = new Date();
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
  const existing = await coll.findOne({ instanceId }).catch(()=>null);

  if (!existing) {
    try {
      await coll.insertOne({
        instanceId,
        ownerId,
        acquiredAt: new Date(),
        expiresAt: new Date(now + leaseMs),
        meta: baseMeta
      });
    } catch (e) {
      const doc = await coll.findOne({ instanceId }).catch(()=>null);
      const err = new Error(`Lock en uso por ${doc?.ownerId || 'desconocido'} instanceId=${instanceId}`);
      err.code = 'LOCK_HELD';
      err.lockInfo = doc || null;
      throw err;
    }
  } else {
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
        const doc = await coll.findOne({ instanceId }).catch(()=>null);
        const err = new Error(`Lock en uso por ${doc?.ownerId || 'desconocido'} instanceId=${instanceId}`);
        err.code = 'LOCK_HELD';
        err.lockInfo = doc || null;
        throw err;
      }
    } else {
      const err = new Error(`Lock en uso por ${existing.ownerId} instanceId=${instanceId}`);
      err.code = 'LOCK_HELD';
      err.lockInfo = existing;
      throw err;
    }
  }

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
  };

  return { release, info: { instanceId, ownerId, meta: baseMeta } };
}

async function getActiveLockInfo({
  collectionName = DEFAULT_COLL,
  instanceId = 'default'
}) {
  const db = await getDb();
  const coll = db.collection(collectionName);
  return await coll.findOne({ instanceId, expiresAt: { $gt: new Date() } });
}

module.exports = { initInstanceLock, getActiveLockInfo };