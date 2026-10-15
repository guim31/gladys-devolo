// -----------------------------------------------------------------------------
// The Gladys devices of the integration.
//
// An adapter (one device, id = its serial number):
//   online           input/binary, 1 = the adapter answers its API
//   plc_tx_<mac>     datarate/rate, Mbit/s, PLC rate from this adapter to another one
//   plc_rx_<mac>     datarate/rate, Mbit/s, PLC rate from the other one to this adapter
//   wifi_clients     counter-sensor/integer, Wi-Fi devices connected to it
//   guest_wifi       switch/binary, controllable
//   leds             switch/binary, controllable
//   firmware         text/text, installed firmware version
//   firmware_update  input/binary, 1 = devolo offers a newer firmware
//   identify         button/push: the adapter blinks
//   restart          button/push, only when allowed in the configuration
// The features follow what the adapter announces: no Wi-Fi feature on a
// PLC-only adapter, no PLC rate on a Wi-Fi-only repeater. The rate features
// exist for the adapters of the PLC network known when the device is
// created; a new adapter in the network makes Gladys offer "Update".
//
// A Wi-Fi device the user chose (one device per MAC address):
//   presence         presence-sensor/binary, 1 = connected to a devolo adapter
//
// Every device is published with should_poll: false: the integration reads
// the adapters itself, at the configured interval (src/hub.js).
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { formatMac, normalizeMac } from './devolo/client.js';

export const ADAPTER_TYPE = 'adapter';
export const STATION_TYPE = 'wifi';

export const FEATURES = {
  ONLINE: 'online',
  WIFI_CLIENTS: 'wifi_clients',
  GUEST_WIFI: 'guest_wifi',
  LEDS: 'leds',
  FIRMWARE: 'firmware',
  FIRMWARE_UPDATE: 'firmware_update',
  IDENTIFY: 'identify',
  RESTART: 'restart',
  PRESENCE: 'presence',
};
const TX_PREFIX = 'plc_tx_';
const RX_PREFIX = 'plc_rx_';

// Display bounds: 2400 Mbit/s is the PHY rate of the fastest devolo Magic
// adapters; 128 Wi-Fi devices is far beyond what a repeater serves.
export const MAX_RATE_MBPS = 2400;
export const MAX_WIFI_CLIENTS = 128;
export const MAX_FEATURE_NAME = 40;

// Feature names, frozen at creation in Gladys (language of the configuration).
export const NAMES = {
  en: {
    online: 'Online',
    wifi_clients: 'Wi-Fi devices',
    guest_wifi: 'Guest Wi-Fi',
    leds: 'LEDs',
    firmware: 'Firmware',
    firmware_update: 'Firmware update available',
    identify: 'Identify (blink)',
    restart: 'Restart',
    presence: 'Presence',
    tx: 'PLC rate to {peer}',
    rx: 'PLC rate from {peer}',
    station: 'Wi-Fi device {mac}',
  },
  fr: {
    online: 'En ligne',
    wifi_clients: 'Appareils Wi-Fi',
    guest_wifi: 'Wi-Fi invités',
    leds: 'Voyants',
    firmware: 'Firmware',
    firmware_update: 'Mise à jour disponible',
    identify: 'Identifier (clignoter)',
    restart: 'Redémarrer',
    presence: 'Présence',
    tx: 'Débit CPL vers {peer}',
    rx: 'Débit CPL depuis {peer}',
    station: 'Appareil Wi-Fi {mac}',
  },
  de: {
    online: 'Online',
    wifi_clients: 'WLAN-Geräte',
    guest_wifi: 'Gast-WLAN',
    leds: 'LEDs',
    firmware: 'Firmware',
    firmware_update: 'Firmware-Update verfügbar',
    identify: 'Identifizieren (blinken)',
    restart: 'Neu starten',
    presence: 'Anwesenheit',
    tx: 'PLC-Rate zu {peer}',
    rx: 'PLC-Rate von {peer}',
    station: 'WLAN-Gerät {mac}',
  },
  es: {
    online: 'En línea',
    wifi_clients: 'Dispositivos Wi-Fi',
    guest_wifi: 'Wi-Fi de invitados',
    leds: 'LED',
    firmware: 'Firmware',
    firmware_update: 'Actualización disponible',
    identify: 'Identificar (parpadear)',
    restart: 'Reiniciar',
    presence: 'Presencia',
    tx: 'Velocidad PLC hacia {peer}',
    rx: 'Velocidad PLC desde {peer}',
    station: 'Dispositivo Wi-Fi {mac}',
  },
};

const namesOf = (language) => NAMES[language] ?? NAMES.en;

/**
 * A name with `{peer}` filled in, the peer name cut so that it fits, and an
 * optional tag kept at the end (the end of a MAC address that tells two
 * peers apart).
 */
export function rateName(template, peer, tag = '') {
  const end = tag ? ` ${tag}` : '';
  const room = MAX_FEATURE_NAME - template.replace('{peer}', '').length - end.length;
  const short = peer.length > room ? `${peer.slice(0, Math.max(1, room - 1))}…` : peer;
  return template.replace('{peer}', `${short}${end}`);
}

/** External ids of an adapter device; `feature(key)` for any feature key. */
export function adapterIds(gladys, adapterId) {
  const ids = gladys.externalIds(ADAPTER_TYPE, adapterId);
  return {
    device: ids.device,
    feature: ids.feature,
    tx: (mac) => ids.feature(`${TX_PREFIX}${normalizeMac(mac).toLowerCase()}`),
    rx: (mac) => ids.feature(`${RX_PREFIX}${normalizeMac(mac).toLowerCase()}`),
  };
}

/** External ids of a Wi-Fi device (by MAC). */
export function stationIds(gladys, mac) {
  const ids = gladys.externalIds(STATION_TYPE, normalizeMac(mac).toLowerCase());
  return { device: ids.device, presence: ids.feature(FEATURES.PRESENCE) };
}

/** The id behind a device external id of a type, or null. */
function idOf(gladys, type, externalId) {
  const prefix = gladys.externalIds(type, '').device;
  if (typeof externalId !== 'string' || !externalId.startsWith(prefix)) {
    return null;
  }
  return externalId.slice(prefix.length).split(':')[0] || null;
}

export const adapterIdOf = (gladys, externalId) => idOf(gladys, ADAPTER_TYPE, externalId);

/** The MAC (`00005E005301`) of a Wi-Fi device external id, or null. */
export const stationMacOf = (gladys, externalId) =>
  normalizeMac(idOf(gladys, STATION_TYPE, externalId));

/** The peer MAC and direction of a rate feature external id, or null. */
export function rateOf(featureExternalId) {
  const key = String(featureExternalId ?? '')
    .split(':')
    .at(-1);
  for (const [prefix, direction] of [
    [TX_PREFIX, 'tx'],
    [RX_PREFIX, 'rx'],
  ]) {
    if (key.startsWith(prefix)) {
      const mac = normalizeMac(key.slice(prefix.length));
      return mac ? { mac, direction } : null;
    }
  }
  return null;
}

/** The name shown for an adapter of the PLC network (from its overview entry). */
export function peerName(peer) {
  return peer.userDeviceName || peer.productName || formatMac(peer.macAddress);
}

/** The name of an adapter device. */
export function adapterName(adapter) {
  const product = adapter.info.product || 'devolo';
  const own = adapter.self?.userDeviceName;
  return String(own && own !== product ? `${product} (${own})` : product).slice(0, 60);
}

const feature = (name, externalId, category, type, extra = {}) => ({
  name,
  external_id: externalId,
  category,
  type,
  read_only: true,
  has_feedback: false,
  keep_history: true,
  min: 0,
  max: 1,
  ...extra,
});

const control = (name, externalId, category, type) =>
  feature(name, externalId, category, type, {
    read_only: false,
    has_feedback: category === DEVICE_FEATURE_CATEGORIES.SWITCH,
    keep_history: category === DEVICE_FEATURE_CATEGORIES.SWITCH,
  });

/**
 * The rate feature names of the peers of an adapter, distinct: two peers
 * whose names are the same (two adapters of the same model without a name),
 * or only differ beyond what fits, get the end of their MAC address.
 * @param {Array<object>} peers overview entries of the other adapters
 * @returns {Array<{ mac: string, tx: string, rx: string }>}
 */
export function peerFeatureNames(peers, names) {
  const named = peers
    .filter((peer) => normalizeMac(peer.macAddress))
    .map((peer) => ({ mac: normalizeMac(peer.macAddress), name: peerName(peer) }));
  const plain = named.map((peer) => rateName(names.tx, peer.name));
  return named.map((peer, index) => {
    const tag =
      plain.filter((name) => name === plain[index]).length > 1 ? formatMac(peer.mac).slice(-5) : '';
    return {
      mac: peer.mac,
      tx: rateName(names.tx, peer.name, tag),
      rx: rateName(names.rx, peer.name, tag),
    };
  });
}

/**
 * The discovery payload of an adapter.
 * @param {object} gladys
 * @param {object} adapter hub entry: `{ info, client, self, peers }`
 * @param {object} options
 * @param {string} options.language language of the feature names
 * @param {boolean} options.allowRestart publish the restart button
 */
export function buildAdapterDevice(gladys, adapter, { language = 'fr', allowRestart = false }) {
  const { info, client } = adapter;
  const ids = adapterIds(gladys, info.id);
  const names = namesOf(language);
  const CATEGORIES = DEVICE_FEATURE_CATEGORIES;
  const TYPES = DEVICE_FEATURE_TYPES;
  const features = [
    feature(names.online, ids.feature(FEATURES.ONLINE), CATEGORIES.INPUT, TYPES.SENSOR.BINARY),
  ];
  for (const peer of peerFeatureNames(adapter.peers ?? [], names)) {
    for (const direction of ['tx', 'rx']) {
      features.push(
        feature(
          peer[direction],
          ids[direction](peer.mac),
          CATEGORIES.DATARATE,
          TYPES.DATARATE.RATE,
          { unit: DEVICE_FEATURE_UNITS.MEGABITS_PER_SECOND, max: MAX_RATE_MBPS },
        ),
      );
    }
  }
  if (client.has('wifi1')) {
    features.push(
      feature(
        names.wifi_clients,
        ids.feature(FEATURES.WIFI_CLIENTS),
        CATEGORIES.COUNTER_SENSOR,
        TYPES.SENSOR.INTEGER,
        { max: MAX_WIFI_CLIENTS },
      ),
      control(
        names.guest_wifi,
        ids.feature(FEATURES.GUEST_WIFI),
        CATEGORIES.SWITCH,
        TYPES.SWITCH.BINARY,
      ),
    );
  }
  if (client.has('led')) {
    features.push(
      control(names.leds, ids.feature(FEATURES.LEDS), CATEGORIES.SWITCH, TYPES.SWITCH.BINARY),
    );
  }
  features.push(
    feature(names.firmware, ids.feature(FEATURES.FIRMWARE), CATEGORIES.TEXT, TYPES.TEXT.TEXT, {
      max: 0,
    }),
  );
  if (client.has('update')) {
    features.push(
      feature(
        names.firmware_update,
        ids.feature(FEATURES.FIRMWARE_UPDATE),
        CATEGORIES.INPUT,
        TYPES.SENSOR.BINARY,
      ),
    );
  }
  if (client.hasPlcnet) {
    features.push(
      control(names.identify, ids.feature(FEATURES.IDENTIFY), CATEGORIES.BUTTON, TYPES.BUTTON.PUSH),
    );
  }
  if (allowRestart && client.has('restart')) {
    features.push(
      control(names.restart, ids.feature(FEATURES.RESTART), CATEGORIES.BUTTON, TYPES.BUTTON.PUSH),
    );
  }
  const params = [{ name: 'IP_ADDRESS', value: info.address }];
  if (info.sn) {
    params.push({ name: 'SERIAL_NUMBER', value: info.sn });
  }
  if (info.plcMac) {
    params.push({ name: 'PLC_MAC', value: formatMac(info.plcMac) });
  }
  return {
    name: adapterName(adapter),
    external_id: ids.device,
    model: info.product || 'devolo adapter',
    should_poll: false,
    params,
    features,
  };
}

/** The discovery payload of a Wi-Fi device. */
export function buildStationDevice(gladys, mac, language = 'fr') {
  const ids = stationIds(gladys, mac);
  const names = namesOf(language);
  return {
    name: names.station.replace('{mac}', formatMac(mac)),
    external_id: ids.device,
    model: 'devolo Wi-Fi client',
    should_poll: false,
    params: [{ name: 'MAC_ADDRESS', value: formatMac(mac) }],
    features: [
      feature(
        names.presence,
        ids.presence,
        DEVICE_FEATURE_CATEGORIES.PRESENCE_SENSOR,
        DEVICE_FEATURE_TYPES.SENSOR.BINARY,
      ),
    ],
  };
}
