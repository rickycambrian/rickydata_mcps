import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

interface EvidenceArtifact {
  id: string;
  type: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  sourceUrls: string[];
  sourceSystem?: string;
  validationStatus?: string;
  limitations: string[];
  claims: EvidenceClaim[];
  data: unknown;
  dataSha256: string;
}

interface EvidenceClaim {
  claim: string;
  sourceUrls?: string[];
  artifactIds?: string[];
  confidence?: string;
  limitation?: string;
}

export const TOOLS: Tool[] = [
  {
    name: "evidence_write_artifact",
    description: "Write a compact local evidence artifact with source URLs, claims, data hash, and limitations.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Optional stable artifact id." },
        type: { type: "string", description: "Artifact type, e.g. sec_pack, macro_snapshot, hl_microstructure." },
        title: { type: "string", description: "Human-readable title." },
        sourceUrls: { type: "array", items: { type: "string" } },
        sourceSystem: { type: "string" },
        validationStatus: { type: "string" },
        limitations: { type: "array", items: { type: "string" } },
        claims: { type: "array", items: { type: "object" } },
        data: { description: "Arbitrary compact JSON-serializable evidence data." },
      },
      required: ["type", "title", "data"],
    },
  },
  {
    name: "evidence_list_artifacts",
    description: "List local capstone evidence artifacts.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", description: "Optional artifact type filter." },
      },
    },
  },
  {
    name: "evidence_get_artifact",
    description: "Fetch a local evidence artifact by id.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Artifact id." },
      },
      required: ["id"],
    },
  },
  {
    name: "evidence_build_claim_register",
    description: "Build a claim register across all local evidence artifacts.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", description: "Optional artifact type filter." },
      },
    },
  },
  {
    name: "evidence_export_capstone_bundle",
    description: "Export a compact bundle containing artifacts, claim register, and source index.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", description: "Optional artifact type filter." },
      },
    },
  },
];

export async function handleToolCall(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    if (name === "evidence_write_artifact") {
      return await writeArtifact({
        id: optionalString(args.id),
        type: String(args.type || ""),
        title: String(args.title || ""),
        sourceUrls: stringArrayArg(args.sourceUrls) || [],
        sourceSystem: optionalString(args.sourceSystem),
        validationStatus: optionalString(args.validationStatus),
        limitations: stringArrayArg(args.limitations) || [],
        claims: claimArrayArg(args.claims),
        data: args.data,
      });
    }
    if (name === "evidence_list_artifacts") return await listArtifacts(optionalString(args.type));
    if (name === "evidence_get_artifact") return await getArtifact(String(args.id || ""));
    if (name === "evidence_build_claim_register") return await buildClaimRegister(optionalString(args.type));
    if (name === "evidence_export_capstone_bundle") return await exportCapstoneBundle(optionalString(args.type));
    return { success: false, error: `Unknown tool: ${name}` };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function writeArtifact(input: {
  id?: string;
  type: string;
  title: string;
  sourceUrls: string[];
  sourceSystem?: string;
  validationStatus?: string;
  limitations: string[];
  claims: EvidenceClaim[];
  data: unknown;
}) {
  if (!input.type.trim()) throw new Error("type is required");
  if (!input.title.trim()) throw new Error("title is required");
  if (input.data === undefined) throw new Error("data is required");
  const now = new Date().toISOString();
  const id = sanitizeId(input.id || `${input.type}-${randomUUID()}`);
  const existing = await readArtifactFile(id).catch(() => null);
  const dataSha256 = sha256(stableJson(input.data));
  const artifact: EvidenceArtifact = {
    id,
    type: input.type,
    title: input.title,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    sourceUrls: input.sourceUrls,
    sourceSystem: input.sourceSystem,
    validationStatus: input.validationStatus,
    limitations: input.limitations,
    claims: input.claims,
    data: input.data,
    dataSha256,
  };
  await ensureDir();
  const path = artifactPath(id);
  await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return { success: true, id, path, dataSha256, artifact };
}

export async function listArtifacts(type?: string) {
  await ensureDir();
  const files = (await readdir(evidenceDir())).filter((file) => file.endsWith(".json"));
  const artifacts = await Promise.all(files.map((file) => readArtifactFile(file.replace(/\.json$/, ""))));
  const filtered = type ? artifacts.filter((artifact) => artifact.type === type) : artifacts;
  return {
    success: true,
    evidenceDir: evidenceDir(),
    count: filtered.length,
    artifacts: filtered.map(({ data, ...summary }) => summary),
  };
}

export async function getArtifact(id: string) {
  if (!id.trim()) throw new Error("id is required");
  const artifact = await readArtifactFile(sanitizeId(id));
  return { success: true, evidenceDir: evidenceDir(), artifact };
}

export async function buildClaimRegister(type?: string) {
  await ensureDir();
  const list = await listArtifacts(type) as any;
  const artifacts: EvidenceArtifact[] = await Promise.all(list.artifacts.map((summary: any) => readArtifactFile(summary.id)));
  const claims = artifacts.flatMap((artifact: EvidenceArtifact) => artifact.claims.map((claim: EvidenceClaim, index: number) => ({
    id: `${artifact.id}#claim-${index + 1}`,
    artifactId: artifact.id,
    artifactTitle: artifact.title,
    artifactType: artifact.type,
    claim: claim.claim,
    sourceUrls: claim.sourceUrls?.length ? claim.sourceUrls : artifact.sourceUrls,
    confidence: claim.confidence,
    limitation: claim.limitation,
    validationStatus: artifact.validationStatus,
    dataSha256: artifact.dataSha256,
  })));
  return { success: true, generatedAt: new Date().toISOString(), count: claims.length, claims };
}

export async function exportCapstoneBundle(type?: string) {
  await ensureDir();
  const list = await listArtifacts(type) as any;
  const artifacts = await Promise.all(list.artifacts.map((summary: any) => readArtifactFile(summary.id)));
  const claimRegister = await buildClaimRegister(type) as any;
  const sourceIndex = [...new Set(artifacts.flatMap((artifact) => artifact.sourceUrls))].map((url) => ({
    url,
    artifactIds: artifacts.filter((artifact) => artifact.sourceUrls.includes(url)).map((artifact) => artifact.id),
  }));
  return {
    success: true,
    generatedAt: new Date().toISOString(),
    evidenceDir: evidenceDir(),
    artifacts,
    claimRegister: claimRegister.claims,
    sourceIndex,
  };
}

function evidenceDir(): string {
  return process.env.CAPSTONE_EVIDENCE_DIR || join(tmpdir(), "rickydata-capstone-evidence");
}

async function ensureDir(): Promise<void> {
  await mkdir(evidenceDir(), { recursive: true });
}

function artifactPath(id: string): string {
  return join(evidenceDir(), `${sanitizeId(id)}.json`);
}

async function readArtifactFile(id: string): Promise<EvidenceArtifact> {
  const text = await readFile(artifactPath(id), "utf8");
  return JSON.parse(text) as EvidenceArtifact;
}

function sanitizeId(id: string): string {
  return id.trim().replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 160);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => [key, sortJson(nested)]));
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArrayArg(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function claimArrayArg(value: unknown): EvidenceClaim[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item) => ({
      claim: String(item.claim || ""),
      sourceUrls: stringArrayArg(item.sourceUrls),
      artifactIds: stringArrayArg(item.artifactIds),
      confidence: optionalString(item.confidence),
      limitation: optionalString(item.limitation),
    }))
    .filter((claim) => claim.claim.trim().length > 0);
}
