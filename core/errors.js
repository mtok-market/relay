export function apiError(status, code, message, details) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  // Optional structured payload surfaced in the HTTP error body (e.g. the
  // per-leg EIP-3009 nonces a buyer must sign each leg with, #74).
  if (details !== undefined) err.details = details;
  return err;
}
