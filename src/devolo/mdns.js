// -----------------------------------------------------------------------------
// Finding the adapters and where their APIs live.
//
// A devolo adapter announces two DNS-SD services: `_dvl-deviceapi._tcp` (the
// Device API: serial number, product, firmware, features) and
// `_dvl-plcnetapi._tcp` (the PLC network API, absent on the Wi-Fi-only
// repeaters). Their TXT records give the port, the path and the version of
// each API, which change from one adapter to another: nothing works without
// them.
//
// Two ways to read them:
// - the core's mediated mDNS scan (manifest `network_discovery`): the
//   container sits on a bridge network and never sees multicast, the core
//   browses the LAN and relays the raw records;
// - for an address typed by hand (another subnet, a core without the
//   capture), a unicast DNS query sent straight to the adapter's port 5353,
//   which crosses the NAT like any unicast packet ("legacy unicast",
//   RFC 6762 §6.7) — what the devolo Python library does too.
// -----------------------------------------------------------------------------

import dgram from 'node:dgram';
import { isIPv4, isIPv6 } from 'node:net';
import { parseMdnsTxt } from '@gladysassistant/integration-sdk';
import { DEFAULT_FEATURES, normalizeMac } from './client.js';

export const DEVICE_SERVICE = '_dvl-deviceapi._tcp';
export const PLCNET_SERVICE = '_dvl-plcnetapi._tcp';
export const SERVICES = [DEVICE_SERVICE, PLCNET_SERVICE];
export const MDNS_PORT = 5353;
export const SCAN_TIMEOUT_SECONDS = 5;
export const UNICAST_TIMEOUT_MS = 2000;

// devolo Home Control gateways announce the Device API too, but are not
// network adapters (Home Assistant skips them as well).
export const HOME_CONTROL_MT = ['2600', '2601'];

const TYPE = { A: 1, PTR: 12, TXT: 16, AAAA: 28, SRV: 33, ANY: 255 };
const CLASS_IN = 1;
const UNICAST_RESPONSE = 0x8000;

const serviceOf = (name) =>
  SERVICES.find((service) => String(name ?? '').endsWith(`.${service}.local`));

const firstAddress = (addresses) =>
  (addresses ?? []).find((address) => isIPv4(address)) ??
  (addresses ?? []).find((address) => isIPv6(address)) ??
  null;

/** The API location of a service record, or null when its TXT lacks it. */
function apiOf(record, txt) {
  const path = txt.path;
  const version = txt.version;
  const port = Number(record.port);
  if (typeof path !== 'string' || !path || typeof version !== 'string' || !version) {
    return null;
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return null;
  }
  return { port, path, version };
}

/**
 * The adapters among raw mDNS service records (the core's scan format:
 * `[{ name, host, addresses, port, txt }]`), one per address.
 * @returns {Array<object>} adapter infos: `{ id, sn, mt, product, firmware,
 *   hostname, address, plcMac, plcMacRaw, technology, deviceApi, plcnetApi }`
 */
export function adaptersFromServices(results) {
  const byAddress = new Map();
  for (const record of Array.isArray(results) ? results : []) {
    const service = serviceOf(record?.name);
    const address = firstAddress(record?.addresses);
    if (!service || !address) {
      continue;
    }
    const txt = parseMdnsTxt(Array.isArray(record.txt) ? record.txt : []);
    const entry = byAddress.get(address) ?? { address, hostname: null };
    entry.hostname ??= typeof record.host === 'string' ? record.host.replace(/\.$/, '') : null;
    entry[service] = { record, txt };
    byAddress.set(address, entry);
  }

  const adapters = [];
  for (const entry of byAddress.values()) {
    const device = entry[DEVICE_SERVICE];
    const plcnet = entry[PLCNET_SERVICE];
    const deviceTxt = device?.txt ?? {};
    const plcnetTxt = plcnet?.txt ?? {};
    if (HOME_CONTROL_MT.includes(deviceTxt.mt)) {
      continue;
    }
    const deviceApi = device ? apiOf(device.record, deviceTxt) : null;
    const plcnetApi = plcnet ? apiOf(plcnet.record, plcnetTxt) : null;
    if (deviceApi) {
      const features = typeof deviceTxt.features === 'string' ? deviceTxt.features : '';
      deviceApi.features = features
        ? features
            .split(',')
            .map((feature) => feature.trim())
            .filter(Boolean)
        : [...DEFAULT_FEATURES];
    }
    const plcMacRaw = plcnetTxt.plcmacaddress || deviceTxt.plcmacaddress || null;
    const plcMac = normalizeMac(plcMacRaw);
    const sn = typeof deviceTxt.sn === 'string' && deviceTxt.sn.trim() ? deviceTxt.sn.trim() : null;
    // The serial number identifies an adapter; one without the Device API
    // (none known so far) falls back to its PLC MAC address.
    const id = sn ?? plcMac;
    if (!id || (!deviceApi && !plcnetApi)) {
      continue;
    }
    adapters.push({
      id: String(id).replace(/[^0-9A-Za-z_-]/g, ''),
      sn,
      mt: deviceTxt.mt ?? null,
      product: deviceTxt.product || null,
      firmware: deviceTxt.firmwareversion || null,
      hostname: entry.hostname,
      address: entry.address,
      plcMac,
      plcMacRaw,
      technology: plcnetTxt.plctechnology || null,
      deviceApi,
      plcnetApi,
    });
  }
  return adapters;
}

// --- DNS messages (RFC 1035), for the unicast query --------------------------

function encodeName(name) {
  const parts = String(name)
    .replace(/\.$/, '')
    .split('.')
    .map((label) => {
      const bytes = Buffer.from(label, 'utf8');
      return Buffer.concat([Buffer.from([bytes.length]), bytes]);
    });
  return Buffer.concat([...parts, Buffer.from([0])]);
}

/** A DNS query asking for a unicast answer. */
export function encodeQuery(questions, id = 0) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(questions.length, 4);
  const body = questions.map(({ name, type }) => {
    const tail = Buffer.alloc(4);
    tail.writeUInt16BE(type, 0);
    tail.writeUInt16BE(CLASS_IN | UNICAST_RESPONSE, 2);
    return Buffer.concat([encodeName(name), tail]);
  });
  return Buffer.concat([header, ...body]);
}

function readName(buffer, offset, depth = 0) {
  const labels = [];
  let position = offset;
  let next = null;
  for (;;) {
    if (position >= buffer.length || depth > 20) {
      throw new Error('Malformed DNS name');
    }
    const length = buffer[position];
    if (length === 0) {
      position += 1;
      break;
    }
    if ((length & 0xc0) === 0xc0) {
      if (position + 1 >= buffer.length) {
        throw new Error('Malformed DNS name');
      }
      const pointer = buffer.readUInt16BE(position) & 0x3fff;
      next ??= position + 2;
      const { name } = readName(buffer, pointer, depth + 1);
      if (name) {
        labels.push(name);
      }
      return { name: labels.join('.'), next };
    }
    labels.push(buffer.toString('utf8', position + 1, position + 1 + length));
    position += 1 + length;
  }
  return { name: labels.join('.'), next: next ?? position };
}

/** The records of a DNS response (answers, authority and additional sections). */
export function decodeResponse(buffer) {
  if (buffer.length < 12) {
    throw new Error('Short DNS message');
  }
  const flags = buffer.readUInt16BE(2);
  if ((flags & 0x8000) === 0) {
    return []; // a query, not a response
  }
  const counts = [4, 6, 8, 10].map((at) => buffer.readUInt16BE(at));
  let offset = 12;
  for (let i = 0; i < counts[0]; i += 1) {
    offset = readName(buffer, offset).next + 4;
  }
  const records = [];
  const total = counts[1] + counts[2] + counts[3];
  for (let i = 0; i < total; i += 1) {
    const { name, next } = readName(buffer, offset);
    if (next + 10 > buffer.length) {
      throw new Error('Truncated DNS record');
    }
    const type = buffer.readUInt16BE(next);
    const length = buffer.readUInt16BE(next + 8);
    const start = next + 10;
    const end = start + length;
    if (end > buffer.length) {
      throw new Error('Truncated DNS record');
    }
    const data = buffer.subarray(start, end);
    if (type === TYPE.PTR) {
      records.push({ name, type: 'PTR', data: readName(buffer, start).name });
    } else if (type === TYPE.SRV && length >= 7) {
      records.push({
        name,
        type: 'SRV',
        data: { port: data.readUInt16BE(4), target: readName(buffer, start + 6).name },
      });
    } else if (type === TYPE.TXT) {
      const entries = [];
      let at = 0;
      while (at < data.length) {
        const size = data[at];
        entries.push(data.toString('utf8', at + 1, at + 1 + size));
        at += 1 + size;
      }
      records.push({ name, type: 'TXT', data: entries.filter((entry) => entry !== '') });
    } else if (type === TYPE.A && length === 4) {
      records.push({ name, type: 'A', data: [...data].join('.') });
    } else if (type === TYPE.AAAA && length === 16) {
      const groups = [];
      for (let at = 0; at < 16; at += 2) {
        groups.push(data.readUInt16BE(at).toString(16));
      }
      records.push({ name, type: 'AAAA', data: groups.join(':') });
    }
    offset = end;
  }
  return records;
}

/** Records → the core's scan format, the address being the one queried. */
export function servicesFromRecords(records, address) {
  const instances = new Map();
  const instance = (name) => {
    if (!instances.has(name)) {
      instances.set(name, { name, host: null, addresses: [address], port: null, txt: [] });
    }
    return instances.get(name);
  };
  for (const record of records) {
    if (record.type === 'PTR' && SERVICES.some((s) => record.name === `${s}.local`)) {
      instance(record.data);
    } else if (record.type === 'SRV' && serviceOf(record.name)) {
      Object.assign(instance(record.name), { host: record.data.target, port: record.data.port });
    } else if (record.type === 'TXT' && serviceOf(record.name)) {
      instance(record.name).txt = record.data;
    }
  }
  return [...instances.values()];
}

/**
 * Send one datagram to `address:port` and collect the answers coming back
 * from that address for `timeoutMs`.
 * @returns {Promise<Buffer[]>}
 */
export function udpExchange(address, port, packet, timeoutMs = UNICAST_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket(isIPv6(address) ? 'udp6' : 'udp4');
    const answers = [];
    const finish = () => {
      clearTimeout(timer);
      socket.close(() => resolve(answers));
    };
    const timer = setTimeout(finish, timeoutMs);
    socket.on('message', (message, remote) => {
      if (remote.address === address || remote.address === `::ffff:${address}`) {
        answers.push(message);
      }
    });
    socket.on('error', () => finish());
    socket.send(packet, port, address, (err) => {
      if (err) {
        finish();
      }
    });
  });
}

/**
 * Ask one address for its devolo services, in unicast. Resolves the services
 * in the core's scan format ([] when nothing answers).
 * @param {string} address
 * @param {object} [options]
 * @param {Function} [options.exchange] UDP seam (tests)
 * @param {number} [options.port]
 */
export async function queryAddress(address, { exchange = udpExchange, port = MDNS_PORT } = {}) {
  const ask = async (questions) => {
    const packets = await exchange(address, port, encodeQuery(questions));
    return packets.flatMap((packet) => {
      try {
        return decodeResponse(packet);
      } catch {
        return [];
      }
    });
  };
  let records = await ask(
    SERVICES.map((service) => ({ name: `${service}.local`, type: TYPE.PTR })),
  );
  let services = servicesFromRecords(records, address);
  // The answer to a PTR question usually carries SRV and TXT in its
  // additional section; ask for them when it does not.
  const incomplete = services.filter((service) => !service.port || service.txt.length === 0);
  if (incomplete.length > 0) {
    records = records.concat(
      await ask(incomplete.map((service) => ({ name: service.name, type: TYPE.ANY }))),
    );
    services = servicesFromRecords(records, address);
  }
  return services.filter((service) => service.port);
}
