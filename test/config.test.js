import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, normalizeConfig, parseAddresses } from '../src/config.js';

test('the defaults', () => {
  assert.deepEqual(normalizeConfig(), {
    addresses: [],
    password: '',
    pollInterval: 30,
    offlineAfter: 180,
    allowRestart: false,
    language: 'fr',
  });
  assert.deepEqual(normalizeConfig(DEFAULT_CONFIG), normalizeConfig({}));
  assert.deepEqual(normalizeConfig(null), normalizeConfig({}));
});

test('values outside the lists fall back to the defaults', () => {
  const config = normalizeConfig({ poll_interval: '7', offline_after: 'x', language: 'it' });
  assert.equal(config.pollInterval, 30);
  assert.equal(config.offlineAfter, 180);
  assert.equal(config.language, 'fr');
  assert.equal(normalizeConfig({ poll_interval: 120 }).pollInterval, 120);
  assert.equal(normalizeConfig({ allow_restart: 'true' }).allowRestart, true);
});

test('the password is kept as typed', () => {
  assert.equal(normalizeConfig({ password: ' a b ' }).password, ' a b ');
  assert.equal(normalizeConfig({ password: 12 }).password, '');
});

test('addresses: commas, spaces, URLs; invalid ones dropped', () => {
  assert.deepEqual(
    parseAddresses(
      '192.0.2.10, 192.0.2.11;http://192.0.2.12/ 192.0.2.10 devolo.local [2001:db8::1] 999.1.1.1',
    ),
    ['192.0.2.10', '192.0.2.11', '192.0.2.12', '2001:db8::1'],
  );
  assert.deepEqual(parseAddresses(undefined), []);
  assert.equal(
    parseAddresses(Array.from({ length: 30 }, (_, i) => `192.0.2.${i}`).join(',')).length,
    20,
  );
});
