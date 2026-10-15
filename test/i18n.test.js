// -----------------------------------------------------------------------------
// Every text Gladys shows exists in the four languages of its interface
// (English, French, German, Spanish): the manifest, the message tables of the
// code, the feature names, the widget texts and the documentation. German
// says "du", never the polite "Sie".
// -----------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LANGUAGES } from '../src/config.js';
import { NAMES, rateName } from '../src/devices.js';
import { ERRORS, INIT_FAILED, REPORTS, STATUS } from '../src/messages.js';
import { TEXT } from '../src/widgets.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);

const LANGS = ['en', 'fr', 'de', 'es'];
const POLITE_GERMAN = /(?<!\p{L})(Sie|Ihr|Ihre|Ihren|Ihrem|Ihrer|Ihres)(?!\p{L})/u;

// Upper bounds, in characters: what the Gladys interface shows without cutting.
const MAX = {
  catalog: 100,
  widgetLabel: 30,
  label: 60,
  placeholder: 60,
  description: 400,
  message: 200,
  short: 24,
  featureName: 40,
};

const sorted = (keys) => [...keys].sort();

/** Checks one multi-language object; returns its problems. */
function problems(value, path, max) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [`${path} must be a multi-language object`];
  }
  const found = [];
  if (JSON.stringify(sorted(Object.keys(value))) !== JSON.stringify(sorted(LANGS))) {
    found.push(`${path} has [${Object.keys(value)}], expected exactly [${LANGS}]`);
  }
  for (const [lang, text] of Object.entries(value)) {
    found.push(...textProblems(text, `${path}.${lang}`, lang, max));
  }
  return found;
}

function textProblems(text, path, lang, max) {
  if (typeof text !== 'string' || text.trim() === '') {
    return [`${path} is empty`];
  }
  const found = [];
  if (text.length > max) {
    found.push(`${path} has ${text.length} characters (${max} at most)`);
  }
  if (lang === 'de' && POLITE_GERMAN.test(text)) {
    found.push(`${path} uses the polite form: "${text}"`);
  }
  return found;
}

/** Every multi-language object of the manifest, with its length limit. */
function manifestTexts(root) {
  const texts = [];
  const walk = (value, path, key) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`, key));
      return;
    }
    if (!value || typeof value !== 'object') {
      return;
    }
    const isText =
      ['label', 'description', 'placeholder'].includes(key) ||
      Object.keys(value).some((child) => LANGS.includes(child));
    if (isText) {
      const max =
        path === 'manifest.description' || /^manifest\.widgets\[\d+\]\.description$/.test(path)
          ? MAX.catalog
          : /^manifest\.widgets\[\d+\]\.label$/.test(path)
            ? MAX.widgetLabel
            : (MAX[key] ?? MAX.label);
      texts.push({ path, value, max });
      return;
    }
    for (const [child, item] of Object.entries(value)) {
      walk(item, `${path}.${child}`, child);
    }
  };
  walk(root, 'manifest', null);
  return texts;
}

// Tables written one language at a time: same keys everywhere, no empty text.
function tableProblems(table, name, max, render = (value) => value) {
  const found = [];
  if (JSON.stringify(sorted(Object.keys(table))) !== JSON.stringify(sorted(LANGS))) {
    found.push(`${name} has [${Object.keys(table)}], expected exactly [${LANGS}]`);
  }
  for (const lang of LANGS) {
    const entries = table[lang] ?? {};
    if (
      JSON.stringify(sorted(Object.keys(entries))) !== JSON.stringify(sorted(Object.keys(table.en)))
    ) {
      found.push(`${name}.${lang} does not have the keys of ${name}.en`);
    }
    for (const [key, value] of Object.entries(entries)) {
      found.push(...textProblems(render(value), `${name}.${lang}.${key}`, lang, max));
    }
  }
  return found;
}

// Renders a function entry with plausible long parameters.
const SAMPLE = {
  names:
    'devolo Magic 2 WiFi next (Salon), devolo Magic 2 LAN triple (Bureau), devolo WiFi 6 Repeater 5400…',
  name: 'devolo Magic 2 WiFi next (Bureau du premier)',
  firmware: '7.12.5.124',
  address: '192.0.2.254',
  count: 12,
  reason: 'unreachable',
};
const renderSample = (value) => (typeof value === 'function' ? value(SAMPLE) : value);

test('the configuration offers the four languages', () => {
  assert.deepEqual(LANGUAGES, LANGS);
  assert.deepEqual(Object.keys(NAMES), LANGS);
});

test('every text of the manifest is in English, French, German and Spanish', () => {
  const texts = manifestTexts(manifest);
  assert.ok(texts.length >= 50, `only ${texts.length} texts found in the manifest`);
  const found = texts.flatMap(({ path, value, max }) => problems(value, path, max));
  assert.deepEqual(found, []);
});

test('the feature names exist in every language', () => {
  const peer = 'devolo Magic 2 WiFi next (Bureau du premier étage)';
  const render = (value) =>
    value.includes('{peer}')
      ? rateName(value, peer, '53:02')
      : value.replace('{mac}', '00:00:5E:00:53:01');
  assert.deepEqual(tableProblems(NAMES, 'NAMES', MAX.featureName, render), []);
});

test('every message table of the code has the four languages', () => {
  const found = [
    ...problems(INIT_FAILED, 'INIT_FAILED', MAX.message),
    ...tableProblems(STATUS, 'STATUS', MAX.message, renderSample),
    ...tableProblems(REPORTS, 'REPORTS', MAX.message, renderSample),
    ...tableProblems(ERRORS, 'ERRORS', MAX.message, renderSample),
  ];
  assert.deepEqual(found, []);
});

test('the widget texts have the four languages and fit their component', () => {
  const longTexts = new Set(['none', 'turnedOn', 'turnedOff']);
  const found = Object.entries(TEXT).flatMap(([key, value]) =>
    problems(value, `TEXT.${key}`, longTexts.has(key) ? MAX.message : MAX.short),
  );
  assert.deepEqual(found, []);
});

test('the guard catches a missing language, an empty text and the polite German form', () => {
  assert.equal(problems({ en: 'Online', fr: 'En ligne', de: 'Online' }, 'x', 60).length, 1);
  assert.equal(problems({ en: 'a', fr: 'a', de: '', es: 'a' }, 'x', 60).length, 1);
  assert.equal(problems({ en: 'a', fr: 'a', de: 'a', es: 'a', it: 'a' }, 'x', 60).length, 1);
  assert.equal(problems({ en: 'a', fr: 'a', de: 'a'.repeat(61), es: 'a' }, 'x', 60).length, 1);
  for (const polite of ['Wählen Sie', 'Ihr Gerät', 'Ihre IP', 'mit Ihrem', 'Ihren', 'Ihrer']) {
    assert.equal(problems({ en: 'a', fr: 'a', de: polite, es: 'a' }, 'x', 60).length, 1, polite);
  }
  assert.deepEqual(
    problems({ en: 'a', fr: 'a', de: 'Siebenschläfer, ihre', es: 'a' }, 'x', 60),
    [],
  );
  const forgotten = structuredClone(manifest);
  delete forgotten.config_schema[1].placeholder.de;
  const found = manifestTexts(forgotten).flatMap(({ path, value, max }) =>
    problems(value, path, max),
  );
  assert.deepEqual(found, [
    'manifest.config_schema[1].placeholder has [en,fr,es], expected exactly [en,fr,de,es]',
  ]);
});

// --- Documentation -------------------------------------------------------------

const docs = Object.fromEntries(
  await Promise.all(
    LANGS.map(async (lang) => [
      lang,
      await readFile(new URL(`../docs/${lang}.md`, import.meta.url), 'utf8'),
    ]),
  ),
);
const headingLevels = (text) =>
  text
    .split('\n')
    .filter((line) => /^#{1,4} /.test(line))
    .map((line) => line.match(/^#+/)[0].length);

test('the documentation exists in the four languages, with the same sections', () => {
  const reference = headingLevels(docs.en);
  assert.ok(reference.filter((level) => level === 2).length >= 8, 'the template sections');
  for (const lang of LANGS) {
    assert.ok(docs[lang].length >= 3000, `docs/${lang}.md is too short`);
    assert.deepEqual(headingLevels(docs[lang]), reference, `docs/${lang}.md sections`);
  }
});

test('the documentation says the hardware was not used, and German says "du"', () => {
  assert.match(docs.en, /Developed without the hardware/);
  assert.match(docs.fr, /Développée sans le matériel/);
  assert.match(docs.de, /Ohne die Hardware entwickelt/);
  assert.match(docs.es, /Desarrollada sin el hardware/);
  const politeLines = docs.de.split('\n').filter((line) => POLITE_GERMAN.test(line));
  assert.deepEqual(politeLines, []);
});
