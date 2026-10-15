// -----------------------------------------------------------------------------
// A complete test world: the SDK's fake Gladys, a simulated devolo network
// (test/helpers/fakeAdapter.js), a manual clock, a temporary /data, and the
// integration wired on top through registerHandlers. Nothing touches the
// network.
// -----------------------------------------------------------------------------

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { registerHandlers } from '../../src/app.js';
import { Store } from '../../src/store.js';
import { PASSWORD, createFakeNetwork } from './fakeAdapter.js';

process.env.LOG_LEVEL ??= 'silent';

export const CONFIG = { password: PASSWORD };

/** A manual clock. */
export function createClock(start = 1_700_000_000_000) {
  const clock = {
    time: start,
    now: () => clock.time,
    advance(ms) {
      clock.time += ms;
    },
  };
  return clock;
}

/** Lets pending callbacks (fire-and-forget promises) run. */
export const flush = () => new Promise((resolve) => setImmediate(resolve));

/**
 * @param {object} [options]
 * @param {object} [options.config] raw integration config (CONFIG by default)
 * @param {object} [options.network] options of createFakeNetwork, or a network
 * @param {Array} [options.devices] devices already created in Gladys
 * @param {object} [options.saved] content of /data/state.json before the start
 * @param {boolean} [options.mdns] false: the core's scan finds nothing
 * @param {boolean} [options.connect]
 * @param {boolean} [options.timers] true: the hub's own read timer runs (tests mock it)
 */
export async function createWorld({
  config = CONFIG,
  network = {},
  devices = [],
  saved,
  mdns = true,
  connect = true,
  timers = false,
  dataDir = mkdtempSync(join(tmpdir(), 'gladys-devolo-')),
} = {}) {
  const net = typeof network.request === 'function' ? network : createFakeNetwork(network);
  const gladys = createFakeGladys({ config, devices, scanResults: { mdns: [] } });
  // The scan answers what the network holds at the time of the scan.
  Object.defineProperty(gladys.fake, 'scanResults', {
    get: () => ({ mdns: mdns ? net.scanResults() : [] }),
    set: () => {},
    configurable: true,
  });
  const store = new Store(dataDir);
  if (saved) {
    await store.save(saved);
    await store.flush();
  }
  const clock = createClock();
  const app = registerHandlers(gladys, {
    store,
    request: net.request,
    exchange: net.exchange,
    timers,
    now: clock.now,
  });
  if (connect) {
    await gladys.connect();
    await app.ready;
    await app.hub.running;
  }
  return { gladys, fake: gladys.fake, app, hub: app.hub, net, clock, store, dataDir };
}

/** The discovered device whose external id contains a text. */
export const discovered = (world, text) =>
  world.fake.discoveredDevices.find((device) => device.external_id.includes(text));

/** The adapter device of a serial number. */
export const adapterDevice = (world, sn) => discovered(world, `:adapter:${sn}`);

/** Create a discovered device in Gladys, as the user would. */
export async function create(world, device) {
  if (!device) {
    throw new Error('No such discovered device');
  }
  await world.fake.deviceCreated(device);
  return device;
}

/** External id of one feature of a device, by its key. */
export const featureId = (device, key) =>
  device.features.find((feature) => feature.external_id.endsWith(`:${key}`))?.external_id;

/** The last state published for a feature of a device. */
export const state = (world, device, key) => world.fake.lastState(featureId(device, key));

/** Scene events fired with a key. */
export const events = (world, key) =>
  world.fake.sceneEvents.filter((event) => event.key === key).map((event) => event.data);

/** Run one read cycle at `ms` later. */
export async function cycleAfter(world, ms = 30_000) {
  world.clock.advance(ms);
  await world.hub.runCycle();
}
