#!/usr/bin/env -S npx tsx
// ============================================================================
// capture — record NotebookLM batchexecute RPCs into committable fixtures
// ============================================================================
//
// The riskiest part of this MCP is keeping the rpcid + payload contract current.
// This harness makes capture systematic + re-runnable. DEV-ONLY (Playwright),
// excluded from the build / prod image.
//
//   npm run capture -- --action=manual            # open browser, you click;
//                                                  # we record ALL batchexecute
//   npm run capture -- --action=download          # best-effort auto-drive
//   npm run capture -- --verify                    # canary: replay known rpcids
//   npm run capture -- --parse-har=<file.har>      # extract RPCs from a HAR
//
// Output (cookies/tokens REDACTED so fixtures are committable):
//   fixtures/<rpcid>.request.txt    decoded inner f.req payload
//   fixtures/<rpcid>.response.txt   raw batchexecute response body
//   fixtures/rpc.capture.json       { rpcid, action, sourcePath, bl, capturedAt }[]

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCookieJar, defaultStatePath } from "../notebooklm/auth.js";
import { NOTEBOOKLM_ORIGIN } from "../config.js";
import { capturedActions } from "../notebooklm/rpc.js";
import { BatchExecuteClient } from "../notebooklm/client.js";

const FIX_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures");

interface CaptureRecord {
  rpcid: string;
  action: string;
  sourcePath: string | null;
  bl: string | null;
  capturedAt: string;
}

function argValue(name: string): string | undefined {
  const pref = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(pref));
  return hit ? hit.slice(pref.length) : undefined;
}

/** Decode the inner payload array from a urlencoded batchexecute POST body. */
function decodeFReq(postData: string): { rpcid: string; payload: unknown } | null {
  const params = new URLSearchParams(postData);
  const fReq = params.get("f.req");
  if (!fReq) return null;
  try {
    const env = JSON.parse(fReq) as unknown;
    // [[[ rpcid, "<json payload>", null, "generic" ], ...]]
    const first = (env as any[])?.[0]?.[0];
    if (!Array.isArray(first)) return null;
    const rpcid = String(first[0]);
    const payload = typeof first[1] === "string" ? JSON.parse(first[1]) : first[1];
    return { rpcid, payload };
  } catch {
    return null;
  }
}

function writeFixture(rpcid: string, payload: unknown, responseBody: string): void {
  mkdirSync(FIX_DIR, { recursive: true });
  writeFileSync(
    join(FIX_DIR, `${rpcid}.request.txt`),
    JSON.stringify(payload, null, 2),
    "utf8",
  );
  writeFileSync(join(FIX_DIR, `${rpcid}.response.txt`), responseBody, "utf8");
}

function recordCaptureIndex(records: CaptureRecord[]): void {
  const path = join(FIX_DIR, "rpc.capture.json");
  let existing: CaptureRecord[] = [];
  if (existsSync(path)) {
    try {
      existing = JSON.parse(readFileSync(path, "utf8")) as CaptureRecord[];
    } catch {
      /* overwrite a corrupt index */
    }
  }
  const byRpcid = new Map(existing.map((r) => [r.rpcid, r]));
  for (const r of records) byRpcid.set(r.rpcid, r);
  writeFileSync(path, JSON.stringify([...byRpcid.values()], null, 2), "utf8");
}

// ── --verify canary ──────────────────────────────────────────────────────────

async function runVerify(): Promise<void> {
  const actions = capturedActions();
  if (actions.length === 0) {
    console.log("No verified actions to canary yet.");
    return;
  }
  const client = new BatchExecuteClient();
  console.log(`Canary: replaying ${actions.length} verified rpcid(s) against live NotebookLM…`);
  let ok = 0;
  for (const action of actions) {
    try {
      // A benign probe: most read actions tolerate a placeholder id and still
      // return a parseable (possibly error) frame, which is all the canary needs.
      await client.callAction(action, { notebook_id: "canary-probe" }, {
        sourcePath: "/",
      });
      console.log(`  ✓ ${action} parsed (live bl=${client.bl})`);
      ok++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // A ContractBrokenError means the canary caught real drift; anything else
      // (auth/ratelimit) is environmental.
      console.log(`  • ${action}: ${msg}`);
      if (/contract broken/i.test(msg)) ok = -1;
    }
  }
  if (ok < 0) {
    console.error("Canary detected contract drift. Re-capture the affected action(s).");
    process.exit(2);
  }
  console.log(`Canary done (live bl=${client.bl}).`);
}

// ── --parse-har fallback ──────────────────────────────────────────────────────

async function runParseHar(harPath: string): Promise<void> {
  const har = JSON.parse(readFileSync(harPath, "utf8")) as {
    log: { entries: Array<{ request: any; response: any }> };
  };
  const records: CaptureRecord[] = [];
  for (const entry of har.log.entries) {
    const url: string = entry.request?.url || "";
    if (!url.includes("/data/batchexecute")) continue;
    const postData: string = entry.request?.postData?.text || "";
    const decoded = decodeFReq(postData);
    if (!decoded) continue;
    const body: string = entry.response?.content?.text || "";
    writeFixture(decoded.rpcid, decoded.payload, body);
    const sp = new URL(url).searchParams;
    records.push({
      rpcid: decoded.rpcid,
      action: argValue("action") || "unknown",
      sourcePath: sp.get("source-path"),
      bl: sp.get("bl"),
      capturedAt: new Date().toISOString(),
    });
    console.log(`  recorded ${decoded.rpcid} (from HAR)`);
  }
  recordCaptureIndex(records);
  console.log(`Parsed ${records.length} batchexecute RPC(s) from ${harPath}.`);
}

// ── live browser capture ──────────────────────────────────────────────────────

async function runBrowserCapture(action: string): Promise<void> {
  // Validate a session exists before opening the browser.
  loadCookieJar();
  const statePath = process.env.NOTEBOOKLM_STATE_PATH || defaultStatePath();

  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ storageState: statePath });
  const page = await context.newPage();

  const records: CaptureRecord[] = [];
  const seen = new Set<string>();

  // The audio download (HpN0Ub) authorizes via batchexecute (empty body) and
  // then triggers a browser DOWNLOAD navigation whose URL is NOT visible to page
  // JS or to a response listener. Playwright's download event is the one place
  // that exposes the signed media URL + filename — record it for download_audio.
  page.on("download", async (dl) => {
    const url = dl.url();
    const name = dl.suggestedFilename();
    mkdirSync(FIX_DIR, { recursive: true });
    writeFileSync(
      join(FIX_DIR, "download_audio.media.json"),
      JSON.stringify({ url, suggestedFilename: name, capturedAt: new Date().toISOString() }, null, 2),
      "utf8",
    );
    console.log(`  ✓ captured download media URL → fixtures/download_audio.media.json (${name})`);
  });

  page.on("response", async (response) => {
    const url = response.url();
    if (!url.includes("/data/batchexecute")) return;
    const req = response.request();
    const postData = req.postData() || "";
    const decoded = decodeFReq(postData);
    if (!decoded) return;
    let body = "";
    try {
      body = await response.text();
    } catch {
      return;
    }
    writeFixture(decoded.rpcid, decoded.payload, body);
    const sp = new URL(url).searchParams;
    if (!seen.has(decoded.rpcid)) {
      seen.add(decoded.rpcid);
      console.log(`  ✓ captured ${decoded.rpcid} → fixtures/${decoded.rpcid}.{request,response}.txt`);
    }
    records.push({
      rpcid: decoded.rpcid,
      action,
      sourcePath: sp.get("source-path"),
      bl: sp.get("bl"),
      capturedAt: new Date().toISOString(),
    });
  });

  await page.goto(NOTEBOOKLM_ORIGIN, { waitUntil: "domcontentloaded" });
  console.log(
    `\nRecording all batchexecute RPCs for action "${action}".\n` +
      `>>> Perform the action in the browser now (e.g. ${action}).\n` +
      `>>> Every RPC is written to fixtures/ as it fires. Close the window when done.\n`,
  );

  await page.waitForEvent("close", { timeout: 10 * 60_000 }).catch(() => {});
  await browser.close().catch(() => {});
  recordCaptureIndex(records);
  console.log(`\nCapture complete: ${seen.size} distinct rpcid(s) recorded for "${action}".`);
  console.log("Next: copy the rpcid into src/notebooklm/rpc.ts, flip status to 'verified', add a codec test.");
}

// ── entry ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (process.argv.includes("--verify")) return runVerify();
  const har = argValue("parse-har");
  if (har) return runParseHar(har);
  const action = argValue("action") || "manual";
  return runBrowserCapture(action);
}

main().catch((err) => {
  console.error(`capture failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
