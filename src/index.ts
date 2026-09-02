import { spawn, execFileSync } from "node:child_process"
import { existsSync, readFileSync, appendFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { OpencodeClient } from "@opencode-ai/sdk/v2/client"

const LOG = join(homedir(), ".config", "opencode", "kde-interactive.log")

function log(...args: unknown[]) {
  try {
    appendFileSync(LOG, `[${new Date().toISOString()}] ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`)
  } catch {}
}

type Config = {
  enabled?: boolean
  suppressWhenFocused?: boolean
  timeout?: number
}

function loadConfig(): Config {
  const path = join(homedir(), ".config", "opencode", "kde-interactive.json")
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
  const args = ["--app-name", "OpenCode", "-t", String(timeoutMs ?? 0), "--hint", "int:transient:1"]
  for (const a of actions) args.push("-A", a)
  args.push(title, body)
  return runCmd("notify-send", args, timeoutMs)
}

function terminalFocused(): boolean {
  try {
    const out = execFileSync("kdotool", ["getactivewindow"], { timeout: 1000, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim()
    if (!out) return false
    let name = ""
    try {
      name = execFileSync("kdotool", ["getwindowclassname", out], {
        timeout: 1000,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim()
        .toLowerCase()
    } catch {}
    if (!name) {
      name = execFileSync("kdotool", ["getwindowname", out], {
        timeout: 1000,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim()
        .toLowerCase()
    }
    const terms = ["alacritty", "ghostty", "konsole", "kitty", "wezterm", "foot", "kitty", "urxvt", "xterm", "st-"]
    return terms.some((t) => name.includes(t))
  } catch {
    return false
  }
}

function shouldSuppress(config: Config): boolean {
  return config.suppressWhenFocused !== false && terminalFocused()
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
  log("plugin init", { hasServerUrl: !!serverUrl, serverUrl: serverUrl?.toString(), directory })
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
    const lines: string[] = []
    lines.push(`Permission type: ${p.permission}`)
    if (p.patterns && p.patterns.length) {
      lines.push("")
      lines.push("Request:")
      for (const pat of p.patterns) lines.push(`  • ${pat}`)
    }
    const meta = p.metadata ?? {}
    const command = meta.command ?? meta.cmd ?? meta.pattern
    if (command !== undefined) {
      lines.push("")
      lines.push(`Komut: ${String(command)}`)
    }
    const extra = (Object.keys(meta) as string[])
      .filter((k) => !["tool", "callID", "messageID", "sessionID", "command", "cmd", "pattern"].includes(k))
      .map((k) => {
        const v = meta[k]
        const s = v && typeof v === "object" ? JSON.stringify(v) : String(v)
        return `${k}: ${s}`
      })
    if (extra.length) {
      lines.push("")
      lines.push(...extra)
    }
    return { title: "OpenCode — Permission requested", text: lines.join("\n") }
  }

  const handlePermission = async (p: PermissionRequest) => {
    if (shouldSuppress(config)) return
    const { title, text } = permissionSummary(p)
    try {
      const timeout = config.timeout ? config.timeout * 1000 : undefined
      const res = await runBanner(title, text, ["once=Allow once", "always=Always allow", "reject=Reject"], timeout)
      active.set(p.id, res.proc)
      log("permission banner result", { code: res.code, out: res.out })
      const reply = res.out as "once" | "always" | "reject"
      if (res.code === 0 && ["once", "always", "reject"].includes(reply)) {
        await v2.permission.reply({ requestID: p.id, reply, directory })
        log("permission reply sent", { requestID: p.id, reply })
      } else {
        log("permission banner timeout/closed", { requestID: p.id })
      }
    } catch (e) {
      log("permission banner ERROR", { requestID: p.id, error: (e as Error).message })
    }
    active.delete(p.id)
  }

  const CUSTOM_LABEL = "Type your own answer…"

const askQuestion = async (q: QuestionInfo): Promise<{ cancelled: boolean; answers: string[] }> => {
    log("askQuestion start", { question: q.question, options: q.options, multiple: q.multiple, custom: q.custom })
    if (q.options && q.options.length) {
      const labels = q.options.map((o) => o.label)
      if (q.multiple) {
        const args = ["--title", "OpenCode — Question", "--checklist", q.question]
        for (const label of labels) args.push(label, "off")
        const res = await runKdialog(args)
        log("checklist result", { code: res.code, out: res.out })
        if (res.code === 0 && res.out) return { cancelled: false, answers: res.out.split(/\s+/) }
        return { cancelled: true, answers: [] }
      } else {
        const args = ["--title", "OpenCode — Question", "--menu", q.question]
        for (const label of labels) args.push(label, label)
        const custom = q.custom !== false
        if (custom) args.push(CUSTOM_LABEL, CUSTOM_LABEL)
        const res = await runKdialog(args)
        log("menu result", { code: res.code, out: res.out })
        if (res.code !== 0) return { cancelled: true, answers: [] }
        if (res.out === CUSTOM_LABEL) {
          const input = await runKdialog(["--title", "OpenCode — Question", "--inputbox", q.question, ""])
          log("custom inputbox result", { code: input.code, out: input.out })
          if (input.code === 0) return { cancelled: false, answers: [input.out] }
          return { cancelled: true, answers: [] }
        }
        return { cancelled: false, answers: [res.out] }
      }
    }
    const res = await runKdialog(["--title", "OpenCode — Question", "--inputbox", q.question, ""])
    log("inputbox result", { code: res.code, out: res.out })
    if (res.code === 0) return { cancelled: false, answers: [res.out] }
    return { cancelled: true, answers: [] }
  }

  const handleQuestion = async (q: QuestionRequest) => {
    if (shouldSuppress(config)) return
    try {
      const body = q.questions
        .map((question) => {
          const opts = question.options?.length
            ? `\n${question.options.map((o) => `  • ${o.label}`).join("\n")}`
            : ""
          return `${question.question}${opts}`
        })
        .join("\n")
      const timeout = config.timeout ? config.timeout * 1000 : undefined
      const res = await runBanner("OpenCode — Question", body, ["answer=Answer"], timeout)
      active.set(q.id, res.proc)
      log("question banner result", { code: res.code, out: res.out })
      if (res.code !== 0 || res.out !== "answer") {
        log("question banner timeout/closed", { requestID: q.id })
        active.delete(q.id)
        return
      }
      active.delete(q.id)
      const answers: string[][] = []
      for (const question of q.questions) {
        const { cancelled, answers: answer } = await askQuestion(question)
        if (cancelled) {
          log("question cancelled", { requestID: q.id, question: question.question })
          return
        }
        answers.push(answer)
      }
      log("question reply attempt", { requestID: q.id, answers, directory })
      const result = await v2.question.reply({ requestID: q.id, answers, directory })
      log("question reply result", result)
    } catch (e) {
      log("question reply ERROR", { requestID: q.id, error: (e as Error).message, stack: (e as Error).stack })
    }
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
      }
    },
  }
}

export default KdeInteractivePlugin