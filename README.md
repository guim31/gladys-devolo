# devolo Home Network for Gladys Assistant

An external integration for [Gladys Assistant](https://gladysassistant.com) that follows and
controls **devolo powerline (PLC) adapters**: devolo Magic, dLAN and WiFi Repeater. The equivalent
of the Home Assistant **devolo Home Network** (`devolo_home_network`) integration. Everything
stays local: the adapters' own API (the one of the devolo Home Network app), protobuf over HTTP.
No cloud, no account.

> **Developed without the hardware: feedback welcome.** The protocol client is covered by
> automated tests against a simulated devolo network, its protobuf codec is checked against bytes
> produced by the reference protobuf library from the Home Assistant test fixtures, but it has not
> run against a real adapter yet. Please report what works and what does not in the
> [issues](https://github.com/guim31/gladys-devolo/issues). `scripts/probe.mjs` (below) reads a
> real adapter without changing anything.

## Features

- **One device per adapter**: **Online**, the **PLC rate to and from every other adapter** of the
  network (Mbit/s, with history), the number of **Wi-Fi devices** connected to it, the **Firmware**
  version and **Firmware update available**.
- **Commands**: **Guest Wi-Fi** and **LEDs** switches, **Identify** (the adapter blinks), and
  **Restart**, off by default (a configuration option adds the button).
- **Presence**: the Wi-Fi devices you choose in the Discover tab become presence sensors, home
  while connected to a devolo adapter, away after a delay (3 minutes by default).
- **Discovery**: the adapters are found through the mDNS search of the Gladys core
  (`_dvl-deviceapi._tcp`, `_dvl-plcnetapi._tcp`), or at the addresses you type (asked in unicast
  mDNS). Stable identity: the serial number of each adapter and the MAC address of each Wi-Fi
  device. An adapter that changes address is found again.
- **Scene trigger** _New Wi-Fi device_ (a device never seen before joins a devolo Wi-Fi, main or
  guest).
- **Scene actions** _Turn on the guest Wi-Fi_ (optionally for a number of minutes, by the
  adapter's own timer, with the Wi-Fi name and password as outputs) and _Turn off the guest
  Wi-Fi_.
- **Dashboard widget** _devolo PLC network_: adapters online, Wi-Fi devices, the slowest link to
  the router, one row per adapter with its rates colored by quality, and a guest Wi-Fi button. No
  MAC address nor password on the dashboard.
- English, French, German and Spanish.

## Requirements

- Gladys Assistant **5.1.0** or later.
- devolo adapters with the devolo Home Network API (devolo Magic 1 and 2, dLAN 1200+/550+ WiFi,
  devolo WiFi Repeaters). Older dLAN adapters without the API show up as peers of the others only.
- The adapters on the same network as Gladys, or their addresses typed in the configuration.
- The device password if one is set in the devolo Home Network app.

## Installation

1. In Gladys, open **Integrations → Install from GitHub** and enter
   `https://github.com/guim31/gladys-devolo` (or install it from the catalog once it is listed).
   The install screen shows the access the integration asks for: the **mDNS search for
   `_dvl-deviceapi._tcp` and `_dvl-plcnetapi._tcp`** (to find the adapters).
2. In **Configuration**, type the device password if you set one, then run **Search the
   adapters**.
3. Open the **Discover** tab and press **Add to Gladys** on the adapters and on the Wi-Fi devices
   to follow.

The user guide is in [`docs/en.md`](docs/en.md) ([français](docs/fr.md), [Deutsch](docs/de.md),
[español](docs/es.md)); Gladys links it from the Configuration screen.

## How it works

```
Integration container ──HTTP, protobuf, Digest auth (user "devolo")──▶ adapter Device API
      │                ──HTTP, protobuf──────────────────────────────▶ adapter PLC network API
      │                ──unicast DNS query, UDP 5353 (typed addresses)▶ adapter
      │ SDK (WebSocket + host API)
      ▼
Gladys core (host network) ──mDNS browse _dvl-deviceapi._tcp / _dvl-plcnetapi._tcp──▶ LAN
```

- Each adapter announces in mDNS where its APIs live (port, path, version) and what it supports
  (`led`, `wifi1`, `update`, `restart`…). The container is on a bridge network and never sees
  multicast: the core browses for it. For a typed address, the container asks the adapter's port
  5353 in unicast ("legacy unicast", as the devolo Python library does). What was found is kept in
  `/data/state.json`, so a restart does not depend on a new search.
- The client is written on `node:http` and a 200-line protobuf codec (no dependency). It sends the
  same requests as the devolo library and Home Assistant: `LedSettingsGet/Set`,
  `WifiGuestAccessGet/Set`, `WifiConnectedStationsGet`, `UpdateFirmwareCheck`, `UptimeGet`,
  `Restart`, `GetNetworkOverview`, `IdentifyDeviceStart`. A refused password is tried once as its
  SHA-256, as some firmwares expect.
- Devices are published with `should_poll: false` (the core does not poll external devices
  reliably, GladysAssistant/Gladys#3198): the integration reads the adapters itself, one request at
  a time, every 30 s by default; the PLC overview every 5 minutes; the firmware check every 6 hours.
  Only the changes are published, plus every value every 12 hours so that a stable value never
  shows "No recent value".
- Passwords and the guest Wi-Fi key are never logged. A normal read cycle writes nothing at the
  info level; a repeated failure writes one line when it starts and one when it ends.

## Limitations

- **Developed without the hardware**: see above.
- Presence only sees the devices connected to a devolo Wi-Fi, by MAC address (no host name): a
  phone with a random private Wi-Fi address must use its real one on the home network.
- One device password for every adapter.
- Firmware installation, pairing, WPS and the Wi-Fi settings stay in the devolo Home Network app.
- devolo Home Control gateways are not supported.
- The rates are the PHY rates reported by the adapters, not the real throughput.

## Development

Node.js 22+, ESM, no build step. The only runtime dependency is
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js).

```bash
npm install
npm test              # node --test: unit tests + the SDK's fake Gladys and a simulated devolo network
npm run lint
npm run format:check
npx github:GladysAssistant/integration-store --skip-image-check .   # store validator
node scripts/probe.mjs 192.168.1.20   # read-only probe of a real adapter (DEVOLO_PASSWORD=…)
```

```
index.js                SDK wiring (src/app.js registers the handlers)
src/app.js              handlers → hub, configuration action
src/hub.js              adapters, read cycle, states, presence, scene event, commands
src/devolo/client.js    client of one adapter (Device API, PLC network API, Digest, errors)
src/devolo/mdns.js      mDNS records → adapters; unicast DNS query
src/devolo/protobuf.js  minimal protobuf codec
src/devolo/schema.js    the API messages
src/devolo/digest.js    HTTP Digest authentication
src/devolo/http.js      the one place that opens HTTP connections
src/devices.js          Gladys devices (adapters, Wi-Fi devices), names in four languages
src/scenes.js           scene actions
src/widgets.js          dashboard widget
src/messages.js         texts sent from the container, four languages
src/problems.js         repeated failures logged once
src/store.js            /data persistence
src/config.js           configuration defaults and normalization
scripts/probe.mjs       read-only probe of a real adapter
```

## Credits

- [devolo_plc_api](https://github.com/2Fake/devolo_plc_api) (GPL-3.0, Markus Bong, Guido
  Schmitz and contributors): the reference for the protocol (mDNS records, endpoints, message definitions,
  password hashing). Read to understand the protocol; no code was copied.
- [Home Assistant](https://www.home-assistant.io) ([`devolo_home_network`](https://www.home-assistant.io/integrations/devolo_home_network/),
  Apache-2.0): what users expect from this integration (refresh pace, features), and the values of
  its tests used as fixtures (`test/fixtures/devolo/`).

Not affiliated with devolo. devolo, devolo Magic and dLAN are trademarks of devolo Solutions GmbH.

## License

Apache-2.0, see [LICENSE](LICENSE).
