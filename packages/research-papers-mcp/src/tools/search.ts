// ============================================================================
// TOOL: search_paper_contents
// ============================================================================

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { semanticSearchChunks } from "../store.js";

export const searchTools: Tool[] = [
  {
    name: "search_paper_contents",
    description:
      "Semantic search across ingested paper contents using KFDB vector embeddings. " +
      "Finds relevant sections/chunks by meaning, not just keyword match. " +
      "Optionally narrow to a specific paper by arxiv_id. " +
      "Requires papers to be ingested first with ingest_paper.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Natural language search query",
        },
        arxiv_id: {
          type: "string",
          description:
            "Optional: limit search to a specific paper by arXiv ID",
        },
        limit: {
          type: "number",
          description: "Max results to return (default: 10, max: 30)",
        },
      },
      required: ["query"],
    },
  },
];

// ── Handler ────────────────────────────────────────────────────────────────

async function handleSearchPaperContents(
  args: Record<string, unknown>,
): Promise<string> {
  const query = args.query as string;
  if (!query) return "Error: query is required";

  const arxivId = args.arxiv_id as string | undefined;
  const limit = Math.min(Math.max(1, (args.limit as number) ?? 10), 30);

  const results = await semanticSearchChunks(query, arxivId, limit);

  if (results.length === 0) {
    return (
      `# Search: "${query}"\n\n` +
      (arxivId
        ? `No results found in paper "${arxivId}". Make sure it is ingested with \`ingest_paper\`.`
        : `No results found. Papers may not be indexed yet in KFDB, or KFDB is not configured. ` +
          `Use \`list_papers\` to see stored papers and \`get_paper_section\` to browse by section.`)
    );
  }

  const lines = [
    `# Search: "${query}"`,
    arxivId ? `**Paper**: ${arxivId}` : "**Scope**: all ingested papers",
    `**Results**: ${results.length}`,
    "",
  ];

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const title = r.paperTitle ? `${r.paperTitle} (${r.arxivId})` : r.arxivId;
    lines.push(`## ${i + 1}. ${title}`);
    lines.push(`**Section**: ${r.sectionHeading}  |  **Similarity**: ${(r.similarity * 100).toFixed(1)}%`);
    lines.push(`**Excerpt**: ${r.chunkText.slice(0, 600)}${r.chunkText.length > 600 ? "..." : ""}`);
    lines.push(
      `*Use \`get_paper_section\` with arxiv_id="${r.arxivId}" and section_name="${r.sectionHeading}" for full text.*`,
    );
    lines.push("");
  }

  return lines.join("\n");
}

// ── Dispatch ───────────────────────────────────────────────────────────────

export async function handleSearchTool(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "search_paper_contents":
      return handleSearchPaperContents(args);
    default:
      return `Unknown search tool: ${name}`;
  }
}
