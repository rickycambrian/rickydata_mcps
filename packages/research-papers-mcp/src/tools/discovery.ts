// ============================================================================
// TOOL: search_arxiv_papers
// ============================================================================

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { searchPapers, type ArxivPaper } from "../arxiv.js";

export const discoveryTools: Tool[] = [
  {
    name: "search_arxiv_papers",
    description:
      "Search arXiv for research papers by keyword, category, and date range. " +
      "Returns paper metadata (title, authors, abstract, arXiv ID) without ingesting them. " +
      "Use ingest_paper to fetch and store the full content for a specific paper.",
    inputSchema: {
      type: "object" as const,
      properties: {
        keyword: {
          type: "string",
          description: "Search keyword — matched against title and abstract",
        },
        categories: {
          type: "array",
          items: { type: "string" },
          description:
            "arXiv category filters, e.g. ['cs.AI', 'cs.LG', 'stat.ML']",
        },
        start_date: {
          type: "string",
          description:
            "Only return papers published on or after this ISO date (e.g. '2024-01-01')",
        },
        end_date: {
          type: "string",
          description:
            "Only return papers published on or before this ISO date (e.g. '2024-12-31')",
        },
        max_results: {
          type: "number",
          description: "Max results to return (default: 10, max: 50)",
        },
        sort_by: {
          type: "string",
          enum: ["relevance", "submittedDate", "lastUpdatedDate"],
          description: "Sort order (default: relevance)",
        },
      },
      required: ["keyword"],
    },
  },
];

// ── Handler ────────────────────────────────────────────────────────────────

async function handleSearchArxivPapers(
  args: Record<string, unknown>,
): Promise<string> {
  const keyword = args.keyword as string;
  if (!keyword) return "Error: keyword is required";

  const categories = args.categories as string[] | undefined;
  const startDate = args.start_date as string | undefined;
  const endDate = args.end_date as string | undefined;
  const maxResults = Math.min(
    Math.max(1, (args.max_results as number) ?? 10),
    50,
  );
  const sortBy = (args.sort_by as "relevance" | "submittedDate" | "lastUpdatedDate") ?? "relevance";

  const papers = await searchPapers({
    keyword,
    categories,
    startDate,
    endDate,
    maxResults,
    sortBy,
  });

  if (papers.length === 0) {
    return `# arXiv Search: "${keyword}"\n\nNo papers found. Try different keywords or categories.`;
  }

  const lines = [
    `# arXiv Search: "${keyword}"`,
    `**Results**: ${papers.length}`,
    categories ? `**Categories**: ${categories.join(", ")}` : "",
    "",
  ].filter(Boolean);

  for (let i = 0; i < papers.length; i++) {
    const p = papers[i];
    lines.push(`## ${i + 1}. ${p.title}`);
    lines.push(`**arXiv ID**: \`${p.arxivId}\``);
    lines.push(`**Authors**: ${p.authors.slice(0, 5).join(", ")}${p.authors.length > 5 ? " et al." : ""}`);
    lines.push(`**Published**: ${p.published}`);
    lines.push(`**Categories**: ${p.categories.join(", ")}`);
    lines.push(`**Abstract**: ${p.abstract.slice(0, 400)}${p.abstract.length > 400 ? "..." : ""}`);
    if (p.pdfUrl) lines.push(`**PDF**: ${p.pdfUrl}`);
    lines.push("");
    lines.push(`*Use \`ingest_paper\` with arxiv_id="${p.arxivId}" to load full content.*`);
    lines.push("");
  }

  return lines.join("\n");
}

// ── Dispatch ───────────────────────────────────────────────────────────────

export async function handleDiscoveryTool(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "search_arxiv_papers":
      return handleSearchArxivPapers(args);
    default:
      return `Unknown discovery tool: ${name}`;
  }
}
