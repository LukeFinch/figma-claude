# Claude for Figma

A Figma plugin that chats with Claude Code. Claude can inspect and edit the open file, check its work with screenshots, read files in your project, and use your Claude Code skills. You can pick the model and effort level from the panel.

## How it works

A Figma plugin can't run Node or spawn processes, so a small local bridge hosts the [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview) and the plugin talks to it over a WebSocket.

```
Figma main thread ──postMessage── plugin UI (iframe) ──WebSocket :3055── bridge (Node) ──stdio── claude CLI
  runs figma.* calls                 chat panel                          Agent SDK query()
```

- **`bridge/session.ts`**: one long-lived `query()` per plugin connection, in streaming-input mode so the `claude` process stays alive between turns. It turns SDK messages into simple events for the UI (text deltas, tool start and end, approvals, end of turn).
- **`bridge/figma-tools.ts`**: Figma tools exposed to Claude through an in-process MCP server named `canvas`, so it doesn't clash with a `figma` MCP server in your own config: `get_selection`, `get_page`, `get_node`, `screenshot` and `execute` (runs plugin-API JavaScript). Each tool call is sent to the plugin and waits for the result.
- **`src/main.tsx`**: runs those operations against the document.
- **`src/core/protocol.ts`**: the message types shared by all three.

### Selection context

The main thread listens for `selectionchange` and keeps the panel told about what's selected. Each message carries a short summary of the selection: layer names, types, ids, sizes and links. Claude knows what "this" means without calling a tool first.

- The summary is only added when the selection has changed since the last message, so follow-up messages don't repeat it. It lists up to 20 layers.
- The chip above the message box shows what will be sent. Click × to leave it off one message; the next selection change turns it back on.
- Links need `figma.fileKey`, which Figma only provides to development and private plugins, so the manifest sets `enablePrivatePluginApi`. Published as a public plugin, the summary works the same but has no links.

### Models, effort and skills

- When the panel connects, the bridge starts the CLI and sends its model list and skills. The model and effort pickers sit under the message box. Changes apply from the next response, and the plugin remembers your choice.
- **Default** uses whatever Claude Code would pick, including `model` from your settings. The label shows the model that's actually running once the first reply arrives.
- Skills come from your user and project settings: `~/.claude/skills`, `.claude/skills`, and the skills of enabled plugins. Claude uses them by itself, or you can type `/` to pick one. `/clear` starts a new chat.

### Settings loaded

By default the bridge loads your **user and project** Claude Code settings, the same as running `claude` in the project folder. That's what brings in skills, but it also brings in:

- your MCP servers, CLAUDE.md files and hooks;
- your permission rules. An `allow` rule in your settings auto-approves that tool here too, without showing an Allow/Deny card.

It also makes the first message bigger and more expensive, because every skill's description is in the prompt. Set `FIGMA_CLAUDE_SETTINGS=none` for an isolated session without skills, or `user` for user settings only.

### Permission modes

The first picker under the message box sets the mode. Shift+Tab cycles through the modes, as in the terminal. The bridge always passes a mode explicitly, so a `defaultMode` in your settings doesn't silently change how the panel asks.

| Mode | Figma edits (`execute`) | Web, other tools | Notes |
| --- | --- | --- | --- |
| **Ask before edits** (`default`) | asks | asks | The starting mode |
| **Accept edits** (`acceptEdits`) | runs | asks | In the CLI this mode only covers file edits; here it covers Figma edits too |
| **Plan first** (`plan`) | blocked | read-only | Claude looks around and writes a plan. You approve it from a card: **Approve** (back to asking), **Approve, accept edits**, or **Keep planning** |
| **Auto** (`auto`) | a classifier decides | a classifier decides | No Allow/Deny cards |
| **Bypass** (`bypassPermissions`) | runs | runs | Only offered with `FIGMA_CLAUDE_ALLOW_BYPASS=1` |

The read-only Figma tools, plus `Read`, `Glob`, `Grep` and `Skill`, never ask. An approval card for a Figma edit also has **Allow all edits**, which switches to Accept edits.

Your mode choice is saved. The picker follows the session, so when Claude leaves plan mode the picker updates too.

### Tools

By default Claude gets read-only built-in tools plus `Write`/`Edit`. A `PreToolUse` hook limits `Write`/`Edit` to plan files (`~/.claude/plans`); plan mode needs them to write its plan. It's a hook because in Accept edits mode the CLI approves file edits without asking `canUseTool`. Set `FIGMA_CLAUDE_TOOLS=all` for the full Claude Code toolset, including Bash and project file edits. Those still follow the mode.

### Pairing

Any page in your browser can open a socket to `127.0.0.1`, so the bridge only accepts connections that present its pairing code. The code is generated once and stored in `~/.figma-claude/token`. The bridge prints it at startup; you enter it in the plugin once and it is saved in Figma's client storage. To rotate it, delete that file.

## Setup

```bash
npm install
npm run bridge        # prints the pairing code; keep it running
npm run dev           # or `npm run build` for a standalone build
```

In Figma desktop: **Plugins → Development → Import plugin from manifest…** and pick **`dist/manifest.json`**. The root `manifest.json` points at the source files that plugma reads; Figma can't load it.

Claude uses your existing Claude Code login, or `ANTHROPIC_API_KEY` if set.

### Bridge options

| Variable | Default | |
| --- | --- | --- |
| `FIGMA_CLAUDE_CWD` | current directory | Project folder Claude works in |
| `FIGMA_CLAUDE_MODEL` | Claude Code default | Starting model, e.g. `opus`; the panel's picker overrides it |
| `FIGMA_CLAUDE_SETTINGS` | `user,project` | Settings to load: a comma-separated list of `user`, `project`, `local`, or `none` |
| `FIGMA_CLAUDE_TOOLS` | read-only set | `all` for the full Claude Code toolset |
| `FIGMA_CLAUDE_ALLOW_BYPASS` | off | `1` adds Bypass permissions to the mode picker |
| `FIGMA_CLAUDE_PORT` | `3055` | The plugin connects to 3055, so change both together |

## Scripts

| | |
| --- | --- |
| `npm run bridge` | Start the bridge |
| `npm run bridge:dev` | Bridge with restart on change |
| `npm run dev` | Plugin dev build with hot reload |
| `npm run build` | Production plugin build into `dist/` |
| `npm run typecheck` | Typecheck the plugin and bridge |
