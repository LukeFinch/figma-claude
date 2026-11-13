import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { FigmaOpName } from "../src/core/protocol";

export type CallFigma = (op: FigmaOpName, args: unknown) => Promise<unknown>;

/** Not "figma": that name is often taken by a Figma MCP server in the user's own config. */
export const FIGMA_SERVER_NAME = "canvas";

/** Tools that only read the document; these run without asking. */
export const READ_ONLY_FIGMA_TOOLS = ["get_selection", "get_page", "get_node", "screenshot"].map(
  (name) => `mcp__${FIGMA_SERVER_NAME}__${name}`,
);

const json = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

const depth = z
  .number()
  .int()
  .min(0)
  .max(6)
  .optional()
  .describe("How many levels of children to include (default 2).");

export function createFigmaServer(callFigma: CallFigma) {
  return createSdkMcpServer({
    name: FIGMA_SERVER_NAME,
    version: "0.1.0",
    tools: [
      tool(
        "get_selection",
        "Get the nodes the user currently has selected in Figma, with their properties and children.",
        { depth },
        async (args) => json(await callFigma("get_selection", args)),
      ),
      tool(
        "get_page",
        "Get the current page and its top-level layers. Use this to orient yourself before editing.",
        { depth },
        async (args) => json(await callFigma("get_page", args)),
      ),
      tool(
        "get_node",
        "Get one node by its id (e.g. '12:34'), with its properties and children.",
        { id: z.string(), depth },
        async (args) => json(await callFigma("get_node", args)),
      ),
      tool(
        "execute",
        [
          "Run JavaScript in the Figma plugin sandbox to read or change the document.",
          "The code is the body of an async function with the `figma` global available; `return` a value to see it.",
          "Returned nodes are summarised as { id, name, type, ... } automatically.",
          "This plugin uses dynamic page loading, so use the async APIs: figma.getNodeByIdAsync, page.loadAsync, figma.setCurrentPageAsync.",
          "Call figma.loadFontAsync before setting characters or fonts on text nodes.",
          "Append new nodes to a frame or section rather than leaving them loose on the canvas, and select or scroll to what you made with figma.currentPage.selection and figma.viewport.scrollAndZoomIntoView.",
        ].join(" "),
        { code: z.string().describe("Body of an async function. Use `return` for the result.") },
        async (args) => json(await callFigma("execute", args)),
      ),
      tool(
        "screenshot",
        "Render a node (or the current selection if no id is given) to a PNG so you can check how it looks.",
        {
          id: z.string().optional().describe("Node id. Defaults to the current selection."),
          scale: z.number().min(0.1).max(4).optional().describe("Export scale (default 1)."),
        },
        async (args) => {
          const { base64 } = ((await callFigma("screenshot", args)) ?? {}) as { base64?: string };
          if (!base64) throw new Error("Figma returned no image data for the screenshot");
          return { content: [{ type: "image" as const, data: base64, mimeType: "image/png" }] };
        },
      ),
    ],
  });
}
