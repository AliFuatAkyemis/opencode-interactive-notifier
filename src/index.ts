import { spawn, execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, dirname, basename } from "node:path"
import { fileURLToPath } from "node:url"
import { OpencodeClient } from "@opencode-ai/sdk/v2/client"

type Config = {
  enabled?: boolean
  suppressWhenFocused?: boolean
  timeout?: number
}

function loadConfig(): Config {
  const path = join(homedir(), ".config", "opencode", "opencode-interactive-notifier.json")
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Config
  } catch {
    return {}
  }
}

type RunResult = { code: number; out: string; proc: ReturnType<typeof spawn> }

function runCmd(bin: string, args: string[], timeoutMs?: number): Promise<RunResult> {
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

function runKdialog(args: string[], timeoutMs?: number): Promise<RunResult> {
  return runCmd("kdialog", args, timeoutMs)
}

function runBanner(title: string, body: string, actions: string[], timeoutMs?: number): Promise<RunResult> {
  const icon = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "opencode-logo-dark.png")
  const args = ["--app-name", "OpenCode", "-t", String(timeoutMs ?? 0), "--hint", "int:transient:1"]
  if (existsSync(icon)) args.push("--icon", icon)
  for (const a of actions) args.push("-A", a)
  args.push(title, body)
  return runCmd("notify-send", args, timeoutMs)
}

function hasTool(bin: string): boolean {
  try {
    execFileSync("which", [bin], { timeout: 1000, stdio: ["ignore", "pipe", "ignore"] })
    return true
  } catch {
    return false
  }
}

const WINDOW_TOOL = hasTool("kdotool") ? "kdotool" : hasTool("xdotool") ? "xdotool" : null

function activeWindowIsThisSession(): boolean {
  try {
    if (!WINDOW_TOOL) return false
    const tool = WINDOW_TOOL === "kdotool" ? ["getactivewindow"] : ["getactivewindow"]
    const activeId = execFileSync(WINDOW_TOOL, tool, { timeout: 1000, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim()
    if (!activeId) return false
    const pidCmd = WINDOW_TOOL === "kdotool" ? ["getwindowpid", activeId] : ["getwindowpid", activeId]
    const activePid = execFileSync(WINDOW_TOOL, pidCmd, {
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

function shouldSuppress(config: Config): boolean {
  return config.suppressWhenFocused !== false && activeWindowIsThisSession()
}

const TERMINAL_CLASSES = ["alacritty", "konsole", "ghostty", "kitty", "wezterm", "foot", "xterm", "urxvt", "gnome-terminal"]

function focusTerminalWindow(): void {
  try {
    if (!WINDOW_TOOL) return
    let pid = process.ppid
    for (let i = 0; i < 10; i++) {
      if (pid <= 1) break
      try {
        const searchArgs = WINDOW_TOOL === "kdotool" ? ["search", "--pid", String(pid)] : ["search", "--pid", String(pid)]
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
            const clsArgs = WINDOW_TOOL === "kdotool" ? ["getwindowclassname", id] : ["getwindowclassname", id]
            cls = execFileSync(WINDOW_TOOL, clsArgs, {
              timeout: 1000,
              stdio: ["ignore", "pipe", "ignore"],
            })
              .toString()
              .trim()
              .toLowerCase()
          } catch {}
          if (TERMINAL_CLASSES.some((t) => cls.includes(t))) {
            const actArgs = WINDOW_TOOL === "kdotool" ? ["windowactivate", id] : ["windowactivate", id]
            execFileSync(WINDOW_TOOL, actArgs, { timeout: 1500, stdio: ["ignore", "pipe", "ignore"] })
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

type PermissionRequest = {
  id: string
  sessionID: string
  permission: string
  patterns: string[]
  metadata: Record<string, unknown>
  always: string[]
  tool?: { messageID: string; callID: string }
}

type QuestionInfo = {
  question: string
  header: string
  options: Array<{ label: string; description: string }>
  multiple?: boolean
  custom?: boolean
}

type QuestionRequest = {
  id: string
  sessionID: string
  questions: QuestionInfo[]
  tool?: { messageID: string; callID: string }
}

export const KdeInteractivePlugin = async ({ client, serverUrl, directory }: {
  client: any
  serverUrl: URL
  directory: string
}) => {
  const config = loadConfig()
  const v2 = new OpencodeClient({ client: client._client ?? client })
  const active: Map<string, ReturnType<typeof spawn>> = new Map()

  const killDialog = (requestID: string) => {
    const proc = active.get(requestID)
    if (proc) {
      try {
        proc.kill("SIGTERM")
      } catch {}
      active.delete(requestID)
    }
  }

  const permissionSummary = (p: PermissionRequest): { title: string; text: string } => {
    const meta = p.metadata ?? {}
    const command = meta.command ?? meta.cmd ?? meta.pattern
    const lines: string[] = []
    if (command !== undefined) lines.push(`Command: ${String(command)}`)
    const extra = (Object.keys(meta) as string[])
      .filter((k) => !["tool", "callID", "messageID", "sessionID", "command", "cmd", "pattern"].includes(k))
      .map((k) => {
        const v = meta[k]
        const s = v && typeof v === "object" ? JSON.stringify(v) : String(v)
        return `${k}: ${s}`
      })
    if (extra.length) lines.push(...extra)
    if (!lines.length) lines.push(p.permission)
    return { title: "Permission requested", text: lines.join("\n") }
  }

  const handlePermission = async (p: PermissionRequest) => {
    if (shouldSuppress(config)) return
    const { title, text } = permissionSummary(p)
    try {
      const timeout = (config.timeout ?? 30) * 1000
      const res = await runBanner(title, text, ["once=Allow once", "always=Always allow", "reject=Reject"], timeout)
      active.set(p.id, res.proc)
      const reply = res.out as "once" | "always" | "reject"
      if (res.code === 0 && ["once", "always", "reject"].includes(reply)) {
        await v2.permission.reply({ requestID: p.id, reply, directory })
      }
    } catch {}
    active.delete(p.id)
  }

  const CUSTOM_LABEL = "Type your own answer…"

  const askQuestion = async (q: QuestionInfo): Promise<{ cancelled: boolean; answers: string[] }> => {
    if (q.options && q.options.length) {
      const labels = q.options.map((o) => o.label)
      if (q.multiple) {
        const args = ["--title", "Question", "--checklist", q.question]
        for (const label of labels) args.push(label, "off")
        const res = await runKdialog(args)
        if (res.code === 0 && res.out) return { cancelled: false, answers: res.out.split(/\s+/) }
        return { cancelled: true, answers: [] }
      } else {
        const args = ["--title", "Question", "--menu", q.question]
        for (const label of labels) args.push(label, label)
        const custom = q.custom !== false
        if (custom) args.push(CUSTOM_LABEL, CUSTOM_LABEL)
        const res = await runKdialog(args)
        if (res.code !== 0) return { cancelled: true, answers: [] }
        if (res.out === CUSTOM_LABEL) {
          const input = await runKdialog(["--title", "Question", "--inputbox", q.question, ""])
          if (input.code === 0) return { cancelled: false, answers: [input.out] }
          return { cancelled: true, answers: [] }
        }
        return { cancelled: false, answers: [res.out] }
      }
    }
    const res = await runKdialog(["--title", "Question", "--inputbox", q.question, ""])
    if (res.code === 0) return { cancelled: false, answers: [res.out] }
    return { cancelled: true, answers: [] }
  }

  const handleQuestion = async (q: QuestionRequest) => {
    if (shouldSuppress(config)) return
    try {
      const body = q.questions
        .map((question) => {
          const opts = question.options?.length
            ? `\n${question.options.map((o, i) => `${i + 1}. ${o.label}`).join("\n")}`
            : ""
          return `${question.question}${opts}`
        })
        .join("\n")
      const timeout = (config.timeout ?? 30) * 1000
      const res = await runBanner("Question", body, ["answer=Answer"], timeout)
      active.set(q.id, res.proc)
      if (res.code !== 0 || res.out !== "answer") {
        active.delete(q.id)
        return
      }
      active.delete(q.id)
      const answers: string[][] = []
      for (const question of q.questions) {
        const { cancelled, answers: answer } = await askQuestion(question)
        if (cancelled) return
        answers.push(answer)
      }
      await v2.question.reply({ requestID: q.id, answers, directory })
    } catch {}
  }

  const projectName = basename(directory)

  const handleEventNotification = async (title: string, body: string, actions: string[] = [], onAction?: () => void) => {
    if (shouldSuppress(config)) return
    try {
      const timeout = (config.timeout ?? 30) * 1000
      const res = await runBanner(title, body, actions, timeout)
      if (actions.length && res.code === 0 && res.out && onAction) onAction()
    } catch {}
  }

  return {
    event: async ({ event }: { event: { type: string; properties: any } }) => {
      if (event.type === "permission.asked") {
        void handlePermission(event.properties as PermissionRequest)
      } else if (event.type === "permission.replied") {
        killDialog(event.properties?.requestID)
      } else if (event.type === "question.asked") {
        void handleQuestion(event.properties as QuestionRequest)
      } else if (event.type === "question.replied" || event.type === "question.rejected") {
        killDialog(event.properties?.requestID)
      } else if (event.type === "session.created") {
        const props = event.properties as { parentID?: string }
        if (!props?.parentID) void handleEventNotification(`Started · ${projectName}`, "")
      } else if (event.type === "session.idle") {
        void handleEventNotification(`Completed · ${projectName}`, "", ["jump=Jump to terminal"], focusTerminalWindow)
      } else if (event.type === "session.error") {
        const props = event.properties as { error?: { name?: string } }
        const errName = props?.error?.name ? `: ${props.error.name}` : ""
        void handleEventNotification(`Error · ${projectName}`, errName.trim() ? `Error${errName}` : "")
      }
    },
  }
}

export default KdeInteractivePlugin