// A recognized key must reach its own provider, even when a saved setup pairs it
// with another provider's URL (for example Otari, this site's earlier default).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { providerForApiKey, providerMismatch } from "../runtime/ui.js";
import { selectTopRouter } from "../runtime/engine.js";

const GROQ = "https://api.groq.com/openai/v1";
const OTARI = "https://api.otari.ai/api/v1";
const FAKE_GROQ_KEY = "gsk_test_not_a_real_key";

test("a Groq key saved with Otari's URL is flagged as a mismatch", () => {
  assert.equal(providerForApiKey(FAKE_GROQ_KEY)?.router, GROQ);
  assert.equal(providerMismatch(FAKE_GROQ_KEY, OTARI)?.name, "Groq");
  assert.equal(providerMismatch(FAKE_GROQ_KEY, `${OTARI}/`)?.name, "Groq");
});

test("a key at its own provider, a custom proxy or an unknown key is left alone", () => {
  assert.equal(providerMismatch(FAKE_GROQ_KEY, GROQ), null);
  assert.equal(providerMismatch(FAKE_GROQ_KEY, `${GROQ}/`), null);
  assert.equal(providerMismatch(FAKE_GROQ_KEY, "https://proxy.example.test/v1"), null);
  assert.equal(providerMismatch(FAKE_GROQ_KEY, ""), null);
  assert.equal(providerMismatch("custom-key", OTARI), null);
});

test("with no saved router, a key goes to the manifest's provider, Groq", async () => {
  const manifest = JSON.parse(await readFile(new URL("../agent-manifest.json", import.meta.url), "utf8"));
  assert.equal(selectTopRouter(manifest, "", FAKE_GROQ_KEY).baseUrl, GROQ);
});

test("boot replaces a mismatched router before the engine starts", async () => {
  const source = await readFile(new URL("../runtime/index.js", import.meta.url), "utf8");
  const fix = source.indexOf("providerMismatch(tabSetup.key, tabSetup.router)");
  assert.ok(fix > 0 && fix < source.indexOf("new Engine("), "the router is fixed before new Engine()");
});

test("pasting the same key again refills a mismatched router in the settings panel", async () => {
  const source = await readFile(new URL("../runtime/ui.js", import.meta.url), "utf8");
  assert.match(source, /provider !== formProvider \|\| providerMismatch\(key, routerEl\.value\)/);
});
