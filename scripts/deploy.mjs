// Deploys NetTriage to Cloudflare (Pages on Workers static assets) from the committed
// files only. The working folder can hold files that must never go public, such as
// .env.local or personal notes, so this script never uploads it: it exports the current
// commit with `git archive` into a temporary folder and deploys that.
//
// Usage: npm run deploy            (needs `npx wrangler@4 login` once)
//        npm run deploy -- --dry   (builds the folder and lists it, uploads nothing)
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT = "nettriage";
const COMPATIBILITY_DATE = "2026-11-17";
const dry = process.argv.includes("--dry");

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

const dirty = git("status", "--porcelain");
if (dirty) {
  console.error("Commit or stash these changes first, so the deploy matches a commit:\n" + dirty);
  process.exit(1);
}
const commit = git("rev-parse", "--short", "HEAD");
const out = mkdtempSync(join(tmpdir(), "nettriage-deploy-"));
try {
  const archive = execFileSync("git", ["archive", "--format=tar", "HEAD"], { maxBuffer: 256 * 1024 * 1024 });
  // Extract inside the folder: GNU tar on Windows reads "C:" in a -C path as a remote host.
  execFileSync("tar", ["-x"], { cwd: out, input: archive });
  // Files that are in git but have no place on the public site.
  writeFileSync(join(out, ".assetsignore"), [".git*", ".github", ".assetsignore", "wrangler.jsonc", ".wrangler", "node_modules", ".env*", ".dev.vars*", ""].join("\n"));
  writeFileSync(join(out, "wrangler.jsonc"), JSON.stringify({
    name: PROJECT,
    compatibility_date: COMPATIBILITY_DATE,
    assets: { directory: "." },
  }, null, 2));
  const leaked = readdirSync(out).filter((name) => /^\.env|^\.dev\.vars|^HACKATHON_PLAN/i.test(name));
  if (leaked.length) {
    throw new Error(`Refusing to deploy, private files are committed: ${leaked.join(", ")}`);
  }
  console.log(`Deploying commit ${commit} from ${out}`);
  if (dry) {
    console.log(readdirSync(out).join("\n"));
  } else {
    execFileSync("npx", ["--yes", "wrangler@4", "deploy", `--message=commit-${commit}`], { cwd: out, stdio: "inherit", shell: process.platform === "win32" });
  }
} finally {
  rmSync(out, { recursive: true, force: true });
}
