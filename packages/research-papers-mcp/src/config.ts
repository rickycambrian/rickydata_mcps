// Configuration — environment variables

export const KFDB_API_URL =
  process.env.KFDB_API_URL || "http://34.60.37.158";

export const KFDB_API_KEY =
  process.env.KFDB_API_KEY || "";

export const ARTIFACT_DIR =
  process.env.ARTIFACT_DIR || "~/.research-papers-mcp/artifacts/";

export const RESPONSE_MAX_LENGTH =
  parseInt(process.env.RESPONSE_MAX_LENGTH || "200000", 10);

export const ARXIV_RATE_LIMIT_MS =
  parseInt(process.env.ARXIV_RATE_LIMIT_MS || "3000", 10);
