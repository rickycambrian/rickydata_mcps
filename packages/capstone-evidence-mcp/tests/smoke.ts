import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleToolCall } from "../src/tools.js";

process.env.CAPSTONE_EVIDENCE_DIR ||= await mkdtemp(join(tmpdir(), "rickydata-capstone-evidence-smoke-"));

const write = await handleToolCall("evidence_write_artifact", {
  id: "smoke-hl-nvda",
  type: "hl_microstructure",
  title: "Smoke Hyperliquid NVDA Microstructure",
  sourceUrls: ["https://api.hyperliquid.xyz/info"],
  validationStatus: "local_smoke",
  limitations: ["Synthetic smoke artifact."],
  claims: [{ claim: "The evidence register can preserve source-linked dashboard inputs.", confidence: "high" }],
  data: { coin: "xyz:NVDA", spreadBps: 0.47 },
}) as any;
if (!write.success) throw new Error(`write smoke failed: ${JSON.stringify(write)}`);

const bundle = await handleToolCall("evidence_export_capstone_bundle", {}) as any;
if (!bundle.success || !bundle.claimRegister?.length) {
  throw new Error(`bundle smoke failed: ${JSON.stringify(bundle).slice(0, 500)}`);
}

console.log(JSON.stringify({
  ok: true,
  evidenceDir: process.env.CAPSTONE_EVIDENCE_DIR,
  artifactCount: bundle.artifacts.length,
  claimCount: bundle.claimRegister.length,
}, null, 2));
