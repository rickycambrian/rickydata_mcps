#!/usr/bin/env -S npx tsx
// One-off probe: discover how NotebookLM delivers the Audio Overview bytes.
// Clicks ⋮ → Download in the Studio panel and captures Playwright's download
// event (download.url() / suggestedFilename()) — the one place the signed media
// URL is exposed. Also logs the request/response of any media navigation.
//
//   npx tsx src/dev/probe-download.ts <notebookId>
//
// DEV-ONLY (excluded from the build). Writes findings to fixtures/download_audio.probe.json.

import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultStatePath } from "../notebooklm/auth.js";
import { NOTEBOOKLM_ORIGIN } from "../config.js";

const FIX_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures");

async function main() {
  const notebookId = process.argv[2];
  if (!notebookId) throw new Error("usage: probe-download.ts <notebookId>");
  const statePath = process.env.NOTEBOOKLM_STATE_PATH || defaultStatePath();

  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ storageState: statePath, acceptDownloads: true });
  const page = await context.newPage();

  const findings: Record<string, unknown> = { notebookId };

  page.on("download", (dl) => {
    findings.download = { url: dl.url(), suggestedFilename: dl.suggestedFilename() };
    console.log(`\n✓ DOWNLOAD EVENT: ${dl.suggestedFilename()}\n  url: ${dl.url()}\n`);
  });
  // Also log any media-looking response just in case it streams via fetch.
  page.on("response", (r) => {
    const u = r.url();
    if (/\.(mp3|m4a|aac|ogg)(\?|$)|audiocontent|getaudio|download/i.test(u)) {
      console.log(`  [media response] ${r.status()} ${u.slice(0, 160)}`);
    }
  });

  console.log(`Opening /notebook/${notebookId} …`);
  // NotebookLM holds a persistent SSE connection, so "networkidle"/"load" never
  // settle and even "domcontentloaded" can stall behind the headless interstitial.
  // Use "commit" (navigation committed) + an explicit settle wait instead.
  await page.goto(`${NOTEBOOKLM_ORIGIN}/notebook/${notebookId}`, {
    waitUntil: "commit",
    timeout: 60_000,
  });
  await page.waitForSelector('[role="tabpanel"], studio-panel, .studio-panel', { timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(4000);

  // Ensure the Studio tab is active (2026-06 tabbed layout).
  for (const sel of ['[role="tab"]:has-text("Studio")', '.mat-mdc-tab-list .mdc-tab:nth-child(3)']) {
    const tab = page.locator(sel).first();
    if (await tab.count().catch(() => 0)) {
      await tab.click().catch(() => {});
      await page.waitForTimeout(800);
      break;
    }
  }

  // Find the audio artifact row's overflow (⋮) button, then the Download item.
  const overflowSelectors = [
    'button[aria-label*="More" i]',
    'button[aria-label*="more" i]',
    'artifact-library-item button[aria-label*="More" i]',
    '[role="tabpanel"] button:has(mat-icon:has-text("more_vert"))',
  ];
  let opened = false;
  for (const sel of overflowSelectors) {
    const btns = page.locator(sel);
    const n = await btns.count().catch(() => 0);
    if (n > 0) {
      await btns.last().click().catch(() => {});
      await page.waitForTimeout(700);
      const dl = page.locator('[role="menuitem"]:has-text("Download"), button:has-text("Download")').first();
      if (await dl.count().catch(() => 0)) {
        console.log(`Clicking Download (overflow via ${sel}) …`);
        await dl.click().catch(() => {});
        opened = true;
        break;
      }
      // close stray menu
      await page.keyboard.press("Escape").catch(() => {});
    }
  }
  if (!opened) {
    findings.note = "Could not locate the overflow/Download control — capture the DOM and update selectors.";
    console.log("⚠️  Could not find ⋮ → Download. Dumping studio panel buttons for reference.");
    const labels = await page.locator('[role="tabpanel"] button').evaluateAll(
      (els) => els.map((e) => (e as HTMLElement).getAttribute("aria-label") || (e as HTMLElement).innerText).slice(0, 30),
    ).catch(() => []);
    findings.studioButtons = labels;
  }

  // Wait for the download event (or timeout).
  await page.waitForTimeout(8000);

  mkdirSync(FIX_DIR, { recursive: true });
  writeFileSync(join(FIX_DIR, "download_audio.probe.json"), JSON.stringify(findings, null, 2));
  console.log("\nFindings → fixtures/download_audio.probe.json");
  console.log(JSON.stringify(findings, null, 2));
  await browser.close();
}

main().catch((e) => {
  console.error("probe failed:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
