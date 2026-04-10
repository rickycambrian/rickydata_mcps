// ============================================================================
// TOOL: ingest_paper
// ============================================================================

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { fetchPaper, fetchHtml, fetchPdfBuffer } from "../arxiv.js";
import {
  parseHtml,
  parsePdf,
  chunkSections,
  buildGuide,
  type StoredPaperArtifact,
} from "../parser.js";
import { hasPaper, getPaper, savePaper } from "../store.js";

export const ingestionTools: Tool[] = [
  {
    name: "ingest_paper",
    description:
      "Fetch, parse, and store a research paper by arXiv ID. " +
      "Downloads the paper (HTML preferred, PDF fallback), parses it into sections, " +
      "chunks it for semantic search, and stores it in KFDB + local cache. " +
      "Returns a navigation guide and metadata overview. " +
      "Use force=true to re-ingest an already-stored paper.",
    inputSchema: {
      type: "object" as const,
      properties: {
        arxiv_id: {
          type: "string",
          description:
            "arXiv paper ID, e.g. '2301.07041' or '2301.07041v2'. Version suffix is stripped.",
        },
        force: {
          type: "boolean",
          description:
            "Force re-ingestion even if paper is already stored (default: false)",
        },
      },
      required: ["arxiv_id"],
    },
  },
];

// ── Handler ────────────────────────────────────────────────────────────────

async function handleIngestPaper(
  args: Record<string, unknown>,
): Promise<string> {
  const arxivId = (args.arxiv_id as string)?.trim();
  if (!arxivId) return "Error: arxiv_id is required";

  const force = (args.force as boolean) ?? false;

  // Strip version suffix for canonical ID
  const canonicalId = arxivId.replace(/v\d+$/, "");

  // Check if already stored
  if (!force && (await hasPaper(canonicalId))) {
    const existing = await getPaper(canonicalId);
    if (existing) {
      return formatOverview(existing, "cached");
    }
  }

  // 1. Fetch metadata
  const meta = await fetchPaper(canonicalId);
  if (!meta) {
    return `Error: Could not find arXiv paper "${arxivId}". Check the ID and try again.`;
  }

  // 2. Try HTML first, fallback to PDF
  let sections: ReturnType<typeof parseHtml>;
  let rawText = "";
  let sourceFormat: "html" | "pdf" = "html";

  const html = await fetchHtml(canonicalId);
  if (html) {
    sections = parseHtml(html);
    rawText = sections.map((s) => `## ${s.heading}\n\n${s.text}`).join("\n\n");
  } else {
    const pdfBuffer = await fetchPdfBuffer(canonicalId);
    if (!pdfBuffer) {
      return `Error: Could not fetch content for arXiv paper "${arxivId}". The paper may not be available yet.`;
    }
    sections = await parsePdf(pdfBuffer);
    rawText = sections.map((s) => `## ${s.heading}\n\n${s.text}`).join("\n\n");
    sourceFormat = "pdf";
  }

  // 3. Chunk sections
  const chunks = chunkSections(sections);

  // 4. Build guide
  const guide = buildGuide(sections, rawText);

  // 5. Assemble artifact
  const artifact: StoredPaperArtifact = {
    arxivId: canonicalId,
    title: meta.title,
    authors: meta.authors,
    abstract: meta.abstract,
    published: meta.published,
    categories: meta.categories,
    sections,
    chunks,
    guide,
    rawText,
    fetchedAt: new Date().toISOString(),
    sourceFormat,
  };

  // 6. Save
  await savePaper(artifact);

  return formatOverview(artifact, "ingested");
}

function formatOverview(
  artifact: StoredPaperArtifact,
  status: "ingested" | "cached",
): string {
  const lines = [
    `# ${artifact.title}`,
    `**Status**: ${status === "ingested" ? "Successfully ingested" : "Loaded from cache"}`,
    `**arXiv ID**: \`${artifact.arxivId}\``,
    `**Authors**: ${artifact.authors.slice(0, 5).join(", ")}${artifact.authors.length > 5 ? " et al." : ""}`,
    `**Published**: ${artifact.published}`,
    `**Categories**: ${artifact.categories.join(", ")}`,
    `**Source**: ${artifact.sourceFormat.toUpperCase()}`,
    `**Sections**: ${artifact.sections.length}`,
    `**Chunks**: ${artifact.chunks.length}`,
    "",
    `## Abstract`,
    artifact.abstract,
    "",
    `## Navigation Guide`,
    `**Section outline**:`,
  ];

  for (const entry of artifact.guide.sectionOutline) {
    lines.push(`  - ${entry}`);
  }

  lines.push("");
  lines.push(`**Key terms**: ${artifact.guide.keyTerms.join(", ")}`);
  lines.push("");
  lines.push(`**Recommended queries**:`);
  for (const q of artifact.guide.recommendedQueries) {
    lines.push(`  - ${q}`);
  }

  lines.push("");
  lines.push(
    `*Use \`get_paper_section\` to read specific sections, or \`search_paper_contents\` to search within this paper.*`,
  );

  return lines.join("\n");
}

// ── Dispatch ───────────────────────────────────────────────────────────────

export async function handleIngestionTool(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "ingest_paper":
      return handleIngestPaper(args);
    default:
      return `Unknown ingestion tool: ${name}`;
  }
}
