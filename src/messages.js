// -----------------------------------------------------------------------------
// Texts sent from the container (connection status, action messages, errors),
// in the four languages of the Gladys interface. Entries are strings or
// functions of one parameter object. German says "du", Spanish "usted".
// -----------------------------------------------------------------------------

export const INIT_FAILED = {
  en: 'Initialization failed, check the integration logs.',
  fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
  de: 'Initialisierung fehlgeschlagen, sieh dir die Protokolle der Integration an.',
  es: 'La inicialización ha fallado, consulte los registros de la integración.',
};

// Connection status shown in the Configuration screen (keys: src/hub.js).
export const STATUS = {
  en: {
    none: 'No devolo adapter found: check that they are on the same network as Gladys, or enter their addresses in the configuration.',
    auth: ({ names }) =>
      `${names} refused the password: enter the one of the devolo Home Network app in the configuration.`,
    unreachable: ({ names }) => `No answer from ${names}.`,
  },
  fr: {
    none: "Aucun adaptateur devolo trouvé : vérifiez qu'ils sont sur le même réseau que Gladys, ou saisissez leurs adresses dans la configuration.",
    auth: ({ names }) =>
      `${names} a refusé le mot de passe : saisissez celui de l'app devolo Home Network dans la configuration.`,
    unreachable: ({ names }) => `Pas de réponse de ${names}.`,
  },
  de: {
    none: 'Kein devolo-Adapter gefunden: Prüfe, ob sie im selben Netzwerk wie Gladys sind, oder gib ihre Adressen in der Konfiguration ein.',
    auth: ({ names }) =>
      `${names} hat das Kennwort abgelehnt: Gib das aus der App devolo Home Network in der Konfiguration ein.`,
    unreachable: ({ names }) => `Keine Antwort von ${names}.`,
  },
  es: {
    none: 'No se ha encontrado ningún adaptador devolo: compruebe que están en la misma red que Gladys o introduzca sus direcciones en la configuración.',
    auth: ({ names }) =>
      `${names} ha rechazado la contraseña: introduzca la de la app devolo Home Network en la configuración.`,
    unreachable: ({ names }) => `Sin respuesta de ${names}.`,
  },
};

// Report of the "Search the adapters" action.
export const REPORTS = {
  en: {
    found: ({ count }) => `${count} devolo adapter(s):`,
    adapter: ({ name, firmware, address }) => `${name} (firmware ${firmware}) at ${address}`,
    ok: 'answers.',
    auth: 'refuses the password.',
    unreachable: 'does not answer.',
    discover: 'Open the Discover tab to add them.',
  },
  fr: {
    found: ({ count }) => `${count} adaptateur(s) devolo :`,
    adapter: ({ name, firmware, address }) => `${name} (firmware ${firmware}) à ${address}`,
    ok: 'répond.',
    auth: 'refuse le mot de passe.',
    unreachable: 'ne répond pas.',
    discover: "Ouvrez l'onglet Découverte pour les ajouter.",
  },
  de: {
    found: ({ count }) => `${count} devolo-Adapter:`,
    adapter: ({ name, firmware, address }) => `${name} (Firmware ${firmware}) unter ${address}`,
    ok: 'antwortet.',
    auth: 'lehnt das Kennwort ab.',
    unreachable: 'antwortet nicht.',
    discover: 'Öffne den Tab „Entdecken“, um sie hinzuzufügen.',
  },
  es: {
    found: ({ count }) => `${count} adaptador(es) devolo:`,
    adapter: ({ name, firmware, address }) => `${name} (firmware ${firmware}) en ${address}`,
    ok: 'responde.',
    auth: 'rechaza la contraseña.',
    unreachable: 'no responde.',
    discover: 'Abra la pestaña Descubrir para añadirlos.',
  },
};

// Errors of the commands and of the scene actions, in the configured language
// (a scene action does not receive the user's language).
export const ERRORS = {
  en: {
    unknownDevice: 'This device does not belong to the devolo integration, or is not found yet.',
    notAdapter: 'Choose a devolo adapter with Wi-Fi.',
    noWifi: 'No devolo adapter with Wi-Fi is known.',
    offline: ({ name }) => `${name} does not answer.`,
    auth: ({ name }) => `${name} refused the password.`,
    failed: ({ name, reason }) => `${name} refused the command (${reason}).`,
    restartDisabled:
      'Restarting an adapter is disabled: allow it in the configuration of the integration.',
  },
  fr: {
    unknownDevice:
      "Cet appareil n'appartient pas à l'intégration devolo, ou n'est pas encore trouvé.",
    notAdapter: 'Choisissez un adaptateur devolo avec Wi-Fi.',
    noWifi: "Aucun adaptateur devolo avec Wi-Fi n'est connu.",
    offline: ({ name }) => `${name} ne répond pas.`,
    auth: ({ name }) => `${name} a refusé le mot de passe.`,
    failed: ({ name, reason }) => `${name} a refusé la commande (${reason}).`,
    restartDisabled:
      "Le redémarrage d'un adaptateur est désactivé : autorisez-le dans la configuration de l'intégration.",
  },
  de: {
    unknownDevice:
      'Dieses Gerät gehört nicht zur Integration devolo oder wurde noch nicht gefunden.',
    notAdapter: 'Wähle einen devolo-Adapter mit WLAN.',
    noWifi: 'Kein devolo-Adapter mit WLAN bekannt.',
    offline: ({ name }) => `${name} antwortet nicht.`,
    auth: ({ name }) => `${name} hat das Kennwort abgelehnt.`,
    failed: ({ name, reason }) => `${name} hat den Befehl abgelehnt (${reason}).`,
    restartDisabled:
      'Der Neustart eines Adapters ist deaktiviert: Erlaube ihn in der Konfiguration der Integration.',
  },
  es: {
    unknownDevice:
      'Este dispositivo no pertenece a la integración devolo o aún no se ha encontrado.',
    notAdapter: 'Elija un adaptador devolo con Wi-Fi.',
    noWifi: 'No se conoce ningún adaptador devolo con Wi-Fi.',
    offline: ({ name }) => `${name} no responde.`,
    auth: ({ name }) => `${name} ha rechazado la contraseña.`,
    failed: ({ name, reason }) => `${name} ha rechazado la orden (${reason}).`,
    restartDisabled:
      'El reinicio de un adaptador está desactivado: permítalo en la configuración de la integración.',
  },
};

/** A message table entry, rendered in every language. */
export function render(table, key, params = {}) {
  return Object.fromEntries(
    Object.entries(table).map(([language, entries]) => {
      const entry = entries[key];
      return [language, typeof entry === 'function' ? entry(params) : entry];
    }),
  );
}

/** Join several rendered messages, language by language. */
export function join(...messages) {
  return Object.fromEntries(
    Object.keys(messages[0]).map((language) => [
      language,
      messages.map((message) => message[language]).join(' '),
    ]),
  );
}

export class GladysError extends Error {
  /** An error whose message is a multi-language object (shown in Gladys). */
  constructor(message, language = 'en') {
    super(message[language] ?? message.en);
    this.messages = message;
  }
}
