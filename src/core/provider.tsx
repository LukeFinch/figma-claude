import React, { createContext, useCallback, useContext, useEffect, useReducer, useRef, useState } from "react";
import {
  BRIDGE_PORT,
  CLOSE_BAD_TOKEN,
  type ClientMessage,
  type CommandOption,
  type EffortLevel,
  type FromMainMessage,
  type ModelOption,
  type PermissionModeOption,
  type SelectionSummary,
  type ServerMessage,
  type StoredSettings,
  type ToMainMessage,
} from "./protocol";
import type { ChatItem, ConnectionState } from "./types";

const BRIDGE_URL = `ws://127.0.0.1:${BRIDGE_PORT}`;
const RECONNECT_MS = 3000;

// ---- Chat state ----------------------------------------------------------

interface ChatState {
  items: ChatItem[];
  busy: boolean;
  costUsd: number;
}

type Action =
  | { type: "server"; msg: ServerMessage }
  | { type: "user"; text: string; selectionLabel?: string }
  | { type: "approval-answered"; id: string; allow: boolean }
  | { type: "disconnected" }
  | { type: "clear" };

let nextId = 0;
const uid = () => `item-${++nextId}`;

function reducer(state: ChatState, action: Action): ChatState {
  switch (action.type) {
    case "user":
      return {
        ...state,
        busy: true,
        items: [...state.items, { kind: "user", id: uid(), text: action.text, selectionLabel: action.selectionLabel }],
      };

    case "clear":
      return { items: [], busy: false, costUsd: 0 };

    case "disconnected":
      return {
        ...state,
        busy: false,
        items: state.items.map((item) =>
          item.kind === "approval" && item.status === "pending" ? { ...item, status: "cancelled" } : item,
        ),
      };

    case "approval-answered":
      return {
        ...state,
        items: state.items.map((item) =>
          item.kind === "approval" && item.id === action.id
            ? { ...item, status: action.allow ? "allowed" : "denied" }
            : item,
        ),
      };

    case "server": {
      const msg = action.msg;
      switch (msg.type) {
        case "text-delta": {
          const last = state.items[state.items.length - 1];
          if (last?.kind === "assistant") {
            const items = state.items.slice(0, -1);
            items.push({ ...last, text: last.text + msg.text });
            return { ...state, items };
          }
          return { ...state, items: [...state.items, { kind: "assistant", id: uid(), text: msg.text }] };
        }
        case "tool-start":
          return {
            ...state,
            items: [...state.items, { kind: "tool", id: msg.id, name: msg.name, input: msg.input, status: "running" }],
          };
        case "tool-end":
          return {
            ...state,
            items: state.items.map((item) =>
              item.kind === "tool" && item.id === msg.id
                ? { ...item, status: msg.isError ? "error" : "done", summary: msg.summary }
                : item,
            ),
          };
        case "approval-request":
          return {
            ...state,
            items: [
              ...state.items,
              {
                kind: "approval",
                id: msg.id,
                name: msg.name,
                input: msg.input,
                reason: msg.reason,
                plan: msg.plan,
                status: "pending",
              },
            ],
          };
        case "approval-cancelled":
          return {
            ...state,
            items: state.items.map((item) =>
              item.kind === "approval" && item.id === msg.id && item.status === "pending"
                ? { ...item, status: "cancelled" }
                : item,
            ),
          };
        case "turn-end":
          return {
            ...state,
            busy: false,
            costUsd: msg.costUsd ?? state.costUsd,
            items: msg.stopped
              ? [...state.items, { kind: "note", id: uid(), text: "Stopped" }]
              : msg.error
                ? [...state.items, { kind: "error", id: uid(), text: msg.error }]
                : state.items,
          };
        case "error":
          return { ...state, items: [...state.items, { kind: "error", id: uid(), text: msg.message }] };
        default:
          return state;
      }
    }
  }
}

// ---- Context -------------------------------------------------------------

/** Short label for a selection, e.g. `"Header"` or `"Header" + 2 more`. */
export function selectionLabel(selection: SelectionSummary): string {
  const first = selection.nodes[0];
  if (!first) return "";
  return selection.total > 1 ? `${first.name} + ${selection.total - 1} more` : first.name;
}

export interface ClaudeContextType {
  connection: ConnectionState;
  cwd?: string;
  items: ChatItem[];
  busy: boolean;
  costUsd: number;
  send: (text: string) => void;
  interrupt: () => void;
  newChat: () => void;
  /** mode: switch permission mode as part of allowing; message: feedback when denying. */
  answerApproval: (id: string, allow: boolean, opts?: { mode?: PermissionModeOption; message?: string }) => void;
  pair: (token: string) => void;
  reconnect: () => void;
  /** Models and skills reported by the bridge; empty until the CLI has started. */
  models: ModelOption[];
  commands: CommandOption[];
  /** Selected model value; "default" lets Claude Code decide. */
  model: string;
  /** Model the session is actually running, as reported by the CLI. */
  activeModel?: string;
  effort?: EffortLevel;
  setModel: (value: string) => void;
  setEffort: (effort: EffortLevel | undefined) => void;
  /** The session's permission mode as reported by the bridge, and the modes it offers. */
  mode: PermissionModeOption;
  modes: PermissionModeOption[];
  setMode: (mode: PermissionModeOption) => void;
  /** Current Figma selection, and whether it goes with the next message. */
  selection?: SelectionSummary;
  selectionAttached: boolean;
  setSelectionAttached: (attached: boolean) => void;
}

const ClaudeContext = createContext<ClaudeContextType | undefined>(undefined);

function postToMain(msg: ToMainMessage) {
  parent.postMessage({ pluginMessage: msg }, "*");
}

export const ClaudeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [state, dispatch] = useReducer(reducer, { items: [], busy: false, costUsd: 0 });
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [cwd, setCwd] = useState<string>();
  /** undefined until the main thread has answered. */
  const [settings, setSettings] = useState<StoredSettings>();
  const settingsRef = useRef<StoredSettings>({});
  const [models, setModels] = useState<ModelOption[]>([]);
  const [commands, setCommands] = useState<CommandOption[]>([]);
  const [activeModel, setActiveModel] = useState<string>();
  const [mode, setModeState] = useState<PermissionModeOption>("default");
  const [modes, setModes] = useState<PermissionModeOption[]>([]);
  const [selection, setSelection] = useState<SelectionSummary>();
  const [selectionAttached, setSelectionAttached] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const token = settings === undefined ? undefined : (settings.token ?? null);

  const updateSettings = useCallback((patch: Partial<StoredSettings>) => {
    const next = { ...settingsRef.current, ...patch };
    settingsRef.current = next;
    setSettings(next);
    postToMain({ type: "save-settings", settings: next });
  }, []);

  const sendToBridge = useCallback((msg: ClientMessage) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  // Messages from the main thread: stored settings and Figma op results.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const msg = event.data?.pluginMessage as FromMainMessage | undefined;
      if (!msg) return;
      if (msg.type === "settings") {
        settingsRef.current = msg.settings;
        setSettings(msg.settings);
      } else if (msg.type === "selection") {
        setSelection(msg.selection);
        // A new selection is attached again, even if the last one was removed.
        setSelectionAttached(true);
      } else if (msg.type === "figma-result") sendToBridge(msg);
    };
    window.addEventListener("message", onMessage);
    postToMain({ type: "get-settings" });
    return () => window.removeEventListener("message", onMessage);
  }, [sendToBridge]);

  // Connect once the token is known; reconnect after drops.
  useEffect(() => {
    if (token === undefined) return;
    if (token === null) {
      setConnection("needs-token");
      return;
    }

    let retry: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    setConnection("connecting");
    const ws = new WebSocket(`${BRIDGE_URL}?token=${encodeURIComponent(token)}`);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnection("connected");
      // Each connection gets a fresh session on the bridge; reapply the saved choices.
      const { model, effort, mode } = settingsRef.current;
      if (mode && mode !== "default") ws.send(JSON.stringify({ type: "set-mode", mode } satisfies ClientMessage));
      if (model) ws.send(JSON.stringify({ type: "set-model", model } satisfies ClientMessage));
      if (effort) ws.send(JSON.stringify({ type: "set-effort", effort } satisfies ClientMessage));
    };
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data) as ServerMessage;
      if (msg.type === "figma-op") {
        postToMain({ type: "figma-op", id: msg.id, op: msg.op, args: msg.args } as ToMainMessage);
        return;
      }
      if (msg.type === "session-info") {
        setModels(msg.models);
        setCommands(msg.commands);
        setModes(msg.modes);
        return;
      }
      if (msg.type === "mode") {
        // Mirror the session, including changes Claude makes itself (leaving plan mode).
        setModeState(msg.mode);
        if (settingsRef.current.mode !== msg.mode) updateSettings({ mode: msg.mode });
        return;
      }
      if (msg.type === "ready") {
        setCwd(msg.cwd);
        if (msg.model) setActiveModel(msg.model);
      }
      dispatch({ type: "server", msg });
    };
    ws.onclose = (event) => {
      if (wsRef.current === ws) wsRef.current = null;
      if (disposed) return;
      dispatch({ type: "disconnected" });
      if (event.code === CLOSE_BAD_TOKEN) {
        setConnection("needs-token");
        return;
      }
      setConnection("disconnected");
      retry = setTimeout(() => setAttempt((n) => n + 1), RECONNECT_MS);
    };

    return () => {
      disposed = true;
      clearTimeout(retry);
      ws.close();
    };
  }, [token, attempt, updateSettings]);

  const send = useCallback(
    (text: string) => {
      const attached = selectionAttached ? selection : undefined;
      const label = attached && attached.total > 0 ? selectionLabel(attached) : undefined;
      dispatch({ type: "user", text, selectionLabel: label });
      sendToBridge({ type: "chat", text, selection: attached });
    },
    [sendToBridge, selection, selectionAttached],
  );

  const answerApproval = useCallback(
    (id: string, allow: boolean, opts?: { mode?: PermissionModeOption; message?: string }) => {
      dispatch({ type: "approval-answered", id, allow });
      sendToBridge({ type: "approval", id, allow, ...opts });
      if (allow && opts?.mode) setModeState(opts.mode);
    },
    [sendToBridge],
  );

  const value: ClaudeContextType = {
    connection,
    cwd,
    ...state,
    send,
    answerApproval,
    interrupt: () => sendToBridge({ type: "interrupt" }),
    newChat: () => {
      sendToBridge({ type: "reset" });
      dispatch({ type: "clear" });
    },
    pair: (value: string) => {
      updateSettings({ token: value.trim().toUpperCase() });
      setAttempt((n) => n + 1);
    },
    models,
    commands,
    model: settings?.model ?? "default",
    activeModel,
    effort: settings?.effort,
    setModel: (value: string) => {
      const model = value === "default" ? undefined : value;
      sendToBridge({ type: "set-model", model: model ?? null });
      setActiveModel(undefined);
      // Drop an effort level the new model doesn't support.
      const efforts = models.find((m) => m.value === value)?.efforts;
      const effort = settingsRef.current.effort;
      if (effort && !efforts?.includes(effort)) {
        sendToBridge({ type: "set-effort", effort: null });
        updateSettings({ model, effort: undefined });
      } else {
        updateSettings({ model });
      }
    },
    mode,
    modes,
    setMode: (next) => sendToBridge({ type: "set-mode", mode: next }),
    selection,
    selectionAttached,
    setSelectionAttached,
    setEffort: (effort) => {
      sendToBridge({ type: "set-effort", effort: effort ?? null });
      updateSettings({ effort });
    },
    reconnect: () => setAttempt((n) => n + 1),
  };

  return <ClaudeContext.Provider value={value}>{children}</ClaudeContext.Provider>;
};

export const useClaude = (): ClaudeContextType => {
  const context = useContext(ClaudeContext);
  if (!context) throw new Error("useClaude must be used within ClaudeProvider");
  return context;
};
