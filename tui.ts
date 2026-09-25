// Dev-only TUI entrypoint for local loading (see index.ts). The client host
// resolves `./tui` at the plugin directory root; the published npm package
// exposes this through the package.json `exports["./tui"]` instead.
export { default } from "./dist/tui.js"