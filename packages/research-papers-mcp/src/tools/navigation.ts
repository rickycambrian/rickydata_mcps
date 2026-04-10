// ============================================================================
// TOOLS: list_papers, get_paper_overview, get_paper_section
// ============================================================================

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { listPapers, getPaper } from "../store.js";
import type { PaperSection } from "../parser.js";

export const navigationTools: Tool[] = [
  {
    name: "list_papers",
    description:
      "List all research papers that have been ingested and stored locally. " +
      "Optionally filter by keyword (matches title, abstract, authors, categories). " +
      "Returns metadata overview for each paper.",
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: {
          type: "number",
          description: "Max papers to return (default: 20, max: 100)",
        },
        query: {
          type: "string",
          description:
            "Optional keyword filter — matches title, abstract, authors, categories",
        },
      },
    },
  },
  {
    name: "get_paper_overview",
    description:
      "Get the navigation guide and metadata for a stored paper. " +
      "Returns section outline, key terms, recommended queries, and abstract. " +
      "Use this to plan your reading before fetching specific sections.",
    inputSchema: {
      type: "object" as const,
      properties: {
        arxiv_id: {
          type: "string",
          description: "arXiv paper ID, e.g. '2301.07041'",
        },
      },
      required: ["arxiv_id"],
    },
  },
  {
    name: "get_paper_section",
    description:
      "Get the full text of a specific section from a stored paper. " +
      "Identify the section by name (e.g. 'Introduction', 'Methodology') or by ordinal number (1-based). " +
      "Returns section text, section type, and position context.",
    inputSchema: {
      type: "object" as const,
      properties: {
        arxiv_id: {
          type: "string",
          description: "arXiv paper ID, e.g. '2301.07041'",
        },
        section_name: {
          type: "string",
          description:
            "Section heading to look up (case-insensitive partial match)",
        },
        section_ordinal: {
          type: "number",
          description: "Section ordinal (1-based). Takes priority over section_name if both provided.",
        },
      },
      required: ["arxiv_id"],
    },
  },
];

// ── Handlers ───────────────────────────────────────────────────────────────

async function handleListPapers(
  args: Record<string, unknown>,
): Promise<string> {
  const limit = Math.min(Math.max(1, (args.limit as number) ?? 20), 100);
  const query = args.query as string | undefined;

  const papers = await listPapers(limit, query);

  if (papers.length === 0) {
    const msg = query
      ? `No papers found matching "${query}". Try a different query or use \`search_arxiv_papers\` to discover papers.`
      : `No papers ingested yet. Use \`search_arxiv_papers\` to discover papers and \`ingest_paper\` to store them.`;
    return `# Stored Papers\n\n${msg}`;
  }

  const lines = [
    `# Stored Papers`,
    query ? `**Filter**: "${query}"` : "",
    `**Count**: ${papers.length}`,
    "",
  ].filter(Boolean);

  for (let i = 0; i < papers.length; i++) {
    const p = papers[i];
    lines.push(`## ${i + 1}. ${p.title}`);
    lines.push(`**arXiv ID**: \`${p.arxivId}\``);
    lines.push(
      `**Authors**: ${p.authors.slice(0, 3).join(", ")}${p.authors.length > 3 ? " et al." : ""}`,
    );
    lines.push(`**Published**: ${p.published}`);
    lines.push(`**Categories**: ${p.categories.join(", ")}`);
    lines.push(`**Sections**: ${p.sectionCount}  |  **Fetched**: ${p.fetchedAt.split("T")[0]}`);
    lines.push("");
  }

  return lines.join("\n");
}

async function handleGetPaperOverview(
  args: Record<string, unknown>,
): Promise<string> {
  const arxivId = (args.arxiv_id as string)?.replace(/v\d+$/, "").trim();
  if (!arxivId) return "Error: arxiv_id is required";

  const artifact = await getPaper(arxivId);
  if (!artifact) {
    return (
      `Error: Paper "${arxivId}" not found in local store. ` +
      `Use \`ingest_paper\` with arxiv_id="${arxivId}" to fetch and store it first.`
    );
  }

  const lines = [
    `# ${artifact.title}`,
    `**arXiv ID**: \`${artifact.arxivId}\``,
    `**Authors**: ${artifact.authors.slice(0, 5).join(", ")}${artifact.authors.length > 5 ? " et al." : ""}`,
    `**Published**: ${artifact.published}`,
    `**Categories**: ${artifact.categories.join(", ")}`,
    `**Source**: ${artifact.sourceFormat.toUpperCase()}  |  **Fetched**: ${artifact.fetchedAt.split("T")[0]}`,
    `**Sections**: ${artifact.sections.length}  |  **Chunks**: ${artifact.chunks.length}`,
    "",
    `## Abstract`,
    artifact.abstract,
    "",
    `## Section Outline`,
  ];

  for (const entry of artifact.guide.sectionOutline) {
    lines.push(`  - ${entry}`);
  }

  lines.push("");
  lines.push(`## Key Terms`);
  lines.push(artifact.guide.keyTerms.join(", "));
  lines.push("");
  lines.push(`## Recommended Queries`);
  for (const q of artifact.guide.recommendedQueries) {
    lines.push(`  - ${q}`);
  }
  lines.push("");
  lines.push(`## Quality`);
  lines.push(`- Sections: ${artifact.guide.quality.sectionCount}`);
  lines.push(`- Total chars: ${artifact.guide.quality.totalChars}`);
  lines.push(`- Has abstract: ${artifact.guide.quality.hasAbstract}`);
  lines.push(`- Has references: ${artifact.guide.quality.hasReferences}`);
  lines.push("");
  lines.push(
    `*Use \`get_paper_section\` to read a specific section, or \`search_paper_contents\` to search within this paper.*`,
  );

  return lines.join("\n");
}

async function handleGetPaperSection(
  args: Record<string, unknown>,
): Promise<string> {
  const arxivId = (args.arxiv_id as string)?.replace(/v\d+$/, "").trim();
  if (!arxivId) return "Error: arxiv_id is required";

  const sectionName = args.section_name as string | undefined;
  const sectionOrdinal = args.section_ordinal as number | undefined;

  if (!sectionName && sectionOrdinal === undefined) {
    return "Error: provide either section_name or section_ordinal";
  }

  const artifact = await getPaper(arxivId);
  if (!artifact) {
    return (
      `Error: Paper "${arxivId}" not found. Use \`ingest_paper\` first.`
    );
  }

  let section: PaperSection | undefined;

  if (sectionOrdinal !== undefined) {
    // ordinal is 1-based in the API
    section = artifact.sections.find((s) => s.ordinal === sectionOrdinal - 1);
    if (!section) {
      return (
        `Error: Section ordinal ${sectionOrdinal} not found in "${artifact.title}". ` +
        `Valid range: 1–${artifact.sections.length}. ` +
        `Use \`get_paper_overview\` to see section outline.`
      );
    }
  } else if (sectionName) {
    const query = sectionName.toLowerCase();
    section = artifact.sections.find(
      (s) =>
        s.heading.toLowerCase() === query ||
        s.heading.toLowerCase().includes(query) ||
        s.type === query,
    );
    if (!section) {
      return (
        `Error: Section "${sectionName}" not found in "${artifact.title}". ` +
        `Use \`get_paper_overview\` to see available sections.`
      );
    }
  }

  if (!section) return "Error: section not found";

  const totalSections = artifact.sections.length;
  const prev =
    section.ordinal > 0 ? artifact.sections[section.ordinal - 1] : null;
  const next =
    section.ordinal < totalSections - 1
      ? artifact.sections[section.ordinal + 1]
      : null;

  const lines = [
    `# ${artifact.title} — ${section.heading}`,
    `**Section**: ${section.ordinal + 1}/${totalSections} (type: ${section.type})`,
    prev ? `**Previous**: ${prev.heading}` : "",
    next ? `**Next**: ${next.heading}` : "",
    "",
    section.text,
  ].filter((l) => l !== "");

  return lines.join("\n");
}

// ── Dispatch ───────────────────────────────────────────────────────────────

export async function handleNavigationTool(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "list_papers":
      return handleListPapers(args);
    case "get_paper_overview":
      return handleGetPaperOverview(args);
    case "get_paper_section":
      return handleGetPaperSection(args);
    default:
      return `Unknown navigation tool: ${name}`;
  }
}
