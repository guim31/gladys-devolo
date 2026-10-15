// -----------------------------------------------------------------------------
// The devolo API messages the integration uses, as schemas for
// src/devolo/protobuf.js. Field numbers and enum values come from the message
// definitions the adapters speak (packages `device.api` and `plcnet.api`, as
// published with the devolo_plc_api Python library); they are restated here,
// not copied code.
// -----------------------------------------------------------------------------

const f = (id, type, repeated = false) => ({ id, type, repeated });

// --- Device API (`device.api`) -----------------------------------------------

/** LedSettingsGet / LedSettingsSet: `state` 0 = LED_ON, 1 = LED_OFF. */
export const LED_ON = 0;
export const LED_OFF = 1;
export const LedSettings = { state: f(1, 'enum') };

/** Result of the simple commands: 0 = SUCCESS. */
export const SUCCESS = 0;
export const Result = { result: f(1, 'enum') };

/** Restart response: result, uptime. UptimeGet: uptime only (field 2). */
export const RestartResponse = { result: f(1, 'enum'), uptime: f(2, 'int64') };
export const UptimeGetResponse = { uptime: f(2, 'int64') };

/** UpdateFirmwareCheck: 0 = UPDATE_AVAILABLE, 1 = UPDATE_NOT_AVAILABLE, 255 = error. */
export const UPDATE_AVAILABLE = 0;
export const UPDATE_NOT_AVAILABLE = 1;
export const UpdateFirmwareCheck = { result: f(1, 'enum'), newFirmwareVersion: f(2, 'string') };

/** WifiGuestAccessGet; WifiGuestAccessSet carries `enable` and `duration` (minutes, 0 = no end). */
export const WifiGuestAccessGet = {
  enabled: f(1, 'bool'),
  remainingDuration: f(2, 'uint32'),
  ssid: f(3, 'string'),
  key: f(4, 'string'),
  wpa: f(5, 'enum'),
};
export const WifiGuestAccessSet = { enable: f(1, 'bool'), duration: f(2, 'uint32') };

/** WifiResult: 0 = WIFI_SUCCESS. */
export const WIFI_SUCCESS = 0;

/** WifiBand: 1 = 2.4 GHz, 2 = 5 GHz. WifiVAPType: 1 = main access point, 2 = guest one. */
export const WIFI_BAND_2G = 1;
export const WIFI_BAND_5G = 2;
export const WIFI_VAP_MAIN_AP = 1;
export const WIFI_VAP_GUEST_AP = 2;

export const ConnectedStation = {
  macAddress: f(1, 'string'),
  vapType: f(2, 'enum'),
  band: f(3, 'enum'),
  rxRate: f(4, 'uint32'),
  txRate: f(5, 'uint32'),
};
export const WifiConnectedStationsGet = { stations: f(1, ConnectedStation, true) };

// --- PLC network API (`plcnet.api`) ------------------------------------------

/** Topology: 1 = LOCAL (the adapter asked), 2 = REMOTE (the others). */
export const TOPOLOGY_LOCAL = 1;
export const TOPOLOGY_REMOTE = 2;

export const PlcDevice = {
  productName: f(1, 'string'),
  productId: f(2, 'string'),
  friendlyVersion: f(3, 'string'),
  fullVersion: f(4, 'string'),
  userDeviceName: f(5, 'string'),
  userNetworkName: f(6, 'string'),
  macAddress: f(7, 'string'),
  topology: f(8, 'enum'),
  technology: f(9, 'enum'),
  bridgedDevices: f(10, 'string', true),
  ipv4Address: f(11, 'string'),
  attachedToRouter: f(12, 'bool'),
};

/** Data rates in Mbit/s, from one adapter to another. */
export const DataRate = {
  macAddressFrom: f(1, 'string'),
  macAddressTo: f(2, 'string'),
  txRate: f(3, 'double'),
  rxRate: f(4, 'double'),
};

export const LogicalNetwork = {
  devices: f(1, PlcDevice, true),
  dataRates: f(2, DataRate, true),
};
export const GetNetworkOverview = { network: f(1, LogicalNetwork) };

/** IdentifyDeviceStart: the PLC MAC address of the adapter to blink. */
export const IdentifyDevice = { macAddress: f(1, 'string') };
