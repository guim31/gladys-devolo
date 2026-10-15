# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- devolo adapters (Magic, dLAN, WiFi Repeater) found through the mDNS search of the Gladys core,
  or at the addresses typed in the configuration, read locally through their own API.
- One device per adapter: online, PLC rate to and from every other adapter, Wi-Fi devices
  connected, firmware version and firmware update available.
- Guest Wi-Fi and LED switches, an Identify button, and a Restart button off by default.
- Presence of the Wi-Fi devices you choose, with a delay before "away".
- Scene trigger "New Wi-Fi device"; scene actions to turn the guest Wi-Fi on (optionally for a
  number of minutes, with its name and password as outputs) and off.
- Dashboard widget "devolo PLC network".
- English, French, German and Spanish, documentation included.

[Unreleased]: https://github.com/guim31/gladys-devolo/commits/main
