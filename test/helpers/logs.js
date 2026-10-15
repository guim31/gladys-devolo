// -----------------------------------------------------------------------------
// The lines the integration writes (the SDK logger writes through console.log
// and console.error), at a given LOG_LEVEL, for the duration of a test.
// -----------------------------------------------------------------------------

/** Captured lines, `[LEVEL] [name] message`, without the timestamp. */
export function captureLogs(t, level = 'info') {
  const lines = [];
  const previous = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = level;
  const capture = (...args) => lines.push(args.join(' ').replace(/^\[[^\]]+\] /, ''));
  t.mock.method(console, 'log', capture);
  t.mock.method(console, 'error', capture);
  t.after(() => {
    process.env.LOG_LEVEL = previous;
  });
  return lines;
}
