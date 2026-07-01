import http from 'node:http';

export const MAX_BODY_BYTES = 256_000;

export function readBody(req, { maxBytes = MAX_BODY_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    let raw = '';
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
      raw += d;
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
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
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/chunk') {
      return send(res, 404, { error: 'not found' });
    }

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
