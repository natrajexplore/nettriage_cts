// Network probes that run in the visitor's own browser.
//
// Every probe here is ordinary page code: the page's own buttons call the same functions
// as the assistant. Nothing is sent to a NetTriage server (there is none). The probes
// contact only the public endpoints listed in ENDPOINTS and RESOLVERS, plus a website the
// visitor names and confirms in a site check.

/**
 * Public endpoints the checkup times. One is an IP address, so a failing system DNS
 * shows up as "the IP endpoint answers but the named ones do not".
 */
export const ENDPOINTS = [
  { id: "google", label: "Google", url: "https://www.gstatic.com/generate_204", usesDns: true },
  { id: "cloudflare_ip", label: "Cloudflare (by IP address 1.1.1.1)", url: "https://1.1.1.1/cdn-cgi/trace", usesDns: false },
  { id: "microsoft", label: "Microsoft", url: "https://www.microsoft.com/favicon.ico", usesDns: true },
  { id: "wikipedia", label: "Wikipedia", url: "https://www.wikipedia.org/static/favicon/wikipedia.ico", usesDns: true },
];

/**
 * Public DNS-over-HTTPS resolvers that allow browser requests (CORS). Used to ask
 * "does this domain exist on the public internet?" for a site check.
 */
export const RESOLVERS = [
  { id: "cloudflare", label: "Cloudflare DNS", url: "https://cloudflare-dns.com/dns-query" },
  { id: "google", label: "Google Public DNS", url: "https://dns.google/resolve" },
];

/** Samples per endpoint. The first includes DNS and connection setup; later ones reuse it. */
export const SAMPLES = 3;

/** Per-request timeout. */
export const TIMEOUT_MS = 5000;

/**
 * Low-level probe functions. fetchImpl and now are injectable so tests run offline.
 */
export class Probes {
  /**
   * :param fetchImpl: A fetch-compatible function.
   * :param now: A function returning a high-resolution time in milliseconds.
   */
  constructor(fetchImpl, now) {
    this.fetchImpl = fetchImpl;
    this.now = now;
  }

  /**
   * Time one request. no-cors mode: the response body is opaque, but whether the
   * server answered, and how fast, is still visible. No cookies are sent.
   *
   * :param url: The URL to request.
   * :return: {ok, ms} or {ok: false, error}.
   */
  async timeOnce(url) {
    const controller = new AbortController();
    const timer = setTimeout(controller.abort.bind(controller), TIMEOUT_MS);
    const start = this.now();
    try {
      await this.fetchImpl(url, {
        mode: "no-cors",
        cache: "no-store",
        credentials: "omit",
        redirect: "follow",
        signal: controller.signal,
      });
      return { ok: true, ms: Math.round(this.now() - start) };
    } catch (error) {
      const timedOut = error && error.name === "AbortError";
      return { ok: false, error: timedOut ? "timeout" : "no response" };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Time up to SAMPLES requests to one endpoint, one after another. After a timeout the
   * endpoint gets no more requests: on a network that drops packets, every request would
   * wait the full TIMEOUT_MS, and a checkup must finish well inside its action timeout.
   *
   * :param endpoint: An entry like those in ENDPOINTS.
   * :return: A summary with first, median of the repeats, jitter and failures.
   */
  async timeEndpoint(endpoint) {
    const samples = [];
    for (let index = 0; index < SAMPLES; index += 1) {
      const sample = await this.timeOnce(endpoint.url);
      samples.push(sample);
      if (!sample.ok && sample.error === "timeout") {
        break;
      }
    }
    return Probes.summarize(endpoint, samples);
  }

  /**
   * Summarize samples. Pure, so tests can check the arithmetic.
   *
   * The first request includes DNS and connection setup, so it is reported apart
   * (firstMs) and left out of the median and the jitter. Otherwise an ordinary TLS
   * handshake would look like an unstable connection.
   *
   * :param endpoint: The endpoint the samples are for.
   * :param samples: The results of timeOnce, in order.
   * :return: The summary.
   */
  static summarize(endpoint, samples) {
    const okTimes = samples.filter((sample) => sample.ok).map((sample) => sample.ms);
    const repeats = samples.slice(1).filter((sample) => sample.ok).map((sample) => sample.ms);
    const sorted = [...repeats].sort((a, b) => a - b);
    const median = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null;
    return {
      id: endpoint.id,
      label: endpoint.label,
      host: new URL(endpoint.url).host,
      usesDns: endpoint.usesDns,
      sent: samples.length,
      answered: okTimes.length,
      firstMs: samples[0] && samples[0].ok ? samples[0].ms : null,
      medianMs: median,
      jitterMs: repeats.length > 1 ? Math.max(...repeats) - Math.min(...repeats) : null,
      errors: samples.filter((sample) => !sample.ok).map((sample) => sample.error),
    };
  }

  /**
   * Resolve a domain's A records through one public DNS-over-HTTPS resolver.
   *
   * :param resolver: An entry like those in RESOLVERS.
   * :param domain: A validated host name.
   * :return: {resolver, status: "resolved"|"not_found"|"no_answer"|"error", addresses}.
   */
  async resolve(resolver, domain) {
    const url = `${resolver.url}?name=${encodeURIComponent(domain)}&type=A`;
    const controller = new AbortController();
    const timer = setTimeout(controller.abort.bind(controller), TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(url, {
        headers: { accept: "application/dns-json" },
        cache: "no-store",
        credentials: "omit",
        signal: controller.signal,
      });
      if (!response.ok) {
        return { resolver: resolver.label, status: "error", addresses: [] };
      }
      const body = await response.json();
      const addresses = (body.Answer || [])
        .filter((answer) => answer.type === 1)
        .map((answer) => String(answer.data));
      let status = "no_answer";
      if (body.Status === 3) {
        status = "not_found";
      } else if (addresses.length) {
        status = "resolved";
      }
      return { resolver: resolver.label, status: status, addresses: addresses.slice(0, 4) };
    } catch (error) {
      return { resolver: resolver.label, status: "error", addresses: [] };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Name endings that never reach a public website: loopback, local network and
 * reserved names (RFC 6761, RFC 8375, and common home and office router names).
 */
export const LOCAL_SUFFIXES = ["localhost", "local", "internal", "lan", "home", "home.arpa", "intranet", "corp", "localdomain", "test", "invalid", "example.local"];

/**
 * Check that text is a plain public host name, such as "example.com". Pure.
 * International names such as "bücher.de" are converted to their DNS form
 * ("xn--bcher-kva.de").
 *
 * :param text: What the visitor typed.
 * :return: {ok: true, host} or {ok: false, reason}.
 */
export function normalizeHost(text) {
  let host = String(text || "").trim().toLowerCase();
  host = host.replace(/^https?:\/\//, "").replace(/[/?#].*$/, "").replace(/\.$/, "");
  if (!host) {
    return { ok: false, reason: "Enter a website address, such as example.com." };
  }
  if (/[^\x00-\x7f]/.test(host) && !/[\s@:]/.test(host)) {
    try {
      host = new URL(`http://${host}`).hostname;
    } catch (error) {
      // Not a valid international name; the check below gives the reason.
    }
  }
  if (host.length > 253 || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) {
    return { ok: false, reason: `"${String(text).trim().slice(0, 60)}" is not a website address. Use a name such as example.com.` };
  }
  for (const label of host.split(".")) {
    if (label.length > 63 || label.startsWith("-") || label.endsWith("-")) {
      return { ok: false, reason: `"${host}" is not a valid website address.` };
    }
  }
  const local = LOCAL_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  if (/^[0-9.]+$/.test(host) || local) {
    return { ok: false, reason: "NetTriage checks public websites by name only, not IP addresses or devices on your own network." };
  }
  return { ok: true, host: host };
}

/**
 * Whether an IPv4 address is on the public internet. Private, loopback, link-local,
 * carrier-grade NAT, multicast and reserved ranges are not. Pure.
 *
 * :param address: A dotted IPv4 address, as DNS-over-HTTPS returns it.
 * :return: True for a public address; false otherwise, and for text that is not IPv4.
 */
export function isPublicIPv4(address) {
  const parts = String(address).split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) {
    return false;
  }
  const [a, b] = parts.map(Number);
  const blocked = a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19));
  return !blocked;
}
