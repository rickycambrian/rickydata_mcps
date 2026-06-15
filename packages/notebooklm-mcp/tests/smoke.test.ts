import { existsSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { defaultStatePath } from "../src/notebooklm/auth.js";
import { getHealthInfo } from "../src/tools.js";

// Real end-to-end probe against live NotebookLM. Skipped unless a session is
// available (NOTEBOOKLM_COOKIES / NOTEBOOKLM_STATE_B64 / local state.json), so
// CI (no session) skips it entirely.
const hasSession =
  !!process.env.NOTEBOOKLM_COOKIES ||
  !!process.env.NOTEBOOKLM_STATE_B64 ||
  existsSync(process.env.NOTEBOOKLM_STATE_PATH || defaultStatePath());

describe.skipIf(!hasSession)("live smoke (session present)", () => {
  it("getHealthInfo(probe) confirms the session bootstraps server-side", async () => {
    // Exercises cookie load → SAPISIDHASH → authenticated GET → WIZ token parse.
    const health = await getHealthInfo(true);
    // Either authenticated (live bl present) or a clear expired signal — never
    // a thrown raw error.
    expect(["authenticated", "expired"]).toContain(health.auth);
    if (health.auth === "authenticated") {
      expect(health.live_bl).toBeTruthy();
    }
  }, 30_000);
});
