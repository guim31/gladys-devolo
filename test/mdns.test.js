// -----------------------------------------------------------------------------
// Finding the adapters: the core's mDNS scan results, and the unicast query
// to an address typed by hand (through the simulated network, and once over a
// real UDP socket on 127.0.0.1).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import {
  adaptersFromServices,
  decodeResponse,
  encodeQuery,
  queryAddress,
  udpExchange,
} from '../src/devolo/mdns.js';
import { MDNS_SCAN, createFakeNetwork, dnsAnswer } from './helpers/fakeAdapter.js';

test('the core scan gives the adapters and where their APIs live', () => {
  const adapters = adaptersFromServices(MDNS_SCAN);
  assert.deepEqual(
    adapters.map((adapter) => adapter.id),
    ['1234567890', '1234567891', '1234567892'],
  );
  const [wifi, magic, repeater] = adapters;
  assert.deepEqual(wifi.deviceApi, {
    port: 14791,
    path: 'abcdefghijkl/deviceapi',
    version: 'v0',
    features: ['intmtg1', 'led', 'reset', 'restart', 'update', 'wifi1'],
  });
  assert.deepEqual(wifi.plcnetApi, { port: 14791, path: 'abcdefghijkl/plcnetapi', version: 'v0' });
  assert.equal(wifi.address, '192.0.2.1');
  assert.equal(wifi.product, 'dLAN pro 1200+ WiFi ac');
  assert.equal(wifi.firmware, '5.6.1');
  assert.equal(wifi.plcMac, '00005E005300');
  assert.equal(wifi.plcMacRaw, '00:00:5E:00:53:00');
  assert.equal(wifi.hostname, 'devolo-930.local');
  assert.equal(magic.technology, 'ghn');
  // A Wi-Fi-only repeater: no PLC network API, no PLC MAC address.
  assert.equal(repeater.plcnetApi, null);
  assert.equal(repeater.plcMac, null);
});

test('Home Control gateways, other services and incomplete records are left out', () => {
  const ids = adaptersFromServices(MDNS_SCAN).map((adapter) => adapter.id);
  assert.ok(!ids.includes('1234567893'));
  assert.deepEqual(adaptersFromServices([]), []);
  assert.deepEqual(adaptersFromServices(null), []);
  const noPath = structuredClone(MDNS_SCAN.slice(0, 1));
  noPath[0].txt = noPath[0].txt.filter((entry) => !entry.startsWith('Path='));
  assert.deepEqual(adaptersFromServices(noPath), []);
  const noAddress = structuredClone(MDNS_SCAN.slice(0, 1));
  noAddress[0].addresses = [];
  assert.deepEqual(adaptersFromServices(noAddress), []);
});

test('an adapter announcing no feature gets the devolo defaults', () => {
  const record = structuredClone(MDNS_SCAN[0]);
  record.txt = record.txt.filter((entry) => !entry.startsWith('Features='));
  const [adapter] = adaptersFromServices([record]);
  assert.deepEqual(adapter.deviceApi.features, ['reset', 'update', 'led', 'intmtg']);
});

test('a DNS query asks for unicast answers, and an answer decodes', () => {
  const query = encodeQuery([{ name: '_dvl-deviceapi._tcp.local', type: 12 }], 7);
  assert.equal(query.readUInt16BE(0), 7);
  assert.equal(query.readUInt16BE(4), 1);
  assert.equal(query.readUInt16BE(query.length - 2), 0x8001);
  const services = MDNS_SCAN.filter((record) => record.addresses[0] === '192.0.2.1');
  const records = decodeResponse(dnsAnswer(query, services, '192.0.2.1'));
  assert.deepEqual(
    records.map((record) => record.type),
    ['PTR', 'PTR', 'SRV', 'TXT', 'SRV', 'TXT', 'A'],
  );
  assert.deepEqual(records.at(-1), { name: 'devolo-930.local', type: 'A', data: '192.0.2.1' });
  assert.equal(records[2].data.port, 14791);
  assert.ok(records[3].data.includes('SN=1234567890'));
  // A query (not a response) is ignored.
  assert.deepEqual(decodeResponse(query), []);
  assert.throws(() => decodeResponse(Buffer.alloc(4)));
});

test('a compressed name decodes', () => {
  // Header, one answer: "a.local" PTR "b.a.local" (pointer to offset 12).
  const header = Buffer.from([0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 0]);
  const owner = Buffer.from([1, 0x61, 5, ...Buffer.from('local'), 0]);
  const meta = Buffer.from([0, 12, 0, 1, 0, 0, 0, 120, 0, 4]);
  const data = Buffer.from([1, 0x62, 0xc0, 12]);
  const [record] = decodeResponse(Buffer.concat([header, owner, meta, data]));
  assert.deepEqual(record, { name: 'a.local', type: 'PTR', data: 'b.a.local' });
});

test('an address typed by hand is asked in unicast', async () => {
  const network = createFakeNetwork();
  const services = await queryAddress('192.0.2.2', { exchange: network.exchange });
  const [adapter] = adaptersFromServices(services);
  assert.equal(adapter.id, '1234567891');
  assert.equal(adapter.plcnetApi.path, 'mnopqrstuvwx/plcnetapi');
  assert.deepEqual(await queryAddress('192.0.2.99', { exchange: network.exchange }), []);
});

test('an answer without SRV and TXT: they are asked for', async () => {
  const network = createFakeNetwork();
  const services = network.adapter('1234567891').services;
  const questions = [];
  const exchange = async (_address, _port, packet) => {
    questions.push(packet);
    return [dnsAnswer(packet, services, '192.0.2.2', { additionals: questions.length > 1 })];
  };
  const [adapter] = adaptersFromServices(await queryAddress('192.0.2.2', { exchange }));
  assert.equal(questions.length, 2);
  assert.equal(adapter.id, '1234567891');
});

test('the unicast query over a real UDP socket', async (t) => {
  const network = createFakeNetwork();
  const services = network.adapter('1234567890').services;
  const responder = dgram.createSocket('udp4');
  t.after(() => responder.close());
  responder.on('message', (message, remote) => {
    responder.send(dnsAnswer(message, services, '127.0.0.1'), remote.port, remote.address);
  });
  await new Promise((resolve) => responder.bind(0, '127.0.0.1', resolve));
  const { port } = responder.address();
  const [adapter] = adaptersFromServices(await queryAddress('127.0.0.1', { port }));
  assert.equal(adapter.id, '1234567890');
  assert.equal(adapter.address, '127.0.0.1');
  // Nobody answers: an empty list after the timeout.
  assert.deepEqual(await udpExchange('127.0.0.1', 9, Buffer.from([0]), 100), []);
});
