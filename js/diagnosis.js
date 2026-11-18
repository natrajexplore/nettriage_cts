import { isPublicIPv4 } from "./probes.js";

// Deterministic diagnosis rules. The assistant explains these verdicts; it never makes
// them up. Keep every threshold here, so the page and the assistant agree.

export const THRESHOLDS = {
  slowMedianMs: 300,
  unstableJitterMs: 250,
  slowSetupGapMs: 1000,
};

/**
 * Verdict codes, with the plain-language headline the page shows.
 */
export const VERDICTS = {
  offline: "Your device is not connected to any network.",
  no_internet: "Your device is on a network, but nothing on the internet answered. The problem is likely your router, modem or internet provider.",
  dns_problem: "The internet answers by IP address, but website names are not being looked up. This is a DNS problem.",
  unstable: "Your connection works but is dropping or wobbling. Some requests failed or times varied a lot.",
  slow: "Your connection works but is slow to respond.",
  slow_setup: "Repeat requests are fast, but each new connection is slow to start. Name lookups (DNS) or connection setup are slow.",
  healthy: "Your connection looks healthy from this browser.",
  site_not_found: "This website name does not exist on the public internet. Check the spelling.",
  site_no_answer: "The website did not answer from your connection, while a known-good site did. The site may be down, or blocked on your network.",
  site_private: "This name points only to private or local network addresses, so NetTriage did not contact it. NetTriage checks public websites only.",
  site_answers: "The website answers from your connection. If it still fails, the problem is likely on the site itself or with your account there.",
  site_unknown: "Your own connection failed during this check, so the website could not be tested fairly. Run a checkup first.",
};

/**
 * Turn a checkup's measurements into one verdict. Pure.
 *
 * :param online: navigator.onLine (true, false or null when unknown).
 * :param endpoints: Summaries from Probes.summarize.
 * :return: {code, headline, evidence: [strings]}.
 */
export function diagnoseCheckup(online, endpoints) {
  const result = classifyCheckup(online, endpoints);
  result.metrics = checkupMetrics(endpoints);
  return result;
}

/**
 * The numbers behind a checkup, for comparing checkups and for a support report. Pure.
 *
 * :param endpoints: Summaries from Probes.summarize.
 * :return: {sent, lost, typicalMs, worstJitterMs}; a value is null when nothing measured it.
 */
export function checkupMetrics(endpoints) {
  const answered = endpoints.filter((endpoint) => endpoint.answered > 0);
  const jitters = answered.map((endpoint) => endpoint.jitterMs).filter((value) => value !== null);
  return {
    sent: endpoints.reduce((sum, endpoint) => sum + endpoint.sent, 0),
    lost: endpoints.reduce((sum, endpoint) => sum + (endpoint.sent - endpoint.answered), 0),
    typicalMs: typicalOf(answered),
    worstJitterMs: jitters.length ? Math.max(...jitters) : null,
  };
}

/**
 * The middle of the endpoints' median times (the lower middle for an even count). Pure.
 *
 * :param endpoints: Summaries that answered at least once.
 * :return: Milliseconds, or null when no endpoint has a median.
 */
function typicalOf(endpoints) {
  const medians = endpoints.map((endpoint) => endpoint.medianMs).filter((value) => value !== null).sort((a, b) => a - b);
  return medians.length ? medians[Math.floor((medians.length - 1) / 2)] : null;
}

/**
 * The checkup rules, in order. Pure.
 *
 * :param online: navigator.onLine (true, false or null when unknown).
 * :param endpoints: Summaries from Probes.summarize.
 * :return: {code, headline, evidence}.
 */
function classifyCheckup(online, endpoints) {
  const evidence = [];
  const answeredAny = endpoints.filter((endpoint) => endpoint.answered > 0);
  const named = endpoints.filter((endpoint) => endpoint.usesDns);
  const byIp = endpoints.filter((endpoint) => !endpoint.usesDns);
  const namedAnswered = named.filter((endpoint) => endpoint.answered > 0);
  const ipAnswered = byIp.filter((endpoint) => endpoint.answered > 0);

  if (online === false && answeredAny.length === 0) {
    evidence.push("The browser reports it is offline.");
    return verdict("offline", evidence);
  }
  if (answeredAny.length === 0) {
    evidence.push(`None of the ${endpoints.length} test endpoints answered.`);
    return verdict("no_internet", evidence);
  }
  if (ipAnswered.length > 0 && namedAnswered.length === 0) {
    evidence.push("The endpoint reached by IP address answered.");
    evidence.push(`None of the ${named.length} endpoints reached by name answered.`);
    return verdict("dns_problem", evidence);
  }
  const sent = endpoints.reduce((sum, endpoint) => sum + endpoint.sent, 0);
  const lost = endpoints.reduce((sum, endpoint) => sum + (endpoint.sent - endpoint.answered), 0);
  const jitters = answeredAny.map((endpoint) => endpoint.jitterMs).filter((value) => value !== null);
  const worstJitter = jitters.length ? Math.max(...jitters) : 0;
  if (lost > 0 || worstJitter > THRESHOLDS.unstableJitterMs) {
    if (lost > 0) {
      evidence.push(`${lost} of ${sent} requests got no answer.`);
    }
    if (worstJitter > THRESHOLDS.unstableJitterMs) {
      evidence.push(`Response times varied by up to ${worstJitter} ms on one endpoint.`);
    }
    return verdict("unstable", evidence);
  }
  const typical = typicalOf(answeredAny);
  if (typical !== null && typical > THRESHOLDS.slowMedianMs) {
    evidence.push(`Typical response time was ${typical} ms (above ${THRESHOLDS.slowMedianMs} ms).`);
    return verdict("slow", evidence);
  }
  const gaps = answeredAny
    .filter((endpoint) => endpoint.firstMs !== null && endpoint.medianMs !== null)
    .map((endpoint) => endpoint.firstMs - endpoint.medianMs);
  const worstGap = gaps.length ? Math.max(...gaps) : 0;
  if (worstGap > THRESHOLDS.slowSetupGapMs) {
    evidence.push(`A first connection took ${worstGap} ms longer than repeat requests.`);
    return verdict("slow_setup", evidence);
  }
  if (typical !== null) {
    evidence.push(`Typical response time was ${typical} ms, with every request answered.`);
  }
  return verdict("healthy", evidence);
}

/**
 * Turn a site check into one verdict. Pure.
 *
 * :param dns: Results of Probes.resolve, one per resolver.
 * :param site: The site's timing summary, or null when it was not timed.
 * :param baseline: The timing summary for a known-good endpoint in the same check.
 * :return: {code, headline, evidence}.
 */
export function diagnoseSite(dns, site, baseline) {
  const evidence = [];
  for (const result of dns) {
    const found = result.status === "resolved" ? `found (${result.addresses.join(", ")})` : result.status.replace("_", " ");
    evidence.push(`${result.resolver}: ${found}.`);
  }
  if (pointsOnlyToPrivate(dns)) {
    evidence.push("Every address public DNS gave for this name is a private or local network address.");
    return verdict("site_private", evidence);
  }
  if (!baseline || baseline.answered === 0) {
    evidence.push("A known-good endpoint did not answer during this check.");
    return verdict("site_unknown", evidence);
  }
  if (dns.length && dns.every((result) => result.status === "not_found")) {
    return verdict("site_not_found", evidence);
  }
  if (!site || site.answered === 0) {
    evidence.push("The website did not answer any of the test requests.");
    return verdict("site_no_answer", evidence);
  }
  evidence.push(`The website answered ${site.answered} of ${site.sent} requests (typical ${site.medianMs ?? site.firstMs} ms).`);
  return verdict("site_answers", evidence);
}

/**
 * Whether public DNS found the name, and every address it gave is private or local, such
 * as 192.168.1.1. The site check must not contact such a name: it would probe the
 * visitor's own network. Pure.
 *
 * :param dns: Results of Probes.resolve, one per resolver.
 * :return: True when at least one address was found and none is public.
 */
export function pointsOnlyToPrivate(dns) {
  const addresses = dns.flatMap((result) => (result.status === "resolved" ? result.addresses : []));
  return addresses.length > 0 && !addresses.some(isPublicIPv4);
}

/**
 * :param code: A key of VERDICTS.
 * :param evidence: The measured facts behind it.
 * :return: The verdict object.
 */
function verdict(code, evidence) {
  return { code: code, headline: VERDICTS[code], evidence: evidence };
}
