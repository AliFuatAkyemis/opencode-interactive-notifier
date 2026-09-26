import { spawn, execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { buildBannerArgs } from "./core.js"

export type RunResult = { code: number; out: string; proc: ReturnType<typeof spawn> }

export type RunOptions = {
  timeoutMs?: number
  onSpawn?: (proc: ReturnType<typeof spawn>) => void
  /** Called once with the daemon notification id as soon as notify-send prints it (-p). */
  onId?: (id: number) => void
}

export function runCmd(bin: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] })
    options.onSpawn?.(proc)
    let out = ""
    let idReported = false
    const timer = options.timeoutMs ? setTimeout(() => proc.kill("SIGTERM"), options.timeoutMs) : undefined
    proc.stdout.on("data", (d) => {
      out += d
      if (options.onId && !idReported) {
        const nl = out.indexOf("\n")
        if (nl !== -1) {
          idReported = true
          const first = out.slice(0, nl).trim()
          if (/^\d+$/.test(first)) options.onId(Number(first))
        }
      }
    })
    proc.stderr.on("data", () => {})
    proc.on("error", reject)
    proc.on("close", (code) => {
      if (timer) clearTimeout(timer)
      resolve({ code: code ?? 1, out: out.trim(), proc })
    })
  })
}

export function runKdialog(args: string[], options: RunOptions = {}): Promise<RunResult> {
  return runCmd("kdialog", args, options)
}

const iconPath = () => {
  const icon = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "opencode-logo-dark.png")
  return existsSync(icon) ? icon : undefined
}

export function runBanner(
  title: string,
  text: string,
  actions: string[],
  options: RunOptions = {},
): Promise<RunResult> {
  const args = buildBannerArgs({ title, text, actions, timeoutMs: options.timeoutMs ?? 0, icon: iconPath() })
  return runCmd("notify-send", args, options)
}

/**
 * Closes a pending notification through the freedesktop CloseNotification
 * call so it disappears from Plasma even when notify-send already returned.
 * Prefers busctl, falling back to dbus-send / qdbus for the same call.
 * No-op without an id (older notify-send without -p support).
 */
export function closeBanner(id: number | undefined): void {
  if (id === undefined) return
  const idStr = String(id)
  const close = (bin: string, args: string[]) => {
    try {
      spawn(bin, args, { stdio: "ignore" })
    } catch {}
  }
  if (hasTool("busctl")) {
    close("busctl", [
      "--user", "call",
      "org.freedesktop.Notifications", "/org/freedesktop/Notifications",
      "org.freedesktop.Notifications", "CloseNotification",
      "u", idStr,
    ])
  } else if (hasTool("dbus-send")) {
    close("dbus-send", [
      "--session", "--dest=org.freedesktop.Notifications",
      "/org/freedesktop/Notifications",
      "org.freedesktop.Notifications", "CloseNotification",
      `uint32:${idStr}`,
    ])
  } else if (hasTool("qdbus6")) {
    close("qdbus6", ["org.freedesktop.Notifications", "/org/freedesktop/Notifications", "org.freedesktop.Notifications", "CloseNotification", idStr])
  } else {
    close("qdbus", ["org.freedesktop.Notifications", "/org/freedesktop/Notifications", "org.freedesktop.Notifications", "CloseNotification", idStr])
  }
}

export function hasTool(bin: string): boolean {
  try {
    execFileSync("which", [bin], { timeout: 1000, stdio: ["ignore", "pipe", "ignore"] })
    return true
  } catch {
    return false
  }
}

export const WINDOW_TOOL = hasTool("kdotool") ? "kdotool" : hasTool("xdotool") ? "xdotool" : null

// Focus polling runs in-process with the TUI, so cache the result briefly
// instead of spawning two subprocesses per handled event.
const focusCache: { value: boolean; at: number } = { value: false, at: 0 }

function computeFocus(): boolean {
  try {
    if (!WINDOW_TOOL) return false
    const activeId = execFileSync(WINDOW_TOOL, ["getactivewindow"], {
      timeout: 1000,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim()
    if (!activeId) return false
    const activePid = execFileSync(WINDOW_TOOL, ["getwindowpid", activeId], {
      timeout: 1000,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim()
    if (!activePid) return false
    let pid = process.ppid
    for (let i = 0; i < 10; i++) {
      if (pid === Number(activePid)) return true
      if (pid <= 1) break
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
        const m = stat.match(/\)\s+\w+\s+(\d+)/)
        if (!m) break
        pid = Number(m[1])
      } catch {
        break
      }
    }
    return false
  } catch {
    return false
  }
}

export function activeWindowIsThisSession(ttlMs = 300): boolean {
  const now = Date.now()
  if (now - focusCache.at < ttlMs) return focusCache.value
  const value = computeFocus()
  focusCache.value = value
  focusCache.at = now
  return value
}

const TERMINAL_CLASSES = ["alacritty", "konsole", "ghostty", "kitty", "wezterm", "foot", "xterm", "urxvt", "gnome-terminal"]

export function focusTerminalWindow(): void {
  try {
    if (!WINDOW_TOOL) return
    let pid = process.ppid
    for (let i = 0; i < 10; i++) {
      if (pid <= 1) break
      try {
        const searchArgs = WINDOW_TOOL === "kdotool" ? ["search", "--all", "--pid", String(pid)] : ["search", "--pid", String(pid)]
        const matches = execFileSync(WINDOW_TOOL, searchArgs, {
          timeout: 1500,
          stdio: ["ignore", "pipe", "ignore"],
        })
          .toString()
          .trim()
        const ids = matches.split("\n").filter(Boolean)
        for (const id of ids) {
          let cls = ""
          try {
            cls = execFileSync(WINDOW_TOOL, ["getwindowclassname", id], {
              timeout: 1000,
              stdio: ["ignore", "pipe", "ignore"],
            })
              .toString()
              .trim()
              .toLowerCase()
          } catch {}
          if (TERMINAL_CLASSES.some((t) => cls.includes(t))) {
            execFileSync(WINDOW_TOOL, ["windowactivate", id], { timeout: 1500, stdio: ["ignore", "pipe", "ignore"] })
            return
          }
        }
      } catch {}
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
      const m = stat.match(/\)\s+\w+\s+(\d+)/)
      if (!m) break
      pid = Number(m[1])
    }
  } catch {}
}