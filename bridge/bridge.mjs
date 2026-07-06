// mtok-bridge core: the TRANSPORT guts of a model seller, with NO payment and NO market.
// Serve any model as an OpenAI-compatible API, gated by an api key. Runtime-agnostic and
// dependency-free: the request logic is pure functions; a host (the node CLI here, a CF Worker
// later, the market relay on top) adapts its req/res to them. The market layer (on-chain verify,
// fee, redemption, discovery) is a SEPARATE wrapper that calls the same serveChat guts; it is not
// in here. (#566)

// Bearer-key auth. No key configured (null/'') = OPEN on purpose (keyless mode is an explicit
// opt-in the CLI announces loudly). A configured key must match exactly.
export function checkAuth(authHeader, apiKey) {
  if (!apiKey) return true;
  const m = /^Bearer\s+(.+)$/i.exec(String(authHeader || ''));
  return !!m && m[1] === apiKey;
}

// Resolve the requested model against the served set. Empty set = pass the request through
// (the upstream decides). One-or-more served models: default to the first when none is asked,
// and reject a model we do not serve (null = not allowed).
export function pickModel(requested, models) {
  const set = Array.isArray(models) ? models.filter(Boolean) : [];
  if (!set.length) return requested || null;
  if (!requested) return set[0];
  return set.includes(requested) ? requested : null;
}

// Core chat handler. `upstream(payload)` returns an OpenAI-shaped completion (or throws). Returns
// { status, json } for the host to serialize. This is the whole free bridge; the market layer
// wraps it with a verify step in front.
export async function serveChat({ body, authHeader, apiKey, models, upstream }) {
  if (!checkAuth(authHeader, apiKey)) {
    return { status: 401, json: { error: { message: 'missing or invalid api key', type: 'auth_error' } } };
  }
  if (!body || !Array.isArray(body.messages) || !body.messages.length) {
    return { status: 400, json: { error: { message: 'messages[] is required', type: 'invalid_request_error' } } };
  }
  const model = pickModel(body.model, models);
  if (!model) {
    const served = (Array.isArray(models) ? models : []).join(', ') || '(any)';
    return { status: 400, json: { error: { message: `model "${body.model}" is not served here (served: ${served})`, type: 'invalid_request_error' } } };
  }
  let completion;
  try {
    completion = await upstream({ ...body, model });
  } catch (e) {
    return { status: 502, json: { error: { message: `upstream error: ${e?.message ?? e}`, type: 'upstream_error' } } };
  }
  return { status: 200, json: completion };
}

// Build an upstream function that forwards to any OpenAI-compatible chat/completions endpoint.
// `baseUrl` is the API root (e.g. https://api.openai.com/v1 or a local model server); `key` is
// its bearer token (optional for a keyless local server). This is what makes the bridge portable:
// point it at a provider, or at ollama / LM Studio / vLLM on localhost.
export function httpUpstream({ baseUrl, key }) {
  const url = String(baseUrl || '').replace(/\/$/, '') + '/chat/completions';
  return async (payload) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { throw new Error(`non-JSON upstream response (${res.status})`); }
    if (!res.ok) throw new Error(json?.error?.message || `upstream ${res.status}`);
    return json;
  };
}

// The SECOND upstream mode (#566): a Cloudflare Workers AI binding instead of an HTTP endpoint.
// `ai` is the Worker's `env.AI` (has `.run(model, { messages, max_tokens })`). Returns the same
// upstream(payload) contract as httpUpstream, normalizing Workers AI's output (native `{ response,
// usage }` OR an already-OpenAI-shaped `{ choices, usage }`) into a standard chat.completion, so a
// caller reads one shape no matter which upstream it composed. Leaves `id`/`created` to the caller
// (the house seller keys its id to bookingId), and passes max_tokens through only when set.
export function workersAiUpstream(ai) {
  return async (payload) => {
    const out = await ai.run(payload.model, {
      messages: payload.messages,
      ...(payload.max_tokens != null ? { max_tokens: Math.max(1, Number(payload.max_tokens)) } : {}),
    });
    const content = out?.response ?? out?.choices?.[0]?.message?.content ?? '';
    const usage = out?.usage || {};
    return {
      object: 'chat.completion',
      model: payload.model,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0,
        completion_tokens: Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0,
      },
    };
  };
}
