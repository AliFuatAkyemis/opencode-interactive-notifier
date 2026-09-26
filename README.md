# opencode-interactive-notifier

KDE Plasma interactive notifications for [opencode](https://opencode.ai) (OpenCode V2, CLI plugin). Permission requests, questions, and session events (started / completed / error) show up as native Plasma banners; answers are sent back to opencode, and the jump action focuses the terminal **and switches to the tab** that finished.

## How it works

OpenCode V2 separates the terminal UI (TUI/client) from the background service. The notifier runs as a **[CLI plugin](https://opencode.ai/v2/docs/build/plugins/cli)** (`./tui` entrypoint) inside the TUI process, because only the client knows terminal-window focus, the open session tabs, and can show kdialog/notify-send. The server-side entrypoint is a stub required for the TUI part to load. (Level of this doc: use the V2 plugin context via `data.listen` for server events; see below.)

## Features

- **Permissions**: banner with `Allow once` / `Always allow` / `Reject` buttons → direct reply
- **Questions**: notification; clicking the notification **body** opens a kdialog dialog (menu / checklist / inputbox with custom answer) → form reply
- **Session events**: `Started · <project>` / `Completed · <project>` / `Error · <project>` banners
- **Jump to result**: clicking the `Completed` notification **body** switches the TUI to the tab whose task finished and raises the terminal window
- **Focus-aware**: notifications are suppressed while the TUI's terminal window is focused — unless the event comes from a *different tab* (background work still notifies). The same rule **dismisses** a pending banner the moment you return focus to the tab it belongs to: no click, no timeout wait — it is gone the moment you are looking at the result. Focusing a *different* tab keeps the banner clickable.
- **Timeout**: banners expire automatically, no answer/jump performed

### Notification interaction

The default interaction is **body-click**: clicking a notification's body acts as the action (freedesktop "default" action, supported by Plasma). To use visible action buttons instead, set `notificationInteraction` to `"buttons"`:

```json
{
  "notificationInteraction": "buttons"
}
```

Permission prompts always use buttons (they are real choices).

## Requirements

- OpenCode **V2** (the interactive TUI client; the plugin does not run for `opencode run` / non-interactive mode)
- KDE Plasma (Wayland recommended)
- `kdialog`, `notify-send`
- One of the following for focus detection / jump-to-terminal:
  - `kdotool` (KDE/Wayland, recommended)
  - `xdotool` (X11 fallback)

If neither `kdotool` nor `xdotool` is installed, the plugin still works: banners and dialogs are shown for every event (focus-aware suppression and the tab jump are disabled).

## Install

```
opencode plugin add opencode-interactive-notifier
```

Or add to `opencode.jsonc`:

```jsonc
{
  "plugin": ["opencode-interactive-notifier"]
}
```

The `./tui` entrypoint is discovered automatically by the client for any active plugin.

## Configuration (optional)

The plugin works with sensible defaults out of the box. To customize, create `~/.config/opencode/opencode-interactive-notifier.json`:

```json
{
  "enabled": true,
  "suppressWhenFocused": true,
  "timeout": 30,
  "notificationInteraction": "body"
}
```

| Option | Default | Description |
| --- | --- | --- |
| `enabled` | `true` | Set to `false` to disable the plugin entirely |
| `suppressWhenFocused` | `true` | Suppress notifications while the TUI terminal is focused (except other-tab events; set `false` to always notify) |
| `timeout` | `30` | Banner lifetime in seconds; no answer/jump after it expires |
| `notificationInteraction` | `"body"` | `"body"` = notification body click activates the action; `"buttons"` = visible action buttons |

## Suppression rule

A notification fires when:

1. the TUI terminal window does **not** have focus **or**
2. the terminal has focus but the event belongs to a **different tab** than the one being viewed.

`Started` notifications only fire while the terminal is unfocused (a new tab you just opened is right in front of you).

A **pending banner is dismissed** when the terminal window gains focus **and** the active tab is the banner's own tab — the exact condition that would have suppressed it at emit time. This applies to every banner, including permission and question banners: once you are back at the terminal, the answer is right in front of you in the TUI, and the dismissed banner sends no (stale) reply — the pending request simply remains answerable inline. Banners for a different tab stay until clicked, dismissed, or timed out.

## Development

```
npm install
npm test        # unit tests for the pure logic (node --test)
npm run build   # tsc → dist/, copies assets
```

To test against your local checkout, load it as a directory plugin by adding a `file://` entry to the config (the repo keeps dev-only `index.ts`/`tui.ts` roots because directory plugins are resolved from those filenames, while the npm package uses `exports`):

```jsonc
{
  "plugins": ["file:///path/to/opencode-kde-interactive"]
}
```

Then restart the opencode service (`opencode service restart`) or start a fresh instance so the client loads the new `./tui` entrypoint. The `opencode plugin add` command only accepts npm/Git package specifiers.