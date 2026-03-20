/**
 * Canonical Geo Knowledge Graph schema IDs for the Research ontology.
 * All IDs are dashless 32-char hex.
 */

// ── Canonical Entity Types ──────────────────────────────────────────────────
export const PAPER_TYPE = '5e24fb52856c4189a9716af4387b1b89';
export const CLAIM_TYPE = '96f859efa1ca4b229372c86ad58b694b';
export const PERSON_TYPE = '7ed45f2bc48b419e8e4664d5ff680b0d';
export const TOPIC_TYPE = '5ef5a5860f274d8e8f6c59ae5b3e89e2';
export const PROJECT_TYPE = '484a18c5030a499cb0f2ef588ff16d50';

// ── Paper Properties ────────────────────────────────────────────────────────
export const PAPER_PROPS = {
  abstract: '1d274ed52372471289614a50168a37aa',
  authors: '91a9e2f6e51a48f7997661de8561b690',
  publishedIn: '8b87530a67774d93a9aa8321b7f10019',
  publishDate: '94e43fe8faf241009eb887ab4f999723',
  webUrl: '412ff593e9154012a43d4c27ec5c68b6',
  tags: '257090341ba5406f94e4d4af90042fba',
  relatedTopics: '806d52bc27e94c9193c057978b093351',
  relatedSpaces: '5b722cd361d6494e88871310566437ba',
} as const;

// ── Claim Properties ────────────────────────────────────────────────────────
export const CLAIM_PROPS = {
  sources: '49c5d5e1679a4dbdbfd33f618f227c94',
  relatedTopics: '806d52bc27e94c9193c057978b093351',
  quotes: 'f9eeaf9d9eb741b1ac5d257c6e82e526',
  tags: '257090341ba5406f94e4d4af90042fba',
  supportingArguments: '1dc6a843458848198e7a6e672268f811',
  opposingArguments: '4e6ec5d14292498a84e5f607ca1a08ce',
  relatedPeople: '5df8e4329cc54f038f854ac82e157ada',
  relatedProjects: '6e3503fab974460ea3dbab8af9a41427',
  relatedSpaces: '5b722cd361d6494e88871310566437ba',
} as const;

// ── DAO Space ───────────────────────────────────────────────────────────────
export const DAO_SPACE_ID = '6b05a4fc85e69e56c15e2c6891e1df32';
export const DAO_SPACE_ADDRESS = '0xd3a0cce0d01214a1fc5cdedf8ca78bc1618f7c2f';

// ── UUID Helpers ────────────────────────────────────────────────────────────
export function toDashedUUID(hex: string): string {
  const h = hex.replace(/-/g, '');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function toDashlessUUID(dashed: string): string {
  return dashed.replace(/-/g, '');
}
