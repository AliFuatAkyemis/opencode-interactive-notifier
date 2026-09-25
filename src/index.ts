// Server-side (main) entrypoint.
//
// OpenCode 2 runs the interactive notifier as a CLI plugin instead: the
// notifier needs terminal-window focus detection, tab switching
// (`ui.tabs.focus`), and the kdialog/notify-send environment, which only
// exist in the client process. This entrypoint exists so the package loads as
// an active plugin (required for the `./tui` entrypoint to be discovered and
// run by the TUI). See `src/tui.ts` for the implementation.

export default {
  id: "opencode-interactive-notifier",
  setup() {},
}