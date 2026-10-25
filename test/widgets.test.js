// -----------------------------------------------------------------------------
// The dashboard widget: content within the core vocabulary and budget, the
// rows of the adapters, the guest Wi-Fi button, the empty state.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WIDGET_COLORS, validateWidgetContent } from '@gladysassistant/integration-sdk';
import { WIDGET_KEY } from '../src/hub.js';
import { adapterRow, rateColor } from '../src/widgets.js';
import { LANGUAGES } from '../src/config.js';
import { createWorld, cycleAfter } from './helpers/world.js';

const content = async (world, language = 'fr', settings = {}) => {
  const ack = await world.fake.widgetGet(WIDGET_KEY, { settings, language, units: 'metric' });
  assert.equal(ack.success, true, ack.error);
  return ack.data.content;
};

test('the PLC network at a glance, valid in every language', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  for (const language of LANGUAGES) {
    const widget = await content(world, language);
    assert.deepEqual(validateWidgetContent(widget), [], language);
  }
  const widget = await content(world, 'fr');
  const tiles = widget.components.filter((component) => component.type === 'value');
  assert.deepEqual(
    tiles.map((tile) => [tile.label, tile.value]),
    [
      ['En ligne', '4 / 4'],
      ['Appareils Wi-Fi', 1],
      ['Lien le plus lent', 100],
    ],
  );
  const [status] = widget.components.filter((component) => component.type === 'status');
  assert.deepEqual(
    status.items.map((item) => [item.label, item.value, item.color]),
    [
      ['dLAN pro 1200+ WiFi ac (test1)', '↑ 100 ↓ 100 Mbit/s ↔ test2', WIDGET_COLORS.SUCCESS],
      ['devolo Magic 2 LAN (test2)', 'Branché au routeur', WIDGET_COLORS.SUCCESS],
      ['devolo WiFi 6 Repeater 3000', 'En ligne', WIDGET_COLORS.SUCCESS],
      // An older dLAN without a management API, seen through the others.
      ['dLAN 550 duo+ (test3)', '↑ 381 ↓ 420 Mbit/s ↔ test2', WIDGET_COLORS.SUCCESS],
    ],
  );
  const [button] = widget.components.filter((component) => component.type === 'button');
  assert.equal(button.label, 'Activer Wi-Fi invités');
  assert.deepEqual(button.action, { key: 'guest_wifi', params: { enable: true } });
  // No MAC address nor password on a dashboard.
  assert.doesNotMatch(JSON.stringify(widget), /00:00:5E|HMANPGBA/);
});

test('the button switches the guest Wi-Fi of every adapter, then offers the opposite', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const ack = await world.fake.widgetAction(
    WIDGET_KEY,
    'guest_wifi',
    { enable: true },
    { settings: {} },
  );
  assert.equal(ack.success, true);
  assert.equal(world.net.adapter('1234567890').guest.enabled, true);
  assert.equal(world.net.adapter('1234567892').guest.enabled, true);
  const widget = await content(world, 'en');
  const [button] = widget.components.filter((component) => component.type === 'button');
  assert.equal(button.label, 'Turn off guest Wi-Fi');
});

test('an offline adapter and a firmware update show in the rows', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  world.net.adapter('1234567892').reachable = false;
  await cycleAfter(world);
  await cycleAfter(world);
  const widget = await content(world, 'en');
  const [status] = widget.components.filter((component) => component.type === 'status');
  assert.deepEqual(status.items[2].value, 'Offline');
  assert.equal(status.items[2].color, WIDGET_COLORS.DANGER);
  assert.equal(status.items[0].value, '↑ 100 ↓ 100 Mbit/s ↔ test2 · update');
});

test('rates are colored by quality', () => {
  assert.equal(rateColor({ tx: 400, rx: 120 }), WIDGET_COLORS.SUCCESS);
  assert.equal(rateColor({ tx: 400, rx: 60 }), WIDGET_COLORS.WARNING);
  assert.equal(rateColor({ tx: 20, rx: 60 }), WIDGET_COLORS.DANGER);
  const row = adapterRow({ name: 'x'.repeat(80), online: null }, 'de');
  assert.equal(row.label.length, 40);
  assert.equal(row.value, 'Unbekannt');
});

test('no adapter yet: one text that says what to check', async (t) => {
  const world = await createWorld({ mdns: false });
  t.after(() => world.app.stop());
  const widget = await content(world, 'es');
  assert.deepEqual(validateWidgetContent(widget), []);
  assert.equal(widget.components.length, 1);
  assert.match(widget.components[0].text, /^Aún no se ha encontrado/);
});

test('the guest Wi-Fi button can be hidden by the widget setting', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const shown = await content(world, 'en', { guest_button: true });
  assert.ok(shown.components.some((component) => component.type === 'button'));
  const hidden = await content(world, 'en', { guest_button: false });
  assert.deepEqual(validateWidgetContent(hidden), []);
  assert.ok(!hidden.components.some((component) => component.type === 'button'));
});

test('a long peer name never pushes the update notice out of the row', () => {
  const row = adapterRow(
    {
      name: 'a',
      online: true,
      rate: { tx: 1000, rx: 1000 },
      peer: 'x'.repeat(50),
      firmwareUpdate: true,
    },
    'fr',
  );
  assert.ok(row.value.length <= 40, row.value);
  assert.match(row.value, /· mise à jour$/);
});

test('an older dLAN is offline when no adapter that answers lists it any more', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  // test3 is listed by the two PLC adapters; both stop answering.
  world.net.adapter('1234567890').reachable = false;
  world.net.adapter('1234567891').reachable = false;
  await cycleAfter(world);
  await cycleAfter(world);
  const widget = await content(world, 'en');
  const [status] = widget.components.filter((component) => component.type === 'status');
  const old = status.items.find((item) => item.label === 'dLAN 550 duo+ (test3)');
  assert.equal(old.value, 'Offline');
  const [online] = widget.components.filter((component) => component.type === 'value');
  assert.equal(online.value, '1 / 4');
});
