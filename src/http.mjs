import http from 'node:http';
import { isIP } from 'node:net';
import { createLimiter } from '../core/limiter.js';

export const MAX_BODY_BYTES = 256_000;

export function readBody(req, { maxBytes = MAX_BODY_BYTES, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    // Accumulate raw Buffers and decode ONCE at the end (#419): `raw += d` on a Buffer
    // coerces each chunk through toString() independently, so a multi-byte UTF-8 codepoint
    // (emoji / CJK / accented char) straddling a TCP chunk boundary decodes as mojibake.
    // Buffer.concat + a single utf8 decode reassembles the split sequence correctly. It
    // also keeps the byte accounting honest: `bytes` counts raw bytes, matching maxBytes.
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chunks.length = 0;
      reject(error);
    };
    const timer = setTimeout(() => fail(Object.assign(new Error('body_timeout'), { code: 'body_timeout' })), timeoutMs);
    req.on('data', (d) => {
      bytes += d.length;
      if (bytes > maxBytes && !settled) {
        fail(Object.assign(new Error('body_too_large'), { code: 'body_too_large' }));
        req.resume();
        return;
      }
      if (settled) return;
      chunks.push(d);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const raw = Buffer.concat(chunks).toString('utf8');
      try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); }
    });
    req.on('error', fail);
    req.on('aborted', () => fail(new Error('body_aborted')));
  });
}

export function send(res, status, body) {
  if (res.destroyed || res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function canonicalIp(value) {
  if (typeof value !== 'string' || value.includes('%') || !isIP(value)) return null;
  if (isIP(value) === 4) return value;
  const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([\da-f]+):([\da-f]+)$/.exec(canonical);
  if (mapped) return mapped.slice(1).flatMap(word => [parseInt(word, 16) >> 8, parseInt(word, 16) & 255]).join('.');
  return canonical;
}

export function clientRateKey(req, trustedProxies = new Set(), header = 'cf-connecting-ip') {
  const peer = canonicalIp(req.socket.remoteAddress) ?? 'unknown';
  // A trusted proxy must overwrite this single-address header, never append it.
  const forwarded = trustedProxies.has(peer) ? canonicalIp(req.headers[header]) : null;
  const address = forwarded ?? peer;
  if (!address.includes(':')) return address;
  const [left, right] = address.split('::');
  const start = left ? left.split(':') : [];
  const end = right ? right.split(':') : [];
  const words = right === undefined ? start : [...start, ...Array(8 - start.length - end.length).fill('0'), ...end];
  return words.slice(0, 4).map(word => word.padStart(4, '0')).join(':') + '::/64';
}

export function startRelayServer({ config, handleDraw, handleQuote }) {
  const callers = createLimiter({ max: config.maxRequestsPerMinute ?? 120 });
  const aggregate = createLimiter({ max: config.maxTotalRequestsPerMinute ?? 1200 });
  const trustedProxies = new Set((config.trustedProxies ?? []).map(canonicalIp).filter(Boolean));
  const maxConcurrent = config.maxConcurrentRequests ?? 64;
  let active = 0;

  const server = http.createServer({ headersTimeout: 10_000, requestTimeout: 15_000, connectionsCheckingInterval: 1000 }, async (req, res) => {
    const refuse = (status, error) => {
      if (res.headersSent || res.destroyed) return res.destroy();
      res.setHeader('connection', 'close');
      res.once('finish', () => req.destroy());
      send(res, status, { error });
    };
    if (req.method !== 'POST' || !['/chunk', '/quote'].includes(req.url)) {
      return refuse(404, 'not found');
    }
    try {
      callers.check(clientRateKey(req, trustedProxies, config.clientIpHeader ?? 'cf-connecting-ip'));
      aggregate.check('all');
    } catch {
      res.setHeader('retry-after', '60');
      return refuse(429, 'rate_limited');
    }
    if (active >= maxConcurrent) return refuse(503, 'relay_busy');
    active++;
    try {
      let body;
      try { body = await readBody(req, { timeoutMs: config.bodyTimeoutMs ?? 10_000 }); } catch (e) {
        if (e?.code === 'body_too_large') return refuse(413, 'body_too_large');
        if (e?.code === 'body_timeout') return refuse(408, 'relay_timeout');
        return refuse(400, 'bad body');
      }
      if (body?.request == null) {
        return send(res, 400, { error: 'bad_request', detail: 'need a DRAW (request); the legacy FUND lane is retired, pay per draw on-chain' });
      }
      await (req.url === '/quote' ? handleQuote : handleDraw)(body, res);
    } catch (error) {
      (config.log ?? console).error?.(`mtok relay: request failed (${error.message})`);
      refuse(503, 'relay_unavailable');
    } finally {
      active--;
    }
  });
  server.maxConnections = maxConcurrent * 2;
  server.maxRequestsPerSocket = 100;

  server.listen(config.port, () => {
    console.log(`mtok-relay: listening on port ${config.port}  offer=${config.offerId}  model=${config.model}  upstream=${config.upstream}  api=${config.apiBase}  settlement=${config.settlementAddr}`);
  });

  return server;
}
