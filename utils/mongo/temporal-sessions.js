'use strict';
const { getDb } = require('./singleton-mongo');

const COLL = process.env.MONGODB_TEMP_SESSIONS_COLL || 'temp_sessions';
const DBNAME = process.env.MONGODB_DB || 'baileysss';

async function getColl() {
  const db = await getDb(DBNAME);
  const coll = db.collection(COLL);
  // TTL por lastUpdated (24h)
  await coll.createIndex({ lastUpdated: 1 }, { expireAfterSeconds: 24 * 60 * 60 }).catch(() => {});
  // Índice por userId
  await coll.createIndex({ userId: 1 }, { unique: true }).catch(() => {});
  return coll;
}

async function saveTempSessionDB(userId, structureOutput, flowState) {
  const coll = await getColl();
  const now = new Date();
  await coll.updateOne(
    { userId },
    {
      $set: {
        userId,
        structureOutput: structureOutput || {},
        flowState: flowState || 'UNKNOWN',
        lastUpdated: now
      }
    },
    { upsert: true }
  );
  return { userId, structureOutput, flowState, lastUpdated: now };
}

async function getTempSession(userId) {
  const coll = await getColl();
  return await coll.findOne({ userId });
}

async function clearTempSession(userId) {
  const coll = await getColl();
  await coll.deleteOne({ userId });
}

async function listRecentSessions(minutes = 30) {
  const coll = await getColl();
  const since = new Date(Date.now() - minutes * 60 * 1000);
  return await coll.find({ lastUpdated: { $gte: since } }).toArray();
}

module.exports = {
  saveTempSessionDB,
  getTempSession,
  clearTempSession,
  listRecentSessions
};