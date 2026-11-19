// NetTriage page script. One page object (App.page) owns all state and operations.
// The page's own buttons and the assistant's website_* tools call the same methods.
import { ENDPOINTS, RESOLVERS, Probes, normalizeHost } from "./js/probes.js";
import { diagnoseCheckup, diagnoseSite, pointsOnlyToPrivate } from "./js/diagnosis.js";
import { DEVICES, LANGUAGES, PROBLEMS, stepsFor } from "./js/playbooks.js";

/**
 * Facts shown on the page that the assistant reads instead of having them copied into
 * its instructions.
 */
export const PAGE_FACTS = {
  cannotDo: [
    "See or change your router, Wi-Fi settings or other devices",
    "Measure exact download or upload speed (this is not a speed test)",
    "Measure Wi-Fi signal strength",
    "Contact your internet provider for you",
    "Run in the background or after this tab is closed",
  ],
  privacy: "Checks run in your browser. NetTriage has no server and stores nothing. A site check contacts the website you name, only after you confirm.",
};

/** How many checkups the state and the support report keep. */
export const HISTORY_LIMIT = 5;

/** The page buttons that start a probe. They show as unavailable while one runs. */
const PROBE_BUTTONS = ["run-checkup", "site-submit"];

/**
 * The page: state, operations and rendering.
 */
export class TriagePage {
  constructor() {
    this.probes = new Probes(globalThis.fetch ? globalThis.fetch.bind(globalThis) : null, TriagePage.clock);
    this.checkup = null;
    this.siteCheck = null;
    this.busy = null;
    this.history = [];
    this.checkupCount = 0;
  }

  /** :return: A high-resolution time in ms. */
  static clock() {
    return globalThis.performance ? globalThis.performance.now() : Date.now();
  }

  /**
   * Replace the network functions (tests only).
   *
   * :param fetchImpl: A fetch-compatible function.
   * :param now: A clock in ms.
   */
  setNetwork(fetchImpl, now) {
    this.probes = new Probes(fetchImpl, now);
  }

  /** :return: The browser's connection hints, or nulls where the browser gives none. */
  static connectionInfo() {
    const nav = globalThis.navigator || {};
    const info = nav.connection || {};
    return {
      browserOnline: typeof nav.onLine === "boolean" ? nav.onLine : null,
      effectiveType: info.effectiveType || null,
      estimatedRttMs: typeof info.rtt === "number" ? info.rtt : null,
      estimatedDownlinkMbps: typeof info.downlink === "number" ? info.downlink : null,
      saveData: typeof info.saveData === "boolean" ? info.saveData : null,
    };
  }

  /** :return: Today's date in both forms, from the clock at call time. */
  static today() {
    const now = new Date();
    return {
      iso: now.toISOString().slice(0, 10),
      readable: now.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" }),
    };
  }

  /**
   * Seconds since an ISO time, from the clock at call time.
   *
   * :param iso: An ISO time, such as a checkup's ranAt.
   * :return: Whole seconds, never negative.
   */
  static ageSeconds(iso) {
    return Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  }

  /**
   * Plain JSON copy of everything the page shows. Ages are worked out at read time, so
   * the assistant, which has no clock, can tell whether a checkup is recent.
   *
   * :return: The state.
   */
  getState() {
    const aged = (record) => (record ? { ...record, ageSeconds: TriagePage.ageSeconds(record.ranAt) } : null);
    return JSON.parse(JSON.stringify({
      today: TriagePage.today(),
      now: new Date().toISOString(),
      connection: TriagePage.connectionInfo(),
      busy: this.busy,
      latestCheckup: aged(this.checkup),
      latestSiteCheck: aged(this.siteCheck),
      checkupsThisVisit: this.checkupCount,
      recentCheckups: this.history.map(aged),
      endpointsTheCheckupContacts: ENDPOINTS.map((endpoint) => ({ label: endpoint.label, host: new URL(endpoint.url).host })),
      resolversASiteCheckUses: RESOLVERS.map((resolver) => ({ label: resolver.label, host: new URL(resolver.url).host })),
      cannotDo: PAGE_FACTS.cannotDo,
      privacy: PAGE_FACTS.privacy,
    }));
  }

  /**
   * Run the full checkup: time every endpoint, then apply the diagnosis rules.
   *
   * :return: {ok: true, checkup} or {ok: false, reason}.
   */
  async runCheckup() {
    if (this.busy) {
      return { ok: false, reason: `A ${this.busy} is already running. Wait for it to finish.` };
    }
    this.setBusy("checkup");
    TriagePage.setText("checkup-status", "Running checkup… this usually takes under 20 seconds.");
    try {
      const connection = TriagePage.connectionInfo();
      const endpoints = [];
      for (const endpoint of ENDPOINTS) {
        endpoints.push(await this.probes.timeEndpoint(endpoint));
      }
      const verdict = diagnoseCheckup(connection.browserOnline, endpoints);
      this.checkup = {
        ranAt: new Date().toISOString(),
        connection: connection,
        endpoints: endpoints,
        verdict: verdict,
      };
      this.checkupCount += 1;
      this.history.push({ ranAt: this.checkup.ranAt, verdict: verdict.code, ...verdict.metrics });
      this.history = this.history.slice(-HISTORY_LIMIT);
      this.renderCheckup();
      return { ok: true, checkup: JSON.parse(JSON.stringify(this.checkup)) };
    } finally {
      this.setBusy(null);
    }
  }

  /**
   * Read-only check of a site-check request. Used by the page form, the operation and
   * the confirmation dialog.
   *
   * :param text: The website the visitor named.
   * :return: {ok: true, host, contacts} or {ok: false, reason, field}.
   */
  checkSiteInput(text) {
    const normalized = normalizeHost(text);
    if (!normalized.ok) {
      return { ok: false, reason: normalized.reason, field: "site-input" };
    }
    if (this.busy) {
      return { ok: false, reason: `A ${this.busy} is already running. Wait for it to finish.`, field: "site-input" };
    }
    return {
      ok: true,
      host: normalized.host,
      contacts: [normalized.host, ...RESOLVERS.map((resolver) => new URL(resolver.url).host), new URL(ENDPOINTS[0].url).host],
    };
  }

  /**
   * Check one website: public DNS on two resolvers, then time the site against a
   * known-good endpoint.
   *
   * :param text: The website the visitor named.
   * :return: {ok: true, siteCheck} or {ok: false, reason, field}.
   */
  async checkSite(text) {
    const check = this.checkSiteInput(text);
    if (!check.ok) {
      return check;
    }
    this.setBusy("site check");
    TriagePage.setText("site-status", `Checking ${check.host}…`);
    try {
      const dns = [];
      for (const resolver of RESOLVERS) {
        dns.push(await this.probes.resolve(resolver, check.host));
      }
      const baseline = await this.probes.timeEndpoint(ENDPOINTS[0]);
      let site = null;
      // A name that does not exist, or that points only into private networks, is never
      // contacted: the second would probe devices on the visitor's own network.
      const notFound = dns.every((result) => result.status === "not_found");
      if (!notFound && !pointsOnlyToPrivate(dns)) {
        site = await this.probes.timeEndpoint({ id: "site", label: check.host, url: `https://${check.host}/favicon.ico`, usesDns: true });
      }
      this.siteCheck = {
        host: check.host,
        ranAt: new Date().toISOString(),
        dns: dns,
        site: site,
        verdict: diagnoseSite(dns, site, baseline),
      };
      this.renderSite();
      return { ok: true, siteCheck: JSON.parse(JSON.stringify(this.siteCheck)) };
    } finally {
      this.setBusy(null);
    }
  }

  /**
   * Record which probe runs, and mark the page's probe buttons. aria-disabled, not
   * disabled: disabling the focused button would drop keyboard focus to the page body.
   * The busy check in each operation refuses a second run.
   *
   * :param name: "checkup", "site check", or null when nothing runs.
   */
  setBusy(name) {
    this.busy = name;
    for (const id of PROBE_BUTTONS) {
      const button = document.getElementById(id);
      if (name) {
        button.setAttribute("aria-disabled", "true");
      } else {
        button.removeAttribute("aria-disabled");
      }
    }
  }

  /**
   * A plain-text report of this visit's results, for the visitor to send to their
   * internet provider or IT helper. It holds measurements only: no chat text and nothing
   * about the visitor. Changes nothing.
   *
   * :return: {ok: true, createdAt, text} or {ok: false, reason}.
   */
  getSupportReport() {
    if (!this.checkup && !this.siteCheck) {
      return { ok: false, reason: "There is nothing to report yet. Run a checkup first." };
    }
    const createdAt = new Date().toISOString();
    const lines = ["NetTriage connection report", `Created: ${createdAt}`];
    const hints = TriagePage.connectionInfo();
    const hintParts = [];
    if (hints.browserOnline !== null) {
      hintParts.push(`browser online: ${hints.browserOnline ? "yes" : "no"}`);
    }
    if (hints.effectiveType) {
      hintParts.push(`connection type: ${hints.effectiveType}`);
    }
    if (hints.estimatedRttMs !== null) {
      hintParts.push(`estimated round trip: ${hints.estimatedRttMs} ms`);
    }
    if (hints.estimatedDownlinkMbps !== null) {
      hintParts.push(`estimated downlink: ${hints.estimatedDownlinkMbps} Mbps`);
    }
    if (hintParts.length) {
      lines.push(`Browser hints: ${hintParts.join("; ")}`);
    }
    if (this.checkup) {
      const verdict = this.checkup.verdict;
      lines.push("", `Latest checkup: ${this.checkup.ranAt} (code ${verdict.code})`, `Result: ${verdict.headline}`);
      for (const line of verdict.evidence) {
        lines.push(`- ${line}`);
      }
      lines.push("Endpoint | answered | first | typical | variation");
      for (const endpoint of this.checkup.endpoints) {
        lines.push([
          endpoint.label.includes(endpoint.host) ? endpoint.label : `${endpoint.label} (${endpoint.host})`,
          `${endpoint.answered}/${endpoint.sent}`,
          TriagePage.ms(endpoint.firstMs),
          TriagePage.ms(endpoint.medianMs),
          TriagePage.ms(endpoint.jitterMs),
        ].join(" | "));
      }
    }
    const earlier = this.history.slice(0, -1);
    if (earlier.length) {
      lines.push("", "Earlier checkups this visit:");
      for (const entry of earlier) {
        lines.push(`- ${entry.ranAt}: ${entry.verdict}, typical ${TriagePage.ms(entry.typicalMs)}, ${entry.lost} of ${entry.sent} requests unanswered`);
      }
    }
    if (this.siteCheck) {
      const check = this.siteCheck;
      lines.push("", `Website check: ${check.host} at ${check.ranAt} (code ${check.verdict.code})`, `Result: ${check.verdict.headline}`);
      for (const line of check.verdict.evidence) {
        lines.push(`- ${line}`);
      }
    }
    lines.push("", "Measured from a web browser: reachability and response times only, not a speed test or Wi-Fi signal strength.");
    return { ok: true, createdAt: createdAt, text: lines.join("\n") };
  }

  /**
   * :param value: Milliseconds, or null when nothing was measured.
   * :return: "40 ms" or "—".
   */
  static ms(value) {
    return value === null || value === undefined ? "—" : `${value} ms`;
  }

  /**
   * Show the support report on the page and try to copy it. The text stays on the page,
   * so the visitor can copy it by hand when the browser refuses clipboard access.
   *
   * :return: The result of getSupportReport.
   */
  async showSupportReport() {
    const result = this.getSupportReport();
    const output = document.getElementById("report-text");
    if (!result.ok) {
      output.hidden = true;
      TriagePage.setText("report-status", result.reason);
      return result;
    }
    output.textContent = result.text;
    output.hidden = false;
    let copied = false;
    try {
      if (globalThis.navigator && globalThis.navigator.clipboard) {
        await globalThis.navigator.clipboard.writeText(result.text);
        copied = true;
      }
    } catch (error) {
      copied = false;
    }
    TriagePage.setText("report-status", copied
      ? "Report copied. Paste it into a message to your internet provider or IT helper."
      : "Select the report below and copy it.");
    return result;
  }

  /**
   * Fix steps for a problem on a device, in one language. Changes nothing.
   *
   * :param problem: A key of PROBLEMS.
   * :param device: A key of DEVICES.
   * :param language: A key of LANGUAGES ("en", "hi" or "ta"); English when left out.
   * :return: {ok: true, problem, device, language, steps, closing} or {ok: false, reason}.
   */
  getFixSteps(problem, device, language = "en") {
    if (!Object.hasOwn(PROBLEMS, problem) || !Object.hasOwn(DEVICES, device)) {
      return { ok: false, reason: "Unknown problem or device." };
    }
    if (!Object.hasOwn(LANGUAGES, language)) {
      return { ok: false, reason: `Fix steps are available in ${Object.values(LANGUAGES).map((lang) => lang.name).join(", ")}.` };
    }
    return { ok: true, ...stepsFor(problem, device, language) };
  }

  /** Show the fix steps in the page's own panel, marked with their language. */
  showFixSteps(problem, device, language = "en") {
    const result = this.getFixSteps(problem, device, language);
    const list = document.getElementById("fix-steps");
    list.replaceChildren();
    if (!result.ok) {
      return result;
    }
    // Keep the form in step with the list, also when the assistant asked for the steps.
    document.getElementById("fix-problem").value = problem;
    document.getElementById("fix-device").value = device;
    document.getElementById("fix-language").value = language;
    // Screen readers pick the voice for the steps from lang.
    list.setAttribute("lang", result.language);
    for (const step of result.steps) {
      const item = document.createElement("li");
      item.textContent = step;
      list.append(item);
    }
    return result;
  }

  renderCheckup() {
    const verdict = this.checkup.verdict;
    TriagePage.setText("checkup-status", `Last checkup: ${new Date(this.checkup.ranAt).toLocaleTimeString()}`);
    TriagePage.setText("checkup-verdict", verdict.headline);
    document.getElementById("checkup-verdict").setAttribute("data-verdict", verdict.code);
    const evidence = document.getElementById("checkup-evidence");
    evidence.replaceChildren();
    for (const line of verdict.evidence) {
      const item = document.createElement("li");
      item.textContent = line;
      evidence.append(item);
    }
    const body = document.getElementById("checkup-rows");
    body.replaceChildren();
    for (const endpoint of this.checkup.endpoints) {
      const row = document.createElement("tr");
      const cells = [
        endpoint.label,
        `${endpoint.answered}/${endpoint.sent}`,
        endpoint.firstMs === null ? "—" : `${endpoint.firstMs} ms`,
        endpoint.medianMs === null ? "—" : `${endpoint.medianMs} ms`,
        endpoint.jitterMs === null ? "—" : `${endpoint.jitterMs} ms`,
      ];
      for (const text of cells) {
        const cell = document.createElement("td");
        cell.textContent = text;
        row.append(cell);
      }
      body.append(row);
    }
    document.getElementById("checkup-result").hidden = false;
  }

  renderSite() {
    const check = this.siteCheck;
    TriagePage.setText("site-status", `Checked ${check.host} at ${new Date(check.ranAt).toLocaleTimeString()}`);
    TriagePage.setText("site-verdict", check.verdict.headline);
    document.getElementById("site-verdict").setAttribute("data-verdict", check.verdict.code);
    const evidence = document.getElementById("site-evidence");
    evidence.replaceChildren();
    for (const line of check.verdict.evidence) {
      const item = document.createElement("li");
      item.textContent = line;
      evidence.append(item);
    }
    document.getElementById("site-result").hidden = false;
  }

  /** Fill the page's static lists from the same data the assistant reads. */
  renderStatic() {
    const contacts = document.getElementById("contacts-list");
    contacts.replaceChildren();
    for (const endpoint of ENDPOINTS) {
      const item = document.createElement("li");
      item.textContent = `${endpoint.label} — ${new URL(endpoint.url).host}`;
      contacts.append(item);
    }
    const limits = document.getElementById("limits-list");
    limits.replaceChildren();
    for (const line of PAGE_FACTS.cannotDo) {
      const item = document.createElement("li");
      item.textContent = line;
      limits.append(item);
    }
    TriagePage.fillSelect("fix-problem", PROBLEMS);
    TriagePage.fillSelect("fix-device", DEVICES);
    TriagePage.fillSelect("fix-language", Object.fromEntries(Object.entries(LANGUAGES).map(([code, lang]) => [code, lang.name])));
  }

  static fillSelect(id, options) {
    const select = document.getElementById(id);
    select.replaceChildren();
    for (const [value, label] of Object.entries(options)) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      select.append(option);
    }
  }

  static setText(id, text) {
    document.getElementById(id).textContent = text;
  }

  /** Wire the page's own controls to the same operations the assistant uses. */
  bind() {
    document.getElementById("run-checkup").addEventListener("click", async () => {
      const result = await this.runCheckup();
      if (!result.ok) {
        TriagePage.setText("checkup-status", result.reason);
      }
    });
    // A refusal sets a custom validity message, and the browser blocks every later
    // submit while one is set. Clear it as soon as the visitor edits the address.
    document.getElementById("site-input").addEventListener("input", (event) => {
      event.target.setCustomValidity("");
    });
    document.getElementById("site-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const input = document.getElementById("site-input");
      const result = await this.checkSite(input.value);
      input.setCustomValidity(result.ok ? "" : result.reason);
      if (!result.ok) {
        input.reportValidity();
        TriagePage.setText("site-status", result.reason);
      }
    });
    document.getElementById("fix-form").addEventListener("submit", (event) => {
      event.preventDefault();
      this.showFixSteps(
        document.getElementById("fix-problem").value,
        document.getElementById("fix-device").value,
        document.getElementById("fix-language").value,
      );
    });
    document.getElementById("copy-report").addEventListener("click", () => this.showSupportReport());
  }
}

/** Holds the single page object. */
export class App {
  static page = new TriagePage();
}

App.page.renderStatic();
App.page.bind();
