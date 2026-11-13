import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { BRIDGE_PORT, CLOSE_BAD_TOKEN, type ClientMessage, type ServerMessage } from "../src/core/protocol";
import { ClaudeSession } from "./session";

const PORT = Number(process.env.FIGMA_CLAUDE_PORT ?? BRIDGE_PORT);
const CWD = resolve(process.env.FIGMA_CLAUDE_CWD ?? process.cwd());

/**
 * Pairing token. Anything on this machine (including any web page in a browser)
 * can open a socket to 127.0.0.1, and the session behind it can read local files
 * and spend your Claude usage, so the plugin must present this token.
 * It is stored so you only pair once.
 */
function loadToken(): string {
  const dir = join(homedir(), ".figma-claude");
  const file = join(dir, "token");
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    const token = randomBytes(4).toString("hex").toUpperCase().replace(/(.{4})/, "$1-");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(file, token, { mode: 0o600 });
    return token;
  }
}

const TOKEN = loadToken();

function tokenMatches(candidate: string | null): boolean {
  if (!candidate) return false;
  const a = Buffer.from(candidate.trim().toUpperCase());
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Figma plugin iframes have a "null" origin; plugma dev serves the UI from localhost. */
function originAllowed(origin: string | undefined): boolean {
  if (!origin || origin === "null") return true;
  try {
    const { hostname } = new URL(origin);
    return hostname === "localhost" || hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({
  server,
  verifyClient: ({ origin }: { origin: string }) => originAllowed(origin),
});

wss.on("connection", (ws: WebSocket, req) => {
  const token = new URL(req.url ?? "/", "http://localhost").searchParams.get("token");
  if (!tokenMatches(token)) {
    ws.close(CLOSE_BAD_TOKEN, "Bad pairing token");
    return;
  }

  console.log("Plugin connected");
  const send = (msg: ServerMessage) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };
  const session = new ClaudeSession(send, CWD);
  send({ type: "ready", cwd: CWD });

  ws.on("message", (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    switch (msg.type) {
      case "chat":
        session.chat(msg.text, msg.selection);
        break;
      case "interrupt":
        void session.interrupt();
        break;
      case "reset":
        session.reset();
        break;
      case "approval":
        session.resolveApproval(msg.id, { allow: msg.allow, mode: msg.mode, message: msg.message });
        break;
      case "set-model":
        void session.setModel(msg.model);
        break;
      case "set-mode":
        void session.setMode(msg.mode);
        break;
      case "set-effort":
        void session.setEffort(msg.effort);
        break;
      case "figma-result":
        session.resolveFigmaCall(msg.id, msg);
        break;
    }
  });

  ws.on("close", () => {
    console.log("Plugin disconnected");
    session.dispose();
  });
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Is another bridge running?`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Claude for Figma bridge on ws://127.0.0.1:${PORT}`);
  console.log(`Working directory: ${CWD}`);
  console.log(`Pairing code:      ${TOKEN}`);
});
