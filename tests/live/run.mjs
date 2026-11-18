// Live test: the real agent network on a real model, against a fake network.
//
// Each scenario sends one of the site's sample questions through the same runtime and
// LangChain runner the browser uses, on a real LLM. The page's probes see a scripted
// network, so every scenario has a known right answer: the test checks which tools the
// agents called, with which arguments, and that the reply states the measured facts.
//
// Run: npm run test:live                  (all scenarios)
//      npm run test:live -- --only=dns    (scenarios whose id contains "dns")
//      npm run test:live -- --runner=manual --model=llama-3.3-70b-versatile
//
// The key comes from GROQ_API_KEY in .env.local (git-ignored, never deployed). It is
// sent only to Groq and never printed. Not part of `npm test` or CI: it needs a key,
// costs tokens, and a model's wording varies from run to run.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { ActionRegistry } from "../../runtime/actions.js";
import { AgentNetwork } from "../../runtime/kernel.js";
import { LlmClient } from "../../runtime/llm.js";
import { runAgent } from "../../runtime/runner.js";
import { TraceBus } from "../../runtime/trace.js";
import { FakeNet } from "../fake_net.mjs";
import { StubDocument } from "../stub_document.mjs";
import { StubOption } from "../stub_option.mjs";

const ROOT = new URL("../../", import.meta.url);
const BASE = "http://localhost:8080";
const NETWORK_NAME = "net_triage";
const ROUTER = "https://api.groq.com/openai/v1";
const DEFAULT_MODEL = "openai/gpt-oss-120b";
const RESULTS_DIR = new URL(".live-results/", ROOT);

const options = Object.fromEntries(process.argv.slice(2).filter((arg) => arg.startsWith("--"))
  .map((arg) => { const [key, value] = arg.slice(2).split("="); return [key, value ?? true]; }));

/**
 * Read one variable from .env.local. Accepts spaces around "=" and quoted values.
 *
 * :param name: The variable name.
 * :return: The value, or "" when it is missing.
 */
function readEnvLocal(name) {
  let text = "";
  try {
    text = readFileSync(new URL(".env.local", ROOT), "utf8");
  } catch (error) {
    return "";
  }
  for (const raw of text.split(/\r?\n/)) {
    const match = raw.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && match[1] === name) {
      return match[2].replace(/^(["'])(.*)\1$/, "$2").trim();
    }
  }
  return "";
}

const KEY = process.env.GROQ_API_KEY || readEnvLocal("GROQ_API_KEY");
if (!KEY) {
  console.error("No GROQ_API_KEY in .env.local or the environment. See README → Live test.");
  process.exit(2);
}
const MODEL = options.model || DEFAULT_MODEL;

/** Remove the key from any text before it is printed or saved. */
function redact(text) {
  return String(text).split(KEY).join("<key>");
}

// Wait and retry when Groq's free tier says too many requests. Only Groq calls go through
// this: the page's probes use FakeNet, not the global fetch.
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init) => {
  for (let attempt = 0; ; attempt += 1) {
    const response = await realFetch(input, init);
    if (response.status !== 429 || attempt >= 6) {
      return response;
    }
    const wait = Math.min(60, Number(response.headers.get("retry-after")) || 2 ** attempt * 5);
    console.log(`    rate limited by the provider, waiting ${wait}s…`);
    await new Promise((resolve) => setTimeout(resolve, wait * 1000));
  }
};

globalThis.document = StubDocument.fromHtml(await readFile(new URL("index.html", ROOT), "utf8"), `${BASE}/`);
globalThis.Option = StubOption;
const { App } = await import("../../script.js");
const { registerActions } = await import("../../site-actions.js");
const config = JSON.parse(await readFile(new URL(`${NETWORK_NAME}.network.json`, ROOT), "utf8"));
const manifest = JSON.parse(await readFile(new URL("agent-manifest.json", ROOT), "utf8"));

let externalRunner = null;
if ((options.runner || "langchain") === "langchain") {
  const bundle = await import("../../runtime/generated/agent-runner.bundle.js");
  externalRunner = bundle.runAgentLangChain || bundle.default;
}

/**
 * Register the site's actions, recording every call that actually runs.
 *
 * :param calls: The list each executed call is added to.
 * :return: The registry.
 */
async function registry(calls) {
  const reg = new ActionRegistry();
  const scope = { base: BASE, network: NETWORK_NAME };
  await registerActions({
    register(definition) {
      const execute = definition.execute;
      reg.register(scope, {
        ...definition,
        async execute(args, context) {
          calls.push({ name: definition.name, args: args });
          return execute(args, context);
        },
      });
    },
  });
  return reg;
}

/** Forget every result, so each scenario starts from a fresh page. */
function resetPage() {
  Object.assign(App.page, { checkup: null, siteCheck: null, history: [], checkupCount: 0, busy: null });
}

// Scripted networks with a known verdict each.
const NETS = {
  healthy: () => new FakeNet({ "*": [60, 30, 32] }),
  slow: () => new FakeNet({ "*": [460, 420, 430] }),
  dns: () => new FakeNet({ "1.1.1.1": [50], "*": [null] }),
};

const DEVANAGARI = /[ऀ-ॿ]/;

/**
 * Each scenario: the question, the network, how the confirmation dialog answers, and
 * checks. `must` failures fail the scenario; `should` failures are reported as warnings,
 * for behaviour the instructions ask for but a reasonable model may skip.
 */
const SCENARIOS = [
  {
    id: "slow",
    question: "My internet feels really slow right now. What is wrong?",
    net: "slow",
    must: [
      ["ran a checkup", (run) => run.called("run_checkup")],
      ["reply says the connection is slow", (run) => /slow/i.test(run.text)],
      ["reply quotes a measured time", (run) => run.measuredNumbers().some((n) => run.text.includes(String(n)))],
    ],
    should: [["read the page state first", (run) => run.calls[0]?.name === "get_triage_state"]],
  },
  {
    id: "site",
    question: "Is wikipedia.org down for everyone or just for me?",
    net: "healthy",
    confirm: true,
    must: [
      ["checked wikipedia.org", (run) => run.called("check_site", (args) => /wikipedia\.org/i.test(args.site))],
      ["the visitor was asked first", (run) => run.confirmed.some((items) => items.some((item) => item.action === "check_site"))],
      ["reply says the site answers", (run) => /answer|reachable|up\b|working|loads|not down/i.test(run.text)],
      ["reply does not claim it is down for everyone", (run) => !/\bis down for everyone\b/i.test(run.text)],
    ],
  },
  {
    id: "dns-windows",
    question: "Websites will not load on my Windows laptop. How do I fix it?",
    net: "dns",
    must: [
      ["ran a checkup", (run) => run.called("run_checkup")],
      ["got DNS steps for Windows", (run) => run.called("get_fix_steps", (args) => args.problem === "dns_problem" && args.device === "windows")],
      ["reply names DNS", (run) => /\bDNS\b/.test(run.text)],
      ["reply keeps the command exactly", (run) => run.text.includes("ipconfig /flushdns")],
    ],
  },
  {
    id: "steps-iphone",
    question: "Give me fix steps for an unstable connection on my iPhone.",
    net: "healthy",
    must: [
      ["got unstable steps for iPhone", (run) => run.called("get_fix_steps", (args) => args.problem === "unstable" && args.device === "iphone")],
      ["reply has a playbook step", (run) => /5 GHz|closer to the router/i.test(run.text)],
    ],
    should: [["did not run an unrequested checkup", (run) => !run.called("run_checkup")]],
  },
  {
    id: "report",
    question: "Write up my results so I can send them to my internet provider.",
    net: "healthy",
    before: async () => App.page.runCheckup(),
    must: [
      ["fetched the support report", (run) => run.called("get_support_report")],
      ["reply contains the report", (run) => run.text.includes("NetTriage connection report")],
    ],
    should: [["did not rerun a fresh checkup", (run) => !run.called("run_checkup")]],
  },
  {
    id: "hindi-android",
    question: "मेरे Android फ़ोन पर इंटरनेट बहुत धीमा है, हिंदी में स्टेप बताइए।",
    net: "slow",
    must: [
      ["got Hindi steps for Android", (run) => run.called("get_fix_steps", (args) => args.language === "hi" && args.device === "android")],
      ["reply is in Hindi", (run) => (run.text.match(/[ऀ-ॿ]/g) || []).length > 40],
      ["reply uses a Hindi playbook step", (run) => run.fixSteps().some((step) => step.length > 20 && DEVANAGARI.test(step) && run.text.includes(step.slice(0, 20)))],
    ],
  },
  {
    id: "decline-router",
    question: "Can you restart my router for me?",
    net: "healthy",
    must: [
      ["contacted nothing", (run) => !run.called("check_site")],
      ["reply says it cannot", (run) => /can(?:no|')t|cannot|not able|unable|isn't able|doesn't have|no way to/i.test(run.text)],
    ],
    should: [["offered the router steps", (run) => run.called("get_fix_steps", (args) => args.device === "router") || /unplug|power/i.test(run.text)]],
  },
  {
    id: "declined-dialog",
    question: "Is example.com down for everyone or just for me?",
    net: "healthy",
    confirm: false,
    must: [
      ["asked to check example.com", (run) => run.confirmed.some((items) => items.some((item) => item.action === "check_site"))],
      ["the check did not run", (run) => !run.called("check_site")],
      ["reply does not invent a result", (run) => !/\b(answers from your connection|is up|is down|is reachable)\b/i.test(run.text)],
    ],
  },
];

/**
 * Run one scenario through the front agent.
 *
 * :param scenario: An entry of SCENARIOS.
 * :return: The run: calls, dialogs, reply text, timing and check results.
 */
async function runScenario(scenario) {
  resetPage();
  const net = NETS[scenario.net]();
  App.page.setNetwork(net.fetch, net.now);
  if (scenario.before) {
    await scenario.before();
  }
  const calls = [];
  const confirmed = [];
  const network = new AgentNetwork(config, NETWORK_NAME);
  const llm = new LlmClient({ baseUrl: ROUTER, apiKey: KEY, trace: null, mock: false });
  const ctx = {
    network: network,
    manifest: manifest,
    actions: await registry(calls),
    baseOrigin: BASE,
    displayOrigin: new URL(BASE).host,
    trace: new TraceBus(),
    isTop: true,
    frontMan: network.findFrontMan(),
    history: [],
    llm: llm,
    confirmWebsiteActions: async (items) => {
      confirmed.push(items);
      return scenario.confirm ?? true;
    },
    externalRunner: externalRunner,
    routerBaseUrl: ROUTER,
    mock: false,
    apiKey: KEY,
    modelOverride: MODEL,
    defaultModel: MODEL,
    maxSteps: 0,
    requestConsent: async () => "decline",
  };
  const started = Date.now();
  const run = {
    id: scenario.id,
    question: scenario.question,
    calls: calls,
    confirmed: confirmed,
    text: "",
    error: null,
    called(name, test = () => true) {
      return calls.some((call) => call.name === name && test(call.args || {}));
    },
    measuredNumbers() {
      const state = App.page.getState();
      const endpoints = state.latestCheckup?.endpoints || [];
      return [...new Set(endpoints.flatMap((e) => [e.firstMs, e.medianMs, e.jitterMs]).filter((n) => n !== null && n >= 10))];
    },
    fixSteps() {
      return calls.filter((call) => call.name === "get_fix_steps")
        .flatMap((call) => App.page.getFixSteps(call.args.problem, call.args.device, call.args.language ?? "en").steps || []);
    },
  };
  try {
    const result = await runAgent(ctx, ctx.frontMan, scenario.question, null, []);
    run.text = result.text || "";
  } catch (error) {
    run.error = redact(error && error.stack ? error.stack.split("\n").slice(0, 3).join(" ") : error);
  }
  run.seconds = Math.round((Date.now() - started) / 100) / 10;
  run.failures = run.error ? ["the run threw an error"] : (scenario.must || []).filter(([, check]) => !check(run)).map(([name]) => name);
  run.warnings = run.error ? [] : (scenario.should || []).filter(([, check]) => !check(run)).map(([name]) => name);
  return run;
}

const selected = SCENARIOS.filter((scenario) => !options.only || scenario.id.includes(options.only));
console.log(`Live test: ${selected.length} scenario(s) on ${MODEL} via ${new URL(ROUTER).host}, ${externalRunner ? "LangChain" : "manual"} runner\n`);
const runs = [];
for (const scenario of selected) {
  console.log(`▶ ${scenario.id}: ${scenario.question}`);
  const run = await runScenario(scenario);
  runs.push(run);
  const tools = run.calls.map((call) => `${call.name}(${JSON.stringify(call.args)})`).join(", ") || "none";
  console.log(`  tools: ${redact(tools)}`);
  if (run.confirmed.length) {
    console.log(`  dialogs: ${run.confirmed.length} (${scenario.confirm === false ? "declined" : "approved"})`);
  }
  console.log(`  ${run.failures.length ? "✖ FAIL" : "✔ pass"} in ${run.seconds}s${run.failures.length ? ": " + run.failures.join("; ") : ""}`);
  for (const warning of run.warnings) {
    console.log(`  ⚠ ${warning}`);
  }
  if (run.error) {
    console.log(`  error: ${run.error}`);
  }
  console.log("");
}

const passed = runs.filter((run) => !run.failures.length).length;
const lines = [
  "# NetTriage live test",
  "",
  `- Date: ${new Date().toISOString()}`,
  `- Model: \`${MODEL}\` via ${new URL(ROUTER).host}, ${externalRunner ? "LangChain" : "manual"} runner`,
  `- Result: **${passed}/${runs.length} passed**`,
  "",
  "| Scenario | Result | Tools called | Time |",
  "| --- | --- | --- | --- |",
  ...runs.map((run) => `| ${run.id} | ${run.failures.length ? "✖ " + run.failures.join("; ") : "✔"}${run.warnings.length ? " (⚠ " + run.warnings.join("; ") + ")" : ""} | ${run.calls.map((call) => call.name).join(", ") || "none"} | ${run.seconds}s |`),
  "",
];
for (const run of runs) {
  lines.push(`## ${run.id}`, "", `**Visitor:** ${run.question}`, "", "**Tools:**", "");
  for (const call of run.calls) {
    lines.push(`- \`${call.name}\` ${JSON.stringify(call.args)}`);
  }
  lines.push("", "**Reply:**", "", run.error ? `Error: ${run.error}` : run.text.split("\n").map((line) => `> ${line}`).join("\n"), "");
}
mkdirSync(RESULTS_DIR, { recursive: true });
writeFileSync(new URL("latest.md", RESULTS_DIR), redact(lines.join("\n")));
console.log(`${passed}/${runs.length} scenarios passed. Transcripts: .live-results/latest.md`);
process.exit(passed === runs.length ? 0 : 1);
