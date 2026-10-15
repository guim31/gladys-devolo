// -----------------------------------------------------------------------------
// The one place that opens HTTP connections to the adapters: a small request
// function over node:http, bounded in time and size, with binary bodies (the
// API speaks protobuf). It is the seam the tests replace with a simulated
// adapter (test/helpers/fakeAdapter.js).
// -----------------------------------------------------------------------------

import http from 'node:http';

export const DEFAULT_TIMEOUT_MS = 10000;
// The answers are a few hundred bytes; a network overview of a large PLC
// network stays far below this.
export const MAX_RESPONSE_BYTES = 1024 * 1024;

/**
 * @param {object} request
 * @param {string} request.method
 * @param {string} request.url absolute http:// URL
 * @param {Record<string, string>} [request.headers]
 * @param {Buffer} [request.body]
 * @param {number} [request.timeoutMs]
 * @returns {Promise<{ status: number, headers: Record<string, string>, body: Buffer }>}
 */
export function httpRequest({ method, url, headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const payload = method === 'POST' ? (body ?? Buffer.alloc(0)) : undefined;
    const req = http.request(
      target,
      {
        method,
        headers: payload ? { ...headers, 'content-length': payload.length } : headers,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            req.destroy(Object.assign(new Error('Response too large'), { code: 'ETOOBIG' }));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () => {
      req.destroy(Object.assign(new Error('Request timed out'), { code: 'ETIMEDOUT' }));
    });
    req.on('error', reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}
