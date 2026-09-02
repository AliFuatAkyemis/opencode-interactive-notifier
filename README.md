# opencode-kde-interactive

KDE Plasma interactive notifications for [opencode](https://opencode.ai). Permission requests and questions show up as native Plasma banners with action buttons; answers are sent back to opencode.

## Features

- **Permissions**: banner with `Allow once` / `Always allow` / `Reject` buttons → direct reply
- **Questions**: banner with `Answer` button → opens kdialog dialog (menu / checklist / inputbox + custom answer)
- **Focus-aware**: suppressed when the terminal has focus (TUI already shows the prompt)
- **Timeout**: banners expire automatically, no reply sent

## Requirements

- KDE Plasma (Wayland recommended)
- `kdialog`, `notify-send`, `kdotool` (KDE scripts / kdotool for focus detection)

## Install

```
opencode plugin add opencode-kde-interactive
```

Or add to `opencode.jsonc`:

```jsonc
{
  "plugin": ["opencode-kde-interactive"]
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