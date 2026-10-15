// -----------------------------------------------------------------------------
// The adapter client: Digest authentication (password as typed, then hashed),
// the answers of each endpoint, the errors, and one round trip over a real
// HTTP server on 127.0.0.1.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdapterClient, DevoloError, formatMac, normalizeMac } from '../src/devolo/client.js';
import { adaptersFromServices } from '../src/devolo/mdns.js';
import { GUEST_KEY, MDNS_SCAN, PASSWORD, PHONE, createFakeNetwork } from './helpers/fakeAdapter.js';

const infos = adaptersFromServices(MDNS_SCAN);
const info = (sn) => infos.find((entry) => entry.sn === sn);

function client(network, sn = '1234567890', password = PASSWORD) {
  return new AdapterClient({ info: info(sn), password, request: network.request });
}

test('MAC addresses are normalized and formatted', () => {
  assert.equal(normalizeMac('00:00:5e:00:53:01'), '00005E005301');
  assert.equal(normalizeMac('00-00-5E-00-53-01'), '00005E005301');
  assert.equal(normalizeMac('00005e0053'), null);
  assert.equal(formatMac('00005e005301'), '00:00:5E:00:53:01');
});

test('reads every part of a Wi-Fi adapter', async () => {
  const network = createFakeNetwork();
  const adapter = client(network);
  assert.equal(await adapter.leds(), true);
  assert.deepEqual(await adapter.stations(), [
    { macAddress: PHONE, mac: '00005E005301', vapType: 1, band: 2, rxRate: 87800, txRate: 87800 },
  ]);
  const guest = await adapter.guestWifi();
  assert.equal(guest.enabled, false);
  assert.equal(guest.key, GUEST_KEY);
  assert.deepEqual(await adapter.checkFirmware(), { available: true, version: '5.6.2' });
  assert.equal(await adapter.uptime(), 1000);
  const overview = await adapter.networkOverview();
  assert.equal(overview.devices.length, 3);
  assert.equal(overview.dataRates.length, 3);
  // URL built from the mDNS records: port, adapter path, version.
  assert.ok(
    network
      .adapter('1234567890')
      .requests.includes('GET /abcdefghijkl/deviceapi/v0/LedSettingsGet'),
  );
  assert.ok(
    network
      .adapter('1234567890')
      .requests.includes('GET /abcdefghijkl/plcnetapi/v0/GetNetworkOverview'),
  );
});

test('commands reach the adapter', async () => {
  const network = createFakeNetwork();
  const adapter = client(network);
  const fake = network.adapter('1234567890');
  assert.equal(await adapter.setLeds(false), true);
  assert.equal(fake.leds, false);
  assert.equal(await adapter.setGuestWifi(true, 60), true);
  assert.deepEqual(fake.guestSets.at(-1), { enable: true, duration: 60 });
  await adapter.setGuestWifi(false, 60);
  assert.deepEqual(fake.guestSets.at(-1), { enable: false, duration: 0 });
  assert.equal(await adapter.identify(), true);
  assert.equal(fake.identified, 1);
  assert.equal(await adapter.restart(), true);
  assert.equal(fake.restarts, 1);
});

test('Digest: one challenge, then requests reuse it', async () => {
  const network = createFakeNetwork();
  const adapter = client(network);
  await adapter.leds();
  await adapter.leds();
  await adapter.leds();
  // 401 + answer for the first, then one request each.
  assert.equal(network.adapter('1234567890').requests.length, 4);
});

test('a new nonce (the adapter restarted) is answered again', async () => {
  const network = createFakeNetwork();
  const adapter = client(network);
  await adapter.leds();
  network.nonce = 'fresh';
  assert.equal(await adapter.leds(), true);
});

test('an adapter expecting the SHA-256 of the password: tried hashed, then remembered', async () => {
  const network = createFakeNetwork({ hashed: true });
  const adapter = client(network);
  assert.equal(await adapter.leds(), true);
  assert.equal(adapter.hashed, true);
  const before = network.adapter('1234567890').requests.length;
  await adapter.leds();
  assert.equal(network.adapter('1234567890').requests.length, before + 1);
});

test('no password set on the adapters: an empty password works', async () => {
  const network = createFakeNetwork({ password: '' });
  assert.equal(await client(network, '1234567890', '').leds(), true);
});

test('a wrong password, a silent adapter, a missing endpoint: typed errors', async () => {
  const network = createFakeNetwork();
  await assert.rejects(client(network, '1234567890', 'wrong').leds(), { kind: 'auth' });
  network.adapter('1234567890').reachable = false;
  await assert.rejects(client(network).leds(), { kind: 'unreachable' });
  // The repeater has no PLC network API.
  await assert.rejects(client(network, '1234567892').networkOverview(), { kind: 'unsupported' });
  await assert.rejects(client(network, '1234567892').identify(), { kind: 'unsupported' });
  // The Magic 2 LAN has no Wi-Fi.
  await assert.rejects(client(network, '1234567891').guestWifi(), { kind: 'unsupported' });
  // A path the adapter does not serve.
  const moved = structuredClone(info('1234567891'));
  moved.deviceApi.path = 'elsewhere/deviceapi';
  const lost = new AdapterClient({ info: moved, password: PASSWORD, request: network.request });
  await assert.rejects(lost.leds(), { kind: 'unsupported' });
});

test('a garbled answer is a protocol error', async () => {
  const request = async () => ({ status: 200, headers: {}, body: Buffer.from([0x0a, 0x09]) });
  const adapter = new AdapterClient({ info: info('1234567890'), request });
  await assert.rejects(adapter.networkOverview(), (err) => {
    assert.ok(err instanceof DevoloError);
    assert.equal(err.kind, 'protocol');
    return true;
  });
  const failing = async () => ({ status: 500, headers: {}, body: Buffer.alloc(0) });
  await assert.rejects(new AdapterClient({ info: info('1234567890'), request: failing }).leds(), {
    kind: 'protocol',
  });
  const noChallenge = async () => ({ status: 401, headers: {}, body: Buffer.alloc(0) });
  await assert.rejects(
    new AdapterClient({ info: info('1234567890'), request: noChallenge }).leds(),
    { kind: 'auth' },
  );
});

test('an error result of the adapter is "refused"', async () => {
  const network = createFakeNetwork();
  const wrongMac = structuredClone(info('1234567890'));
  wrongMac.plcMacRaw = '00:00:5E:00:53:99';
  const adapter = new AdapterClient({
    info: wrongMac,
    password: PASSWORD,
    request: network.request,
  });
  await assert.rejects(adapter.identify(), { kind: 'refused' });
});

test('requests to one adapter run one at a time', async () => {
  let running = 0;
  let most = 0;
  const network = createFakeNetwork();
  const request = async (options) => {
    running += 1;
    most = Math.max(most, running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    running -= 1;
    return network.request(options);
  };
  const adapter = new AdapterClient({ info: info('1234567890'), password: PASSWORD, request });
  await Promise.all([adapter.leds(), adapter.guestWifi(), adapter.stations(), adapter.uptime()]);
  assert.equal(most, 1);
});

test('a round trip over a real HTTP server', async (t) => {
  const network = createFakeNetwork();
  const { server, port } = await network.serve('1234567890');
  t.after(() => server.close());
  const local = structuredClone(info('1234567890'));
  local.address = '127.0.0.1';
  local.deviceApi.port = port;
  const adapter = new AdapterClient({ info: local, password: PASSWORD });
  assert.equal(await adapter.leds(), true);
  assert.equal(await adapter.setGuestWifi(true, 30), true);
  assert.equal((await adapter.guestWifi()).enabled, true);
  local.deviceApi.port = 9; // nothing listens there
  await assert.rejects(new AdapterClient({ info: local }).leds(), { kind: 'unreachable' });
});
