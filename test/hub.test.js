// -----------------------------------------------------------------------------
// The integration end to end, against the simulated devolo network: what is
// proposed, what is published, presence, the scene event, the commands, the
// failures and what the logs say.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  LAPTOP,
  MAC,
  PASSWORD,
  PHONE,
  GUEST_KEY,
  createFakeNetwork,
} from './helpers/fakeAdapter.js';
import { captureLogs } from './helpers/logs.js';
import {
  CONFIG,
  adapterDevice,
  create,
  createWorld,
  cycleAfter,
  discovered,
  events,
  featureId,
  flush,
  state,
} from './helpers/world.js';
import { render, STATUS } from '../src/messages.js';

const WIFI = '1234567890';
const MAGIC = '1234567891';
const REPEATER = '1234567892';

async function worldWithAdapters(t, options = {}) {
  const world = await createWorld(options);
  t.after(() => world.app.stop());
  for (const sn of [WIFI, MAGIC, REPEATER]) {
    const device = adapterDevice(world, sn);
    if (device) {
      await create(world, device);
    }
  }
  return world;
}

const phoneDevice = (world) => discovered(world, ':wifi:00005e005301');

test('at start: the adapters and the connected Wi-Fi device are proposed, nothing created', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  assert.deepEqual(
    world.fake.discoveredDevices.map((device) => device.name),
    [
      'dLAN pro 1200+ WiFi ac (test1)',
      'devolo Magic 2 LAN (test2)',
      'devolo WiFi 6 Repeater 3000',
      'Appareil Wi-Fi 00:00:5E:00:53:01',
    ],
  );
  const wifi = adapterDevice(world, WIFI);
  assert.equal(wifi.should_poll, false);
  assert.deepEqual(wifi.params, [
    { name: 'IP_ADDRESS', value: '192.0.2.1' },
    { name: 'SERIAL_NUMBER', value: WIFI },
    { name: 'PLC_MAC', value: '00:00:5E:00:53:00' },
  ]);
  // No restart button unless allowed.
  assert.equal(featureId(wifi, 'restart'), undefined);
  assert.deepEqual(world.fake.connectionStatus, { connected: true });
  assert.equal(world.fake.states.length, 0);
});

test('adding an adapter publishes its states at once', async (t) => {
  const world = await worldWithAdapters(t);
  const wifi = adapterDevice(world, WIFI);
  assert.equal(state(world, wifi, 'online'), 1);
  assert.equal(state(world, wifi, 'plc_tx_00005e005302'), 100);
  assert.equal(state(world, wifi, 'plc_rx_00005e005303'), 150);
  assert.equal(state(world, wifi, 'wifi_clients'), 1);
  assert.equal(state(world, wifi, 'guest_wifi'), 0);
  assert.equal(state(world, wifi, 'leds'), 1);
  assert.equal(world.fake.lastState(featureId(wifi, 'firmware')), '5.6.1');
  // The Magic 2 LAN reports the rates seen from its side.
  const magic = adapterDevice(world, MAGIC);
  assert.equal(state(world, magic, 'plc_tx_00005e005303'), 420);
  assert.equal(state(world, magic, 'plc_rx_00005e005303'), 381);
  // Its rate to the Wi-Fi adapter comes from the Wi-Fi adapter's side.
  assert.equal(state(world, magic, 'plc_tx_00005e005300'), 100);
  assert.equal(state(world, magic, 'leds'), 0);
  assert.ok(world.fake.widgetRefreshes.length > 0);
});

test('the firmware check runs after the start, then every 6 hours', async (t) => {
  const world = await worldWithAdapters(t);
  const wifi = adapterDevice(world, WIFI);
  const checks = () =>
    world.net.adapter(WIFI).requests.filter((line) => line.endsWith('UpdateFirmwareCheck')).length;
  assert.equal(checks(), 0);
  await cycleAfter(world);
  assert.equal(checks(), 1);
  assert.equal(state(world, wifi, 'firmware_update'), 1);
  assert.equal(state(world, adapterDevice(world, MAGIC), 'firmware_update'), 0);
  await cycleAfter(world);
  assert.equal(checks(), 1);
  // Updated: no update anymore, and the new version read from mDNS.
  world.net.adapter(WIFI).firmwareUpdate = { available: false, version: '' };
  const record = world.net.records[0];
  record.txt = record.txt.map((entry) =>
    entry.startsWith('FirmwareVersion=') ? 'FirmwareVersion=5.6.2' : entry,
  );
  await cycleAfter(world, 6 * 60 * 60 * 1000);
  assert.equal(state(world, wifi, 'firmware_update'), 0);
  await cycleAfter(world);
  assert.equal(world.fake.lastState(featureId(wifi, 'firmware')), '5.6.2');
});

test('only changes are published, the rates every 5 minutes', async (t) => {
  const world = await worldWithAdapters(t);
  await cycleAfter(world);
  const count = world.fake.states.length;
  await cycleAfter(world);
  assert.equal(world.fake.states.length, count);
  world.net.rates[`${MAC.wifi}>${MAC.magic}`] = { tx: 80, rx: 90 };
  await cycleAfter(world);
  assert.equal(state(world, adapterDevice(world, WIFI), 'plc_tx_00005e005302'), 100);
  await cycleAfter(world, 5 * 60 * 1000);
  assert.equal(state(world, adapterDevice(world, WIFI), 'plc_tx_00005e005302'), 80);
  assert.equal(state(world, adapterDevice(world, WIFI), 'plc_rx_00005e005302'), 90);
});

test('a stable value is published again after 12 hours (heartbeat)', async (t) => {
  const world = await worldWithAdapters(t);
  const online = featureId(adapterDevice(world, MAGIC), 'online');
  const sent = () =>
    world.fake.states.filter((s) => s.device_feature_external_id === online).length;
  const before = sent();
  await cycleAfter(world);
  assert.equal(sent(), before);
  // The SDK dates the last value with the real clock.
  const { mock } = t;
  mock.timers.enable({ apis: ['Date'], now: Date.now() + 12 * 60 * 60 * 1000 + 1000 });
  await cycleAfter(world);
  assert.equal(sent(), before + 1);
});

test('an adapter that stops answering: offline at the second miss, back when it answers', async (t) => {
  const world = await worldWithAdapters(t);
  const lines = captureLogs(t, 'info');
  const magic = adapterDevice(world, MAGIC);
  world.net.adapter(MAGIC).reachable = false;
  await cycleAfter(world);
  assert.equal(state(world, magic, 'online'), 1);
  await cycleAfter(world);
  assert.equal(state(world, magic, 'online'), 0);
  assert.deepEqual(world.fake.connectionStatus, {
    connected: true,
    message: render(STATUS, 'unreachable', { names: 'devolo Magic 2 LAN (test2)' }),
  });
  for (let i = 0; i < 3; i += 1) {
    await cycleAfter(world);
  }
  world.net.adapter(MAGIC).reachable = true;
  await cycleAfter(world);
  assert.equal(state(world, magic, 'online'), 1);
  assert.deepEqual(world.fake.connectionStatus, { connected: true });
  const own = lines.filter((line) => line.includes('[devolo]'));
  assert.equal(own.length, 2, own.join('\n'));
  assert.match(own[0], /^\[WARN\] \[devolo\] devolo Magic 2 LAN \(test2\) does not answer/);
  assert.match(own[1], /^\[INFO\] \[devolo\] Back: devolo Magic 2 LAN \(test2\)/);
});

test('an adapter at a new address (DHCP) is found again by the network search', async (t) => {
  const world = await worldWithAdapters(t);
  const magic = adapterDevice(world, MAGIC);
  world.net.move(MAGIC, '192.0.2.42');
  // Searched again after 3 misses, at most every 10 minutes; the next cycle
  // reads the new address.
  for (let i = 0; i < 3; i += 1) {
    await cycleAfter(world, 4 * 60 * 1000);
  }
  await cycleAfter(world);
  assert.equal(state(world, magic, 'online'), 1);
  assert.equal(world.hub.adapters.get(MAGIC).info.address, '192.0.2.42');
  // Same device in Gladys, its address parameter follows.
  assert.equal(
    adapterDevice(world, MAGIC).params.find((p) => p.name === 'IP_ADDRESS').value,
    '192.0.2.42',
  );
});

test('a wrong password: said in the status and once in the logs', async (t) => {
  const lines = captureLogs(t, 'info');
  const world = await createWorld({ config: { password: 'wrong' } });
  t.after(() => world.app.stop());
  for (let i = 0; i < 3; i += 1) {
    await cycleAfter(world);
  }
  assert.equal(world.fake.connectionStatus.connected, false);
  assert.match(world.fake.connectionStatus.message.fr, /a refusé le mot de passe/);
  const refused = lines.filter((line) => line.includes('refused the password'));
  assert.equal(refused.length, 3, 'one line per adapter');
  // The right password in the configuration: everything answers.
  await world.fake.configUpdated({ password: PASSWORD });
  assert.deepEqual(world.fake.connectionStatus, { connected: true });
});

test('adapters expecting the hashed password are read too', async (t) => {
  const world = await worldWithAdapters(t, { network: { hashed: true } });
  assert.equal(state(world, adapterDevice(world, WIFI), 'online'), 1);
  assert.deepEqual(world.fake.connectionStatus, { connected: true });
});

test('no adapter on the network: the status says what to do, searched every 10 minutes', async (t) => {
  const world = await createWorld({ mdns: false });
  t.after(() => world.app.stop());
  const scans = () =>
    world.fake.requests.filter((r) => r.path.includes('network_discovery')).length;
  const before = scans();
  await cycleAfter(world);
  assert.equal(scans(), before);
  await cycleAfter(world, 10 * 60 * 1000);
  assert.equal(scans(), before + 1);
  assert.deepEqual(world.fake.discoveredDevices, []);
  assert.deepEqual(world.fake.connectionStatus, {
    connected: false,
    message: render(STATUS, 'none'),
  });
});

test('an address typed in the configuration is asked in unicast', async (t) => {
  const world = await createWorld({
    mdns: false,
    config: { ...CONFIG, addresses: '192.0.2.2, 192.0.2.99' },
  });
  t.after(() => world.app.stop());
  assert.deepEqual(
    world.fake.discoveredDevices.map((device) => device.name),
    ['devolo Magic 2 LAN (test2)'],
  );
});

test('the adapters found are remembered under /data: a restart without network search works', async (t) => {
  const first = await createWorld();
  await first.app.stop();
  const saved = JSON.parse(await readFile(join(first.dataDir, 'state.json'), 'utf8'));
  assert.deepEqual(Object.keys(saved.adapters), [WIFI, MAGIC, REPEATER]);
  assert.equal(JSON.stringify(saved).includes(PASSWORD), false);
  const again = await createWorld({ mdns: false, dataDir: first.dataDir, network: first.net });
  t.after(() => again.app.stop());
  assert.equal(
    again.fake.discoveredDevices.filter((d) => d.external_id.includes(':adapter:')).length,
    3,
  );
  // The rate features survive a peer unplugged during the restart.
  again.net.plc.splice(2, 1);
  await again.hub.scan();
  assert.ok(featureId(adapterDevice(again, WIFI), 'plc_tx_00005e005303'));
});

test('a new adapter in the PLC network: the devices are proposed again with its rates', async (t) => {
  const world = await worldWithAdapters(t);
  world.net.plc.push({
    mac: '00:00:5E:00:53:20',
    name: 'Garage',
    product: 'devolo Magic 1',
    router: false,
  });
  world.net.rates[`${MAC.wifi}>00:00:5E:00:53:20`] = { tx: 60, rx: 55 };
  await cycleAfter(world, 5 * 60 * 1000);
  const wifi = adapterDevice(world, WIFI);
  assert.ok(wifi.features.some((feature) => feature.name === 'Débit CPL vers Garage'));
});

test('presence: home while connected, away only after the delay', async (t) => {
  const world = await worldWithAdapters(t);
  const phone = await create(world, phoneDevice(world));
  assert.equal(state(world, phone, 'presence'), 1);
  world.net.adapter(WIFI).stations = [];
  await cycleAfter(world, 60_000);
  assert.equal(state(world, phone, 'presence'), 1);
  await cycleAfter(world, 120_000);
  assert.equal(state(world, phone, 'presence'), 0);
  // Back on the repeater this time.
  world.net.adapter(REPEATER).stations = [
    { macAddress: PHONE.toLowerCase(), vapType: 1, band: 1, rxRate: 1, txRate: 1 },
  ];
  await cycleAfter(world);
  assert.equal(state(world, phone, 'presence'), 1);
});

test('presence: no Wi-Fi adapter answering changes nothing', async (t) => {
  const world = await worldWithAdapters(t);
  const phone = await create(world, phoneDevice(world));
  world.net.adapter(WIFI).reachable = false;
  world.net.adapter(REPEATER).reachable = false;
  for (let i = 0; i < 10; i += 1) {
    await cycleAfter(world, 60_000);
  }
  assert.equal(state(world, phone, 'presence'), 1);
});

test('a Wi-Fi device never seen before fires new_wifi_device; the first read learns silently', async (t) => {
  const world = await worldWithAdapters(t);
  assert.deepEqual(events(world, 'new_wifi_device'), []);
  world.net.adapter(REPEATER).stations = [
    { macAddress: LAPTOP, vapType: 2, band: 1, rxRate: 1, txRate: 1 },
  ];
  world.net.adapter(WIFI).stations = [];
  await cycleAfter(world);
  await flush();
  assert.deepEqual(events(world, 'new_wifi_device'), [
    {
      network: 'guest',
      mac: LAPTOP,
      adapter: 'devolo WiFi 6 Repeater 3000',
      band: '2.4 GHz',
    },
  ]);
  // Seen again, or the phone coming back: nothing.
  world.net.adapter(WIFI).stations = [
    { macAddress: PHONE, vapType: 1, band: 2, rxRate: 1, txRate: 1 },
  ];
  await cycleAfter(world);
  await flush();
  assert.equal(events(world, 'new_wifi_device').length, 1);
  // Remembered across a restart.
  await world.app.stop();
  const again = await createWorld({ dataDir: world.dataDir, network: world.net });
  t.after(() => again.app.stop());
  await flush();
  assert.deepEqual(events(again, 'new_wifi_device'), []);
});

test('the guest Wi-Fi and LED switches of the device', async (t) => {
  const world = await worldWithAdapters(t);
  const lines = captureLogs(t, 'info');
  const wifi = adapterDevice(world, WIFI);
  assert.deepEqual(
    await world.fake.setValue(wifi, { external_id: featureId(wifi, 'guest_wifi') }, 1),
    { success: true },
  );
  assert.equal(world.net.adapter(WIFI).guest.enabled, true);
  assert.equal(state(world, wifi, 'guest_wifi'), 1);
  await world.fake.setValue(wifi, { external_id: featureId(wifi, 'leds') }, 0);
  assert.equal(world.net.adapter(WIFI).leds, false);
  assert.equal(state(world, wifi, 'leds'), 0);
  await world.fake.setValue(wifi, { external_id: featureId(wifi, 'identify') }, 1);
  assert.equal(world.net.adapter(WIFI).identified, 1);
  assert.deepEqual(lines, [
    '[INFO] [devolo] Guest Wi-Fi of dLAN pro 1200+ WiFi ac (test1) switched on',
    '[INFO] [devolo] LEDs of dLAN pro 1200+ WiFi ac (test1) switched off',
    '[INFO] [devolo] dLAN pro 1200+ WiFi ac (test1) blinks',
  ]);
});

test('restart: refused unless allowed in the configuration', async (t) => {
  const world = await worldWithAdapters(t);
  const wifi = adapterDevice(world, WIFI);
  const restart = { external_id: wifi.external_id.replace(/$/, ':restart') };
  const refused = await world.fake.setValue(wifi, restart, 1);
  assert.equal(refused.success, false);
  assert.match(refused.error, /redémarrage d'un adaptateur est désactivé/);
  assert.equal(world.net.adapter(WIFI).restarts, 0);

  await world.fake.configUpdated({ ...CONFIG, allow_restart: true });
  const allowed = adapterDevice(world, WIFI);
  assert.ok(featureId(allowed, 'restart'));
  assert.deepEqual(
    await world.fake.setValue(allowed, { external_id: featureId(allowed, 'restart') }, 1),
    { success: true },
  );
  assert.equal(world.net.adapter(WIFI).restarts, 1);
});

test('a command to a silent adapter or another device fails, in the configured language', async (t) => {
  const world = await worldWithAdapters(t, { config: { ...CONFIG, language: 'de' } });
  const wifi = adapterDevice(world, WIFI);
  world.net.adapter(WIFI).reachable = false;
  const silent = await world.fake.setValue(wifi, { external_id: featureId(wifi, 'leds') }, 1);
  assert.equal(silent.error, 'dLAN pro 1200+ WiFi ac (test1) antwortet nicht.');
  const other = await world.fake.setValue(
    { external_id: 'ext:test-integration:wifi:00005e005301' },
    { external_id: 'ext:test-integration:wifi:00005e005301:presence' },
    1,
  );
  assert.match(other.error, /gehört nicht zur Integration devolo/);
});

test('search_adapters reports every adapter, in four languages', async (t) => {
  const world = await worldWithAdapters(t);
  world.net.adapter(REPEATER).reachable = false;
  const { success, data } = await world.fake.action('search_adapters', {});
  assert.equal(success, true);
  const report = data.message;
  assert.deepEqual(Object.keys(report), ['en', 'fr', 'de', 'es']);
  assert.match(report.fr, /^3 adaptateur\(s\) devolo :/);
  assert.match(
    report.fr,
    /dLAN pro 1200\+ WiFi ac \(test1\) \(firmware 5\.6\.1\) à 192\.0\.2\.1 répond\./,
  );
  assert.match(report.en, /Open the Discover tab/);
  assert.match(
    report.en,
    /devolo WiFi 6 Repeater 3000 \(firmware 5\.11\.0\) at 192\.0\.2\.3 does not answer\./,
  );
});

test('search_adapters with nothing found answers what to do, it does not throw', async (t) => {
  const world = await createWorld({ mdns: false });
  t.after(() => world.app.stop());
  const { success, data } = await world.fake.action('search_adapters', {});
  assert.equal(success, true);
  assert.deepEqual(data.message, render(STATUS, 'none'));
});

test('a reconnection to Gladys publishes the states again', async (t) => {
  const world = await worldWithAdapters(t);
  const count = world.fake.states.length;
  await world.gladys.disconnect();
  await world.gladys.connect();
  assert.ok(world.fake.states.length > count);
});

test('the logs never show the password nor the guest Wi-Fi key', async (t) => {
  const lines = captureLogs(t, 'debug');
  const world = await worldWithAdapters(t, {
    network: createFakeNetwork(),
    config: { ...CONFIG, addresses: '192.0.2.77' },
  });
  await world.fake.sceneAction('enable_guest_wifi', {});
  world.net.password = 'changed';
  await cycleAfter(world);
  await world.fake.configUpdated({ password: 'another-secret-9876' });
  await cycleAfter(world);
  const text = lines.join('\n');
  assert.ok(text.length > 0, 'something was logged');
  for (const secret of [PASSWORD, 'another-secret-9876', GUEST_KEY]) {
    assert.ok(!text.includes(secret), `"${secret}" is in the logs`);
  }
});

test('the hub reads the adapters on its own timer: no poll from Gladys is needed', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const world = await worldWithAdapters(t, { timers: true });
  const wifi = adapterDevice(world, WIFI);
  assert.equal(wifi.should_poll, false);
  world.net.adapter(WIFI).leds = false;
  world.clock.advance(30_000);
  t.mock.timers.tick(30_000); // poll_interval: 30 s by default
  await world.hub.running;
  assert.equal(state(world, wifi, 'leds'), 0);
});

test('onPoll still answers, as a fallback', async (t) => {
  const world = await worldWithAdapters(t);
  const wifi = adapterDevice(world, WIFI);
  world.net.adapter(WIFI).leds = false;
  world.clock.advance(30_000);
  assert.deepEqual(await world.fake.poll(wifi), { success: true });
  assert.equal(state(world, wifi, 'leds'), 0);
});

test('a normal read cycle writes nothing at the info level', async (t) => {
  const world = await worldWithAdapters(t);
  await create(world, phoneDevice(world));
  const lines = captureLogs(t, 'info');
  for (let i = 0; i < 12; i += 1) {
    world.net.rates[`${MAC.wifi}>${MAC.magic}`] = { tx: 100 + i, rx: 100 };
    world.net.adapter(WIFI).leds = i % 2 === 0;
    await cycleAfter(world, 60_000);
  }
  assert.ok(world.fake.states.length > 0);
  assert.deepEqual(lines, []);
});

test('a repeated failure writes one line when it starts and one when it ends', async (t) => {
  const world = await worldWithAdapters(t);
  const lines = captureLogs(t, 'info');
  const publish = world.gladys.publishChangedStates;
  world.gladys.publishChangedStates = async () => {
    throw new Error('HTTP 500');
  };
  for (let i = 0; i < 3; i += 1) {
    world.net.adapter(WIFI).leds = i % 2 === 0;
    await cycleAfter(world);
  }
  world.gladys.publishChangedStates = publish;
  await cycleAfter(world);
  assert.deepEqual(lines, [
    '[WARN] [devolo] Publishing the states failed: HTTP 500',
    '[INFO] [devolo] Gladys accepts the states again',
  ]);
});

test('the network search refused by the core: one line, the known adapters still read', async (t) => {
  const world = await worldWithAdapters(t);
  const lines = captureLogs(t, 'info');
  world.gladys.scanNetwork = async () => {
    throw new Error('HTTP 403');
  };
  await world.hub.scan();
  await world.hub.scan();
  assert.deepEqual(lines, ['[WARN] [devolo] Network search unavailable: HTTP 403']);
  assert.equal(world.hub.adapters.size, 3);
});
