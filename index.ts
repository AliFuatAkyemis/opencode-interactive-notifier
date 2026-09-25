// Dev-only entrypoint for loading this repo as a local OpenCode plugin
// (config entry `file:///home/alifuat/Git/opencode-kde-interactive`). The
// V2 plugin host resolves `./index` + `./tui` at the plugin directory root;
// the published npm package ignores this file (`files: ["dist","assets"]`).
export { default } from "./dist/index.js"