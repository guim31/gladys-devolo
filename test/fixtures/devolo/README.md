# devolo fixtures

- `mdns-scan.json`: mDNS records in the format of the core's mediated scan
  (`[{ name, host, addresses, port, txt }]`). The first adapter's TXT record is
  the `DISCOVERY_INFO` of the Home Assistant tests
  (`tests/components/devolo_home_network/const.py`, Apache 2.0), with the
  path of the PLC network API set next to the Device API one
  (`…/plcnetapi`, an assumption: no capture of that record was published).
  The Magic 2 LAN, the Wi-Fi repeater and the Home Control gateway follow the
  same shape; their MT numbers come from the devolo library
  (`DEVICES_WITHOUT_PLCNET`, the Home Control check of Home Assistant).
- `protobuf.json`: protobuf messages (base64) encoded with the reference
  protobuf library from the message definitions the adapters speak, holding
  the values of the Home Assistant test fixtures (`PLCNET`,
  `CONNECTED_STATIONS`, `GUEST_WIFI`, `FIRMWARE_UPDATE_AVAILABLE`, `UPTIME`,
  `NEIGHBOR_ACCESS_POINTS`) plus a few requests. They pin the integration's
  codec to the real encoding.

Everything is anonymized: documentation addresses (`192.0.2.x`), MAC
addresses of the documentation range (`00:00:5E:00:53:xx`), invented serial
numbers. No capture of a real adapter was available.
