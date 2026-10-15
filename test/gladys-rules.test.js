// -----------------------------------------------------------------------------
// Conformity with the Gladys core, on every device discovered from realistic
// inputs: the network of the Home Assistant tests (a Wi-Fi PLC adapter, a
// Magic 2 LAN, a Wi-Fi-only repeater, an old adapter without API), the
// restart button allowed or not, peers with long or identical names, an
// adapter announcing no features, and the Wi-Fi devices, in every
// feature-name language.
//
// The table (test/fixtures/gladys-feature-table.json) is extracted from the
// core code: a category/type couple missing there shows as "undefined" or
// without icon in Gladys, a poll frequency outside its list is a 400 on
// discovery, a feature without min/max is a 422 on "Add to Gladys".
// Do not loosen this test to make it pass: fix the integration.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LANGUAGES } from '../src/config.js';
import { MAC, createFakeNetwork } from './helpers/fakeAdapter.js';
import { CONFIG, createWorld } from './helpers/world.js';

const table = JSON.parse(
  await readFile(new URL('./fixtures/gladys-feature-table.json', import.meta.url), 'utf8'),
);

function checkDevice(device, where) {
  // should_poll: true if and only if poll_frequency is provided, in ms.
  if (device.poll_frequency === undefined) {
    assert.notEqual(device.should_poll, true, `${where}: should_poll without poll_frequency`);
  } else {
    assert.equal(device.should_poll, true, `${where}: poll_frequency without should_poll`);
    assert.ok(
      table.poll_frequencies_ms.includes(device.poll_frequency),
      `${where}: poll_frequency ${device.poll_frequency} is not one of ${table.poll_frequencies_ms}`,
    );
  }
  assert.ok(device.features.length > 0, `${where}: no feature`);
  const externalIds = new Set();
  const names = new Set();
  for (const feature of device.features) {
    const at = `${where} / ${feature.name}`;
    const pair = table.pairs[`${feature.category}/${feature.type}`];
    assert.ok(pair, `${at}: ${feature.category}/${feature.type} is not a couple Gladys knows`);
    assert.ok(pair.label_en && pair.label_fr && pair.icon, `${at}: couple without label or icon`);
    assert.equal(typeof feature.min, 'number', `${at}: min must be a number`);
    assert.equal(typeof feature.max, 'number', `${at}: max must be a number`);
    assert.ok(
      Number.isFinite(feature.min) && Number.isFinite(feature.max),
      `${at}: finite min/max`,
    );
    assert.ok(feature.min <= feature.max, `${at}: min > max`);
    assert.equal(typeof feature.read_only, 'boolean', `${at}: read_only must be a boolean`);
    assert.equal(typeof feature.has_feedback, 'boolean', `${at}: has_feedback must be a boolean`);
    if (feature.unit !== undefined) {
      assert.ok(table.units.includes(feature.unit), `${at}: unknown unit ${feature.unit}`);
    }
    assert.ok(feature.name.length <= 40, `${at}: name over 40 characters`);
    assert.ok(!externalIds.has(feature.external_id), `${at}: duplicate external_id`);
    externalIds.add(feature.external_id);
    assert.ok(!names.has(feature.name), `${at}: duplicate feature name on the device`);
    names.add(feature.name);
  }
}

/** Networks to discover: label → network options and changes. */
const SETUPS = {
  'the Home Assistant network': { network: {} },
  'restart allowed': { network: {}, config: { allow_restart: true } },
  'peers with long and identical names': {
    network: {},
    change(net) {
      net.plc[0].name = 'Bureau du premier étage, côté jardin, près de la fenêtre';
      net.plc[1].name = '';
      net.plc[2].name = '';
      net.plc[2].product = net.plc[1].product;
    },
  },
  'a repeater alone': { network: { only: ['1234567892'] } },
  'an adapter announcing no features': {
    network: { only: ['1234567891'] },
    change(net) {
      const record = net.records.find((r) => r.name.startsWith('devolo Magic 2 LAN._dvl-device'));
      record.txt = record.txt.filter((entry) => !entry.startsWith('Features='));
    },
  },
};

for (const language of LANGUAGES) {
  test(`every discovered device follows the Gladys rules (${language} names)`, async (t) => {
    const devices = [];
    for (const [label, setup] of Object.entries(SETUPS)) {
      const net = createFakeNetwork(setup.network);
      setup.change?.(net);
      const world = await createWorld({
        config: { ...CONFIG, ...setup.config, language },
        network: net,
      });
      t.after(() => world.app.stop());
      devices.push(...world.fake.discoveredDevices.map((device) => ({ device, label })));
    }
    // Every kind of device was produced.
    const kinds = new Set(devices.map(({ device }) => device.external_id.split(':')[2]));
    assert.deepEqual([...kinds].sort(), ['adapter', 'wifi']);
    const rates = devices.flatMap(({ device }) =>
      device.features.filter((feature) => feature.external_id.includes(':plc_tx_')),
    );
    assert.ok(rates.length >= 4);
    assert.ok(
      devices.some(({ device }) => device.features.some((f) => f.external_id.endsWith(':restart'))),
    );
    for (const { device, label } of devices) {
      checkDevice(device, `${label}: ${device.name}`);
    }
  });
}

test('the peer names stay distinct and within 40 characters', async (t) => {
  const net = createFakeNetwork({ only: ['1234567890'] });
  net.plc[1].name = '';
  net.plc[2].name = '';
  net.plc[2].product = net.plc[1].product;
  net.plc[2].mac = MAC.old;
  const world = await createWorld({ config: { ...CONFIG, language: 'es' }, network: net });
  t.after(() => world.app.stop());
  const names = world.fake.discoveredDevices[0].features
    .filter((feature) => feature.external_id.includes(':plc_'))
    .map((feature) => feature.name);
  assert.deepEqual(names, [
    'Velocidad PLC hacia devolo Magic … 53:02',
    'Velocidad PLC desde devolo Magic … 53:02',
    'Velocidad PLC hacia devolo Magic … 53:03',
    'Velocidad PLC desde devolo Magic … 53:03',
  ]);
});
