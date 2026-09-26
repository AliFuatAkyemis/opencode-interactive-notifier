import { existsSync, readFileSync } from "node:fs"
import { join, basename } from "node:path"
import { homedir } from "node:os"

export type Config = {
  enabled?: boolean
  suppressWhenFocused?: boolean
  timeout?: number
  notificationInteraction?: "body" | "buttons"
}

export function loadConfig(filePath?: string): Config {
  const path = filePath ?? join(homedir(), ".config", "opencode", "opencode-interactive-notifier.json")
  if (!path || !existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Config
  } catch {
    return {}
  }
}

// V2 permission request shape (permission.asked event payload).
export type PermissionRequest = {
  id: string
  sessionID: string
  action?: string
  resources?: string[]
  save?: string[]
  metadata?: Record<string, unknown>
  source?: { type: "tool"; messageID: string; id: string }
  message?: string
}

export function permissionSummary(p: PermissionRequest): { title: string; text: string } {
  const lines: string[] = []
  if (p.action) lines.push(`Action: ${p.action}`)
  for (const resource of p.resources ?? []) lines.push(`Resource: ${resource}`)
  if (p.message) lines.push(`Message: ${p.message}`)
  const meta = p.metadata ?? {}
  for (const [key, value] of Object.entries(meta)) {
    if (["tool", "callID", "messageID", "sessionID", "command", "cmd", "pattern"].includes(key)) continue
    const shown = value && typeof value === "object" ? JSON.stringify(value) : String(value)
    lines.push(`${key}: ${shown}`)
  }
  if (!lines.length) lines.push(p.action || "Permission requested")
  return { title: "Permission requested", text: lines.join("\n") }
}

export type SuppressionInput = {
  focused: boolean
  activeTab: string | undefined
  root: string | undefined
  suppressWhenFocused: boolean
  /** Set false for startup events: never notify while focused, even from another tab. */
  applyTabException?: boolean
}

/**
 * True = hide the notification.
 * Notifications are hidden only while the terminal window is focused AND the
 * event belongs to the tab the user is currently looking at. An event from a
 * different tab (background work) still notifies.
 */
export function shouldSuppressEvent({ focused, activeTab, root, suppressWhenFocused, applyTabException }: SuppressionInput): boolean {
  if (suppressWhenFocused === false) return false
  if (!focused) return false
  if (applyTabException === false) return true
  if (activeTab !== undefined && root !== undefined && activeTab !== root) return false
  return true
}

// ------------------------------------------------------------------ forms

export type FormField = {
  key: string
  type: string
  title?: string
  description?: string
  options?: Array<{ value: string; label: string; description?: string }>
  custom?: boolean
}

export type FormInfo = {
  id: string
  sessionID: string
  title?: string
  metadata?: Record<string, unknown>
  fields: FormField[]
}

export function isQuestionForm(form: FormInfo): boolean {
  return form.metadata?.kind === "question"
}

export const CUSTOM_ANSWER_LABEL = "Type your own answer…"

export type FormPrompt = {
  key: string
  kind: "menu" | "checklist" | "inputbox"
  title: string
  question: string
  options: string[]
  custom: boolean
}

export function questionFormToPrompts(form: FormInfo): FormPrompt[] {
  return form.fields.map((field): FormPrompt => {
    const options = (field.options ?? []).map((option) => option.label)
    const question = field.description || field.title || ""
    if (field.type === "multiselect") {
      return { key: field.key, kind: "checklist", title: field.title || "Question", question, options, custom: false }
    }
    if (options.length) {
      return { key: field.key, kind: "menu", title: field.title || "Question", question, options, custom: field.custom !== false }
    }
    return { key: field.key, kind: "inputbox", title: field.title || "Question", question, options: [], custom: false }
  })
}

export function formPromptToKdialogArgs(prompt: FormPrompt): string[] {
  const title = "Question"
  if (prompt.kind === "checklist") {
    // --separate-output prints selected labels one per line, unquoted, so
    // multi-word options survive round-tripping.
    const args = ["--title", title, "--separate-output", "--checklist", prompt.question]
    for (const option of prompt.options) args.push(option, "off")
    return args
  }
  if (prompt.kind === "menu") {
    const args = ["--title", title, "--menu", prompt.question]
    for (const option of prompt.options) args.push(option, option)
    if (prompt.custom) args.push(CUSTOM_ANSWER_LABEL, CUSTOM_ANSWER_LABEL)
    return args
  }
  return ["--title", title, "--inputbox", prompt.question, ""]
}

export function parseKdialogChecklist(out: string): string[] {
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
}

/** Picked answers are parallel to form fields; multiselect fields collect arrays. */
export function answersToFormReply(fields: FormField[], picked: Array<string | string[]>): Record<string, string | string[]> {
  const reply: Record<string, string | string[]> = {}
  for (let index = 0; index < fields.length; index++) {
    reply[fields[index].key] = picked[index] ?? []
  }
  return reply
}

// ------------------------------------------------------------------ banners

export type BannerActionKind = "permission" | "jump" | "answer" | "passive"

export function bannerActions(config: Pick<Config, "notificationInteraction">, kind: BannerActionKind): string[] {
  if (kind === "permission") return ["once=Allow once", "always=Always allow", "reject=Reject"]
  if (kind === "jump") {
    return config.notificationInteraction === "buttons" ? ["jump=Jump to terminal"] : ["default=Jump to terminal"]
  }
  if (kind === "answer") {
    return config.notificationInteraction === "buttons" ? ["answer=Answer"] : ["default=Answer"]
  }
  return []
}

export function buildBannerArgs(input: {
  title: string
  text: string
  actions: string[]
  timeoutMs: number
  icon: string | undefined
}): string[] {
  const args = ["--app-name", "OpenCode", "-t", String(input.timeoutMs), "--hint", "int:transient:1"]
  // -p prints the daemon-assigned notification id as the first stdout line so a
  // pending banner can be closed remotely via CloseNotification.
  args.push("-p")
  if (input.icon) args.push("--icon", input.icon)
  for (const action of input.actions) args.push("-A", action)
  args.push(input.title, input.text)
  return args
}

// Every action key the plugin reacts to. `default` is the freedesktop body-
// click action in "body" mode; the others are labeled buttons.
export const BANNER_ACTIONS = new Set(["default", "jump", "answer", "once", "always", "reject"])

export type BannerOut = { id?: number; action?: string }

/**
 * Parses the accumulated stdout of a notify-send banner run. With `-p` the
 * first line is the numeric notification id; when the user activates an
 * action notify-send appends the action key, so the last line carries the
 * action when it is one of the keys the plugin reacts to. Also covers the
 * legacy shape without `-p` (a single action line).
 */
export function parseBannerOut(out: string | undefined): BannerOut {
  const lines = (out ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  if (!lines.length) return {}
  let id: number | undefined
  if (/^\d+$/.test(lines[0])) {
    id = Number(lines[0])
    lines.shift()
  }
  const last = lines.at(-1)
  return { id, action: last !== undefined && BANNER_ACTIONS.has(last) ? last : undefined }
}

export function projectName(directory: string | undefined): string {
  return basename(directory ?? "")
}

export type EventKind = "permission" | "permission.kill" | "question" | "form.settled" | "started" | "completed" | "error" | "none"

/**
 * Maps an OpenCode event type to the notifier behavior it triggers.
 * v2.0.16 emits `session.execution.succeeded/failed`; `session.idle`,
 * `session.status` and `session.error` are legacy types with no v2.0.16
 * producer, kept for forward compatibility.
 */
export function classifyEvent(type: string): EventKind {
  switch (type) {
    case "permission.asked":
      return "permission"
    case "permission.replied":
      return "permission.kill"
    case "form.created":
      return "question"
    case "form.replied":
    case "form.cancelled":
      return "form.settled"
    case "session.created":
      return "started"
    case "session.execution.succeeded":
    case "session.idle":
    case "session.status":
      return "completed"
    case "session.execution.failed":
    case "session.error":
      return "error"
    default:
      return "none"
  }
}