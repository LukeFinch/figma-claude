import React, { useEffect, useMemo, useRef, useState } from "react";
import { selectionLabel, useClaude } from "../core/provider";
import type { CommandOption, EffortLevel, PermissionModeOption } from "../core/protocol";

const MAX_SUGGESTIONS = 50;

/** Skills whose name matches what's typed after "/", best matches first. */
function matchCommands(commands: CommandOption[], typed: string): CommandOption[] {
  const q = typed.toLowerCase();
  const score = (c: CommandOption) => {
    const name = c.name.toLowerCase();
    const bare = name.includes(":") ? name.slice(name.indexOf(":") + 1) : name;
    if (name.startsWith(q) || bare.startsWith(q)) return 0;
    if (name.includes(q)) return 1;
    if (c.description.toLowerCase().includes(q)) return 2;
    return -1;
  };
  return commands
    .map((c) => ({ c, s: score(c) }))
    .filter(({ s }) => s >= 0)
    .sort((a, b) => a.s - b.s)
    .slice(0, MAX_SUGGESTIONS)
    .map(({ c }) => c);
}

export const Composer: React.FC = () => {
  const { busy, send, interrupt, newChat, commands, mode, modes, setMode } = useClaude();
  const [input, setInput] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);

  // The menu is open while the input is a single "/word" with no space yet.
  const slash = /^\/(\S*)$/.exec(input);
  const suggestions = useMemo(
    () => (slash ? matchCommands(commands, slash[1]) : []),
    [commands, slash?.[1]],
  );
  const menuOpen = !!slash && !dismissed && suggestions.length > 0;

  useEffect(() => {
    setHighlight(0);
    setDismissed(false);
  }, [slash?.[1]]);

  useEffect(() => {
    listRef.current?.children[highlight]?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  const complete = (command: CommandOption) => setInput(`/${command.name} `);

  const submit = () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    if (text === "/clear") newChat();
    else send(text);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (menuOpen) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setHighlight((h) => (h + step + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        complete(suggestions[highlight]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissed(true);
        return;
      }
    }
    // Shift+Tab cycles permission modes, as in the Claude Code terminal.
    if (e.key === "Tab" && e.shiftKey && modes.length > 0) {
      e.preventDefault();
      setMode(modes[(modes.indexOf(mode) + 1) % modes.length]);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {menuOpen && (
        <ul className="slash-menu" role="listbox" id="slash-menu" ref={listRef}>
          {suggestions.map((c, i) => (
            <li
              key={c.name}
              id={`slash-${i}`}
              role="option"
              aria-selected={i === highlight}
              className={i === highlight ? "active" : undefined}
              onMouseEnter={() => setHighlight(i)}
              onMouseDown={(e) => {
                e.preventDefault(); // keep focus in the textarea
                complete(c);
              }}
            >
              <span className="slash-name">/{c.name}</span>
              <span className="slash-desc">{c.description}</span>
            </li>
          ))}
        </ul>
      )}

      <SelectionChip />

      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={commands.length ? "Ask Claude, or type / for skills" : "Ask Claude…"}
        rows={2}
        aria-label="Message Claude"
        aria-controls={menuOpen ? "slash-menu" : undefined}
        aria-activedescendant={menuOpen ? `slash-${highlight}` : undefined}
        autoFocus
      />

      <div className="composer-bar">
        <div className="pickers">
          <ModePicker />
          <ModelPicker />
        </div>
        {busy ? (
          <button type="button" className="button secondary" onClick={interrupt}>
            Stop
          </button>
        ) : (
          <button type="submit" className="button primary" disabled={!input.trim()}>
            Send
          </button>
        )}
      </div>
    </form>
  );
};

const SelectionChip: React.FC = () => {
  const { selection, selectionAttached, setSelectionAttached } = useClaude();
  if (!selection || selection.total === 0) return null;
  const label = selectionLabel(selection);
  const detail = selection.nodes.map((n) => `${n.type.toLowerCase()} · ${n.name}`).join("\n");

  return (
    <div className={`selection-chip ${selectionAttached ? "" : "detached"}`} title={detail}>
      <span className="selection-chip-label">
        {selectionAttached ? "Selection: " : "Not sending: "}
        <strong>{label}</strong>
      </span>
      <button
        type="button"
        className="chip-toggle"
        onClick={() => setSelectionAttached(!selectionAttached)}
        aria-label={selectionAttached ? "Don't send the selection with this message" : "Send the selection with this message"}
      >
        {selectionAttached ? "×" : "Add"}
      </button>
    </div>
  );
};

export const MODE_LABELS: Record<PermissionModeOption, string> = {
  default: "Ask before edits",
  acceptEdits: "Accept edits",
  plan: "Plan first",
  auto: "Auto",
  bypassPermissions: "Bypass permissions",
};

const MODE_HINTS: Record<PermissionModeOption, string> = {
  default: "Ask before Figma edits, web access and anything else that changes things",
  acceptEdits: "Make Figma and file edits without asking; still ask for the rest",
  plan: "Look around and propose a plan; change nothing until you approve it",
  auto: "A classifier approves or blocks each action instead of asking you",
  bypassPermissions: "Run everything without asking, including commands on your machine",
};

const ModePicker: React.FC = () => {
  const { mode, modes, setMode } = useClaude();
  if (modes.length === 0) return null;
  return (
    <select
      className={`picker mode-${mode}`}
      value={mode}
      onChange={(e) => setMode(e.target.value as PermissionModeOption)}
      aria-label="Permission mode (Shift+Tab to cycle)"
      title={`${MODE_HINTS[mode]} · Shift+Tab to cycle`}
    >
      {modes.map((m) => (
        <option key={m} value={m}>
          {MODE_LABELS[m]}
        </option>
      ))}
    </select>
  );
};

const EFFORT_LABELS: Record<EffortLevel, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

const ModelPicker: React.FC = () => {
  const { models, model, activeModel, effort, setModel, setEffort } = useClaude();
  if (models.length === 0) return null;

  const selected = models.find((m) => m.value === model);
  const efforts = selected?.efforts ?? [];

  return (
    <>
      <select
        className="picker"
        value={model}
        onChange={(e) => setModel(e.target.value)}
        aria-label="Model"
        title={selected?.description}
      >
        {models.map((m) => (
          <option key={m.value} value={m.value}>
            {m.value === "default" && activeModel && model === "default" ? `Default (${activeModel})` : m.displayName}
          </option>
        ))}
      </select>
      {efforts.length > 0 && (
        <select
          className="picker"
          value={effort ?? ""}
          onChange={(e) => setEffort((e.target.value || undefined) as EffortLevel | undefined)}
          aria-label="Effort"
        >
          <option value="">Auto effort</option>
          {efforts.map((level) => (
            <option key={level} value={level}>
              {EFFORT_LABELS[level]} effort
            </option>
          ))}
        </select>
      )}
    </>
  );
};
