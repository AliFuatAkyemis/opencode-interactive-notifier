#!/usr/bin/env node
// Release helper for opencode-interactive-notifier.
//
// Usage: node scripts/release.mjs <patch|minor|major> [--dry-run]
//
// Runs the full industry-standard release flow for one version bump:
//   preflight (clean tree, main branch, npm auth) -> checks (typecheck,
//   test, build) -> `npm version <bump>` (commit "X.Y.Z" + tag "vX.Y.Z")
//   -> push + push --tags -> npm publish.
//
// Policy lives in AGENTS.md (semver table, publish rules). This script is
// the only sanctioned way to bump the version.

import { execSync } from "node:child_process"
import { readFileSync } from "node:fs"

const BUMP = process.argv[2]
const DRY_RUN = process.argv.includes("--dry-run")
const ALLOWED = ["patch", "minor", "major"]

const step = (msg) => console.log(`\n==> ${msg}`)
const fail = (msg) => {
  console.error(`\n!! ${msg}`)
  process.exit(1)
}

const run = (cmd) => execSync(cmd, { stdio: "inherit" })
const runQuiet = (cmd) => execSync(cmd, { encoding: "utf8" }).trim()

// ---------------------------------------------------------------- preflight

if (!ALLOWED.includes(BUMP)) {
  fail(`usage: node scripts/release.mjs <${ALLOWED.join("|")}> [--dry-run]`)
}

step("preflight")
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
console.log(`package: ${pkg.name}@${pkg.version}  bump: ${BUMP}  dry-run: ${DRY_RUN}`)

const tree = runQuiet("git status --porcelain")
if (tree) fail(`working tree not clean:\n${tree}\ncommit or stash first`)
console.log("working tree: clean")

const branch = runQuiet("git branch --show-current")
if (branch !== "main") fail(`not on main (current: ${branch}); releases happen on main`)
console.log(`branch: ${branch}`)

const who = runQuiet("npm whoami")
console.log(`npm user: ${who}`)

if (DRY_RUN) {
  console.log("\ndry-run: skip bump/push/publish")
}

// ------------------------------------------------------------------ checks

step("checks")
for (const script of ["typecheck", "test", "build"]) {
  run(`npm run ${script}`)
  console.log(`npm run ${script}: OK`)
}

if (DRY_RUN) {
  console.log("\npreflight + checks OK; version would become:")
  const [major, minor, patch] = pkg.version.split(".").map(Number)
  const next = BUMP === "major" ? `${major + 1}.0.0` : BUMP === "minor" ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`
  console.log(`  ${pkg.version} -> ${next}  (tag v${next})`)
  process.exit(0)
}

// ---------------------------------------------------- bump / tag / push / publish

step("npm version")
const newVersion = runQuiet(`npm version ${BUMP}`)
console.log(`new version: ${newVersion}`)
// `npm version` commits "X.Y.Z" (repo style) and tags "vX.Y.Z".

step("git push")
run("git push")
run("git push --tags")
console.log("pushed commit + tag")

step("npm publish")
run("npm publish")
console.log(`published ${pkg.name}@${newVersion.replace(/^v/, "")}`)

console.log(`
Done. Next:
  - verify:  npm view ${pkg.name} version   (staging can take ~1 min)
  - plugin:  opencode plugin update   (if this machine runs it)`)