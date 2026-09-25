import { spawn, execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { buildBannerArgs } from "./core.js"

export type RunResult = { code: number; out: string; proc: ReturnType<typeof spawn> }

export function runCmd(bin: string, args: string[], timeoutMs?: number): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] })
    let out = ""
    const timer = timeoutMs ? setTimeout(() => proc.kill("SIGTERM"), timeoutMs) : undefined
    proc.stdout.on("data", (d) => (out += d))
    proc.stderr.on("data", () => {})
    proc.on("error", reject)
    proc.on("close", (code) => {
      if (timer) clearTimeout(timer)
      resolve({ code: code ?? 1, out: out.trim(), proc })
    })
  })
}

export function runKdialog(args: string[], timeoutMs?: number): Promise<RunResult> {
  return runCmd("kdialog", args, timeoutMs)
}

const iconPath = () => {
  const icon = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "opencode-logo-dark.png")
  return existsSync(icon) ? icon : undefined
}

export function runBanner(title: string, text: string, actions: string[], timeoutMs?: number): Promise<RunResult> {
  const args = buildBannerArgs({ title, text, actions, timeoutMs: timeoutMs ?? 0, icon: iconPath() })
  return runCmd("notify-send", args, timeoutMs)
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

export function activeWindowIsThisSession(): boolean {
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