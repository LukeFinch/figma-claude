import React, { useEffect, useRef } from "react";
import { useClaude } from "../core/provider";
import type { ChatItem } from "../core/types";
import { Composer } from "./Composer";

const prettyToolName = (name: string) => name.replace(/^mcp__canvas__/, "figma.");

export const ChatInterface: React.FC = () => {
  const { items, busy } = useClaude();
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [items]);

  const waitingForApproval = items.some((i) => i.kind === "approval" && i.status === "pending");
  const last = items[items.length - 1];
  const showThinking = busy && !waitingForApproval && last?.kind !== "assistant";

  return (
    <div className="chat">
      <div className="messages" aria-live="polite">
        {items.length === 0 && (
          <div className="empty">
            <p>Select something on the canvas and ask Claude to change it, or describe what to build.</p>
          </div>
        )}
        {items.map((item) => (
          <Item key={item.id} item={item} />
        ))}
        {showThinking && <div className="thinking">Working…</div>}
        <div ref={endRef} />
      </div>

      <Composer />
    </div>
  );
};

const Item: React.FC<{ item: ChatItem }> = ({ item }) => {
  switch (item.kind) {
    case "user":
      return (
        <div className="user-message">
          {item.selectionLabel && <div className="selection-tag">{item.selectionLabel}</div>}
          <div className="bubble user">{item.text}</div>
        </div>
      );
    case "assistant":
      return <div className="bubble assistant">{item.text}</div>;
    case "error":
      return <div className="notice error">{item.text}</div>;
    case "note":
      return <div className="notice note">{item.text}</div>;
    case "tool":
      return <ToolRow item={item} />;
    case "approval":
      return <ApprovalCard item={item} />;
  }
};

const ToolRow: React.FC<{ item: Extract<ChatItem, { kind: "tool" }> }> = ({ item }) => (
  <details className={`tool ${item.status}`}>
    <summary>
      <span className="tool-dot" aria-hidden />
      <span className="tool-name">{prettyToolName(item.name)}</span>
      {item.status === "running" && <span className="tool-meta">running</span>}
      {item.status === "error" && <span className="tool-meta">failed</span>}
    </summary>
    <pre>{formatInput(item.input)}</pre>
    {item.summary && <pre className="tool-result">{item.summary}</pre>}
  </details>
);

const EXECUTE_TOOL = "mcp__canvas__execute";

const ApprovalCard: React.FC<{ item: Extract<ChatItem, { kind: "approval" }> }> = ({ item }) => {
  const { answerApproval, modes } = useClaude();
  if (item.name === "ExitPlanMode") return <PlanCard item={item} />;
  const pending = item.status === "pending";
  const canAllowAll = item.name === EXECUTE_TOOL && modes.includes("acceptEdits");
  return (
    <div className={`approval ${item.status}`}>
      <div className="approval-title">
        {pending ? "Allow " : ""}
        <code>{prettyToolName(item.name)}</code>
        {pending ? "?" : ` ${item.status}`}
      </div>
      {item.reason && <p className="approval-reason">{item.reason}</p>}
      <pre>{formatInput(item.input)}</pre>
      {pending && (
        <div className="approval-actions">
          <button className="button secondary" onClick={() => answerApproval(item.id, false)}>
            Deny
          </button>
          {canAllowAll && (
            <button
              className="button secondary"
              onClick={() => answerApproval(item.id, true, { mode: "acceptEdits" })}
              title="Allow this and switch to Accept edits, so Figma edits stop asking"
            >
              Allow all edits
            </button>
          )}
          <button className="button primary" onClick={() => answerApproval(item.id, true)}>
            Allow
          </button>
        </div>
      )}
    </div>
  );
};

const PlanCard: React.FC<{ item: Extract<ChatItem, { kind: "approval" }> }> = ({ item }) => {
  const { answerApproval } = useClaude();
  const pending = item.status === "pending";
  const outcome = { allowed: "Plan approved", denied: "Kept planning", cancelled: "Plan cancelled", pending: "" };
  return (
    <div className={`approval plan ${item.status}`}>
      <div className="approval-title">{pending ? "Ready to build this plan?" : outcome[item.status]}</div>
      <pre className="plan-text">{item.plan?.trim() || "Claude didn't share the plan text; it's in the messages above."}</pre>
      {pending && (
        <div className="approval-actions">
          <button
            className="button secondary"
            onClick={() =>
              answerApproval(item.id, false, {
                message: "The user wants to keep planning. Wait for their feedback before changing anything.",
              })
            }
          >
            Keep planning
          </button>
          <button className="button secondary" onClick={() => answerApproval(item.id, true, { mode: "default" })}>
            Approve
          </button>
          <button
            className="button primary"
            onClick={() => answerApproval(item.id, true, { mode: "acceptEdits" })}
            title="Approve, and let Claude make the edits without asking each time"
          >
            Approve, accept edits
          </button>
        </div>
      )}
    </div>
  );
};

function formatInput(input: unknown): string {
  if (input && typeof input === "object" && "code" in input && typeof (input as any).code === "string") {
    return (input as { code: string }).code;
  }
  if (input && typeof input === "object" && "command" in input && typeof (input as any).command === "string") {
    return (input as { command: string }).command;
  }
  return JSON.stringify(input, null, 2);
}
