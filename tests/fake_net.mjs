/**
 * A fake network for the page's probes, shared by the unit tests and the live test.
 *
 * Each host maps to a list of delays in ms used in turn (the last one repeats). null means
 * no answer, and "timeout" means the probe's timeout fired. The DoH resolvers answer from
 * `dns`, by name, or with a public address. A fake clock advances by each delay, so
 * timings are exact.
 */
export class FakeNet {
  /**
   * :param hosts: Host name (or "*" for any other host) to a list of delays.
   * :param dns: Domain name to a DNS-over-HTTPS JSON answer.
   */
  constructor(hosts, dns = {}) {
    this.hosts = hosts;
    this.dns = dns;
    this.time = 0;
    this.calls = [];
    this.counts = {};
    this.fetch = this.fetch.bind(this);
    this.now = () => this.time;
  }

  /**
   * Answer one request the way the browser's fetch would.
   *
   * :param url: The requested URL.
   * :return: A response stand-in.
   * :raises TypeError: For a host planned to give no answer.
   */
  async fetch(url) {
    const parsed = new URL(url);
    this.calls.push(parsed.host);
    if (parsed.host === "cloudflare-dns.com" || parsed.host === "dns.google") {
      const name = parsed.searchParams.get("name");
      const answer = this.dns[name] ?? { Status: 0, Answer: [{ type: 1, data: "203.0.113.10" }] };
      return { ok: true, json: async () => answer };
    }
    const plan = this.hosts[parsed.host] ?? this.hosts["*"] ?? [40];
    const index = this.counts[parsed.host] ?? 0;
    this.counts[parsed.host] = index + 1;
    const delay = plan[Math.min(index, plan.length - 1)];
    if (delay === null) {
      throw new TypeError("Failed to fetch");
    }
    if (delay === "timeout") {
      // What fetch throws when the probe's AbortController fires.
      throw Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
    }
    this.time += delay;
    return { ok: false, type: "opaque" };
  }
}
