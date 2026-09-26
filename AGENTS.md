# AGENTS.md — opencode-interactive-notifier

Release and versioning policy for this repo. Authoritative for any agent
(or human) that commits, bumps versions, or publishes to npm. Follow it
exactly — no improvisation on versions or publishing.

## Conventional commits

Every commit to `main` uses Conventional Commits:

- `feat:` — new user-visible behavior
- `fix:` — bug fix
- `perf:` — performance improvement
- `refactor:` / `test:` / `docs:` / `chore:` / `style:` / `build:` / `ci:` — non-release
- breaking change — `BREAKING CHANGE:` footer, or `feat!:` / `fix!:`

Commit subjects are lowercase, imperative, ≤ 72 chars (≤ 50 preferred).
Version-release commits are the bare version number (`0.4.1`).

## Versioning (semver)

Choose the bump from the commit type of the change being released:

| Commit type | `release:` script | npm bump | Publish? |
| --- | --- | --- | --- |
| `feat` | `release:minor` | minor | yes |
| `fix` | `release:patch` | patch | yes |
| `perf` | `release:patch` | patch | yes |
| breaking change | `release:major` | major | yes |
| docs/chore/refactor/test/style/build/ci | — | none | never alone |

0.x phase note: for `0.x.y`, a minor bump (`0.x.0` → `0.(x+1).0`) is the
correct container for potentially-breaking behavior changes too. Precedent:
dismiss-on-focus shipped as `0.4.0`, not `0.3.1` — that stays correct.
A major bump still means a real, deliberate breaking change.

## Release workflow (MUST)

1. The feature/fix commit lands first, with the conventional type that
   matches the planned bump.
2. Run `npm run release:patch` / `release:minor` / `release:major`
   (wraps `scripts/release.mjs`). The script
   - verifies a clean tree, the `main` branch, and npm auth,
   - runs `typecheck`, `test`, `build` (all must be green),
   - bumps via `npm version <bump>` → commit `X.Y.Z`, tag `vX.Y.Z`,
   - pushes the commit and the tag,
   - publishes to npm.
   Dry-run any release first: `npm run release:patch -- --dry-run`.
3. After publishing, verify: `npm view opencode-interactive-notifier version`.
   A freshly published version can take ~1 minute to appear (npm staging);
   that delay is normal — poll, do not re-publish.
4. If this machine runs the plugin: `opencode plugin update`.

## Publish rules (MUST NOT)

- NEVER hand-edit `version` in `package.json`; the release script is the
  only sanctioned way to bump.
- NEVER publish without green `typecheck` + `test` (the script enforces it).
- NEVER publish a docs/chore/refactor-only change as a release.
- NEVER move the `latest` dist-tag backwards.
- NEVER unpublish a version older than 72 hours — use `npm deprecate`
  instead. Within 72h, `npm unpublish <pkg>@<version>` is allowed if no
  package depends on it; still avoid it unless the version is truly wrong.
- NEVER delete, rebase, or rewrite published history. Version commits and
  `vX.Y.Z` tags stay forever.

## npm operational facts

- `npm whoami` must succeed (publishing account) before any publish.
- Version commits are bare `X.Y.Z`; git tags are `vX.Y.Z`.
- Publishing targets registry.npmjs.org with the `latest` dist-tag.
- This package has a server entrypoint (`dist/index.js`, thin stub) and a
  TUI entrypoint (`dist/tui.js`); a version bump affects both — one release
  covers the package as a whole.