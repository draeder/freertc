// The Node relay's D1 runs D1's numbered-parameter SQL on Node's SQLite,
// including releases before 22.13 that reject ?1/?2 bound by position.
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openSqliteD1, positionalSql } from '../src/node/d1-sqlite.js';

test('numbered parameters become positional ones in the order they appear', () => {
  assert.deepEqual(positionalSql('SELECT * FROM t WHERE a > ?1 LIMIT ?2'), { sql: 'SELECT * FROM t WHERE a > ? LIMIT ?', order: [0, 1] });
  assert.deepEqual(positionalSql('UPDATE t SET a = ?2 WHERE b = ?1 OR c = ?1'), { sql: 'UPDATE t SET a = ? WHERE b = ? OR c = ?', order: [1, 0, 0] });
  assert.deepEqual(positionalSql("SELECT '?1' AS q, ? AS a, ? AS b"), { sql: "SELECT '?1' AS q, ? AS a, ? AS b", order: [0, 1] });
});

test('the relay migrations and its numbered queries run', async () => {
  const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
  const db = await openSqliteD1({ filename: ':memory:', migrationsDir });
  await db.prepare('INSERT INTO psp_kad_nodes (node_id, bucket_index, url, record_json, expires_at_ms, last_seen_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?5)')
    .bind('a'.repeat(64), 3, 'wss://x/ws', '{}', Date.now() + 60_000).run();
  const { results } = await db.prepare('SELECT node_id, last_seen_ms FROM psp_kad_nodes WHERE expires_at_ms > ?1 LIMIT ?2').bind(Date.now(), 1).all();
  assert.equal(results.length, 1);
  assert.equal(results[0].node_id, 'a'.repeat(64));
});
