import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import {
  query,
  type CanUseTool,
  type HookCallbackMatcher,
  type Options,
  type Query,
  type SettingSource,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  EffortLevel,
  FigmaOpName,
  PermissionModeOption,
  SelectionSummary,
  ServerMessage,
} from "../src/core/protocol";
import { createFigmaServer, FIGMA_SERVER_NAME, READ_ONLY_FIGMA_TOOLS } from "./figma-tools";

const FIGMA_OP_TIMEOUT_MS = 30_000;

const SYSTEM_PROMPT_APPEND = `
You are running inside a Figma plugin. The user is looking at a Figma file and chatting with you from a panel beside the canvas.
Use the mcp__${FIGMA_SERVER_NAME}__* tools to inspect and edit the document: they act on the file open in this plugin, live.
Prefer them over any other Figma MCP tools you may have, which can target other files or need a file key.
Start by looking at the selection or the current page before changing anything, and take a screenshot after visual changes
to check the result. Skills written for other Figma tools (such as use_figma) still apply: run their plugin-API code with
mcp__${FIGMA_SERVER_NAME}__execute. Keep replies short: the panel is narrow.`;

const ALL_TOOLS = process.env.FIGMA_CLAUDE_TOOLS === "all";

/**
 * Built-in Claude Code tools available to the agent, on top of the Figma tools.
 * Write and Edit are included because plan mode writes its plan to a file, but
 * the hook below keeps them to plan files unless FIGMA_CLAUDE_TOOLS=all.
 */
function builtInTools(): Options["tools"] {
  if (ALL_TOOLS) return { type: "preset", preset: "claude_code" };
  return ["Read", "Glob", "Grep", "WebFetch", "WebSearch", "Skill", "ExitPlanMode", "Write", "Edit"];
}

/** Plan files live in ~/.claude/plans, or a project's .claude/plans with plansDirectory. */
function isPlanFile(path: string): boolean {
  const dir = dirname(resolve(path));
  return (
    dir === resolve(homedir(), ".claude", "plans") ||
    (basename(dir) === "plans" && basename(dirname(dir)) === ".claude")
  );
}

/**
 * A hook rather than canUseTool, because "accept edits" approves file edits in
 * the CLI before canUseTool is ever asked.
 */
function fileEditGuard(): Options["hooks"] {
  if (ALL_TOOLS) return undefined;
  const guard: HookCallbackMatcher = {
    matcher: "Write|Edit",
    onFailure: "block",
    hooks: [
      async (input) => {
        if (input.hook_event_name !== "PreToolUse") return {};
        const path = (input.tool_input as { file_path?: unknown })?.file_path;
        if (typeof path === "string" && isPlanFile(path)) return {};
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason:
              "File edits are turned off in the Figma panel (only plan files can be written). " +
              "Make changes in Figma with the canvas tools instead.",
          },
        };
      },
    ],
  };
  return { PreToolUse: [guard] };
}

/** Skipping every check is opt-in: the session can reach local files and the web. */
const BYPASS_ALLOWED = process.env.FIGMA_CLAUDE_ALLOW_BYPASS === "1";
const AVAILABLE_MODES: PermissionModeOption[] = [
  "default",
  "acceptEdits",
  "plan",
  "auto",
  ...(BYPASS_ALLOWED ? (["bypassPermissions"] as const) : []),
];

const EXECUTE_TOOL = `mcp__${FIGMA_SERVER_NAME}__execute`;

interface Decision {
  allow: boolean;
  /** Permission mode to switch to as part of allowing, e.g. when approving a plan. */
  mode?: PermissionModeOption;
  /** Feedback for Claude when denying. */
  message?: string;
}

/**
 * Which Claude Code settings files to load. User and project settings bring in
 * skills, plugins, MCP servers, CLAUDE.md, permission rules and hooks, the same
 * as running `claude` in the project. FIGMA_CLAUDE_SETTINGS=none isolates it.
 */
function settingSources(): SettingSource[] {
  const raw = process.env.FIGMA_CLAUDE_SETTINGS ?? "user,project";
  if (raw === "none") return [];
  return raw.split(",").map((s) => s.trim()) as SettingSource[];
}

/** "default" (or nothing) means: let Claude Code pick, from settings or its own default. */
const modelOrDefault = (model: string | null | undefined) =>
  model && model !== "default" ? model : undefined;

/** A pushable async iterable, used as the streaming prompt for query(). */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiting?: (r: IteratorResult<SDKUserMessage>) => void;
  private done = false;

  push(item: SDKUserMessage) {
    if (this.waiting) {
      this.waiting({ value: item, done: false });
      this.waiting = undefined;
    } else {
      this.items.push(item);
    }
  }

  end() {
    this.done = true;
    this.waiting?.({ value: undefined, done: true });
    this.waiting = undefined;
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.done) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => (this.waiting = resolve));
      },
    };
  }
}

type Pending<T> = { resolve: (v: T) => void; reject: (e: Error) => void; timer?: ReturnType<typeof setTimeout> };

/**
 * One Claude conversation, bound to one plugin connection.
 *
 * Runs a single long-lived query() in streaming-input mode: each chat message
 * is pushed onto the input queue, and the SDK keeps the `claude` subprocess
 * alive between turns. Streaming input is required for canUseTool and for the
 * in-process Figma MCP server.
 */
export class ClaudeSession {
  private input?: InputQueue;
  private q?: Query;
  private abort?: AbortController;
  private figmaCalls = new Map<string, Pending<unknown>>();
  private approvals = new Map<string, Pending<Decision>>();
  /** Set by interrupt() so the aborted turn ends quietly instead of as an error. */
  private interrupted = false;
  private model: string | undefined = modelOrDefault(process.env.FIGMA_CLAUDE_MODEL);
  private effort: EffortLevel | undefined;
  /**
   * Always passed explicitly: left unset, the CLI would take permissions.defaultMode
   * from the user's settings, or "auto", and approvals might never reach the panel.
   */
  private mode: PermissionModeOption = "default";
  /** In plan mode Claude writes its plan to a file; this is the latest one. */
  private planFile?: string;
  /** Selection last described to Claude in this conversation, to avoid repeating it. */
  private lastSelectionKey = "";

  constructor(
    private send: (msg: ServerMessage) => void,
    private cwd: string,
  ) {
    // Start the CLI straight away so the panel can list models and skills
    // before the first message. Nothing is sent to the API until then.
    this.start();
  }

  async setModel(model: string | null) {
    this.model = modelOrDefault(model);
    await this.q?.setModel(this.model).catch((err) => this.reportError("Couldn't switch model", err));
  }

  async setMode(mode: PermissionModeOption) {
    if (!AVAILABLE_MODES.includes(mode)) {
      this.reportError("Couldn't change mode", new Error(`${mode} is not enabled on this bridge`));
      return;
    }
    this.mode = mode;
    try {
      await this.q?.setPermissionMode(mode);
      this.send({ type: "mode", mode });
    } catch (err) {
      this.reportError("Couldn't change mode", err);
    }
  }

  async setEffort(effort: EffortLevel | null) {
    this.effort = effort ?? undefined;
    await this.q
      ?.applyFlagSettings({ effortLevel: effort })
      .catch((err) => this.reportError("Couldn't change effort", err));
  }

  chat(text: string, selection?: SelectionSummary) {
    this.interrupted = false;
    if (!this.q) this.start();
    const context = selection ? this.selectionContext(selection) : "";
    this.input!.push({
      type: "user",
      message: { role: "user", content: context ? `${context}\n\n${text}` : text },
      parent_tool_use_id: null,
      session_id: "",
    });
  }

  async interrupt() {
    if (!this.q) return;
    this.interrupted = true;
    for (const [id, pending] of this.approvals) {
      pending.resolve({ allow: false });
      this.send({ type: "approval-cancelled", id });
    }
    this.approvals.clear();
    await this.q?.interrupt().catch(() => {});
  }

  /** Drop the conversation and start a fresh one with the same model and effort. */
  reset() {
    this.stop();
    this.start();
  }

  /**
   * Describe the selection, but only when it differs from what Claude was last
   * told, so an unchanged selection costs nothing on follow-up messages.
   */
  private selectionContext(selection: SelectionSummary): string {
    const key = `${selection.pageId}|${selection.nodes.map((n) => n.id).join(",")}|${selection.total}`;
    if (key === this.lastSelectionKey) return "";
    const hadSelection = this.lastSelectionKey !== "" && !this.lastSelectionKey.endsWith("||0");
    this.lastSelectionKey = key;

    if (selection.total === 0) {
      return hadSelection ? "<figma_selection>The user now has nothing selected.</figma_selection>" : "";
    }

    const lines = selection.nodes.map((n) => {
      const size = n.width !== undefined ? `, ${n.width}×${n.height}` : "";
      return `- ${n.type} "${n.name}" (id ${n.id}${size})${n.url ? ` ${n.url}` : ""}`;
    });
    if (selection.total > selection.nodes.length) {
      lines.push(`- …and ${selection.total - selection.nodes.length} more`);
    }
    const count = selection.total === 1 ? "1 layer" : `${selection.total} layers`;
    return [
      "<figma_selection>",
      `The user has ${count} selected on page "${selection.pageName}" of "${selection.fileName}".`,
      `"this" or "these" in their message most likely means this selection. Use the ids with mcp__${FIGMA_SERVER_NAME}__get_node for details.`,
      ...lines,
      "</figma_selection>",
    ].join("\n");
  }

  dispose() {
    this.stop();
  }

  resolveFigmaCall(id: string, result: { ok: true; result: unknown } | { ok: false; error: string }) {
    const pending = this.figmaCalls.get(id);
    if (!pending) return;
    this.figmaCalls.delete(id);
    clearTimeout(pending.timer);
    if (result.ok) pending.resolve(result.result);
    else pending.reject(new Error(result.error));
  }

  resolveApproval(id: string, decision: Decision) {
    this.approvals.get(id)?.resolve(decision);
    this.approvals.delete(id);
  }

  private start() {
    this.input = new InputQueue();
    this.abort = new AbortController();
    this.q = query({
      prompt: this.input,
      options: {
        cwd: this.cwd,
        model: this.model,
        effort: this.effort,
        permissionMode: this.mode,
        allowDangerouslySkipPermissions: BYPASS_ALLOWED,
        settingSources: settingSources(),
        skills: "all",
        abortController: this.abort,
        includePartialMessages: true,
        systemPrompt: { type: "preset", preset: "claude_code", append: SYSTEM_PROMPT_APPEND },
        tools: builtInTools(),
        mcpServers: { [FIGMA_SERVER_NAME]: createFigmaServer(this.callFigma) },
        allowedTools: [...READ_ONLY_FIGMA_TOOLS, "Read", "Glob", "Grep", "Skill"],
        canUseTool: this.canUseTool,
        hooks: fileEditGuard(),
        stderr: (data) => process.stderr.write(`[claude] ${data}`),
      },
    });
    this.pump(this.q);
    void this.sendSessionInfo(this.q);
  }

  private async sendSessionInfo(q: Query) {
    try {
      const init = await q.initializationResult();
      if (this.q !== q) return;
      this.send({
        type: "session-info",
        models: init.models.map((m) => ({
          value: m.value,
          displayName: m.displayName,
          description: m.description,
          efforts: m.supportsEffort === false ? undefined : m.supportedEffortLevels,
        })),
        // Built-in commands like /config or /model are for the terminal UI; skills are what's useful here.
        commands: init.commands
          .filter((c) => !c.builtin)
          .map((c) => ({ name: c.name, description: c.description, argumentHint: c.argumentHint })),
        modes: AVAILABLE_MODES,
      });
    } catch (err) {
      if (this.q === q) this.reportError("Couldn't load models and skills", err);
    }
  }

  private reportError(context: string, err: unknown) {
    this.send({ type: "error", message: `${context}: ${(err as Error).message ?? err}` });
  }

  private stop() {
    // A new session hasn't seen any selection yet.
    this.lastSelectionKey = "";
    this.abort?.abort();
    this.input?.end();
    this.q = undefined;
    this.input = undefined;
    for (const p of this.figmaCalls.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("Session ended"));
    }
    this.figmaCalls.clear();
    for (const p of this.approvals.values()) p.resolve({ allow: false });
    this.approvals.clear();
  }

  private async pump(q: Query) {
    try {
      for await (const msg of q) this.forward(msg);
    } catch (err) {
      if (this.q === q && !this.abort?.signal.aborted) {
        this.send({ type: "error", message: (err as Error).message });
        this.send({ type: "turn-end", isError: true, error: (err as Error).message });
      }
    } finally {
      // The subprocess exited (crash, auth failure, or stop()); start fresh next time.
      if (this.q === q) this.stop();
    }
  }

  /** Translate SDK messages into the small set of events the UI renders. */
  private forward(msg: SDKMessage) {
    switch (msg.type) {
      case "system":
        if (msg.subtype === "init") {
          this.send({ type: "ready", cwd: msg.cwd, model: msg.model });
          this.noteMode(msg.permissionMode);
        } else if (msg.subtype === "status" && msg.permissionMode) {
          // The CLI changed mode itself, e.g. after a plan was approved.
          this.noteMode(msg.permissionMode);
        }
        return;

      case "stream_event": {
        const ev = msg.event;
        if (msg.parent_tool_use_id === null && ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
          this.send({ type: "text-delta", text: ev.delta.text });
        }
        return;
      }

      case "assistant":
        if (msg.parent_tool_use_id !== null) return;
        for (const block of msg.message.content) {
          if (block.type === "tool_use") {
            this.notePlanFile(block.name, block.input);
            this.send({ type: "tool-start", id: block.id, name: block.name, input: block.input });
          }
        }
        if (msg.error) this.send({ type: "error", message: `Claude returned an error: ${msg.error}` });
        return;

      case "user": {
        if (msg.parent_tool_use_id !== null) return;
        const content = msg.message.content;
        if (typeof content === "string") return;
        for (const block of content) {
          if (block.type === "tool_result") {
            this.send({
              type: "tool-end",
              id: block.tool_use_id,
              isError: block.is_error === true,
              summary: summariseToolResult(block.content),
            });
          }
        }
        return;
      }

      case "result":
        if (this.interrupted) {
          this.interrupted = false;
          this.send({ type: "turn-end", isError: false, costUsd: msg.total_cost_usd, stopped: true });
          return;
        }
        this.send({
          type: "turn-end",
          isError: msg.is_error,
          costUsd: msg.total_cost_usd,
          error: msg.subtype === "success" ? undefined : msg.errors.join("\n") || msg.subtype,
        });
        return;
    }
  }

  private callFigma = (op: FigmaOpName, args: unknown): Promise<unknown> => {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.figmaCalls.delete(id);
        reject(new Error(`Figma did not answer '${op}' within ${FIGMA_OP_TIMEOUT_MS / 1000}s. Is the plugin still open?`));
      }, FIGMA_OP_TIMEOUT_MS);
      this.figmaCalls.set(id, { resolve, reject, timer });
      this.send({ type: "figma-op", id, op, args });
    });
  };

  private notePlanFile(tool: string, input: unknown) {
    if (this.mode !== "plan" || (tool !== "Write" && tool !== "Edit")) return;
    const path = (input as { file_path?: unknown })?.file_path;
    if (typeof path === "string") this.planFile = path;
  }

  /** ExitPlanMode carries no plan text in recent CLIs; read the file Claude wrote instead. */
  private planText(input: Record<string, unknown>): string | undefined {
    if (typeof input.plan === "string") return input.plan;
    if (!this.planFile) return undefined;
    try {
      return readFileSync(this.planFile, "utf8");
    } catch {
      return undefined;
    }
  }

  private noteMode(mode: string) {
    if (!(AVAILABLE_MODES as string[]).includes(mode) && mode !== "bypassPermissions") return;
    this.mode = mode as PermissionModeOption;
    this.send({ type: "mode", mode: this.mode });
  }

  private canUseTool: CanUseTool = async (name, input, { signal, decisionReason }) => {
    // Plan files are Claude's scratchpad in plan mode; never worth a prompt.
    if ((name === "Write" || name === "Edit") && typeof input.file_path === "string" && isPlanFile(input.file_path)) {
      return { behavior: "allow", updatedInput: input };
    }
    // "Accept edits" covers file edits in the CLI; in this panel it covers Figma edits too.
    if (this.mode === "acceptEdits" && name === EXECUTE_TOOL) {
      return { behavior: "allow", updatedInput: input };
    }

    const id = randomUUID();
    const decision = await new Promise<Decision>((resolve, reject) => {
      this.approvals.set(id, { resolve, reject });
      const plan = name === "ExitPlanMode" ? this.planText(input) : undefined;
      this.send({ type: "approval-request", id, name, input, reason: decisionReason, plan });
      signal.addEventListener("abort", () => {
        if (this.approvals.delete(id)) {
          this.send({ type: "approval-cancelled", id });
          resolve({ allow: false });
        }
      });
    });

    if (!decision.allow) {
      return { behavior: "deny", message: decision.message || "The user declined this action." };
    }
    if (decision.mode && AVAILABLE_MODES.includes(decision.mode)) {
      // Switch mode as part of the approval, so it lands before the next tool call.
      this.mode = decision.mode;
      return {
        behavior: "allow",
        updatedInput: input,
        updatedPermissions: [{ type: "setMode", mode: decision.mode, destination: "session" }],
      };
    }
    return { behavior: "allow", updatedInput: input };
  };
}

function summariseToolResult(content: unknown): string {
  if (typeof content === "string") return truncate(content);
  if (!Array.isArray(content)) return "";
  return truncate(
    content
      .map((part: { type: string; text?: string }) => (part.type === "text" ? part.text : `[${part.type}]`))
      .join(" "),
  );
}

function truncate(text: string, max = 280) {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}
