import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import {
  loadConfig,
  permissionSummary,
  shouldSuppressEvent,
  isQuestionForm,
  questionFormToPrompts,
  formPromptToKdialogArgs,
  answersToFormReply,
  parseKdialogChecklist,
  classifyEvent,
  bannerActions,
  buildBannerArgs,
  projectName,
  parseBannerOut,
  BANNER_ACTIONS,
} from "../src/core.ts"

// ---------------------------------------------------------------- loadConfig

test("loadConfig returns defaults when file is missing", () => {
  const config = loadConfig(join(mkdtempSync("oc-notifier-"), "nope.json"))
  assert.deepEqual(config, {})
})

test("loadConfig merges partial file over defaults", () => {
  const dir = mkdtempSync("oc-notifier-")
  const path = join(dir, "config.json")
  writeFileSync(path, JSON.stringify({ timeout: 12, suppressWhenFocused: false }))
  const config = loadConfig(path)
  assert.equal(config.timeout, 12)
  assert.equal(config.suppressWhenFocused, false)
  assert.equal(config.enabled, undefined)
  rmSync(dir, { recursive: true, force: true })
})

test("loadConfig ignores invalid JSON", () => {
  const dir = mkdtempSync("oc-notifier-")
  const path = join(dir, "config.json")
  writeFileSync(path, "not json")
  assert.deepEqual(loadConfig(path), {})
  rmSync(dir, { recursive: true, force: true })
})

test("loadConfig default interaction mode is body and is overridable", () => {
  const dir = mkdtempSync("oc-notifier-")
  const path = join(dir, "config.json")
  writeFileSync(path, JSON.stringify({ notificationInteraction: "buttons" }))
  assert.equal(loadConfig(path).notificationInteraction, "buttons")
  assert.equal(loadConfig(join(dir, "missing.json")).notificationInteraction, undefined)
  rmSync(dir, { recursive: true, force: true })
})

// ------------------------------------------------------- permissionSummary

test("permissionSummary renders V2 action/resources/message", () => {
  const { title, text } = permissionSummary({
    id: "per_1",
    sessionID: "ses_1",
    action: "edit",
    resources: ["/home/user/file.txt"],
    message: "Edit this file?",
  })
  assert.equal(title, "Permission requested")
  assert.match(text, /^Action: edit/)
  assert.match(text, /Resource: \/home\/user\/file\.txt/)
  assert.match(text, /Edit this file\?/)
})

test("permissionSummary falls back when action is empty", () => {
  const { text } = permissionSummary({ id: "per_1", sessionID: "ses_1", action: "", resources: [] })
  assert.ok(text.length > 0)
})

// ---------------------------------------------------------- shouldSuppress

test("suppress when window focused and event tab is the active tab", () => {
  assert.equal(
    shouldSuppressEvent({ focused: true, activeTab: "ses_a", root: "ses_a", suppressWhenFocused: true }),
    true,
  )
})

test("notify when window focused but event tab differs from active tab", () => {
  assert.equal(
    shouldSuppressEvent({ focused: true, activeTab: "ses_a", root: "ses_b", suppressWhenFocused: true }),
    false,
  )
})

test("notify when window is not focused", () => {
  assert.equal(shouldSuppressEvent({ focused: false, activeTab: "ses_a", root: "ses_a", suppressWhenFocused: true }), false)
})

test("never suppress when suppressWhenFocused is disabled", () => {
  assert.equal(shouldSuppressEvent({ focused: true, activeTab: "ses_a", root: "ses_a", suppressWhenFocused: false }), false)
})

test("suppress when focused and active tab is unknown", () => {
  assert.equal(shouldSuppressEvent({ focused: true, activeTab: undefined, root: "ses_a", suppressWhenFocused: true }), true)
})

test("applyTabException false suppresses focused other-tab events (startup rule)", () => {
  assert.equal(
    shouldSuppressEvent({ focused: true, activeTab: "ses_a", root: "ses_b", suppressWhenFocused: true, applyTabException: false }),
    true,
  )
})

// ---------------------------------------------------------------- question

test("isQuestionForm detects question forms", () => {
  assert.equal(isQuestionForm({ id: "frm_1", sessionID: "ses_1", title: "Questions", fields: [] }), false)
  assert.equal(
    isQuestionForm({ id: "frm_1", sessionID: "ses_1", title: "Questions", metadata: { kind: "question" }, fields: [] }),
    true,
  )
})

test("questionFormToPrompts maps fields to kdialog prompt kinds", () => {
  const form = {
    id: "frm_1",
    sessionID: "ses_1",
    title: "Questions",
    metadata: { kind: "question" },
    fields: [
      { key: "q0", type: "string", title: "A or B", description: "Pick one", options: [{ value: "A", label: "A" }, { value: "B", label: "B" }], custom: true },
      { key: "q1", type: "multiselect", title: "Pick many", description: "Select all", options: [{ value: "X", label: "X" }, { value: "Y", label: "Y" }] },
      { key: "q2", type: "string", title: "Your name", description: "Type it" },
    ],
  }
  const prompts = questionFormToPrompts(form)
  assert.equal(prompts.length, 3)
  assert.equal(prompts[0].key, "q0")
  assert.equal(prompts[0].kind, "menu")
  assert.deepEqual(prompts[0].options, ["A", "B"])
  assert.equal(prompts[1].kind, "checklist")
  assert.deepEqual(prompts[1].options, ["X", "Y"])
  assert.equal(prompts[2].kind, "inputbox")
})

test("formPromptToKdialogArgs builds kdialog argv for a menu with custom answer", () => {
  const args = formPromptToKdialogArgs({
    key: "q0",
    kind: "menu",
    title: "A or B",
    question: "Pick one",
    options: ["A", "B"],
    custom: true,
  })
  assert.deepEqual(args, [
    "--title", "Question",
    "--menu", "Pick one",
    "A", "A",
    "B", "B",
    "Type your own answer…", "Type your own answer…",
  ])
})

test("formPromptToKdialogArgs uses --separate-output for checklists", () => {
  const args = formPromptToKdialogArgs({
    key: "q1",
    kind: "checklist",
    title: "Pick many",
    question: "Select all",
    options: ["X", "Y Z"],
    custom: false,
  })
  assert.deepEqual(args, [
    "--title", "Question",
    "--separate-output",
    "--checklist", "Select all",
    "X", "off",
    "Y Z", "off",
  ])
})

test("answersToFormReply maps picked answers to form reply keys", () => {
  const fields = [
    { key: "q0", type: "string" },
    { key: "q1", type: "multiselect" },
  ]
  const reply = answersToFormReply(fields, ["A", ["X", "Y"]])
  assert.deepEqual(reply, { q0: "A", q1: ["X", "Y"] })
})

test("parseKdialogChecklist splits newline output keeping multi-word labels", () => {
  assert.deepEqual(parseKdialogChecklist("American English\n\"Oz\" English\nPlain"), [
    "American English",
    '"Oz" English',
    "Plain",
  ])
})

// --------------------------------------------------------- event classifying

test("classifyEvent maps the v2.0.16 lifecycle events", () => {
  assert.equal(classifyEvent("session.execution.succeeded"), "completed")
  assert.equal(classifyEvent("session.execution.failed"), "error")
  assert.equal(classifyEvent("session.execution.interrupted"), "none")
  assert.equal(classifyEvent("session.execution.started"), "none")
  // legacy/belt-and-braces types still recognized
  assert.equal(classifyEvent("session.idle"), "completed")
  assert.equal(classifyEvent("session.status"), "completed")
  assert.equal(classifyEvent("session.error"), "error")
  assert.equal(classifyEvent("session.created"), "started")
  assert.equal(classifyEvent("permission.asked"), "permission")
  assert.equal(classifyEvent("permission.replied"), "permission.kill")
  assert.equal(classifyEvent("form.created"), "question")
  assert.equal(classifyEvent("form.replied"), "form.settled")
  assert.equal(classifyEvent("form.cancelled"), "form.settled")
  assert.equal(classifyEvent("message.updated"), "none")
})

// ----------------------------------------------------------- banner actions

test("bannerActions renders body-click default action for jump in body mode", () => {
  assert.deepEqual(bannerActions({ notificationInteraction: "body" }, "jump"), ["default=Jump to terminal"])
})

test("bannerActions renders a labeled button in buttons mode", () => {
  assert.deepEqual(bannerActions({ notificationInteraction: "buttons" }, "jump"), ["jump=Jump to terminal"])
  assert.deepEqual(bannerActions({ notificationInteraction: "buttons" }, "answer"), ["answer=Answer"])
})

test("bannerActions keeps permission choices as buttons in both modes", () => {
  const expected = ["once=Allow once", "always=Always allow", "reject=Reject"]
  assert.deepEqual(bannerActions({ notificationInteraction: "body" }, "permission"), expected)
  assert.deepEqual(bannerActions({ notificationInteraction: "buttons" }, "permission"), expected)
})

test("bannerActions returns no actions for unknown kind", () => {
  assert.deepEqual(bannerActions({ notificationInteraction: "body" }, "passive"), [])
})

test("buildBannerArgs assembles notify-send argv with actions, id print and icon", () => {
  const args = buildBannerArgs({
    title: "Completed",
    text: "project",
    actions: ["default=Jump to terminal"],
    timeoutMs: 30000,
    icon: "/tmp/icon.png",
  })
  assert.deepEqual(args, [
    "--app-name", "OpenCode",
    "-t", "30000",
    "--hint", "int:transient:1",
    "-p",
    "--icon", "/tmp/icon.png",
    "-A", "default=Jump to terminal",
    "Completed", "project",
  ])
})

test("buildBannerArgs omits icon when absent and avoids -A for passive banners", () => {
  const args = buildBannerArgs({ title: "Started", text: "project", actions: [], timeoutMs: 0, icon: undefined })
  assert.deepEqual(args, [
    "--app-name", "OpenCode",
    "-t", "0",
    "--hint", "int:transient:1",
    "-p",
    "Started", "project",
  ])
})

// ----------------------------------------------------------- banner output

test("parseBannerOut extracts numeric id and a known action line", () => {
  assert.deepEqual(parseBannerOut("49\ndefault"), { id: 49, action: "default" })
  assert.deepEqual(parseBannerOut("49\njump"), { id: 49, action: "jump" })
  assert.deepEqual(parseBannerOut("22\nonce"), { id: 22, action: "once" })
})

test("parseBannerOut returns only the id when closed without an action", () => {
  assert.deepEqual(parseBannerOut("49"), { id: 49, action: undefined })
})

test("parseBannerOut handles action-only output when -p is unsupported", () => {
  assert.deepEqual(parseBannerOut("default"), { id: undefined, action: "default" })
})

test("parseBannerOut ignores non-action trailing text (e.g. timeout notice)", () => {
  assert.deepEqual(parseBannerOut("49\nWait timeout expired"), { id: 49, action: undefined })
  assert.deepEqual(parseBannerOut("Wait timeout expired"), { id: undefined, action: undefined })
})

test("parseBannerOut returns empty for blank output", () => {
  assert.deepEqual(parseBannerOut(""), {})
  assert.deepEqual(parseBannerOut("   \n "), {})
  assert.deepEqual(parseBannerOut(undefined as unknown as string), {})
})

test("BANNER_ACTIONS covers every banner key the plugin reacts to", () => {
  for (const key of ["default", "jump", "answer", "once", "always", "reject"]) {
    assert.ok(BANNER_ACTIONS.has(key), `missing ${key}`)
  }
})

// ------------------------------------------------------------------ misc

test("projectName derives a basename from a directory", () => {
  assert.equal(projectName("/home/user/my-project"), "my-project")
})