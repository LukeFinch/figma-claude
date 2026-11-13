export type ConnectionState = "connecting" | "connected" | "disconnected" | "needs-token";

export type ChatItem =
  /** selectionLabel describes the selection that went with the message, if any. */
  | { kind: "user"; id: string; text: string; selectionLabel?: string }
  | { kind: "assistant"; id: string; text: string }
  | { kind: "tool"; id: string; name: string; input: unknown; status: "running" | "done" | "error"; summary?: string }
  | {
      kind: "approval";
      id: string;
      name: string;
      input: unknown;
      reason?: string;
      /** For ExitPlanMode: the plan Claude wants approved. */
      plan?: string;
      status: "pending" | "allowed" | "denied" | "cancelled";
    }
  | { kind: "error"; id: string; text: string }
  | { kind: "note"; id: string; text: string };
