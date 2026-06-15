#!/usr/bin/env -S npx tsx
// ============================================================================
// connect — one-time Google login → saved session (DEV-ONLY, Playwright)
// ============================================================================
//
//   npx @rickydata/notebooklm-mcp connect            # local: writes state.json
//   npx @rickydata/notebooklm-mcp connect --deploy   # + upload to gateway vault
//
// Opens a visible browser, waits for you to log into Google + NotebookLM,
// captures the Playwright storageState, filters it to the critical Google auth
// cookies, and either writes it locally or uploads it as the encrypted
// per-wallet vault secret NOTEBOOKLM_STATE_B64 (sharing policy `isolated`) under
// the established notebook-studio serverId — the SAME secret the RPC runtime
// reads, so this is a drop-in replacement for the DOM-scraping connect flow.
//
// This file lives under src/dev and is excluded from the tsc build / prod image
// (runtime is pure fetch). It is run directly via tsx.

import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { CRITICAL_COOKIE_NAMES, defaultStatePath } from "../notebooklm/auth.js";
import {
  GATEWAY_URL,
  GATEWAY_TOKEN,
  VAULT_SERVER_ID,
  VAULT_SECRET_NAME,
  NOTEBOOKLM_ORIGIN,
} from "../config.js";

const CRITICAL = new Set<string>(CRITICAL_COOKIE_NAMES);
// Also keep the API-signing siblings (used for SAPISIDHASH 1P/3P variants).
const KEEP = new Set<string>([
  ...CRITICAL_COOKIE_NAMES,
  "__Secure-1PAPISID",
  "__Secure-3PAPISID",
  "SIDCC",
  "__Secure-1PSIDCC",
  "__Secure-3PSIDCC",
  "NID",
]);

async function uploadToVault(stateJson: string): Promise<void> {
  if (!GATEWAY_TOKEN) {
    throw new Error(
      "GATEWAY_TOKEN is required for --deploy (the wallet session token). Run `rickydata auth login` and export its token, or omit --deploy for a local session.",
    );
  }
  const b64 = Buffer.from(stateJson).toString("base64");
  const res = await fetch(`${GATEWAY_URL}/api/secrets/${VAULT_SERVER_ID}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GATEWAY_TOKEN}`,
      "Content-Type": "application/json",
    },
    // Matches SecretsManager.store(): { secrets: { <KEY>: <value> } }. The
    // gateway stores it AES-256-GCM, isolated per wallet, and injects it as
    // NOTEBOOKLM_STATE_B64 into this wallet's container env at runtime.
    body: JSON.stringify({ secrets: { [VAULT_SECRET_NAME]: b64 } }),
  });
  if (!res.ok) {
    throw new Error(`Vault upload failed (${res.status}): ${await res.text()}`);
  }
}

async function main(): Promise<void> {
  const deploy = process.argv.includes("--deploy");
  const statePath = process.env.NOTEBOOKLM_STATE_PATH || defaultStatePath();

  // Playwright is a devDependency — import lazily so a prod/runtime context
  // (which never calls connect) doesn't need it installed.
  const { chromium } = await import("playwright");

  console.log("Opening a browser for Google login…");
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(NOTEBOOKLM_ORIGIN, { waitUntil: "domcontentloaded" });

  console.log(
    "\n>>> Log into your Google account and open NotebookLM in the window.\n" +
      ">>> Waiting until you reach notebooklm.google.com (up to 5 minutes)…\n",
  );

  // Wait until we're on the authenticated NotebookLM origin (not the login flow).
  const deadline = Date.now() + 5 * 60_000;
  let authed = false;
  while (Date.now() < deadline) {
    const url = page.url();
    if (/notebooklm\.google\.com/.test(url) && !/accounts\.google\.com/.test(url)) {
      // Confirm at least one critical cookie is present.
      const cookies = await context.cookies();
      if (cookies.some((c) => CRITICAL.has(c.name))) {
        authed = true;
        break;
      }
    }
    await page.waitForTimeout(2000);
  }

  if (!authed) {
    await browser.close();
    throw new Error("Timed out waiting for login. Re-run connect and finish the Google login.");
  }

  // Capture full storageState, then filter cookies to the Google auth set.
  const full = await context.storageState();
  const filtered = {
    ...full,
    cookies: (full.cookies || []).filter(
      (c) => c.domain.includes("google.com") && KEEP.has(c.name),
    ),
  };
  await browser.close();

  const stateJson = JSON.stringify(filtered);
  const critPresent = filtered.cookies.filter((c) => CRITICAL.has(c.name)).length;
  console.log(`Captured ${filtered.cookies.length} cookies (${critPresent}/${CRITICAL.size} critical).`);

  if (deploy) {
    await uploadToVault(stateJson);
    console.log(
      `✅ Uploaded encrypted session to the gateway vault (serverId=${VAULT_SERVER_ID}, key=${VAULT_SECRET_NAME}, isolated).`,
    );
  } else {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, stateJson, "utf8");
    console.log(`✅ Wrote local session to ${statePath}`);
  }
  console.log("NotebookLM is connected. The RPC server can now drive it.");
}

// Allow `connect --from-state <path> --deploy` to upload an already-captured
// state.json without re-opening a browser (CI / headless re-upload).
async function fromState(): Promise<boolean> {
  const idx = process.argv.indexOf("--from-state");
  if (idx === -1) return false;
  const path = process.argv[idx + 1];
  if (!path) throw new Error("--from-state requires a path to a state.json");
  const stateJson = readFileSync(path, "utf8");
  await uploadToVault(stateJson);
  console.log(`✅ Uploaded ${path} to the gateway vault (serverId=${VAULT_SERVER_ID}).`);
  return true;
}

fromState()
  .then((handled) => (handled ? undefined : main()))
  .catch((err) => {
    console.error(`connect failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
