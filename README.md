# opencode-interactive-notifier

KDE Plasma interactive notifications for [opencode](https://opencode.ai). Permission requests and questions show up as native Plasma banners with action buttons; answers are sent back to opencode.

## Features

- **Permissions**: banner with `Allow once` / `Always allow` / `Reject` buttons → direct reply
- **Questions**: banner with `Answer` button → opens kdialog dialog (menu / checklist / inputbox + custom answer)
- **Session events**: `Started · <project>` / `Completed · <project>` / `Error · <project>` banners when the terminal loses focus
- **Jump to terminal**: `Completed` banner has a button that focuses the session's terminal window
- **Focus-aware**: suppressed when this session's terminal has focus (TUI already shows the prompt)
- **Timeout**: banners expire automatically, no reply sent
- **Clean format**: no decorative dashes; numbered question options; concise permission body

## Requirements

- KDE Plasma (Wayland recommended)
- `kdialog`, `notify-send`
- One of the following for focus detection / jump-to-terminal:
  - `kdotool` (KDE/Wayland, recommended)
  - `xdotool` (X11 fallback)

If neither `kdotool` nor `xdotool` is installed, the plugin still works:
banners and dialogs are shown for every event (focus-aware suppression
and the "Jump to terminal" action are disabled).

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

## Configuration

Create `~/.config/opencode/kde-interactive.json`:

```json
{
  "enabled": true,
  "suppressWhenFocused": true,
  "timeout": 30
}
```

| Option | Default | Description |
| --- | --- | --- |
| `enabled` | `true` | Master switch |
| `suppressWhenFocused` | `true` | Skip banners when the terminal window has focus |
| `timeout` | `30` | Banner timeout in seconds |

## Development

```
npm install
npm run build
```

## License

MIT