// -----------------------------------------------------------------------------
// The protobuf codec against bytes produced by the reference protobuf
// library (test/fixtures/devolo/protobuf.json, see its README): the values of
// the Home Assistant test fixtures, encoded with the message definitions the
// adapters speak.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ProtobufError, decode, encode, readFields } from '../src/devolo/protobuf.js';
import {
  GetNetworkOverview,
  IdentifyDevice,
  LedSettings,
  UpdateFirmwareCheck,
  UptimeGetResponse,
  WifiConnectedStationsGet,
  WifiGuestAccessGet,
  WifiGuestAccessSet,
} from '../src/devolo/schema.js';
import { encodeMessage } from './helpers/protobufWriter.js';

const fixtures = JSON.parse(
  await readFile(new URL('./fixtures/devolo/protobuf.json', import.meta.url), 'utf8'),
);
const bytes = (key) => Buffer.from(fixtures[key], 'base64');

test('the network overview of the Home Assistant tests decodes', () => {
  const { network } = decode(GetNetworkOverview, bytes('overview_ha'));
  assert.equal(network.devices.length, 3);
  assert.deepEqual(
    network.devices.map((device) => [device.macAddress, device.userDeviceName, device.topology]),
    [
      ['00:00:5E:00:53:00', 'test1', 1],
      ['00:00:5E:00:53:02', 'test2', 2],
      ['00:00:5E:00:53:03', 'test3', 2],
    ],
  );
  assert.equal(network.devices[1].attachedToRouter, true);
  assert.equal(network.devices[0].attachedToRouter, false);
  assert.deepEqual(network.dataRates, [
    {
      macAddressFrom: '00:00:5E:00:53:00',
      macAddressTo: '00:00:5E:00:53:02',
      txRate: 100,
      rxRate: 100,
    },
    {
      macAddressFrom: '00:00:5E:00:53:00',
      macAddressTo: '00:00:5E:00:53:03',
      txRate: 150,
      rxRate: 150,
    },
  ]);
});

test('Wi-Fi, guest Wi-Fi, firmware, uptime and LED answers decode', () => {
  assert.deepEqual(decode(WifiConnectedStationsGet, bytes('stations_ha')).stations, [
    { macAddress: '00:00:5E:00:53:01', vapType: 1, band: 2, rxRate: 87800, txRate: 87800 },
  ]);
  assert.deepEqual(decode(WifiConnectedStationsGet, bytes('stations_none')).stations, []);
  assert.deepEqual(decode(WifiGuestAccessGet, bytes('guest_wifi_ha')), {
    enabled: false,
    remainingDuration: 0,
    ssid: 'devolo-guest-930',
    key: 'HMANPGBA',
    wpa: 0,
  });
  assert.equal(decode(WifiGuestAccessGet, bytes('guest_wifi_on')).remainingDuration, 58);
  assert.deepEqual(decode(UpdateFirmwareCheck, bytes('firmware_available_ha')), {
    result: 0,
    newFirmwareVersion: '5.6.2_2023-01-15',
  });
  assert.equal(decode(UpdateFirmwareCheck, bytes('firmware_none')).result, 1);
  assert.equal(decode(UptimeGetResponse, bytes('uptime_ha')).uptime, 100);
  // proto3: LED_ON (0) is the default, sent as an empty message.
  assert.equal(bytes('led_on').length, 0);
  assert.equal(decode(LedSettings, bytes('led_on')).state, 0);
  assert.equal(decode(LedSettings, bytes('led_off')).state, 1);
});

test('a negative int32 (a Wi-Fi signal) decodes', () => {
  const schema = {
    aps: {
      id: 1,
      repeated: true,
      type: { mac: { id: 1, type: 'string' }, signal: { id: 5, type: 'int32' } },
    },
  };
  assert.deepEqual(decode(schema, bytes('negative_signal')).aps, [
    { mac: '00:00:5E:00:53:04', signal: -73 },
  ]);
});

test('the requests are encoded as the reference library does', () => {
  assert.deepEqual(encode(LedSettings, { state: 1 }), bytes('request_led_set_off'));
  assert.deepEqual(
    encode(WifiGuestAccessSet, { enable: true, duration: 60 }),
    bytes('request_guest_on_60'),
  );
  assert.deepEqual(
    encode(IdentifyDevice, { macAddress: '00:00:5E:00:53:00' }),
    bytes('request_identify'),
  );
  assert.equal(encode(LedSettings, { state: 0 }).length, 0);
});

test('the test writer produces the reference bytes', () => {
  const decoded = decode(GetNetworkOverview, bytes('overview_ha'));
  assert.deepEqual(encodeMessage(GetNetworkOverview, decoded), bytes('overview_ha'));
  const stations = decode(WifiConnectedStationsGet, bytes('stations_ha'));
  assert.deepEqual(encodeMessage(WifiConnectedStationsGet, stations), bytes('stations_ha'));
});

test('unknown fields are skipped, broken messages refused', () => {
  // A field 9 (varint) and a field 10 (32-bit) a newer firmware might add.
  const extended = Buffer.concat([bytes('uptime_ha'), Buffer.from([0x48, 0x01, 0x55, 1, 2, 3, 4])]);
  assert.equal(decode(UptimeGetResponse, extended).uptime, 100);
  assert.throws(() => readFields(Buffer.from([0x0a, 0x05, 0x61])), ProtobufError);
  assert.throws(() => readFields(Buffer.from([0x08, 0xff])), ProtobufError);
  assert.throws(() => readFields(Buffer.from([0x0b])), ProtobufError);
});
