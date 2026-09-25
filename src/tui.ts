import { type ChildProcess } from "node:child_process"
import {
  loadConfig,
  permissionSummary,
  shouldSuppressEvent,
  isQuestionForm,
  questionFormToPrompts,
  formPromptToKdialogArgs,
  CUSTOM_ANSWER_LABEL,
  parseKdialogChecklist,
  answersToFormReply,
  bannerActions,
  classifyEvent,
  projectName,
  type Config,
  type FormInfo,
  type FormPrompt,
  type PermissionRequest,
} from "./core.js"
import { runBanner, runKdialog, activeWindowIsThisSession, focusTerminalWindow } from "./helpers.js"

// ---------------------------------------------------------------------------
// Minimal local typings for the TUI plugin context (subsets we use). Kept
// in-repo on purpose: matches the rest of the package, which also avoids the
// heavy @opencode/plugin peer tree for its server entrypoint.
// ---------------------------------------------------------------------------

type TuiTab = {
  sessionID: string
  title?: string
  active: boolean
  busy: boolean
  attention: boolean
  unread?: "activity" | "error"
}

type TuiEvent = {
  id: string
  created: number
  type: string
  location?: { directory?: string }
  data: any
}

type TuiContext = {
  app: { name: string; version: string; channel: string }
  location?: { directory?: string; workspace?: string; project?: { id: string; directory: string; canonical: string } }
  options: Record<string, unknown>
  data: {
    on: (type: string, handler: (event: any) => void) => () => void
    listen: (handler: (event: { details: TuiEvent }) => void) => () => void
    session: {
      list(): Array<{ sessionID: string; title?: string; parentID?: string }>
      get(sessionID: string): { sessionID: string; title?: string; parentID?: string } | undefined
      root(sessionID: string): string
      form: {
        reply(input: { sessionID: string; formID: string; answer: Record<string, unknown> }, location?: unknown): Promise<void>
        cancel(input: { sessionID: string; formID: string }, location?: unknown): Promise<void>
      }
    }
  }
  ui: {
    tabs: {
      enabled(): boolean
      list(): readonly TuiTab[]
      open(sessionID: string): boolean
      focus(sessionID: string): boolean
    }
    router: {
      navigate(destination: { type: "session"; sessionID: string }): void
    }
  }
  client: {
    permission: {
      reply(input: { sessionID: string; requestID: string; decision: "once" | "always" | "reject"; message?: string }): Promise<unknown>
    }
  }
}

// ---------------------------------------------------------------------------
// Notifier core (TUI side)
// ---------------------------------------------------------------------------

export function createNotifier(ctx: TuiContext): () => void {
  const config = loadConfig()
  if (config.enabled === false) return () => {}

  const directory = ctx.location?.directory ?? process.cwd()
  const project = projectName(directory)
  const timeout = (config.timeout ?? 30) * 1000
  const active: Map<string, ChildProcess> = new Map()
  // Forms we already know were answered/dismissed (inline or elsewhere): do
  // not fire doomed cancel/reply RPCs after settle.
  const settled = new Set<string>()

  const killDialog = (requestID: string) => {
    const proc = active.get(requestID)
    if (proc) {
      try {
        proc.kill("SIGTERM")
      } catch {}
      active.delete(requestID)
    }
  }

  const withProject = (body: string): string => {
    const header = `<b>${project}</b>`
    return body ? `${header}\n${body}` : header
  }

  const rootOf = (sessionID: string): string => {
    try {
      return ctx.data.session.root(sessionID)
    } catch {
      return sessionID
    }
  }

  /**
   * Focus-aware suppression. `root` is the ROOT session that owns the event so
   * the "other tab" exception compares tabs the user actually sees.
   */
  const isSuppressed = (root: string | undefined, applyTabException = true): boolean => {
    if (config.suppressWhenFocused === false) return false
    const focused = activeWindowIsThisSession()
    if (!focused) return false
    const activeTab = ctx.ui.tabs.enabled() ? ctx.ui.tabs.list().find((tab) => tab.active)?.sessionID : undefined
    return shouldSuppressEvent({ focused, activeTab, root, suppressWhenFocused: true, applyTabException })
  }

  // -- permission -----------------------------------------------------------

  const handlePermission = async (p: PermissionRequest) => {
    if (isSuppressed(rootOf(p.sessionID))) return
    const { title, text } = permissionSummary(p)
    try {
      const res = await runBanner(title, text, bannerActions(config, "permission"), timeout, (proc) => active.set(p.id, proc))
      if (res.code === 0 && ["once", "always", "reject"].includes(res.out)) {
        await ctx.client.permission.reply({
          sessionID: p.sessionID,
          requestID: p.id,
          decision: res.out as "once" | "always" | "reject",
        })
      }
    } catch {}
    active.delete(p.id)
  }

  // -- questions (forms with kind=question) ---------------------------------

  const questionBody = (form: FormInfo): string => {
    return form.fields
      .map((field) => {
        const heading = [field.title, field.description].filter(Boolean).join("\n")
        const options = (field.options ?? []).map((option, index) => `${index + 1}. ${option.label}`).join("\n")
        return options ? `${heading}\n${options}` : heading
      })
      .join("\n")
  }

  const dialogAnswer = async (formID: string, prompt: FormPrompt): Promise<{ ok: true; value: string | string[] } | { ok: false }> => {
    const watch = (proc: ChildProcess) => active.set(formID, proc)
    const res = await runKdialog(formPromptToKdialogArgs(prompt), timeout, watch)
    active.delete(formID)
    if (res.code !== 0) return { ok: false }
    if (prompt.kind === "menu" && res.out === CUSTOM_ANSWER_LABEL) {
      const input = await runKdialog(["--title", "Question", "--inputbox", prompt.question, ""], timeout, watch)
      active.delete(formID)
      if (input.code !== 0) return { ok: false }
      return { ok: true, value: input.out }
    }
    if (prompt.kind === "checklist") return { ok: true, value: parseKdialogChecklist(res.out) }
    return { ok: true, value: res.out }
  }

  const handleQuestion = async (form: FormInfo) => {
    if (settled.has(form.id)) return
    if (isSuppressed(rootOf(form.sessionID))) return
    try {
      const res = await runBanner("Question", questionBody(form), bannerActions(config, "answer"), timeout, (proc) =>
        active.set(form.id, proc),
      )
      const answerAction = config.notificationInteraction === "buttons" ? "answer" : "default"
      if (res.code !== 0 || res.out !== answerAction) {
        active.delete(form.id)
        return
      }
      active.delete(form.id)

      const picked: Array<string | string[]> = []
      for (const prompt of questionFormToPrompts(form)) {
        if (settled.has(form.id)) return
        const answer = await dialogAnswer(form.id, prompt)
        if (!answer.ok) {
          if (!settled.has(form.id)) {
            await ctx.data.session.form.cancel({ sessionID: form.sessionID, formID: form.id }).catch(() => {})
          }
          return
        }
        picked.push(answer.value)
      }
      if (settled.has(form.id)) return
      await ctx.data.session.form
        .reply({ sessionID: form.sessionID, formID: form.id, answer: answersToFormReply(form.fields, picked) })
        .catch(() => {})
    } catch {}
    active.delete(form.id)
  }

  // -- session events -------------------------------------------------------

  const handleCreated = async (sessionID: string, parentID: string | undefined) => {
    if (parentID) return
    // Startup notifications never fire while focused, not even from another tab.
    if (isSuppressed(sessionID, false)) return
    try {
      await runBanner("Started", withProject(""), [], timeout)
    } catch {}
  }

  const jumpTo = (root: string) => {
    try {
      if (ctx.ui.tabs.enabled()) {
        ctx.ui.tabs.focus(root)
      } else {
        ctx.ui.router.navigate({ type: "session", sessionID: root })
      }
    } catch {}
    focusTerminalWindow()
  }

  const handleCompletion = async (sessionID: string) => {
    const root = rootOf(sessionID)
    if (root !== sessionID) return // only root sessions notify
    if (isSuppressed(root)) return
    try {
      const res = await runBanner("Completed", withProject(""), bannerActions(config, "jump"), timeout)
      const jumpAction = config.notificationInteraction === "buttons" ? "jump" : "default"
      if (res.code === 0 && res.out === jumpAction) jumpTo(root)
    } catch {}
  }

  const handleError = async (sessionID: string, error: { type?: string; message?: string } | undefined) => {
    const root = rootOf(sessionID)
    if (root !== sessionID) return
    if (isSuppressed(root)) return
    const lines: string[] = []
    if (error?.type) lines.push(`Error: ${error.type}`)
    if (error?.message) lines.push(error.message)
    try {
      await runBanner("Error", withProject(lines.length ? lines.join("\n") : "Error"), [], timeout)
    } catch {}
  }

  // -- event subscription ---------------------------------------------------

  const off = ctx.data.listen(({ details }) => {
    const data = details?.data ?? {}
    // Ignore events from other workspaces/projects on a shared server so
    // notifications and jumps stay scoped to the location this TUI runs in.
    const eventLocation = details?.location?.directory
    if (details?.type && ctx.location?.directory && eventLocation && eventLocation !== ctx.location.directory) return
    try {
      switch (classifyEvent(details.type)) {
        case "permission":
          void handlePermission(data)
          break
        case "permission.kill":
          killDialog(data.requestID)
          break
        case "question":
          if (isQuestionForm(data.form)) {
            settled.delete(data.form.id)
            void handleQuestion(data.form)
          }
          break
        case "form.settled":
          settled.add(data.id)
          killDialog(data.id)
          break
        case "started":
          void handleCreated(data.sessionID, data.parentID)
          break
        case "completed":
          if (!data.status || data.status.type === "idle") void handleCompletion(data.sessionID)
          break
        case "error":
          void handleError(data.sessionID, data.error)
          break
        case "none":
          break
      }
    } catch {
      // never break the event stream on a handler error
    }
  })

  return () => off()
}

export default {
  id: "opencode-interactive-notifier",
  setup(ctx: TuiContext) {
    return createNotifier(ctx)
  },
}