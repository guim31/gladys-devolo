// The probe script is syntactically sound and refuses to run without an address.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const script = new URL('../scripts/probe.mjs', import.meta.url).pathname;

test('scripts/probe.mjs checks its argument', () => {
  const run = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /Usage: node scripts\/probe\.mjs <adapter-ip>/);
});
