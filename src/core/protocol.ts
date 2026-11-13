// Wire protocol shared by the bridge (Node), the plugin UI (iframe) and the
// plugin main thread. The UI is the hub: it holds the WebSocket to the bridge
// and relays Figma operations to the main thread via postMessage.

export const BRIDGE_PORT = 3055;

/** Operations the main thread can perform on the document. */
export type FigmaOp =
  | { op: "get_selection"; args: { depth?: number } }
  | { op: "get_page"; args: { depth?: number } }
  | { op: "get_node"; args: { id: string; depth?: number } }
  | { op: "execute"; args: { code: string } }
  | { op: "screenshot"; args: { id?: string; scale?: number } };

export type FigmaOpName = FigmaOp["op"];

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Permission modes the panel offers. "acceptEdits" also auto-approves Figma
 * edits here, not just file edits. "bypassPermissions" is only offered when the
 * bridge runs with FIGMA_CLAUDE_ALLOW_BYPASS=1.
 */
export type PermissionModeOption = "default" | "acceptEdits" | "plan" | "auto" | "bypassPermissions";

export interface ModelOption {
  /** Value to pass to setModel; "default" means the Claude Code default. */
  value: string;
  displayName: string;
  description: string;
  efforts?: EffortLevel[];
}

export interface CommandOption {
  name: string;
  description: string;
  argumentHint: string;
}

export interface SelectedNode {
  id: string;
  name: string;
  type: string;
  width?: number;
  height?: number;
  /** Link to the node; only when the file key is available (dev or private plugins). */
  url?: string;
}

/** What the user has selected, pushed by the main thread whenever it changes. */
export interface SelectionSummary {
  fileName: string;
  pageId: string;
  pageName: string;
  /** Up to MAX_SELECTION_NODES nodes; `total` is the real count. */
  nodes: SelectedNode[];
  total: number;
}

export const MAX_SELECTION_NODES = 20;

/** Preferences the main thread keeps in figma.clientStorage. */
export interface StoredSettings {
  token?: string;
  model?: string;
  effort?: EffortLevel;
  mode?: PermissionModeOption;
}

// ---- UI -> bridge -------------------------------------------------------

export type ClientMessage =
  /** selection is omitted when the user detached it from this message. */
  | { type: "chat"; text: string; selection?: SelectionSummary }
  | { type: "interrupt" }
  | { type: "reset" }
  /** mode: switch to this permission mode as part of allowing (used to leave plan mode). */
  | { type: "approval"; id: string; allow: boolean; mode?: PermissionModeOption; message?: string }
  | { type: "set-mode"; mode: PermissionModeOption }
  /** null returns to the Claude Code default. */
  | { type: "set-model"; model: string | null }
  | { type: "set-effort"; effort: EffortLevel | null }
  | { type: "figma-result"; id: string; ok: true; result: unknown }
  | { type: "figma-result"; id: string; ok: false; error: string };

// ---- bridge -> UI -------------------------------------------------------

export type ServerMessage =
  | { type: "ready"; cwd: string; model?: string }
  /** Models and skills this session can use; sent once the CLI has started. */
  | { type: "session-info"; models: ModelOption[]; commands: CommandOption[]; modes: PermissionModeOption[] }
  /** The session's permission mode, whenever it changes (including when Claude leaves plan mode). */
  | { type: "mode"; mode: PermissionModeOption }
  | { type: "text-delta"; text: string }
  | { type: "tool-start"; id: string; name: string; input: unknown }
  | { type: "tool-end"; id: string; isError: boolean; summary: string }
  /** plan: the plan text, for ExitPlanMode requests. */
  | { type: "approval-request"; id: string; name: string; input: unknown; reason?: string; plan?: string }
  | { type: "approval-cancelled"; id: string }
  /** costUsd is the running total for the session, not this turn. */
  | { type: "turn-end"; isError: boolean; costUsd?: number; error?: string; stopped?: boolean }
  | { type: "figma-op"; id: string; op: FigmaOpName; args: unknown }
  | { type: "error"; message: string };

// ---- UI <-> main thread -------------------------------------------------

export type ToMainMessage =
  | ({ type: "figma-op"; id: string } & FigmaOp)
  | { type: "get-settings" }
  | { type: "save-settings"; settings: StoredSettings };

export type FromMainMessage =
  | { type: "figma-result"; id: string; ok: true; result: unknown }
  | { type: "figma-result"; id: string; ok: false; error: string }
  | { type: "settings"; settings: StoredSettings }
  | { type: "selection"; selection: SelectionSummary };

/** WebSocket close code the bridge uses for a missing or wrong pairing token. */
export const CLOSE_BAD_TOKEN = 4001;
