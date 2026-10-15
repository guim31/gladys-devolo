// -----------------------------------------------------------------------------
// Client of ONE devolo adapter: its Device API (LEDs, Wi-Fi, firmware,
// restart) and its PLC network API (network overview, identify), protobuf
// over HTTP with Digest authentication.
//
// Where an API lives is announced by the adapter in mDNS (src/devolo/mdns.js):
// `http://<address>:<port>/<path>/<version>/<Endpoint>`, the path being
// specific to the adapter. Authentication: user "devolo" and the device
// password (empty by default); some firmwares expect the SHA-256 of the
// password instead, so a refused password is tried once hashed, as the devolo
// app and Home Assistant do. The way that works is remembered.
//
// Requests to one adapter run one at a time: these are small embedded
// devices, Home Assistant serializes its requests for the same reason.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { authorization, parseChallenge } from './digest.js';
import { DEFAULT_TIMEOUT_MS, httpRequest } from './http.js';
import { ProtobufError, decode, encode } from './protobuf.js';
import {
  GetNetworkOverview,
  IdentifyDevice,
  LED_OFF,
  LED_ON,
  LedSettings,
  RestartResponse,
  Result,
  SUCCESS,
  UPDATE_AVAILABLE,
  UpdateFirmwareCheck,
  UptimeGetResponse,
  WIFI_SUCCESS,
  WifiConnectedStationsGet,
  WifiGuestAccessGet,
  WifiGuestAccessSet,
} from './schema.js';

export const USER = 'devolo';
// The firmware check asks devolo's update server from the adapter.
export const LONG_TIMEOUT_MS = 30000;
// Features assumed by the devolo library when an adapter announces none.
export const DEFAULT_FEATURES = ['reset', 'update', 'led', 'intmtg'];

/**
 * A failed request. `kind`: `unreachable` (no answer), `auth` (password
 * refused), `unsupported` (the adapter lacks the API or the feature),
 * `refused` (the adapter answered with an error result), `protocol`
 * (unexpected answer).
 */
export class DevoloError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/** `00:00:5E:00:53:01`, `00005e005301`… → `00005E005301`, or null. */
export function normalizeMac(value) {
  const hex = String(value ?? '')
    .replace(/[^0-9a-f]/gi, '')
    .toUpperCase();
  return hex.length === 12 ? hex : null;
}

/** `00005E005301` → `00:00:5E:00:53:01`. */
export const formatMac = (mac) => normalizeMac(mac)?.match(/../g).join(':') ?? String(mac ?? '');

export class AdapterClient {
  /**
   * @param {object} options
   * @param {object} options.info see src/devolo/mdns.js `adaptersFromServices`
   * @param {string} [options.password]
   * @param {Function} [options.request] HTTP seam (tests)
   */
  constructor({ info, password = '', request = httpRequest }) {
    this.info = info;
    this.password = password;
    this.request = request;
    this.hashed = false;
    this.challenges = new Map();
    this.queue = Promise.resolve();
  }

  get features() {
    return this.info.deviceApi?.features ?? [];
  }

  /** True when the Device API announces the feature (`led`, `wifi1`, `update`, `restart`…). */
  has(feature) {
    return Boolean(this.info.deviceApi) && this.features.includes(feature);
  }

  get hasPlcnet() {
    return Boolean(this.info.plcnetApi);
  }

  // --- Transport ---------------------------------------------------------------

  /** Run requests one after the other on this adapter. */
  serialize(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  async call(apiName, method, endpoint, body, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const api = apiName === 'plcnet' ? this.info.plcnetApi : this.info.deviceApi;
    if (!api) {
      throw new DevoloError('unsupported', `No ${apiName} API on this adapter`);
    }
    const path = `/${String(api.path).replace(/^\/+|\/+$/g, '')}/${api.version}/${endpoint}`;
    const url = `http://${hostOf(this.info.address)}:${api.port}${path}`;
    return this.serialize(() =>
      this.authenticated(apiName, { method, url, path, body, timeoutMs }),
    );
  }

  async authenticated(apiName, { method, url, path, body, timeoutMs }) {
    const send = async () => {
      const headers = {};
      const cached = this.challenges.get(apiName);
      if (cached) {
        cached.nc += 1;
        headers.authorization = authorization({
          challenge: cached.challenge,
          username: USER,
          password: this.hashed ? sha256(this.password) : this.password,
          method,
          uri: path,
          nc: cached.nc,
        });
      }
      try {
        return await this.request({ method, url, headers, body, timeoutMs });
      } catch (err) {
        throw new DevoloError('unreachable', `${this.info.address}: ${err.code ?? err.message}`);
      }
    };
    const learn = (response) => {
      const challenge = parseChallenge(response.headers?.['www-authenticate']);
      if (!challenge) {
        throw new DevoloError('auth', `${this.info.address}: access refused`);
      }
      this.challenges.set(apiName, { challenge, nc: 0 });
    };

    let response = await send();
    if (response.status === 401) {
      // No challenge yet, or a stale nonce: answer the new one.
      learn(response);
      response = await send();
    }
    if (response.status === 401) {
      // The password as typed is refused: some firmwares expect its SHA-256.
      learn(response);
      this.hashed = !this.hashed;
      response = await send();
      if (response.status === 401) {
        this.hashed = !this.hashed;
        this.challenges.delete(apiName);
        throw new DevoloError('auth', `${this.info.address}: password refused`);
      }
    }
    if (response.status === 404) {
      throw new DevoloError('unsupported', `${this.info.address}: ${path} not found`);
    }
    if (response.status < 200 || response.status >= 300) {
      throw new DevoloError('protocol', `${this.info.address}: HTTP ${response.status}`);
    }
    return Buffer.from(response.body ?? []);
  }

  async read(apiName, method, endpoint, schema, { body, timeoutMs } = {}) {
    const raw = await this.call(apiName, method, endpoint, body, timeoutMs);
    try {
      return decode(schema, raw);
    } catch (err) {
      if (err instanceof ProtobufError) {
        throw new DevoloError('protocol', `${this.info.address}: ${endpoint}: ${err.message}`);
      }
      throw err;
    }
  }

  requireFeature(feature) {
    if (!this.has(feature)) {
      throw new DevoloError('unsupported', `The adapter does not announce "${feature}"`);
    }
  }

  checkResult(endpoint, result, success = SUCCESS) {
    if (result !== success) {
      throw new DevoloError('refused', `${endpoint} answered ${result}`);
    }
    return true;
  }

  // --- Device API --------------------------------------------------------------

  /** @returns {Promise<boolean>} true when the LEDs are on */
  async leds() {
    this.requireFeature('led');
    const { state } = await this.read('device', 'GET', 'LedSettingsGet', LedSettings);
    return state === LED_ON;
  }

  async setLeds(on) {
    this.requireFeature('led');
    const body = encode(LedSettings, { state: on ? LED_ON : LED_OFF });
    const { result } = await this.read('device', 'POST', 'LedSettingsSet', Result, { body });
    return this.checkResult('LedSettingsSet', result);
  }

  /** @returns {Promise<{ enabled: boolean, remainingDuration: number, ssid: string, key: string }>} */
  async guestWifi() {
    this.requireFeature('wifi1');
    return this.read('device', 'GET', 'WifiGuestAccessGet', WifiGuestAccessGet);
  }

  /** @param {number} [minutes] the adapter switches it off again after that (0: never) */
  async setGuestWifi(enable, minutes = 0) {
    this.requireFeature('wifi1');
    const body = encode(WifiGuestAccessSet, { enable, duration: enable ? minutes : 0 });
    const { result } = await this.read('device', 'POST', 'WifiGuestAccessSet', Result, { body });
    return this.checkResult('WifiGuestAccessSet', result, WIFI_SUCCESS);
  }

  /** The Wi-Fi stations connected to the adapter, MAC addresses normalized. */
  async stations() {
    this.requireFeature('wifi1');
    const { stations } = await this.read(
      'device',
      'GET',
      'WifiConnectedStationsGet',
      WifiConnectedStationsGet,
    );
    return stations
      .map((station) => ({ ...station, mac: normalizeMac(station.macAddress) }))
      .filter((station) => station.mac);
  }

  /** @returns {Promise<{ available: boolean, version: string|null }>} */
  async checkFirmware() {
    this.requireFeature('update');
    const check = await this.read('device', 'GET', 'UpdateFirmwareCheck', UpdateFirmwareCheck, {
      timeoutMs: LONG_TIMEOUT_MS,
    });
    if (check.result !== UPDATE_AVAILABLE) {
      return { available: false, version: null };
    }
    // `5.6.2_2023-01-15`: the version, then the build date.
    return { available: true, version: check.newFirmwareVersion.split('_')[0] || null };
  }

  /** Seconds since the adapter started (a counter without a documented unit). */
  async uptime() {
    this.requireFeature('restart');
    const { uptime } = await this.read('device', 'GET', 'UptimeGet', UptimeGetResponse);
    return uptime;
  }

  async restart() {
    this.requireFeature('restart');
    const { result } = await this.read('device', 'POST', 'Restart', RestartResponse, {
      body: Buffer.alloc(0),
    });
    return this.checkResult('Restart', result);
  }

  // --- PLC network API ---------------------------------------------------------

  /** The PLC network seen from this adapter: devices and data rates (Mbit/s). */
  async networkOverview() {
    const { network } = await this.read('plcnet', 'GET', 'GetNetworkOverview', GetNetworkOverview);
    return network ?? { devices: [], dataRates: [] };
  }

  /** Make the PLC LED of this adapter blink. */
  async identify() {
    if (!this.hasPlcnet) {
      throw new DevoloError('unsupported', 'No PLC network API on this adapter');
    }
    const body = encode(IdentifyDevice, { macAddress: this.info.plcMacRaw ?? this.info.plcMac });
    const { result } = await this.read('plcnet', 'POST', 'IdentifyDeviceStart', Result, { body });
    return this.checkResult('IdentifyDeviceStart', result);
  }
}

/** An IPv6 address goes between brackets in a URL. */
function hostOf(address) {
  return String(address).includes(':') ? `[${address}]` : address;
}
