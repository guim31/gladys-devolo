// -----------------------------------------------------------------------------
// The hub: the adapters found on the network, the read cycle, the states
// published to Gladys, the scene event and the commands. Everything the SDK
// handlers, the scene actions and the widget need goes through it (src/app.js
// wires it).
//
// Scheduling: the devices are published with should_poll: false and the hub
// reads the adapters at the configured interval (GladysAssistant/Gladys#3198:
// the core does not poll external devices reliably). Each cycle reads, per
// adapter, what moves: LEDs, guest Wi-Fi, connected Wi-Fi devices. The PLC
// network overview (rates) is read every 5 minutes and the firmware check
// (the adapter asks devolo's update server) every 6 hours, as Home Assistant
// does. States: `publishChangedStates` sends only what changed, plus a
// heartbeat every 12 hours so that a stable value never shows "no recent
// value" (the front's default is 48 hours).
//
// Requests: one at a time per adapter, and the adapters one after the other
// (src/devolo/client.js).
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { AdapterClient, formatMac, normalizeMac } from './devolo/client.js';
import { SCAN_TIMEOUT_SECONDS, adaptersFromServices, queryAddress } from './devolo/mdns.js';
import {
  TOPOLOGY_LOCAL,
  WIFI_BAND_2G,
  WIFI_BAND_5G,
  WIFI_VAP_GUEST_AP,
  WIFI_VAP_MAIN_AP,
} from './devolo/schema.js';
import {
  FEATURES,
  adapterIdOf,
  adapterIds,
  adapterName,
  buildAdapterDevice,
  buildStationDevice,
  peerName,
  rateOf,
  stationIds,
  stationMacOf,
} from './devices.js';
import { ERRORS, GladysError, REPORTS, STATUS, join, render } from './messages.js';
import { ProblemLog } from './problems.js';

const logger = createLogger({ name: 'devolo' });

export const WIDGET_KEY = 'plc_network';
export const TRIGGERS = { NEW_WIFI_DEVICE: 'new_wifi_device' };

export const DEFAULT_TIMINGS = {
  heartbeatMs: 12 * 60 * 60 * 1000,
  overviewMs: 5 * 60 * 1000,
  firmwareMs: 6 * 60 * 60 * 1000,
  // A new network search: firmware versions are announced in mDNS only.
  rediscoverMs: 6 * 60 * 60 * 1000,
  // An adapter silent for a while may have a new address (DHCP).
  lostRediscoverMs: 10 * 60 * 1000,
  // requestWidgetRefresh is rate-limited to one call every 10 s by the core.
  widgetRefreshMs: 10000,
};
// Failed cycles in a row before an adapter is shown offline: one lost
// answer is not an outage.
export const OFFLINE_AFTER_FAILURES = 2;
export const LOST_REDISCOVER_FAILURES = 3;
// Wi-Fi devices proposed in the Discover tab: the created ones and the
// connected ones, at most.
export const MAX_DISCOVERED_STATIONS = 100;
export const MAX_KNOWN_STATIONS = 1000;
export const MAX_GUEST_MINUTES = 1440;

const NETWORKS = { [WIFI_VAP_MAIN_AP]: 'main', [WIFI_VAP_GUEST_AP]: 'guest' };
const BANDS = { [WIFI_BAND_2G]: '2.4 GHz', [WIFI_BAND_5G]: '5 GHz' };

export class Hub {
  /**
   * @param {object} options
   * @param {object} options.gladys GladysIntegration (or the SDK fake)
   * @param {object} options.store see src/store.js
   * @param {Function} [options.request] HTTP seam of the adapter clients (tests)
   * @param {Function} [options.exchange] UDP seam of the unicast mDNS query (tests)
   * @param {boolean} [options.timers] false: no background timer (tests drive the cycles)
   * @param {Function} [options.now] clock in ms
   * @param {object} [options.timings] overrides of DEFAULT_TIMINGS
   */
  constructor({ gladys, store, request, exchange, timers = true, now, timings }) {
    this.gladys = gladys;
    this.store = store;
    this.request = request;
    this.exchange = exchange;
    this.timers = timers;
    this.now = now ?? (() => Date.now());
    this.timings = { ...DEFAULT_TIMINGS, ...timings };
    this.config = null;
    this.saved = {};
    /** @type {Map<string, object>} adapter id → entry (see addAdapter) */
    this.adapters = new Map();
    this.known = new Set();
    this.seeded = new Set();
    this.presence = new Map();
    this.problems = new ProblemLog(logger);
    this.lastStatusSent = null;
    this.lastDiscoverAt = -Infinity;
    this.overviewAt = -Infinity;
    this.startedAt = this.now();
    this.cycleTimer = null;
    this.refreshTimer = null;
    this.lastRefreshAt = -Infinity;
    this.running = null;
    this.stopped = false;
    this.started = false;
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(config) {
    this.config = config;
    this.saved = await this.store.load();
    this.known = new Set(Array.isArray(this.saved.knownStations) ? this.saved.knownStations : []);
    this.seeded = new Set(Array.isArray(this.saved.seeded) ? this.saved.seeded : []);
    for (const info of Object.values(this.saved.adapters ?? {})) {
      if (info?.id && info.address) {
        this.addAdapter(info);
      }
    }
    await this.discover();
    // The firmware check can take 30 s per adapter: not before the devices
    // are proposed, the next cycle does it.
    await this.runCycle({ firmware: false });
    await this.publishDiscovered();
    this.started = true;
    this.schedule();
  }

  /** Reconnection to Gladys (it may have restarted): publish everything again. */
  async resync(config) {
    this.config = config;
    this.lastStatusSent = null;
    await this.publishDiscovered();
    await this.sendStatus();
    this.gladys.forgetPublishedStates?.();
    await this.publishStates();
    this.requestRefresh();
  }

  async reconfigure(config) {
    const previous = this.config;
    this.config = config;
    if (previous?.password !== config.password) {
      for (const entry of this.adapters.values()) {
        entry.client = this.clientFor(entry.info);
        entry.problem = null;
      }
    }
    if (JSON.stringify(previous?.addresses) !== JSON.stringify(config.addresses)) {
      await this.discover();
    }
    this.lastStatusSent = null;
    this.schedule();
    await this.runCycle({ overview: true });
    // The language of the feature names and the restart button apply to the
    // devices created from now on (or updated from the Discover tab).
    await this.publishDiscovered();
    this.requestRefresh();
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.cycleTimer);
    clearTimeout(this.refreshTimer);
    this.cycleTimer = null;
    await this.running?.catch(() => {});
    await this.store.flush();
  }

  schedule() {
    if (!this.timers || this.stopped) {
      return;
    }
    clearInterval(this.cycleTimer);
    this.cycleTimer = setInterval(() => this.runCycle(), this.config.pollInterval * 1000);
    this.cycleTimer.unref?.();
  }

  save() {
    const adapters = {};
    for (const [id, entry] of this.adapters) {
      adapters[id] = { ...entry.info, peers: entry.peers };
    }
    this.saved = {
      version: 1,
      adapters,
      knownStations: [...this.known].slice(-MAX_KNOWN_STATIONS),
      seeded: [...this.seeded],
    };
    return this.store.save(this.saved);
  }

  // --- Adapters ----------------------------------------------------------------

  clientFor(info) {
    return new AdapterClient({ info, password: this.config.password, request: this.request });
  }

  addAdapter(info) {
    const { peers = [], ...rest } = info;
    const entry = {
      info: rest,
      client: this.clientFor(rest),
      peers: Array.isArray(peers) ? peers : [],
      online: null,
      failures: 0,
      problem: null,
      announced: false,
      self: null,
      leds: null,
      guest: null,
      stations: null,
      stationsAt: -Infinity,
      overview: null,
      firmwareUpdate: null,
      firmwareAt: -Infinity,
    };
    this.adapters.set(rest.id, entry);
    return entry;
  }

  /** A found adapter: new, or a known one whose address or APIs changed. */
  upsertAdapter(info) {
    const entry = this.adapters.get(info.id);
    if (!entry) {
      this.addAdapter(info);
      return false;
    }
    const where = (i) => JSON.stringify([i.address, i.deviceApi, i.plcnetApi, i.plcMacRaw]);
    if (where(entry.info) !== where(info)) {
      const hashed = entry.client.hashed;
      entry.info = info;
      entry.client = this.clientFor(info);
      entry.client.hashed = hashed;
      logger.debug(`${this.nameOf(entry)} found at ${info.address}`);
      return true;
    }
    entry.info = { ...entry.info, firmware: info.firmware ?? entry.info.firmware };
    return false;
  }

  nameOf(entry) {
    return adapterName(entry);
  }

  /**
   * Search the adapters: the core's mDNS scan, then a unicast query to each
   * address of the configuration the scan did not find.
   */
  async discover() {
    this.lastDiscoverAt = this.now();
    let services = [];
    try {
      services = await this.gladys.scanNetwork('mdns', { timeoutSeconds: SCAN_TIMEOUT_SECONDS });
      this.problems.recover('search', 'The network search works again');
    } catch (err) {
      this.problems.fail('search', `Network search unavailable: ${err.message}`);
    }
    const found = adaptersFromServices(services);
    for (const address of this.config.addresses) {
      if (found.some((info) => info.address === address)) {
        continue;
      }
      try {
        const answer = adaptersFromServices(
          await queryAddress(address, { exchange: this.exchange }),
        );
        if (answer.length === 0) {
          this.problems.fail(`query:${address}`, `No devolo adapter answers at ${address}`);
        } else {
          this.problems.recover(`query:${address}`, `A devolo adapter answers at ${address}`);
        }
        found.push(...answer);
      } catch (err) {
        this.problems.fail(`query:${address}`, `Querying ${address} failed: ${err.message}`);
      }
    }
    // A known adapter at a new address (DHCP): its device follows (params).
    const moved = found.map((info) => this.upsertAdapter(info)).some(Boolean);
    logger.debug(`Network search: ${found.length} adapter(s) found, ${this.adapters.size} known`);
    await this.save();
    if (moved && this.started) {
      await this.publishDiscovered();
    }
    return found;
  }

  // --- The PLC network -----------------------------------------------------------

  /** The PLC network merged from the overviews of every adapter. */
  network() {
    const devices = new Map();
    const rates = new Map();
    for (const entry of this.adapters.values()) {
      for (const device of entry.overview?.devices ?? []) {
        const mac = normalizeMac(device.macAddress);
        // An adapter describes itself best (topology LOCAL).
        if (mac && (!devices.has(mac) || device.topology === TOPOLOGY_LOCAL)) {
          devices.set(mac, device);
        }
      }
      for (const rate of entry.overview?.dataRates ?? []) {
        const from = normalizeMac(rate.macAddressFrom);
        const to = normalizeMac(rate.macAddressTo);
        if (from && to) {
          rates.set(`${from}>${to}`, rate);
        }
      }
    }
    return { devices, rates };
  }

  /** `{ tx, rx }` in Mbit/s from an adapter to another PLC adapter, or null. */
  rateBetween(entry, peerMac, network = this.network()) {
    const own = entry.info.plcMac;
    if (!own) {
      return null;
    }
    const direct = network.rates.get(`${own}>${peerMac}`);
    if (direct) {
      return { tx: direct.txRate, rx: direct.rxRate };
    }
    // Seen from the other side: what it sends is what this one receives.
    const reverse = network.rates.get(`${peerMac}>${own}`);
    return reverse ? { tx: reverse.rxRate, rx: reverse.txRate } : null;
  }

  /** The MAC of the adapter plugged into the router, or null. */
  routerMac(network = this.network()) {
    for (const [mac, device] of network.devices) {
      if (device.attachedToRouter) {
        return mac;
      }
    }
    return null;
  }

  /**
   * The PLC peers of every adapter: the others in the network, plus the ones
   * known before (an adapter unplugged for a while keeps its features).
   * @returns {boolean} true when a peer appeared
   */
  updatePeers() {
    const network = this.network();
    let changed = false;
    for (const entry of this.adapters.values()) {
      const own = entry.info.plcMac;
      entry.self = own ? (network.devices.get(own) ?? entry.self) : null;
      if (!own || !entry.info.plcnetApi) {
        continue;
      }
      const peers = new Map(entry.peers.map((peer) => [normalizeMac(peer.macAddress), peer]));
      for (const [mac, device] of network.devices) {
        if (mac === own) {
          continue;
        }
        const peer = {
          macAddress: formatMac(mac),
          userDeviceName: device.userDeviceName || '',
          productName: device.productName || '',
        };
        if (!peers.has(mac)) {
          changed = true;
        }
        peers.set(mac, peers.has(mac) && !peerName(peer) ? peers.get(mac) : peer);
      }
      entry.peers = [...peers.values()];
    }
    return changed;
  }

  firmwareOf(entry) {
    return entry.info.firmware || entry.self?.friendlyVersion || null;
  }

  // --- Discovery ---------------------------------------------------------------

  createdDevices() {
    return this.gladys.devices ?? [];
  }

  isCreated(externalId) {
    return this.createdDevices().some((device) => device.external_id === externalId);
  }

  /** MAC addresses of the Wi-Fi devices created in Gladys. */
  createdStations() {
    return this.createdDevices()
      .map((device) => stationMacOf(this.gladys, device.external_id))
      .filter(Boolean);
  }

  /** The Wi-Fi devices connected now, over every adapter: mac → { station, entry }. */
  connectedStations() {
    const stations = new Map();
    for (const entry of this.adapters.values()) {
      for (const station of entry.stations ?? []) {
        if (!stations.has(station.mac)) {
          stations.set(station.mac, { station, entry });
        }
      }
    }
    return stations;
  }

  discoveredDevices() {
    const { language, allowRestart } = this.config;
    const devices = [...this.adapters.values()].map((entry) =>
      buildAdapterDevice(this.gladys, entry, { language, allowRestart }),
    );
    const created = this.createdStations();
    const connected = [...this.connectedStations().keys()]
      .filter((mac) => !created.includes(mac))
      .sort();
    devices.push(
      ...[...created, ...connected]
        .slice(0, MAX_DISCOVERED_STATIONS)
        .map((mac) => buildStationDevice(this.gladys, mac, language)),
    );
    return devices;
  }

  async publishDiscovered() {
    await this.gladys.publishDiscoveredDevices(this.discoveredDevices());
  }

  async scan() {
    await this.discover();
    await this.runCycle({ overview: true });
    await this.publishDiscovered();
  }

  // --- The read cycle ------------------------------------------------------------

  /**
   * One read cycle, coalesced: a cycle already running is awaited instead.
   * @param {object} [options] `overview` / `firmware`: force (true) or skip (false)
   */
  runCycle(options = {}) {
    if (this.running || this.stopped) {
      return this.running;
    }
    this.running = this.cycle(options)
      .then(() => this.problems.recover('cycle'))
      .catch((err) => {
        if (this.problems.fail('cycle', `Read cycle failed: ${err.message}`, 'error')) {
          logger.debug('Read cycle failed', err);
        }
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  async cycle({ overview, firmware } = {}) {
    if (!this.config) {
      return;
    }
    const now = this.now();
    if (this.adapters.size === 0 || now - this.lastDiscoverAt >= this.timings.rediscoverMs) {
      await this.discover();
    }
    const overviewDue = overview ?? now - this.overviewAt >= this.timings.overviewMs;
    for (const entry of this.adapters.values()) {
      const firmwareDue = firmware ?? now - entry.firmwareAt >= this.timings.firmwareMs;
      await this.readAdapter(entry, { now, overview: overviewDue, firmware: firmwareDue });
    }
    if (overviewDue) {
      this.overviewAt = now;
    }
    if (this.updatePeers()) {
      await this.save();
      await this.publishDiscovered();
    }
    this.updatePresence(now);
    await this.sendStatus();
    await this.publishStates();
    const lost = [...this.adapters.values()].some(
      (entry) => entry.failures >= LOST_REDISCOVER_FAILURES,
    );
    if (lost && this.now() - this.lastDiscoverAt >= this.timings.lostRediscoverMs) {
      await this.discover();
    }
  }

  /** Read one adapter; a silent adapter or a refused password ends its read. */
  async readAdapter(entry, { now, overview, firmware }) {
    const { client } = entry;
    const name = this.nameOf(entry);
    const before = this.widgetSummary(entry);
    // A part the adapter does not support or refuses leaves the others alone.
    const part = async (key, fn) => {
      try {
        await fn();
        this.problems.recover(`part:${entry.info.id}:${key}`);
      } catch (err) {
        if (err.kind === 'unreachable' || err.kind === 'auth') {
          throw err;
        }
        this.problems.fail(`part:${entry.info.id}:${key}`, `${name}: ${key}: ${err.message}`);
      }
    };
    try {
      let read = false;
      if (client.has('led')) {
        await part('leds', async () => {
          entry.leds = await client.leds();
        });
        read = true;
      }
      if (client.has('wifi1')) {
        await part('stations', async () => {
          entry.stations = await client.stations();
          entry.stationsAt = now;
          this.learnStations(entry);
        });
        await part('guest wifi', async () => {
          entry.guest = await client.guestWifi();
        });
        read = true;
      }
      if (client.hasPlcnet && (overview || !read || !entry.overview)) {
        await part('network overview', async () => {
          entry.overview = await client.networkOverview();
        });
        read = true;
      }
      if (!read && client.has('restart')) {
        await client.uptime();
      }
      if (firmware && client.has('update')) {
        entry.firmwareAt = now;
        await part('firmware check', async () => {
          const previous = entry.firmwareUpdate;
          entry.firmwareUpdate = await client.checkFirmware();
          if (previous?.available && !entry.firmwareUpdate.available) {
            // Updated: the new version is announced in mDNS.
            this.lastDiscoverAt = -Infinity;
          }
        });
      }
      this.adapterAnswered(entry);
    } catch (err) {
      this.adapterFailed(entry, err);
    }
    if (JSON.stringify(before) !== JSON.stringify(this.widgetSummary(entry))) {
      this.requestRefresh();
    }
  }

  adapterAnswered(entry) {
    entry.failures = 0;
    entry.problem = null;
    const wasOffline = entry.online === false;
    entry.online = true;
    const back = this.problems.recover(`adapter:${entry.info.id}`);
    const line = `${back || wasOffline ? 'Back' : 'Connected'}: ${this.nameOf(entry)}, firmware ${this.firmwareOf(entry) ?? '?'}, at ${entry.info.address}`;
    if (back || !entry.announced) {
      logger.info(line);
    } else {
      logger.debug(line);
    }
    entry.announced = true;
  }

  adapterFailed(entry, err) {
    entry.failures += 1;
    entry.problem = err.kind === 'auth' ? 'auth' : 'unreachable';
    if (entry.failures >= OFFLINE_AFTER_FAILURES || entry.problem === 'auth') {
      entry.online = false;
    }
    if (entry.problem === 'auth') {
      this.problems.fail(`adapter:${entry.info.id}`, `${this.nameOf(entry)} refused the password`);
    } else if (entry.online === false) {
      this.problems.fail(
        `adapter:${entry.info.id}`,
        `${this.nameOf(entry)} does not answer (${err.message})`,
      );
    } else {
      logger.debug(`${this.nameOf(entry)}: no answer (${err.message}), retried next cycle`);
    }
  }

  /** New Wi-Fi devices fire the scene event; the first read of an adapter learns silently. */
  learnStations(entry) {
    const silent = !this.seeded.has(entry.info.id);
    let changed = silent;
    for (const station of entry.stations ?? []) {
      if (this.known.has(station.mac)) {
        continue;
      }
      this.known.add(station.mac);
      changed = true;
      if (!silent) {
        this.fire(TRIGGERS.NEW_WIFI_DEVICE, {
          network: NETWORKS[station.vapType] ?? 'other',
          mac: formatMac(station.mac),
          adapter: this.nameOf(entry),
          band: BANDS[station.band] ?? '',
        });
      }
    }
    if (changed) {
      this.seeded.add(entry.info.id);
      // The set grows by insertion order: keep the latest ones.
      if (this.known.size > MAX_KNOWN_STATIONS) {
        this.known = new Set([...this.known].slice(-MAX_KNOWN_STATIONS));
      }
      this.save();
    }
  }

  /** Presence of the created Wi-Fi devices, with the delay before "away". */
  updatePresence(now = this.now()) {
    const fresh = [...this.adapters.values()].filter((entry) => entry.stationsAt === now);
    if (fresh.length === 0) {
      // No Wi-Fi adapter answered: nothing is known, nothing changes.
      return;
    }
    const seen = new Set(fresh.flatMap((entry) => entry.stations.map((station) => station.mac)));
    const delay = this.config.offlineAfter * 1000;
    for (const mac of this.createdStations()) {
      const presence = this.presence.get(mac) ?? { online: null, lastSeen: null };
      const before = presence.online;
      if (seen.has(mac)) {
        presence.online = true;
        presence.lastSeen = now;
      } else if (now - (presence.lastSeen ?? this.startedAt) >= delay) {
        presence.online = false;
      }
      this.presence.set(mac, presence);
      if (before !== presence.online) {
        this.requestRefresh();
      }
    }
  }

  /** The states of every created device, published when they changed. */
  async publishStates() {
    const created = new Set();
    for (const device of this.createdDevices()) {
      for (const feature of device.features ?? []) {
        created.add(feature.external_id);
      }
    }
    const states = [];
    const add = (externalId, value) => {
      if (value === null || value === undefined || !created.has(externalId)) {
        return;
      }
      states.push(
        typeof value === 'string'
          ? { device_feature_external_id: externalId, text: value }
          : { device_feature_external_id: externalId, state: value },
      );
    };
    const bit = (value) => (value === null || value === undefined ? null : value ? 1 : 0);
    const network = this.network();
    for (const entry of this.adapters.values()) {
      const ids = adapterIds(this.gladys, entry.info.id);
      add(ids.feature(FEATURES.ONLINE), bit(entry.online));
      for (const peer of entry.peers) {
        const mac = normalizeMac(peer.macAddress);
        const rate = this.rateBetween(entry, mac, network);
        if (rate) {
          add(ids.tx(mac), Math.round(rate.tx));
          add(ids.rx(mac), Math.round(rate.rx));
        }
      }
      add(ids.feature(FEATURES.WIFI_CLIENTS), entry.stations?.length);
      add(ids.feature(FEATURES.GUEST_WIFI), bit(entry.guest?.enabled));
      add(ids.feature(FEATURES.LEDS), bit(entry.leds));
      add(ids.feature(FEATURES.FIRMWARE), this.firmwareOf(entry));
      add(ids.feature(FEATURES.FIRMWARE_UPDATE), bit(entry.firmwareUpdate?.available));
    }
    for (const [mac, presence] of this.presence) {
      add(stationIds(this.gladys, mac).presence, bit(presence.online));
    }
    if (states.length === 0) {
      return;
    }
    try {
      await this.gladys.publishChangedStates(states, { heartbeat: this.timings.heartbeatMs });
      this.problems.recover('publish', 'Gladys accepts the states again');
    } catch (err) {
      // Sent again at the next cycle (the SDK forgets what Gladys refused).
      this.problems.fail('publish', `Publishing the states failed: ${err.message}`);
    }
  }

  /** The connection status of the Configuration screen, sent when it changes. */
  async sendStatus() {
    const entries = [...this.adapters.values()];
    const names = (list) => {
      const shown = list.slice(0, 3).map((entry) => this.nameOf(entry));
      return list.length > 3 ? `${shown.join(', ')}…` : shown.join(', ');
    };
    const refused = entries.filter((entry) => entry.problem === 'auth');
    const silent = entries.filter((entry) => entry.problem !== 'auth' && entry.online === false);
    let connected = entries.length > 0 && refused.length + silent.length < entries.length;
    let message;
    if (entries.length === 0) {
      message = render(STATUS, 'none');
      connected = false;
    } else if (refused.length > 0) {
      message = render(STATUS, 'auth', { names: names(refused) });
    } else if (silent.length > 0) {
      message = render(STATUS, 'unreachable', { names: names(silent) });
    }
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatusSent) {
      return;
    }
    this.lastStatusSent = key;
    await this.gladys.setConnectionStatus(connected, message).catch(() => {});
  }

  fire(key, data) {
    this.gladys
      .publishSceneEvent(key, data)
      .catch((err) => logger.warn(`Scene event ${key} refused: ${err.message}`));
  }

  // --- Gladys events -----------------------------------------------------------

  async onDeviceCreated(device) {
    if (stationMacOf(this.gladys, device.external_id)) {
      // Its presence from the last read, without waiting for the next one.
      const latest = Math.max(...[...this.adapters.values()].map((entry) => entry.stationsAt));
      if (Number.isFinite(latest)) {
        this.updatePresence(latest);
      }
    }
    // The SDK forgot the states of this device: everything is published again.
    await this.publishStates();
    this.requestRefresh();
  }

  /** onPoll fallback: should_poll is false, but a Gladys polling anyway gets an answer. */
  async poll() {
    await this.runCycle();
  }

  // --- Commands ------------------------------------------------------------------

  /** The adapter entry of a device external id; throws when there is none. */
  adapterOf(externalId) {
    const entry = this.adapters.get(adapterIdOf(this.gladys, externalId));
    if (!entry) {
      throw new GladysError(render(ERRORS, 'unknownDevice'), this.config.language);
    }
    return entry;
  }

  async command(entry, fn) {
    const name = this.nameOf(entry);
    try {
      return await fn(entry.client);
    } catch (err) {
      if (err instanceof GladysError) {
        throw err;
      }
      const key = err.kind === 'auth' ? 'auth' : err.kind === 'unreachable' ? 'offline' : 'failed';
      throw new GladysError(
        render(ERRORS, key, { name, reason: err.kind ?? err.message }),
        this.config.language,
      );
    }
  }

  async setValue(device, feature, value) {
    const entry = this.adapterOf(device.external_id);
    const key = String(feature.external_id).split(':').at(-1);
    const on = Number(value) === 1;
    switch (key) {
      case FEATURES.GUEST_WIFI:
        await this.setGuestWifi(entry, on);
        return;
      case FEATURES.LEDS:
        await this.command(entry, (client) => client.setLeds(on));
        logger.info(`LEDs of ${this.nameOf(entry)} switched ${on ? 'on' : 'off'}`);
        entry.leds = on;
        break;
      case FEATURES.IDENTIFY:
        await this.command(entry, (client) => client.identify());
        logger.info(`${this.nameOf(entry)} blinks`);
        return;
      case FEATURES.RESTART:
        if (!this.config.allowRestart) {
          throw new GladysError(render(ERRORS, 'restartDisabled'), this.config.language);
        }
        await this.command(entry, (client) => client.restart());
        logger.info(`${this.nameOf(entry)} restarts`);
        return;
      default:
        if (rateOf(feature.external_id) === null) {
          throw new GladysError(render(ERRORS, 'unknownDevice'), this.config.language);
        }
        return;
    }
    await this.publishStates();
  }

  /** The adapters with a guest Wi-Fi: the one of a device, or all of them. */
  guestWifiAdapters(deviceExternalId) {
    if (deviceExternalId) {
      const entry = this.adapterOf(deviceExternalId);
      if (!entry.client.has('wifi1')) {
        throw new GladysError(render(ERRORS, 'notAdapter'), this.config.language);
      }
      return [entry];
    }
    const entries = [...this.adapters.values()].filter((entry) => entry.client.has('wifi1'));
    if (entries.length === 0) {
      throw new GladysError(render(ERRORS, 'noWifi'), this.config.language);
    }
    return entries;
  }

  /**
   * Switch the guest Wi-Fi of an adapter; `minutes` (when switching on): the
   * adapter switches it off again by itself after that delay.
   */
  async setGuestWifi(entry, enable, minutes = 0) {
    const duration = enable ? Math.min(Math.max(0, Math.round(minutes)), MAX_GUEST_MINUTES) : 0;
    await this.command(entry, (client) => client.setGuestWifi(enable, duration));
    logger.info(
      `Guest Wi-Fi of ${this.nameOf(entry)} switched ${enable ? 'on' : 'off'}${duration ? ` for ${duration} min` : ''}`,
    );
    entry.guest = {
      ...(entry.guest ?? { ssid: '', key: '' }),
      enabled: enable,
      remainingDuration: duration,
    };
    this.requestRefresh();
    await this.publishStates();
  }

  /** Name and password of the guest Wi-Fi of an adapter, read again. */
  async guestWifiDetails(entry) {
    const guest = await this.command(entry, (client) => client.guestWifi());
    entry.guest = guest;
    return { ssid: guest.ssid ?? '', password: guest.key ?? '' };
  }

  /** The "Search the adapters" report. */
  async searchReport() {
    await this.discover();
    await this.runCycle({ overview: true });
    await this.publishDiscovered();
    const entries = [...this.adapters.values()];
    if (entries.length === 0) {
      throw new GladysError(render(STATUS, 'none'), this.config.language);
    }
    const parts = [render(REPORTS, 'found', { count: entries.length })];
    for (const entry of entries) {
      parts.push(
        join(
          render(REPORTS, 'adapter', {
            name: this.nameOf(entry),
            firmware: this.firmwareOf(entry) ?? '?',
            address: entry.info.address,
          }),
          render(REPORTS, entry.problem ?? (entry.online ? 'ok' : 'unreachable')),
        ),
      );
    }
    parts.push(render(REPORTS, 'discover'));
    return join(...parts);
  }

  // --- Widget ------------------------------------------------------------------

  requestRefresh() {
    if (this.stopped) {
      return;
    }
    const now = this.now();
    const wait = this.lastRefreshAt + this.timings.widgetRefreshMs - now;
    if (wait <= 0) {
      this.lastRefreshAt = now;
      this.gladys.requestWidgetRefresh(WIDGET_KEY);
    } else if (this.timers && !this.refreshTimer) {
      this.refreshTimer = setTimeout(() => {
        this.refreshTimer = null;
        this.requestRefresh();
      }, wait);
      this.refreshTimer.unref?.();
    }
  }

  /** What the widget shows of one adapter (compared to know when to refresh it). */
  widgetSummary(entry) {
    return [entry.online, entry.guest?.enabled ?? null, entry.stations?.length ?? null];
  }

  /** What the widget shows. */
  view() {
    const network = this.network();
    const router = this.routerMac(network);
    const adapters = [...this.adapters.values()].map((entry) => {
      const mac = entry.info.plcMac;
      const isRouter = Boolean(router && mac === router);
      return {
        id: entry.info.id,
        externalId: adapterIds(this.gladys, entry.info.id).device,
        name: this.nameOf(entry),
        online: entry.online,
        isRouter,
        rate: router && mac && !isRouter ? this.rateBetween(entry, router, network) : null,
        wifi: entry.client.has('wifi1'),
        stations: entry.stations?.length ?? null,
        guest: entry.guest?.enabled ?? null,
        firmwareUpdate: entry.firmwareUpdate?.available ?? false,
      };
    });
    return { adapters };
  }
}
