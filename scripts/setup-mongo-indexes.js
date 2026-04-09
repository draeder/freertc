#!/usr/bin/env node
// scripts/setup-mongo-indexes.js — One-time index setup for MongoDB.
//
// Run once after provisioning (or after any index changes):
//   MONGODB_URI="mongodb+srv://..." node scripts/setup-mongo-indexes.js
//
// Creates indexes for:
//   peers.expiresAt     — TTL index for automatic peer record expiry
//   relay.toPeerId      — Lookup for receiving queued signaling messages
//   relay.expiresAt     — TTL index for automatic message cleanup

import { MongoClient } from 'mongodb';

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error('MONGODB_URI environment variable is required');
  process.exit(1);
}

const client = new MongoClient(uri);
try {
  await client.connect();
  const db = client.db('signal');

  // peers — TTL on expiresAt
  await db.collection('peers').createIndex(
    { expiresAt: 1 },
    { expireAfterSeconds: 0, name: 'ttl_peers' }
  );
  console.log('✓ peers TTL index');

  // relay — Compound index for efficient dequeue by toPeerId and networkId
  await db.collection('relay').createIndex(
    { toPeerId: 1, networkId: 1, expiresAt: 1 },
    { name: 'relay_dequeue' }
  );
  console.log('✓ relay dequeue index');

  // relay — TTL on expiresAt for automatic cleanup
  await db.collection('relay').createIndex(
    { expiresAt: 1 },
    { expireAfterSeconds: 0, name: 'ttl_relay' }
  );
  console.log('✓ relay TTL index');

  console.log('\nAll indexes created successfully.');
} finally {
  await client.close();
}
