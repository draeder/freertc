// A peer's role (its announce's capabilities.role) is stored, listed, and listed first:
// a scope where many plain peers look for a few storage servers must not cut the servers.
import assert from 'node:assert/strict';
import test from 'node:test';

import { announcedRole, peersNearest, upsertAnnouncement } from '../src/index.js';
import { openSqliteD1 } from './harness/sqlite-d1.js';

const rows = (d1, sql, ...values) => d1.raw.prepare(sql).all(...values);

test('only a short lowercase word is taken as a role', () => {
  assert.equal(announcedRole({ body: { capabilities: { role: 'storage' } } }), 'storage');
  assert.equal(announcedRole({ body: { capabilities: {} } }), null);
  assert.equal(announcedRole({ body: { capabilities: { role: 'Storage Server' } } }), null);
  assert.equal(announcedRole({ body: { capabilities: { role: 'x'.repeat(40) } } }), null);
  assert.equal(announcedRole({}), null);
});

test('an announcement keeps its role, and a changed role is written at once', async (t) => {
  const d1 = await openSqliteD1();
  if (!d1) return t.skip('node:sqlite is not available on this Node');
  const announce = (role) => upsertAnnouncement(d1, { network: 'net', from: 'peer-a', session_id: 'room', ttl_ms: 30_000, body: { capabilities: role ? { role } : {} } });
  await announce('storage');
  assert.equal(rows(d1, 'SELECT role FROM psp_announcements')[0].role, 'storage');
  await announce(null);
  assert.equal(rows(d1, 'SELECT role FROM psp_announcements')[0].role, null, 'a role dropped is dropped at once, not at half the lease');
});

test('peers with a role are listed before the rest', () => {
  const plain = Array.from({ length: 40 }, (_, i) => ({ peer_id: (0x1000 + i).toString(16).padStart(16, '0') }));
  const servers = [{ peer_id: 'ffffffffffffff01', role: 'storage' }, { peer_id: 'ffffffffffffff02', role: 'storage' }];
  const list = peersNearest([...plain, ...servers], '0000000000001000', 10);
  assert.equal(list.length, 10);
  assert.deepEqual(list.slice(0, 2).map((p) => p.role), ['storage', 'storage']);
  // With no roles, the list is as it was: the nearest.
  assert.equal(peersNearest(plain, '0000000000001000', 10)[0].peer_id, '0000000000001001');
});

test('a database without migration 0003 gets the role column on first use', async (t) => {
  const { openSqliteD1: open } = await import('./harness/sqlite-d1.js');
  const d1 = await open({ migrations: ['0001_initial.sql', '0002_kademlia_overlay.sql'] }).catch(() => null);
  if (!d1) return t.skip('harness cannot open a database at an earlier migration');
  const { ensureRoleColumn } = await import('../src/index.js');
  await ensureRoleColumn(d1);
  await ensureRoleColumn(d1);
  await upsertAnnouncement(d1, { network: 'net', from: 'peer-b', session_id: 'room', ttl_ms: 30_000, body: { capabilities: { role: 'storage' } } });
  assert.equal(rows(d1, 'SELECT role FROM psp_announcements')[0].role, 'storage');
});
