// The Node relay's dashboard numbers (src/node/relay-stats.js).
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { createRelayStats, isLocalAddress } from '../src/node/relay-stats.js';

test('sockets, messages and bytes are counted both ways', () => {
  const stats = createRelayStats();
  try {
    const socket = Object.assign(new EventEmitter(), { sent: [], send(data) { this.sent.push(data); } });
    stats.watchSocket(socket);
    stats.watchSocket(socket); // counted once
    socket.emit('message', Buffer.from('hello'));
    socket.send('héllo');
    let s = stats.snapshot();
    assert.equal(s.traffic.connectionsOpen, 1);
    assert.equal(s.traffic.connectionsOpened, 1);
    assert.equal(s.traffic.messagesIn, 1);
    assert.equal(s.traffic.bytesIn, 5);
    assert.equal(s.traffic.messagesOut, 1);
    assert.equal(s.traffic.bytesOut, 6);
    assert.deepEqual(socket.sent, ['héllo'], 'messages still go out');
    socket.emit('close');
    socket.emit('close');
    s = stats.snapshot();
    assert.equal(s.traffic.connectionsOpen, 0);
    assert.equal(s.traffic.connectionsPeak, 1);
  } finally {
    stats.stop();
  }
});

test('account requests are counted by who asked and what came of it', () => {
  const stats = createRelayStats();
  try {
    stats.setAccountCount(() => 7);
    stats.account({ action: 'idp-get' }, { ok: true, record: { alias: 'x' } });
    stats.account({ action: 'idp-get' }, { ok: true, record: null });
    stats.account({ action: 'idp-put' }, { ok: true, stored: true });
    stats.account({ action: 'idp-put' }, { ok: true, stored: false });
    stats.account({ action: 'idp-put' }, { ok: false, error: 'taken' });
    stats.account({ action: 'idp-put', from_relay: true }, { ok: true, stored: true });
    stats.account({ action: 'idp-get', from_relay: true }, { ok: true, record: null });
    stats.accountOutbound({ action: 'idp-put' });
    stats.accountOutbound({ action: 'idp-get' });
    assert.deepEqual(stats.snapshot().accounts, {
      lookups: 2, found: 1, registrations: 1, unchanged: 1, refused: 1,
      receivedFromRelays: 1, askedByRelays: 1, sentToRelays: 1, askedRelays: 1, stored: 7,
    });
  } finally {
    stats.stop();
  }
});

test('the dashboard answers only this machine and its network by default', () => {
  for (const address of ['127.0.0.1', '::1', '::ffff:192.168.1.20', '10.1.2.3', '172.16.0.9', 'fd00::5', '169.254.1.1']) {
    assert.equal(isLocalAddress(address), true, address);
  }
  for (const address of ['67.52.200.58', '8.8.8.8', '172.32.0.1', '2001:db8::1', '', null]) {
    assert.equal(isLocalAddress(address), false, String(address));
  }
});
