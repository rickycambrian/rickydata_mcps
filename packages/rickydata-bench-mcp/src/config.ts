// ============================================================================
// CONFIGURATION — environment variables
// ============================================================================

export const BENCH_API_URL =
  process.env.BENCH_API_URL || "https://benchmarks.rickydata.org";

export const RESPONSE_MAX_LENGTH = parseInt(
  process.env.RESPONSE_MAX_LENGTH || "200000",
  10,
);
