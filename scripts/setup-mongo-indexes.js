#!/usr/bin/env node
// scripts/setup-mongo-indexes.js — One-time index setup for MongoDB.
//
// Run once after provisioning (or after any index changes):
//   MONGODB_URI="mongodb+srv://..." node scripts/setup-mongo-indexes.js
//
// Creates:
//   peers.expiresAt    — TTL index for automatic peer record expiry

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

  console.log('\nAll indexes created successfully.');
} finally {
  await client.close();
}
