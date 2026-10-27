export const PROVIDER_NAMES = { hunter: "Hunter", apollo: "Apollo" };

export class ProviderError extends Error {
  constructor(provider, code, message, status = null) {
    super(message);
    this.name = "ProviderError";
    this.provider = provider;
    this.code = code;
    this.status = status;
  }
}

/** Errors that mean "stop trying" rather than "try a different filter". */
export const FATAL_CODES = new Set([
  "auth",
  "quota",
  "rate_limited",
  "network",
  "server",
  "forbidden",
  "legal",
  "bad_response",
]);

export const defaultFetch = (...args) => globalThis.fetch(...args);

export async function requestJson({
  provider,
  url,
  method = "GET",
  headers = {},
  body,
  fetchImpl = defaultFetch,
  signal,
  mapError,
}) {
  let res;
  try {
    res = await fetchImpl(url, { method, headers, body, signal });
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    throw new ProviderError(
      provider,
      "network",
      `Couldn't reach ${PROVIDER_NAMES[provider]}. Check your internet connection and try again.`
    );
  }

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!res.ok) throw mapError(res.status, json, text);
  if (json === null || typeof json !== "object") {
    throw new ProviderError(
      provider,
      "bad_response",
      `${PROVIDER_NAMES[provider]} sent a response Scout couldn't read.`,
      res.status
    );
  }
  return json;
}
