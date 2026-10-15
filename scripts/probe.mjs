#!/usr/bin/env node
// -----------------------------------------------------------------------------
// Read-only probe of a real devolo adapter, with the integration's own client:
//
//   node scripts/probe.mjs <adapter-ip>
//   DEVOLO_PASSWORD='…' node scripts/probe.mjs <adapter-ip>
//
// 1. asks the adapter for its mDNS records in unicast (port 5353), as the
//    integration does for an address typed by hand;
// 2. reads every part the adapter announces, through the Device API and the
//    PLC network API: LEDs, guest Wi-Fi, Wi-Fi devices, uptime, firmware
//    check, network overview. Nothing is written: no LED, no guest Wi-Fi,
//    no restart, no identify.
//
// What is printed stays shareable: no password, no guest Wi-Fi name or key,
// MAC addresses and serial numbers shortened, the API path masked. Each step
// prints "ok" with what it read, or the error kind (unreachable, auth,
// unsupported, refused, protocol).
// -----------------------------------------------------------------------------

import { AdapterClient } from '../src/devolo/client.js';
import { adaptersFromServices, queryAddress } from '../src/devolo/mdns.js';

const address = process.argv[2];
if (!address) {
  console.error('Usage: node scripts/probe.mjs <adapter-ip>   (password: DEVOLO_PASSWORD)');
  process.exit(2);
}
const password = process.env.DEVOLO_PASSWORD ?? '';

const short = (value) => (value ? `…${String(value).slice(-4)}` : null);
const mask = (path) =>
  path ? String(path).replace(/^[^/]+/, (token) => `${token.slice(0, 2)}…`) : null;

function report(step, value) {
  console.log(`${step.padEnd(22)} ${typeof value === 'string' ? value : JSON.stringify(value)}`);
}

async function step(name, fn) {
  const started = Date.now();
  try {
    const value = await fn();
    report(name, { ok: true, ms: Date.now() - started, ...value });
  } catch (err) {
    report(name, {
      ok: false,
      ms: Date.now() - started,
      kind: err.kind ?? 'error',
      error: err.message,
    });
  }
}

const services = await queryAddress(address);
report('mdns services', {
  found: services.map((service) => ({
    service: service.name.split('.').slice(-3, -1).join('.'),
    port: service.port,
    txtKeys: service.txt.map((entry) => entry.split('=')[0]),
  })),
});
const [info] = adaptersFromServices(services);
if (!info) {
  report('result', 'no devolo adapter answered the unicast mDNS query: stopping');
  process.exit(1);
}
report('adapter', {
  product: info.product,
  mt: info.mt,
  serial: short(info.sn),
  firmware: info.firmware,
  plcMac: short(info.plcMac),
  technology: info.technology,
  deviceApi: info.deviceApi && { ...info.deviceApi, path: mask(info.deviceApi.path) },
  plcnetApi: info.plcnetApi && { ...info.plcnetApi, path: mask(info.plcnetApi.path) },
  password: password ? 'set' : 'empty',
});

const client = new AdapterClient({ info, password });
if (info.deviceApi) {
  if (client.has('restart')) {
    await step('uptime', async () => ({ uptime: await client.uptime() }));
  }
  if (client.has('led')) {
    await step('leds', async () => ({ on: await client.leds() }));
  }
  if (client.has('wifi1')) {
    await step('guest wifi', async () => {
      const guest = await client.guestWifi();
      return { enabled: guest.enabled, remainingMinutes: guest.remainingDuration };
    });
    await step('wifi devices', async () => {
      const stations = await client.stations();
      return {
        count: stations.length,
        networks: stations.map((station) => station.vapType),
        bands: stations.map((station) => station.band),
      };
    });
  }
  if (client.has('update')) {
    await step('firmware check', async () => client.checkFirmware());
  }
  report('password mode', client.hashed ? 'SHA-256 of the password' : 'as typed');
}
if (info.plcnetApi) {
  await step('network overview', async () => {
    const network = await client.networkOverview();
    return {
      devices: network.devices.map((device) => ({
        mac: short(device.macAddress),
        product: device.productName,
        firmware: device.friendlyVersion,
        topology: device.topology,
        router: device.attachedToRouter,
        named: Boolean(device.userDeviceName),
      })),
      rates: network.dataRates.map((rate) => ({
        from: short(rate.macAddressFrom),
        to: short(rate.macAddressTo),
        tx: rate.txRate,
        rx: rate.rxRate,
      })),
    };
  });
}
