// -----------------------------------------------------------------------------
// Integration configuration: defaults (they mirror the `default` values of the
// manifest `config_schema`, see test/manifest.test.js) and normalization, so
// the rest of the code never deals with strings, blanks or `undefined`.
//
// Select values are strings in the manifest (stored by Gladys as typed); the
// normalized config holds numbers, in seconds.
// -----------------------------------------------------------------------------

import { isIP } from 'node:net';

export const LANGUAGES = ['en', 'fr', 'de', 'es'];

// Seconds between two reads of the adapters (LEDs, Wi-Fi, guest Wi-Fi). The
// scheduler runs in the container (devices are published with
// should_poll: false). Home Assistant reads these every 15 s.
export const POLL_INTERVALS = ['15', '30', '60', '120'];

// Seconds a Wi-Fi device may be missing before it is shown away: phones
// asleep on Wi-Fi drop off for a few minutes.
export const OFFLINE_DELAYS = ['0', '60', '180', '300', '600', '900'];

export const MAX_ADDRESSES = 20;

export const DEFAULT_CONFIG = {
  addresses: '',
  password: '',
  poll_interval: '30',
  offline_after: '180',
  allow_restart: false,
  language: 'fr',
};

const pick = (value, allowed, fallback) =>
  allowed.includes(String(value)) ? Number(value) : Number(fallback);
const bool = (value) => value === true || value === 'true' || value === 1 || value === '1';

/** `192.0.2.10, 192.0.2.11; http://192.0.2.12/` → the valid IP addresses, deduplicated. */
export function parseAddresses(value) {
  const addresses = [];
  for (let token of String(value ?? '').split(/[\s,;]+/)) {
    token = token.trim();
    if (!token) {
      continue;
    }
    try {
      if (/^[a-z]+:\/\//i.test(token)) {
        token = new URL(token).hostname;
      }
    } catch {
      continue;
    }
    token = token.replace(/^\[|\]$/g, '').replace(/\/.*$/, '');
    if (isIP(token) && !addresses.includes(token)) {
      addresses.push(token);
    }
  }
  return addresses.slice(0, MAX_ADDRESSES);
}

/**
 * @param {Record<string, unknown>} raw the configuration returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    addresses: parseAddresses(source.addresses),
    // Passwords may legitimately start or end with a space.
    password: typeof source.password === 'string' ? source.password : '',
    pollInterval: pick(source.poll_interval, POLL_INTERVALS, DEFAULT_CONFIG.poll_interval),
    offlineAfter: pick(source.offline_after, OFFLINE_DELAYS, DEFAULT_CONFIG.offline_after),
    allowRestart: bool(source.allow_restart),
    language: LANGUAGES.includes(source.language) ? source.language : DEFAULT_CONFIG.language,
  };
}
