import { homedir } from "node:os";
import { join } from "node:path";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";

export const CREDENTIAL_TOKEN_PREFIX = "siymcp_v1_";

export interface CredentialRecord {
  /** Full paste-back token including the `siymcp_v1_` prefix. */
  token: string;
  /** Free-form label shown in `whoami` (wallet address, email, etc). */
  label?: string;
  /** ISO-8601 timestamp the credential was written. */
  savedAt: string;
}

export interface CredentialStoreOptions {
  /** Override the directory where `credentials.json` lives. Default: `~/.siyuan-mcp`. */
  dir?: string;
}

function resolveDir(options?: CredentialStoreOptions): string {
  return options?.dir ?? join(homedir(), ".siyuan-mcp");
}

function resolvePath(options?: CredentialStoreOptions): string {
  return join(resolveDir(options), "credentials.json");
}

/**
 * Ensure the store dir exists with 0700 perms. Silently tightens perms on an
 * existing loose directory so callers can rely on the invariant.
 */
function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // On some filesystems chmod after mkdir is a no-op; ignore.
  }
}

/**
 * Validate that a string is a syntactically well-formed paste-back token.
 * Throws a descriptive Error otherwise. Does NOT verify the token against
 * the SiYuan server.
 */
export function assertValidToken(token: unknown): asserts token is string {
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("credential token must be a non-empty string");
  }
  if (!token.startsWith(CREDENTIAL_TOKEN_PREFIX)) {
    throw new Error(
      `credential token must start with '${CREDENTIAL_TOKEN_PREFIX}'`,
    );
  }
  if (token.length <= CREDENTIAL_TOKEN_PREFIX.length) {
    throw new Error("credential token is missing the KFDB api key body");
  }
}

/**
 * Strip the `siymcp_v1_` prefix and return the raw KFDB API key suitable for
 * use as `?kfdb_token=<value>`.
 */
export function extractApiKey(token: string): string {
  assertValidToken(token);
  return token.slice(CREDENTIAL_TOKEN_PREFIX.length);
}

/**
 * Read the credential file. Returns `null` if no credential has been saved.
 * Throws on malformed JSON.
 */
export function readCredential(
  options?: CredentialStoreOptions,
): CredentialRecord | null {
  const path = resolvePath(options);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const parsed = JSON.parse(raw) as Partial<CredentialRecord>;
  if (!parsed || typeof parsed.token !== "string") {
    throw new Error(`credential file at ${path} is missing 'token' field`);
  }
  if (typeof parsed.savedAt !== "string") {
    throw new Error(`credential file at ${path} is missing 'savedAt' field`);
  }
  return {
    token: parsed.token,
    savedAt: parsed.savedAt,
    label: parsed.label,
  };
}

/**
 * Atomically write the credential file with 0600 perms.
 *
 * Write sequence:
 *   1. Write to a sibling `credentials.json.<pid>.tmp` with mode 0600.
 *   2. `chmodSync` to re-assert 0600 in case umask dropped bits.
 *   3. `renameSync` over the final path (atomic on same filesystem).
 *
 * On error, the tempfile is best-effort cleaned up.
 */
export function writeCredential(
  record: Omit<CredentialRecord, "savedAt"> & { savedAt?: string },
  options?: CredentialStoreOptions,
): CredentialRecord {
  assertValidToken(record.token);

  const dir = resolveDir(options);
  const final = resolvePath(options);
  ensureDir(dir);

  const savedAt = record.savedAt ?? new Date().toISOString();
  const payload: CredentialRecord = {
    token: record.token,
    savedAt,
    ...(record.label ? { label: record.label } : {}),
  };

  const tmp = join(dir, `credentials.json.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(payload, null, 2), {
      mode: 0o600,
      flag: "w",
    });
    chmodSync(tmp, 0o600);
    renameSync(tmp, final);
    chmodSync(final, 0o600);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // ignore tempfile cleanup failures
    }
    throw err;
  }

  return payload;
}

/**
 * Delete the credential file. Idempotent — no error if it does not exist.
 */
export function deleteCredential(options?: CredentialStoreOptions): boolean {
  const path = resolvePath(options);
  try {
    rmSync(path, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Expose the resolved credential path. Useful for `whoami`-style commands.
 */
export function credentialPath(options?: CredentialStoreOptions): string {
  return resolvePath(options);
}

/**
 * Returns the Unix mode bits (e.g. 0o600) of the credential file, or null if
 * it does not exist. Intended for tests verifying the 0600 invariant.
 */
export function credentialMode(
  options?: CredentialStoreOptions,
): number | null {
  try {
    const st = statSync(resolvePath(options));
    return st.mode & 0o777;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}
