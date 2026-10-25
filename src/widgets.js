// -----------------------------------------------------------------------------
// Dashboard widget (manifest `widgets`, Gladys 5.1+): `plc_network`.
//
// The PLC network at a glance: how many adapters answer, how many Wi-Fi
// devices they serve, the slowest PLC link to the adapter plugged into the
// router (the one that limits the internet speed of a room), then one status
// row per adapter (its rates to the router adapter, colored by quality, or
// offline) named with the adapter at the other end of the link, including the
// older dLAN without a management API (known only through the overview of the
// others), and a button that switches the guest Wi-Fi of every adapter on or
// off, hidden by the `guest_button` setting.
//
// Budget (8 components, 6 tiles, 1 status, 4 buttons): 3 tiles, 1 status of
// 10 rows at most, 1 button; a text when no adapter is known. No MAC address
// and no password: a dashboard can be shown to visitors.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { WIDGET_KEY } from './hub.js';

export const TTL_SECONDS = 60;
export const MAX_STATUS_ROWS = 10;
// PHY rates (Mbit/s) under which a link is shown as weak, then as poor.
export const GOOD_RATE = 100;
export const WEAK_RATE = 30;
const GUEST_ACTION = 'guest_wifi';
const MAX_VALUE = 40;

export const TEXT = {
  none: {
    en: 'No devolo adapter found yet: check the configuration of the integration.',
    fr: "Aucun adaptateur devolo trouvé pour l'instant : vérifiez la configuration de l'intégration.",
    de: 'Noch kein devolo-Adapter gefunden: Prüfe die Konfiguration der Integration.',
    es: 'Aún no se ha encontrado ningún adaptador devolo: revise la configuración de la integración.',
  },
  online: { en: 'Online', fr: 'En ligne', de: 'Online', es: 'En línea' },
  wifiDevices: {
    en: 'Wi-Fi devices',
    fr: 'Appareils Wi-Fi',
    de: 'WLAN-Geräte',
    es: 'Dispositivos Wi-Fi',
  },
  slowest: {
    en: 'Slowest link',
    fr: 'Lien le plus lent',
    de: 'Langsamste Strecke',
    es: 'Enlace más lento',
  },
  offline: { en: 'Offline', fr: 'Hors ligne', de: 'Offline', es: 'Sin conexión' },
  unknown: { en: 'Unknown', fr: 'Inconnu', de: 'Unbekannt', es: 'Desconocido' },
  router: {
    en: 'Plugged into the router',
    fr: 'Branché au routeur',
    de: 'Am Router',
    es: 'Conectado al router',
  },
  update: { en: 'update', fr: 'mise à jour', de: 'Update', es: 'actualización' },
  turnOn: {
    en: 'Turn on guest Wi-Fi',
    fr: 'Activer Wi-Fi invités',
    de: 'Gast-WLAN einschalten',
    es: 'Activar Wi-Fi invitados',
  },
  turnOff: {
    en: 'Turn off guest Wi-Fi',
    fr: 'Couper Wi-Fi invités',
    de: 'Gast-WLAN ausschalten',
    es: 'Apagar Wi-Fi invitados',
  },
  turnedOn: {
    en: 'Guest Wi-Fi turned on.',
    fr: 'Wi-Fi invités activé.',
    de: 'Gast-WLAN eingeschaltet.',
    es: 'Wi-Fi de invitados activado.',
  },
  turnedOff: {
    en: 'Guest Wi-Fi turned off.',
    fr: 'Wi-Fi invités coupé.',
    de: 'Gast-WLAN ausgeschaltet.',
    es: 'Wi-Fi de invitados apagado.',
  },
};

const t = (text, language) => text[language] ?? text.en;

/** The color of a link from its rates. */
export function rateColor(rate) {
  const slowest = Math.min(rate.tx, rate.rx);
  if (slowest >= GOOD_RATE) {
    return WIDGET_COLORS.SUCCESS;
  }
  return slowest >= WEAK_RATE ? WIDGET_COLORS.WARNING : WIDGET_COLORS.DANGER;
}

/** The status row of one adapter. */
export function adapterRow(adapter, language) {
  const row = { label: String(adapter.name).slice(0, 40) };
  if (adapter.online === false) {
    return {
      ...row,
      value: t(TEXT.offline, language),
      icon: 'x-circle',
      color: WIDGET_COLORS.DANGER,
    };
  }
  if (adapter.online === null) {
    return {
      ...row,
      value: t(TEXT.unknown, language),
      icon: 'help-circle',
      color: WIDGET_COLORS.NEUTRAL,
    };
  }
  const suffix = adapter.firmwareUpdate ? ` · ${t(TEXT.update, language)}` : '';
  if (adapter.rate) {
    const tx = Math.round(adapter.rate.tx);
    const rx = Math.round(adapter.rate.rx);
    const rates = `↑ ${tx} ↓ ${rx} Mbit/s`;
    // The rates are those of the link to the router adapter: say which one,
    // in the room left (the update notice comes first).
    const room = MAX_VALUE - rates.length - suffix.length;
    const peer = adapter.peer && room > 4 ? ` ↔ ${adapter.peer}`.slice(0, room) : '';
    return {
      ...row,
      value: `${rates}${peer}${suffix}`,
      icon: 'activity',
      color: rateColor(adapter.rate),
    };
  }
  return {
    ...row,
    value: `${t(adapter.isRouter ? TEXT.router : TEXT.online, language)}${suffix}`,
    icon: adapter.isRouter ? 'home' : 'check-circle',
    color: WIDGET_COLORS.SUCCESS,
  };
}

export const WIDGETS = {
  [WIDGET_KEY]: {
    async get(hub, { language = 'en', settings }) {
      const { adapters } = hub.view();
      if (adapters.length === 0) {
        return {
          ttl_seconds: TTL_SECONDS,
          components: [{ type: 'text', variant: 'body', text: t(TEXT.none, language) }],
        };
      }
      const components = [
        {
          type: 'value',
          value: `${adapters.filter((adapter) => adapter.online).length} / ${adapters.length}`,
          label: t(TEXT.online, language),
          icon: 'power',
        },
      ];
      const wifi = adapters.filter((adapter) => adapter.wifi);
      if (wifi.length > 0) {
        components.push({
          type: 'value',
          value: wifi.reduce(
            (sum, adapter) => sum + (adapter.online ? (adapter.stations ?? 0) : 0),
            0,
          ),
          label: t(TEXT.wifiDevices, language),
          icon: 'wifi',
        });
      }
      const rates = adapters
        .filter((adapter) => adapter.online && adapter.rate)
        .map((adapter) => Math.round(Math.min(adapter.rate.tx, adapter.rate.rx)));
      if (rates.length > 0) {
        components.push({
          type: 'value',
          value: Math.min(...rates),
          unit: 'Mbit/s',
          label: t(TEXT.slowest, language),
          icon: 'activity',
        });
      }
      components.push({
        type: 'status',
        items: adapters.slice(0, MAX_STATUS_ROWS).map((adapter) => adapterRow(adapter, language)),
      });
      const guests = wifi.filter((adapter) => adapter.online && adapter.guest !== null);
      if (guests.length > 0 && settings?.guest_button !== false) {
        const allOn = guests.every((adapter) => adapter.guest);
        components.push({
          type: 'button',
          label: t(allOn ? TEXT.turnOff : TEXT.turnOn, language),
          icon: allOn ? 'wifi-off' : 'wifi',
          style: 'secondary',
          action: { key: GUEST_ACTION, params: { enable: !allOn } },
        });
      }
      return { ttl_seconds: TTL_SECONDS, components };
    },

    async action(hub, { actionKey, params }) {
      if (actionKey !== GUEST_ACTION) {
        return undefined;
      }
      const enable = params?.enable === true;
      for (const entry of hub.guestWifiAdapters()) {
        if (entry.online !== false) {
          await hub.setGuestWifi(entry, enable);
        }
      }
      return enable ? TEXT.turnedOn : TEXT.turnedOff;
    },
  },
};
