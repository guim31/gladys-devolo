// -----------------------------------------------------------------------------
// A simulated devolo network for the tests: adapters answering the Device API
// and the PLC network API (protobuf over HTTP, Digest authentication), their
// mDNS records (the core's scan format) and unicast DNS answers. It plugs into
// the integration through its seams (`request`, `exchange`), so nothing
// touches the network; `serve()` also exposes one adapter over a real HTTP
// server on 127.0.0.1 for the transport tests.
//
// The starting point is the network of the Home Assistant tests (Apache 2.0):
// a dLAN pro 1200+ WiFi ac (test1), a Magic 2 LAN plugged into the router
// (test2) and an old dLAN 550 duo+ without API (test3), plus a Wi-Fi-only
// repeater. Anonymized: documentation addresses (192.0.2.x, 00:00:5E:00:53:xx).
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { decode } from '../../src/devolo/protobuf.js';
import {
  GetNetworkOverview,
  IdentifyDevice,
  LedSettings,
  RestartResponse,
  Result,
  UpdateFirmwareCheck,
  UptimeGetResponse,
  WifiConnectedStationsGet,
  WifiGuestAccessGet,
  WifiGuestAccessSet,
} from '../../src/devolo/schema.js';
import { encodeMessage } from './protobufWriter.js';

export const PASSWORD = 'secret-pass-1234';
export const GUEST_KEY = 'HMANPGBA';
const md5 = (text) => createHash('md5').update(text).digest('hex');
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

export const MDNS_SCAN = JSON.parse(
  readFileSync(new URL('../fixtures/devolo/mdns-scan.json', import.meta.url), 'utf8'),
);

export const MAC = {
  wifi: '00:00:5E:00:53:00',
  magic: '00:00:5E:00:53:02',
  old: '00:00:5E:00:53:03',
};
export const PHONE = '00:00:5E:00:53:01';
export const LAPTOP = '00:00:5E:00:53:11';

/** The adapters of MDNS_SCAN, as the simulated network serves them. */
function defaultAdapters() {
  return [
    {
      address: '192.0.2.1',
      sn: '1234567890',
      hostname: 'devolo-930.local',
      product: 'dLAN pro 1200+ WiFi ac',
      plcMac: MAC.wifi,
      name: 'test1',
      leds: true,
      guest: { enabled: false, remainingDuration: 0, ssid: 'devolo-guest-930', key: GUEST_KEY },
      stations: [{ macAddress: PHONE, vapType: 1, band: 2, rxRate: 87800, txRate: 87800 }],
      firmwareUpdate: { available: true, version: '5.6.2_2023-01-15' },
    },
    {
      address: '192.0.2.2',
      sn: '1234567891',
      hostname: 'devolo-512.local',
      product: 'devolo Magic 2 LAN',
      plcMac: MAC.magic,
      name: 'test2',
      leds: false,
      firmwareUpdate: { available: false, version: '' },
    },
    {
      address: '192.0.2.3',
      sn: '1234567892',
      hostname: 'devolo-077.local',
      product: 'devolo WiFi 6 Repeater 3000',
      plcMac: null,
      leds: true,
      guest: { enabled: false, remainingDuration: 0, ssid: 'devolo-guest-077', key: GUEST_KEY },
      stations: [],
      firmwareUpdate: { available: false, version: '' },
    },
  ];
}

/**
 * @param {object} [options]
 * @param {string} [options.password] device password ('' = none)
 * @param {boolean} [options.hashed] the adapters expect the SHA-256 of the password
 * @param {Array<string>} [options.only] serial numbers of the adapters present
 */
export function createFakeNetwork({ password = PASSWORD, hashed = false, only } = {}) {
  const records = MDNS_SCAN.map((record) => structuredClone(record));
  const adapters = defaultAdapters()
    .filter((adapter) => !only || only.includes(adapter.sn))
    .map((adapter) => ({
      reachable: true,
      uptime: 1000,
      restarts: 0,
      identified: 0,
      guestSets: [],
      requests: [],
      ...adapter,
      services: records.filter((record) => record.addresses.includes(adapter.address)),
    }));

  const network = {
    password,
    hashed,
    adapters,
    records,
    // The PLC network: the adapters, their names, who is plugged into the
    // router, and the PHY rates (Mbit/s) by "from>to".
    plc: [
      { mac: MAC.wifi, name: 'test1', product: 'dLAN pro 1200+ WiFi ac', router: false },
      { mac: MAC.magic, name: 'test2', product: 'devolo Magic 2 LAN', router: true },
      { mac: MAC.old, name: 'test3', product: 'dLAN 550 duo+', router: false },
    ],
    rates: {
      [`${MAC.wifi}>${MAC.magic}`]: { tx: 100, rx: 100 },
      [`${MAC.wifi}>${MAC.old}`]: { tx: 150, rx: 150 },
      [`${MAC.magic}>${MAC.old}`]: { tx: 420.4, rx: 380.6 },
    },
    nonce: randomBytes(8).toString('hex'),

    adapter: (sn) => adapters.find((adapter) => adapter.sn === sn),

    /** The core's mDNS scan: the records of the present adapters, plus the noise. */
    scanResults() {
      const present = new Set(adapters.map((adapter) => adapter.address));
      return records.filter(
        (record) =>
          !['192.0.2.1', '192.0.2.2', '192.0.2.3'].includes(record.addresses[0]) ||
          present.has(record.addresses[0]),
      );
    },

    /** Move an adapter to another address (a new DHCP lease). */
    move(sn, address) {
      const adapter = network.adapter(sn);
      for (const record of adapter.services) {
        record.addresses = [address];
      }
      adapter.address = address;
    },

    overviewOf(adapter) {
      const devices = network.plc.map((device) => ({
        productName: device.product,
        userDeviceName: device.name,
        macAddress: device.mac,
        topology: device.mac === adapter.plcMac ? 1 : 2,
        attachedToRouter: device.router,
        friendlyVersion: device.mac === adapter.plcMac ? 'x' : '',
      }));
      const dataRates = Object.entries(network.rates)
        .filter(([key]) => network.plc.some((device) => key.startsWith(device.mac)))
        .map(([key, rate]) => {
          const [from, to] = key.split('>');
          return { macAddressFrom: from, macAddressTo: to, txRate: rate.tx, rxRate: rate.rx };
        });
      return { network: { devices, dataRates } };
    },

    /** The HTTP seam of the integration. */
    async request({ method, url, headers = {}, body }) {
      const target = new URL(url);
      const adapter = adapters.find((entry) => entry.address === target.hostname);
      if (!adapter || !adapter.reachable) {
        throw Object.assign(new Error('connect EHOSTUNREACH'), { code: 'EHOSTUNREACH' });
      }
      adapter.requests.push(`${method} ${target.pathname}`);
      if (!network.authorized(method, target.pathname, headers.authorization)) {
        return {
          status: 401,
          headers: {
            'www-authenticate': `Digest realm="devolo", nonce="${network.nonce}", qop="auth", algorithm=MD5`,
          },
          body: Buffer.alloc(0),
        };
      }
      const service = adapter.services.find(
        (record) =>
          target.pathname.startsWith(`/${pathOf(record)}/v0/`) &&
          record.port === Number(target.port),
      );
      if (!service) {
        return { status: 404, headers: {}, body: Buffer.alloc(0) };
      }
      const endpoint = target.pathname.split('/').at(-1);
      const answer = network.answer(adapter, method, endpoint, Buffer.from(body ?? []));
      return answer === null
        ? { status: 404, headers: {}, body: Buffer.alloc(0) }
        : { status: 200, headers: { 'content-type': 'application/octet-stream' }, body: answer };
    },

    /** Digest check, as the adapter does it. */
    authorized(method, path, header) {
      const match = String(header ?? '').match(/^Digest\s+(.*)$/s);
      if (!match) {
        return false;
      }
      const params = {};
      for (const [, key, quoted, bare] of match[1].matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g)) {
        params[key] = quoted ?? bare;
      }
      if (params.username !== 'devolo' || params.nonce !== network.nonce || params.uri !== path) {
        return false;
      }
      const secret = network.hashed ? sha256(network.password) : network.password;
      const ha1 = md5(`devolo:devolo:${secret}`);
      const ha2 = md5(`${method}:${path}`);
      const expected = md5(`${ha1}:${params.nonce}:${params.nc}:${params.cnonce}:auth:${ha2}`);
      return params.response === expected;
    },

    answer(adapter, method, endpoint, body) {
      switch (`${method} ${endpoint}`) {
        case 'GET LedSettingsGet':
          return encodeMessage(LedSettings, { state: adapter.leds ? 0 : 1 });
        case 'POST LedSettingsSet':
          adapter.leds = decode(LedSettings, body).state === 0;
          return encodeMessage(Result, { result: 0 });
        case 'GET WifiGuestAccessGet':
          return adapter.guest ? encodeMessage(WifiGuestAccessGet, adapter.guest) : null;
        case 'POST WifiGuestAccessSet': {
          const set = decode(WifiGuestAccessSet, body);
          adapter.guestSets.push(set);
          adapter.guest.enabled = set.enable;
          adapter.guest.remainingDuration = set.duration;
          return encodeMessage(Result, { result: 0 });
        }
        case 'GET WifiConnectedStationsGet':
          return adapter.stations
            ? encodeMessage(WifiConnectedStationsGet, { stations: adapter.stations })
            : null;
        case 'GET UpdateFirmwareCheck':
          return encodeMessage(UpdateFirmwareCheck, {
            result: adapter.firmwareUpdate.available ? 0 : 1,
            newFirmwareVersion: adapter.firmwareUpdate.version,
          });
        case 'GET UptimeGet':
          return encodeMessage(UptimeGetResponse, { uptime: adapter.uptime });
        case 'POST Restart':
          adapter.restarts += 1;
          return encodeMessage(RestartResponse, { result: 0, uptime: adapter.uptime });
        case 'GET GetNetworkOverview':
          return adapter.plcMac
            ? encodeMessage(GetNetworkOverview, network.overviewOf(adapter))
            : null;
        case 'POST IdentifyDeviceStart':
          if (decode(IdentifyDevice, body).macAddress !== adapter.plcMac) {
            return encodeMessage(Result, { result: 2 });
          }
          adapter.identified += 1;
          return encodeMessage(Result, { result: 0 });
        default:
          return null;
      }
    },

    /** The UDP seam: unicast DNS answers to a query sent to an adapter's port 5353. */
    async exchange(address, _port, packet) {
      const adapter = adapters.find((entry) => entry.address === address);
      if (!adapter || !adapter.reachable) {
        return [];
      }
      return [dnsAnswer(packet, adapter.services, address)];
    },

    /** One adapter over a real HTTP server on 127.0.0.1 (resolves its port). */
    serve(sn) {
      const adapter = network.adapter(sn);
      const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', async () => {
          const local = `http://${adapter.address}:${adapter.services[0].port}${req.url}`;
          const answer = await network.request({
            method: req.method,
            url: local,
            headers: req.headers,
            body: Buffer.concat(chunks),
          });
          res.writeHead(answer.status, answer.headers);
          res.end(answer.body);
        });
      });
      return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
      });
    },
  };
  return network;
}

const pathOf = (record) =>
  record.txt
    .find((entry) => /^path=/i.test(entry))
    .replace(/^path=/i, '')
    .replace(/^\/+/, '');

// --- DNS answers ---------------------------------------------------------------

function name(text) {
  return Buffer.concat([
    ...text.split('.').map((label) => {
      const bytes = Buffer.from(label);
      return Buffer.concat([Buffer.from([bytes.length]), bytes]);
    }),
    Buffer.from([0]),
  ]);
}

function record(owner, type, data) {
  const head = Buffer.alloc(10);
  head.writeUInt16BE(type, 0);
  head.writeUInt16BE(1, 2);
  head.writeUInt32BE(120, 4);
  head.writeUInt16BE(data.length, 8);
  return Buffer.concat([name(owner), head, data]);
}

/** An answer to a query: PTR answers, SRV/TXT/A additionals (no compression). */
export function dnsAnswer(query, services, address, { additionals = true } = {}) {
  const answers = [];
  const extra = [];
  for (const service of services) {
    const type = service.name.split('.').slice(-3, -1).join('.');
    answers.push(record(`${type}.local`, 12, name(service.name)));
    const srv = Buffer.alloc(6);
    srv.writeUInt16BE(service.port, 4);
    const txt = Buffer.concat(
      service.txt.map((entry) => {
        const bytes = Buffer.from(entry);
        return Buffer.concat([Buffer.from([bytes.length]), bytes]);
      }),
    );
    if (additionals) {
      extra.push(
        record(service.name, 33, Buffer.concat([srv, name(service.host)])),
        record(service.name, 16, txt),
      );
    }
  }
  if (additionals) {
    extra.push(record(services[0].host, 1, Buffer.from(address.split('.').map(Number))));
  }
  const header = Buffer.alloc(12);
  header.writeUInt16BE(query.readUInt16BE(0), 0);
  header.writeUInt16BE(0x8400, 2);
  header.writeUInt16BE(answers.length, 6);
  header.writeUInt16BE(extra.length, 10);
  return Buffer.concat([header, ...answers, ...extra]);
}
