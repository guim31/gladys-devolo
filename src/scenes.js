// -----------------------------------------------------------------------------
// Scene actions (manifest `scene_actions`, Gladys 5.1+).
//
// - enable_guest_wifi: switch the guest Wi-Fi on, on one adapter or on every
//   adapter with Wi-Fi, optionally for a number of minutes (the adapter
//   switches it off again by itself: devolo's own timer), and return its name
//   and password for a message to the guests. The core's "Control a device"
//   can flip the switch too; this action adds the timer and the outputs.
// - disable_guest_wifi: switch it off.
//
// The scene trigger (`new_wifi_device`) is fired by the hub (src/hub.js).
// -----------------------------------------------------------------------------

import { MAX_GUEST_MINUTES } from './hub.js';

/** Minutes from a number field (or a scene variable resolved to a string). */
export function minutesOf(value) {
  const minutes = Math.round(Number(String(value ?? '').replace(',', '.')));
  return Number.isFinite(minutes) && minutes > 0 ? Math.min(minutes, MAX_GUEST_MINUTES) : 0;
}

const deviceOf = (fields) =>
  typeof fields?.device === 'string' && fields.device.trim() ? fields.device.trim() : null;

export const SCENE_ACTIONS = {
  async enable_guest_wifi(hub, { fields }) {
    const entries = hub.guestWifiAdapters(deviceOf(fields));
    const minutes = minutesOf(fields?.duration_minutes);
    for (const entry of entries) {
      await hub.setGuestWifi(entry, true, minutes);
    }
    return hub.guestWifiDetails(entries[0]);
  },

  async disable_guest_wifi(hub, { fields }) {
    for (const entry of hub.guestWifiAdapters(deviceOf(fields))) {
      await hub.setGuestWifi(entry, false);
    }
    return {};
  },
};
