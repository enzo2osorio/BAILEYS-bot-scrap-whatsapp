'use strict';
const { MongoClient, ServerApiVersion } = require('mongodb');

const MAX_POOL = parseInt(process.env.MONGO_MAX_POOL_SIZE || '10', 10);

let clientPromise = global.__MONGO_CLIENT_PROMISE || null;
let clientInstance = global.__MONGO_CLIENT_INSTANCE || null;

async function getClient() {
  if (clientPromise && clientInstance) return clientInstance;
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI no definida");
  const client = new MongoClient(uri, {
    maxPoolSize: MAX_POOL,
    minPoolSize: 0,
    serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
    monitorCommands: false
  });
  clientPromise = client.connect();
  clientInstance = await clientPromise;
  global.__MONGO_CLIENT_PROMISE = clientPromise;
  global.__MONGO_CLIENT_INSTANCE = clientInstance;
  return clientInstance;
}

async function getDb(dbName = process.env.MONGODB_DB || 'baileysss') {
  const client = await getClient();
  return client.db(dbName);
}

async function closeClient() {
  if (!clientInstance) return;
  try { await clientInstance.close(); } catch {}
  clientInstance = null;
  clientPromise = null;
  global.__MONGO_CLIENT_PROMISE = null;
  global.__MONGO_CLIENT_INSTANCE = null;
}

async function getServerStatus() {
  try {
    const client = await getClient();
    const admin = client.db().admin();
    // Atlas permite serverStatus en lectura básica
    const status = await admin.command({ serverStatus: 1 });
    return status;
  } catch (e) {
    return null;
  }
}

module.exports = { getClient, getDb, closeClient, getServerStatus };