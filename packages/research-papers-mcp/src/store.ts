// ============================================================================
// PAPER STORE — KFDB-backed with local file cache
// ============================================================================

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ARTIFACT_DIR } from "./config.js";
import {
  kfdbFetch,
  kfdbWrite,
  kfdbSemanticSearch,
  storeChunkEmbedding,
  paperId,
  chunkNodeId,
  chunkFilePath,
  wrapString,
  wrapInteger,
  type WriteOp,
} from "./kfdb.js";
import type { StoredPaperArtifact } from "./parser.js";

// ── Path Helpers ──────────────────────────────────────────────────────────

function artifactDir(): string {
  return resolve(ARTIFACT_DIR.replace(/^~/, homedir()));
}

function artifactPath(arxivId: string): string {
  const safe = arxivId.replace(/[^a-z0-9._-]/gi, "_");
  return join(artifactDir(), `${safe}.json`);
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(artifactDir(), { recursive: true });
}

// ── Local Cache ───────────────────────────────────────────────────────────

async function readLocal(arxivId: string): Promise<StoredPaperArtifact | null> {
  try {
    const raw = await fs.readFile(artifactPath(arxivId), "utf8");
    return JSON.parse(raw) as StoredPaperArtifact;
  } catch {
    return null;
  }
}

async function writeLocal(artifact: StoredPaperArtifact): Promise<void> {
  await ensureDir();
  await fs.writeFile(
    artifactPath(artifact.arxivId),
    JSON.stringify(artifact, null, 2),
    "utf8",
  );
}

// ── KFDB Persistence ──────────────────────────────────────────────────────

async function writePaperToKfdb(artifact: StoredPaperArtifact): Promise<void> {
  const ops: WriteOp[] = [];

  // Main paper node
  ops.push({
    operation: "create_node",
    label: "ResearchPaper",
    id: paperId(artifact.arxivId),
    properties: {
      arxiv_id: wrapString(artifact.arxivId),
      title: wrapString(artifact.title),
      authors: wrapString(artifact.authors.join(", ")),
      abstract: wrapString(artifact.abstract),
      published: wrapString(artifact.published),
      categories: wrapString(artifact.categories.join(", ")),
      fetched_at: wrapString(artifact.fetchedAt),
      source_format: wrapString(artifact.sourceFormat),
      section_count: wrapInteger(artifact.sections.length),
      chunk_count: wrapInteger(artifact.chunks.length),
      guide_json: wrapString(JSON.stringify(artifact.guide)),
      enrichment_status: wrapString("pending"),
    },
  });

  // Write chunks as separate nodes for semantic search
  for (const chunk of artifact.chunks) {
    const cId = chunkNodeId(artifact.arxivId, chunk.ordinal);
    const cFilePath = chunkFilePath(artifact.arxivId, chunk.ordinal);
    ops.push({
      operation: "create_node",
      label: "PaperChunk",
      id: cId,
      properties: {
        arxiv_id: wrapString(artifact.arxivId),
        paper_title: wrapString(artifact.title),
        section_type: wrapString(chunk.sectionType),
        section_heading: wrapString(chunk.sectionHeading),
        ordinal: wrapInteger(chunk.ordinal),
        chunk_index: wrapInteger(chunk.chunkIndex),
        text: wrapString(chunk.text),
        file_path: wrapString(cFilePath),
      },
    });

    // Edge: paper HAS_CHUNK chunk
    ops.push({
      operation: "create_edge",
      edge_type: "HAS_CHUNK",
      from: paperId(artifact.arxivId),
      to: cId,
      properties: {},
    });

    // Batch writes in groups of 50 to avoid oversized requests
    if (ops.length >= 50) {
      await kfdbWrite(ops.splice(0, ops.length));
    }
  }

  if (ops.length > 0) {
    await kfdbWrite(ops);
  }

  // Also store via file-embeddings API for Gemini auto-embedding (semantic search)
  for (const chunk of artifact.chunks) {
    try {
      await storeChunkEmbedding(artifact.arxivId, chunk);
    } catch (err) {
      console.error(`file-embeddings store failed for chunk ${chunk.ordinal}:`, err);
    }
  }
}

// ── Public API ────────────────────────────────────────────────────────────

export async function hasPaper(arxivId: string): Promise<boolean> {
  const local = await readLocal(arxivId);
  return local !== null;
}

export async function getPaper(
  arxivId: string,
): Promise<StoredPaperArtifact | null> {
  return readLocal(arxivId);
}

export async function savePaper(artifact: StoredPaperArtifact): Promise<void> {
  // Save to local cache first (always works)
  await writeLocal(artifact);

  // Best-effort save to KFDB for semantic search
  try {
    await writePaperToKfdb(artifact);
  } catch (err) {
    // KFDB may not be configured — local cache is the source of truth
    console.error("KFDB write failed (non-fatal):", err);
  }

  // Trigger paper enrichment (non-fatal)
  try {
    await kfdbFetch("/api/v1/graph/enrich/papers", { method: "POST" });
  } catch (err) {
    console.error("Paper enrichment trigger failed (non-fatal):", err);
  }
}

export interface PaperListing {
  arxivId: string;
  title: string;
  authors: string[];
  published: string;
  categories: string[];
  fetchedAt: string;
  sectionCount: number;
}

export async function listPapers(
  limit = 20,
  query?: string,
): Promise<PaperListing[]> {
  await ensureDir();
  const dir = artifactDir();

  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    return [];
  }

  const jsonFiles = files.filter((f) => f.endsWith(".json"));

  const listings: PaperListing[] = [];

  for (const file of jsonFiles) {
    try {
      const raw = await fs.readFile(join(dir, file), "utf8");
      const artifact = JSON.parse(raw) as StoredPaperArtifact;

      if (query) {
        const q = query.toLowerCase();
        const hit =
          artifact.title.toLowerCase().includes(q) ||
          artifact.abstract.toLowerCase().includes(q) ||
          artifact.authors.some((a) => a.toLowerCase().includes(q)) ||
          artifact.categories.some((c) => c.toLowerCase().includes(q));
        if (!hit) continue;
      }

      listings.push({
        arxivId: artifact.arxivId,
        title: artifact.title,
        authors: artifact.authors,
        published: artifact.published,
        categories: artifact.categories,
        fetchedAt: artifact.fetchedAt,
        sectionCount: artifact.sections.length,
      });
    } catch {
      // skip corrupt files
    }
  }

  // Sort by fetchedAt descending (most recent first)
  listings.sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt));
  return listings.slice(0, limit);
}

export async function semanticSearchChunks(
  query: string,
  arxivId?: string,
  limit = 10,
): Promise<Array<{ arxivId: string; chunkText: string; sectionHeading: string; similarity: number; paperTitle?: string }>> {
  const prefix = arxivId
    ? `ResearchPaper://${arxivId}/`
    : "ResearchPaper://";

  const results = await kfdbSemanticSearch(query, limit, undefined, prefix, true, true);

  return results.map((r) => {
    const props = r.properties as Record<string, { String?: string; Integer?: number }>;
    return {
      arxivId: props.arxiv_id?.String ?? "",
      chunkText: props.text?.String ?? "",
      sectionHeading: props.section_heading?.String ?? "",
      paperTitle: props.paper_title?.String ?? props.title?.String ?? "",
      similarity: r.similarity,
    };
  });
}
