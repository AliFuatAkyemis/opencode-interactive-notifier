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
  parseBannerOut,
  type Config,
  type FormInfo,
  type FormPrompt,
  type PermissionRequest,
} from "./core.js"
import { runBanner, runKdialog, closeBanner, activeWindowIsThisSession, focusTerminalWindow } from "./helpers.js"

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

  // Live processes we may need to end while an event is in flight.
  // - kind "banner": notify-send behind a notification; id = daemon id (-p),
  //   root = owning root session for the focus/tab dismiss rule.
  // - kind "dialog": kdialog window (question answer flow), never auto-closed.
  type ActiveEntry = { proc: ChildProcess; kind: "banner" | "dialog"; id?: number; root?: string }
  const active: Map<string, ActiveEntry> = new Map()
  // Forms we already know were answered/dismissed (inline or elsewhere): do
  // not fire doomed cancel/reply RPCs after settle.
  const settled = new Set<string>()

  const killDialog = (requestID: string) => {
    const entry = active.get(requestID)
    if (entry) {
      try {
        entry.proc.kill("SIGTERM")
      } catch {}
      active.delete(requestID)
    }
  }

  /**
   * Dismiss every pending banner whose suppression rule now says it would be
   * hidden: the terminal window is focused and the user is viewing the banner's
   * own tab. A different-tab focus keeps the banner clickable. Mirrors
   * `shouldSuppressEvent` used at emit time, surfaced again here.
   */
  const dismissIfFocused = () => {
    if (config.suppressWhenFocused === false) return
    const focused = activeWindowIsThisSession()
    if (!focused) return
    const activeTab = ctx.ui.tabs.enabled() ? ctx.ui.tabs.list().find((tab) => tab.active)?.sessionID : undefined
    for (const [key, entry] of [...active]) {
      if (entry.kind !== "banner") continue
      if (shouldSuppressEvent({ focused: true, activeTab, root: entry.root, suppressWhenFocused: true, applyTabException: true })) {
        closeBanner(entry.id)
        try {
          entry.proc.kill("SIGTERM")
        } catch {}
        active.delete(key)
      }
    }
    syncFocusTimer()
  }

  // Poll focus only while a dismissible banner is pending; stops when the last
  // one resolves (clicked, timed out or dismissed).
  let focusTimer: ReturnType<typeof setInterval> | undefined
  function syncFocusTimer() {
    const hasBanners = [...active.values()].some((entry) => entry.kind === "banner")
    if (hasBanners && focusTimer === undefined) {
      focusTimer = setInterval(dismissIfFocused, 1000)
    } else if (!hasBanners && focusTimer !== undefined) {
      clearInterval(focusTimer)
      focusTimer = undefined
    }
  }

  const watchBanner = (key: string, root: string) => (proc: ChildProcess) => {
    active.set(key, { proc, kind: "banner", root })
    syncFocusTimer()
  }
  const watchId = (key: string) => (id: number) => {
    const entry = active.get(key)
    if (entry) entry.id = id
  }
  const release = (key: string) => {
    active.delete(key)
    syncFocusTimer()
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
    const root = rootOf(p.sessionID)
    const { title, text } = permissionSummary(p)
    try {
      const res = await runBanner(title, text, bannerActions(config, "permission"), {
        timeoutMs: timeout,
        onSpawn: watchBanner(p.id, root),
        onId: watchId(p.id),
      })
      const action = parseBannerOut(res.out).action
      if (res.code === 0 && action && ["once", "always", "reject"].includes(action)) {
        await ctx.client.permission.reply({
          sessionID: p.sessionID,
          requestID: p.id,
          decision: action as "once" | "always" | "reject",
        })
      }
    } catch {}
    release(p.id)
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
    const watch = (proc: ChildProcess) => active.set(formID, { proc, kind: "dialog" })
    const res = await runKdialog(formPromptToKdialogArgs(prompt), { timeoutMs: timeout, onSpawn: watch })
    active.delete(formID)
    if (res.code !== 0) return { ok: false }
    if (prompt.kind === "menu" && res.out === CUSTOM_ANSWER_LABEL) {
      const input = await runKdialog(["--title", "Question", "--inputbox", prompt.question, ""], { timeoutMs: timeout, onSpawn: watch })
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
    const root = rootOf(form.sessionID)
    try {
      const res = await runBanner("Question", questionBody(form), bannerActions(config, "answer"), {
        timeoutMs: timeout,
        onSpawn: watchBanner(form.id, root),
        onId: watchId(form.id),
      })
      const action = parseBannerOut(res.out).action
      const answerAction = config.notificationInteraction === "buttons" ? "answer" : "default"
      if (res.code !== 0 || action !== answerAction) {
        release(form.id)
        return
      }
      release(form.id)

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
    release(form.id)
  }

  // -- session events -------------------------------------------------------

  const handleCreated = async (sessionID: string, parentID: string | undefined) => {
    if (parentID) return
    // Startup notifications never fire while focused, not even from another tab.
    if (isSuppressed(sessionID, false)) return
    const key = `started-${sessionID}`
    try {
      await runBanner("Started", withProject(""), [], { timeoutMs: timeout, onSpawn: watchBanner(key, sessionID), onId: watchId(key) })
    } catch {}
    release(key)
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
    const key = `completed-${root}`
    try {
      const res = await runBanner("Completed", withProject(""), bannerActions(config, "jump"), {
        timeoutMs: timeout,
        onSpawn: watchBanner(key, root),
        onId: watchId(key),
      })
      const action = parseBannerOut(res.out).action
      const jumpAction = config.notificationInteraction === "buttons" ? "jump" : "default"
      if (res.code === 0 && action === jumpAction) jumpTo(root)
    } catch {}
    release(key)
  }

  const handleError = async (sessionID: string, error: { type?: string; message?: string } | undefined) => {
    const root = rootOf(sessionID)
    if (root !== sessionID) return
    if (isSuppressed(root)) return
    const key = `error-${root}`
    const lines: string[] = []
    if (error?.type) lines.push(`Error: ${error.type}`)
    if (error?.message) lines.push(error.message)
    try {
      await runBanner("Error", withProject(lines.length ? lines.join("\n") : "Error"), [], {
        timeoutMs: timeout,
        onSpawn: watchBanner(key, root),
        onId: watchId(key),
      })
    } catch {}
    release(key)
  }

  // -- event subscription ---------------------------------------------------

  const off = ctx.data.listen(({ details }) => {
    const data = details?.data ?? {}
    // Ignore events from other workspaces/projects on a shared server so
    // notifications and jumps stay scoped to the location this TUI runs in.
    const eventLocation = details?.location?.directory
    if (details?.type && ctx.location?.directory && eventLocation && eventLocation !== ctx.location.directory) return
    // Leaving the TUI for a moment and coming back while a banner is pending
    // should clear it right away ("start a new task" fires events fast).
    dismissIfFocused()
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

  return () => {
    if (focusTimer !== undefined) {
      clearInterval(focusTimer)
      focusTimer = undefined
    }
    off()
  }
}

export default {
  id: "opencode-interactive-notifier",
  setup(ctx: TuiContext) {
    return createNotifier(ctx)
  },
}