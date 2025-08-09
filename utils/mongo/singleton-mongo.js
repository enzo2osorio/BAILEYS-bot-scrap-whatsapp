const { MongoClient, ServerApiVersion } = require('mongodb');

let clientPromise = null;

async function getClient() {
  if (clientPromise) return clientPromise;
  const uri = process.env.MONGO_URI;
  const client = new MongoClient(uri, {
    maxPoolSize: 10,           // refuerzo además del query param
    minPoolSize: 0,
    serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
    connectTimeoutMS: 20000,
    waitQueueTimeoutMS: 20000
  });
  clientPromise = client.connect();
  return clientPromise;
}

async function getDb(dbName = process.env.MONGODB_DB || 'baileysss') {
  const client = await getClient();
  return client.db(dbName);
}

async function closeClient() {
  if (!clientPromise) return;
  try {
    const client = await clientPromise;
    await client.close();
  } catch (_) {}
  clientPromise = null;
}

module.exports = { getClient, getDb, closeClient };