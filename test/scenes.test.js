// -----------------------------------------------------------------------------
// The scene actions: guest Wi-Fi on (optionally for a while, by the adapter's
// own timer) with its name and password as outputs, and off.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { minutesOf } from '../src/scenes.js';
import { GUEST_KEY } from './helpers/fakeAdapter.js';
import { CONFIG, adapterDevice, createWorld, state, create } from './helpers/world.js';

test('minutes from a field or a scene variable', () => {
  assert.equal(minutesOf(30), 30);
  assert.equal(minutesOf('45,4'), 45);
  assert.equal(minutesOf(''), 0);
  assert.equal(minutesOf(undefined), 0);
  assert.equal(minutesOf(-5), 0);
  assert.equal(minutesOf(99999), 1440);
});

test('enable_guest_wifi: every Wi-Fi adapter, with a duration, gives name and password', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const wifi = await create(world, adapterDevice(world, '1234567890'));
  const result = await world.fake.sceneAction('enable_guest_wifi', { duration_minutes: 90 });
  assert.deepEqual(result, {
    success: true,
    data: { outputs: { ssid: 'devolo-guest-930', password: GUEST_KEY } },
  });
  for (const sn of ['1234567890', '1234567892']) {
    assert.deepEqual(world.net.adapter(sn).guestSets, [{ enable: true, duration: 90 }]);
  }
  assert.equal(state(world, wifi, 'guest_wifi'), 1);
});

test('enable/disable on one adapter only', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const repeater = adapterDevice(world, '1234567892');
  await world.fake.sceneAction('enable_guest_wifi', { device: repeater.external_id });
  assert.deepEqual(world.net.adapter('1234567892').guestSets, [{ enable: true, duration: 0 }]);
  assert.deepEqual(world.net.adapter('1234567890').guestSets, []);
  const off = await world.fake.sceneAction('disable_guest_wifi', { device: repeater.external_id });
  assert.equal(off.success, true);
  assert.equal(world.net.adapter('1234567892').guest.enabled, false);
});

test('an adapter without Wi-Fi, or no Wi-Fi adapter at all: a clear error', async (t) => {
  const world = await createWorld({ config: { ...CONFIG, language: 'en' } });
  t.after(() => world.app.stop());
  const magic = adapterDevice(world, '1234567891');
  const refused = await world.fake.sceneAction('enable_guest_wifi', { device: magic.external_id });
  assert.deepEqual(refused, { success: false, error: 'Choose a devolo adapter with Wi-Fi.' });
  const lan = await createWorld({
    network: { only: ['1234567891'] },
    config: { ...CONFIG, language: 'en' },
  });
  t.after(() => lan.app.stop());
  const none = await lan.fake.sceneAction('disable_guest_wifi', {});
  assert.deepEqual(none, { success: false, error: 'No devolo adapter with Wi-Fi is known.' });
});
