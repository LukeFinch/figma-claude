// Figma plugin main thread. Owns the document; the UI relays operations here.
import {
  MAX_SELECTION_NODES,
  type FigmaOp,
  type FromMainMessage,
  type SelectionSummary,
  type StoredSettings,
  type ToMainMessage,
} from "./core/protocol";

const SETTINGS_KEY = "settings";
/** Where the pairing token lived before settings were grouped. */
const LEGACY_TOKEN_KEY = "bridge-token";

async function loadSettings(): Promise<StoredSettings> {
  const settings: StoredSettings = (await figma.clientStorage.getAsync(SETTINGS_KEY)) ?? {};
  if (!settings.token) {
    const legacy = await figma.clientStorage.getAsync(LEGACY_TOKEN_KEY);
    if (legacy) settings.token = legacy;
  }
  return settings;
}

export default function main() {
  figma.showUI(__html__, { width: 420, height: 640, themeColors: true });

  // Keep the UI told about the selection, so it can go along with each message.
  // Debounced because drag-selecting fires many events.
  let pending: ReturnType<typeof setTimeout> | undefined;
  const queueSelection = () => {
    clearTimeout(pending);
    pending = setTimeout(() => post({ type: "selection", selection: summariseSelection() }), 150);
  };
  figma.on("selectionchange", queueSelection);
  figma.on("currentpagechange", queueSelection);

  figma.ui.onmessage = async (msg: ToMainMessage) => {
    switch (msg.type) {
      case "get-settings":
        post({ type: "settings", settings: await loadSettings() });
        post({ type: "selection", selection: summariseSelection() });
        return;
      case "save-settings":
        await figma.clientStorage.setAsync(SETTINGS_KEY, msg.settings);
        return;
      case "figma-op":
        try {
          post({ type: "figma-result", id: msg.id, ok: true, result: toCloneable(await runOp(msg)) });
        } catch (err) {
          post({ type: "figma-result", id: msg.id, ok: false, error: errorMessage(err) });
        }
        return;
    }
  };
}

function post(msg: FromMainMessage) {
  figma.ui.postMessage(msg);
}

async function runOp(msg: FigmaOp): Promise<unknown> {
  switch (msg.op) {
    case "get_selection": {
      const selection = figma.currentPage.selection;
      return {
        page: { id: figma.currentPage.id, name: figma.currentPage.name },
        count: selection.length,
        nodes: selection.map((n) => describe(n, msg.args.depth ?? 2)),
      };
    }
    case "get_page":
      return describe(figma.currentPage, msg.args.depth ?? 2);
    case "get_node": {
      const node = await figma.getNodeByIdAsync(msg.args.id);
      if (!node) throw new Error(`No node with id ${msg.args.id}`);
      return describe(node, msg.args.depth ?? 2);
    }
    case "execute":
      return execute(msg.args.code);
    case "screenshot": {
      const target = msg.args.id
        ? await figma.getNodeByIdAsync(msg.args.id)
        : figma.currentPage.selection[0];
      if (!target) throw new Error(msg.args.id ? `No node with id ${msg.args.id}` : "Nothing is selected");
      if (!("exportAsync" in target)) throw new Error(`${target.type} nodes can't be exported`);
      const bytes = await target.exportAsync({
        format: "PNG",
        constraint: { type: "SCALE", value: msg.args.scale ?? 1 },
      });
      return { base64: figma.base64Encode(bytes) };
    }
  }
}

async function execute(code: string): Promise<unknown> {
  // Indirect eval runs in global scope, where `figma` is defined. The code is
  // the body of an async function so it can use await and return.
  const fn = (0, eval)(`(async () => {\n${code}\n})`) as () => Promise<unknown>;
  return fn();
}

function summariseSelection(): SelectionSummary {
  const page = figma.currentPage;
  const selection = page.selection;
  return {
    fileName: figma.root.name,
    pageId: page.id,
    pageName: page.name,
    total: selection.length,
    nodes: selection.slice(0, MAX_SELECTION_NODES).map((node) => ({
      id: node.id,
      name: node.name,
      type: node.type,
      ...("width" in node ? { width: round(node.width), height: round(node.height) } : {}),
      ...(nodeUrl(node.id) ? { url: nodeUrl(node.id) } : {}),
    })),
  };
}

/** figma.fileKey is only set for development and private plugins (enablePrivatePluginApi). */
function nodeUrl(id: string): string | undefined {
  if (!figma.fileKey) return undefined;
  const slug = encodeURIComponent(figma.root.name.replace(/\s+/g, "-")) || "file";
  return `https://www.figma.com/design/${figma.fileKey}/${slug}?node-id=${id.replace(/:/g, "-")}`;
}

// ---- Serialisation -------------------------------------------------------

type Described = Record<string, unknown>;

function describe(node: BaseNode, depth: number): Described {
  const out: Described = { id: node.id, name: node.name, type: node.type };
  const n = node as any;

  if ("x" in n) Object.assign(out, { x: round(n.x), y: round(n.y) });
  if ("width" in n) Object.assign(out, { width: round(n.width), height: round(n.height) });
  if ("visible" in n && !n.visible) out.visible = false;
  if ("layoutMode" in n && n.layoutMode !== "NONE") {
    Object.assign(out, {
      layoutMode: n.layoutMode,
      itemSpacing: n.itemSpacing,
      padding: [n.paddingTop, n.paddingRight, n.paddingBottom, n.paddingLeft],
    });
  }
  if ("fills" in n && Array.isArray(n.fills) && n.fills.length) out.fills = n.fills.map(describePaint);
  if ("strokes" in n && Array.isArray(n.strokes) && n.strokes.length) out.strokes = n.strokes.map(describePaint);
  if ("cornerRadius" in n && typeof n.cornerRadius === "number" && n.cornerRadius) out.cornerRadius = n.cornerRadius;
  if (node.type === "TEXT") {
    out.characters = n.characters.length > 500 ? `${n.characters.slice(0, 500)}…` : n.characters;
    if (typeof n.fontSize === "number") out.fontSize = n.fontSize;
    if (typeof n.fontName === "object" && "family" in n.fontName) out.fontName = n.fontName;
  }
  if (node.type === "INSTANCE") out.componentProperties = n.componentProperties;

  if ("children" in n) {
    const children = n.children as readonly BaseNode[];
    if (depth > 0) out.children = children.map((c) => describe(c, depth - 1));
    else if (children.length) out.childCount = children.length;
  }
  return out;
}

function describePaint(paint: Paint): unknown {
  if (paint.type === "SOLID") {
    const { r, g, b } = paint.color;
    const hex = [r, g, b].map((c) => Math.round(c * 255).toString(16).padStart(2, "0")).join("");
    return { type: "SOLID", color: `#${hex}`, opacity: paint.opacity ?? 1 };
  }
  return { type: paint.type };
}

/**
 * Make a value safe for postMessage and JSON: nodes become summaries, and
 * symbols and functions are dropped.
 */
function toCloneable(value: unknown, seen = new WeakSet<object>(), level = 0): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "function" || typeof value === "symbol") return undefined;
  if (typeof value !== "object") return value;
  if (isNode(value)) return describe(value, 0);
  if (value instanceof Uint8Array) return `[${value.length} bytes]`;
  if (seen.has(value) || level > 8) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => toCloneable(v, seen, level + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = toCloneable(v, seen, level + 1);
  return out;
}

function isNode(value: object): value is BaseNode {
  return "id" in value && "type" in value && "removed" in value;
}

function round(n: number) {
  return Math.round(n * 100) / 100;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.stack ? `${err.message}\n${err.stack}` : err.message;
  return String(err);
}
