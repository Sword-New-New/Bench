// Did a wake fail because the network dropped, not because of anything the
// seat or its client did? Those are worth trying again by themselves
// (lib/summon.ts retries them). The whole list is here, in one place.
//
// Matched against the failure line, the client's last error step and its
// last words. Not on the list on purpose: usage limits (they have their own
// card), the user pressing stop, permission refusals, auth errors (401/403:
// trying again gives the same answer), bad requests.
const NETWORK = [
  // Node / libc errno names
  /\bECONNRESET\b/,
  /\bECONNREFUSED\b/,
  /\bECONNABORTED\b/,
  /\bETIMEDOUT\b/,
  /\bEPIPE\b/,
  /\bEHOSTUNREACH\b/,
  /\bENETUNREACH\b/,
  /\bENETDOWN\b/,
  /\bEAI_AGAIN\b/,
  /\bENOTFOUND\b/,
  /\bUND_ERR_(?:SOCKET|CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT)\b/,
  // The same said in words (socat, curl, the clients' own messages)
  /socket hang up/i,
  /connection (?:reset|refused|closed|aborted|terminated)/i,
  /reset by peer/i,
  /broken pipe/i,
  /connection error/i,
  /network (?:error|is unreachable)|network issue connecting/i,
  /fetch failed/i,
  /getaddrinfo/i,
  /could not resolve host/i,
  /timed? ?out (?:while|waiting)|request timed out|connect(?:ion)? timed out/i,
  // Codex / Antigravity / Rust reqwest / Go transport errors on Windows & relays
  /stream disconnected/i,
  /error sending request/i,
  /error decoding response body/i,
  /tcp connect error/i,
  /http2 error/i,
  /unexpected eof/i,
  /(?:error|status|message).*?:\s*EOF\b/i,
  /transport:\s*error while dialing/i,
  /no connection could be made|actively refused/i,
  /upstream connect error/i,
  // TLS dropped halfway (seen when the proxy changes under the room)
  /socket disconnected before secure TLS/i,
  /\bTLS\b.*(?:disconnect|handshake|closed|reset)/i,
  /\bSSL_ERROR_SYSCALL\b|unexpected eof while reading/i,
  // A gateway in between, or the service briefly overloaded
  /\b(?:502|504)\b.*(?:gateway|unavailable|timeout)/i,
  /\b(?:bad gateway|gateway time-?out)\b/i,
  /\bOverloaded\b/,
]

const CAPACITY_PATTERNS = [
  /\bno capacity available\b/i,
  /\bservice unavailable\b/i,
  /\b(?:unavailable|overloaded)\b.*\b(?:503|529)\b/i,
  /\b(?:503|529)\b.*(?:unavailable|overloaded|capacity|service unavailable)/i,
  /\boverloaded_error\b/i,
]

export function isNetworkFailure(...texts: (string | undefined)[]) {
  return texts.some(
    (text) =>
      text &&
      (NETWORK.some((pattern) => pattern.test(text)) ||
        CAPACITY_PATTERNS.some((pattern) => pattern.test(text))),
  )
}

/** Return `{ model }` when upstream reports a 503/529 capacity or overload error, else null. */
export function capacityFailure(...texts: (string | undefined)[]): { model?: string } | null {
  for (const text of texts) {
    if (!text || !CAPACITY_PATTERNS.some((pattern) => pattern.test(text))) continue
    const model = text.match(/\bfor model\s+([^\s,;:'"()（）]+)/i)?.[1]
    return model ? { model } : {}
  }
  return null
}

// How many times, and how long to wait before each.
// BENCH_RETRY_MS="200,500" shortens them for tests.
export function retryDelays() {
  const set = process.env.BENCH_RETRY_MS?.split(",").map(Number).filter((n) => Number.isFinite(n) && n >= 0)
  return set && set.length > 0 ? set : [20_000, 60_000]
}
