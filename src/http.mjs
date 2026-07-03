import http from 'node:http';

export const MAX_BODY_BYTES = 256_000;

export function readBody(req, { maxBytes = MAX_BODY_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    // Accumulate raw Buffers and decode ONCE at the end (#419): `raw += d` on a Buffer
    // coerces each chunk through toString() independently, so a multi-byte UTF-8 codepoint
    // (emoji / CJK / accented char) straddling a TCP chunk boundary decodes as mojibake.
    // Buffer.concat + a single utf8 decode reassembles the split sequence correctly. It
    // also keeps the byte accounting honest: `bytes` counts raw bytes, matching maxBytes.
    const chunks = [];
    let bytes = 0;
    let settled = false;
    req.on('data', (d) => {
      bytes += d.length;
      if (bytes > maxBytes && !settled) {
        settled = true;
        reject(Object.assign(new Error('body_too_large'), { code: 'body_too_large' }));
        req.resume();
        return;
      }
      if (settled) return;
      chunks.push(d);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf8');
      try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); }
    });
    req.on('error', (e) => {
      if (settled) return;
      settled = true;
      reject(e);
    });
  });
}

export function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

export function startRelayServer({ config, handleFund, handleDraw }) {
  const windows = new Map();
  const windowMs = 60_000;
  const maxPerMinute = Number(config.maxRequestsPerMinute ?? 120);
  const checkRate = (req) => {
    if (!Number.isFinite(maxPerMinute)) return true;
    const key = req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    let w = windows.get(key);
    if (!w || now - w.start >= windowMs) {
      w = { start: now, count: 0 };
      windows.set(key, w);
      if (windows.size > 10_000) {
        for (const [k, v] of windows) if (now - v.start >= windowMs) windows.delete(k);
      }
    }
    w.count += 1;
    return w.count <= maxPerMinute;
  };

  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/chunk') {
      return send(res, 404, { error: 'not found' });
    }
    if (!checkRate(req)) return send(res, 429, { error: 'rate_limited' });

    let body;
    try { body = await readBody(req); } catch (e) {
      if (e?.code === 'body_too_large') return send(res, 413, { error: 'body_too_large' });
      return send(res, 400, { error: 'bad body' });
    }

    const hasFund = body.sellerTxHash != null && body.sellerTxHash !== '';
    const hasDraw = body.request != null;
    if (hasFund && hasDraw) return send(res, 400, { error: 'bad_request', detail: 'send a FUND (sellerTxHash) or a DRAW (request), not both' });
    if (hasFund) return handleFund(body, res);
    if (hasDraw) return handleDraw(body, res);
    return send(res, 400, { error: 'bad_request', detail: 'need a FUND (sellerTxHash) or a DRAW (request)' });
  });

  server.listen(config.port, () => {
    console.log(`mtok-relay: listening on port ${config.port}  offer=${config.offerId}  model=${config.model}  upstream=${config.upstream}  api=${config.apiBase}  settlement=${config.settlementAddr}`);
  });

  return server;
}
