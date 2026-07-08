import { createHash } from 'node:crypto';

export const HOME_NAMESPACE = '6f3a1e2c-9b47-5d8a-bc11-7e0f2a9d4c63';
export const RICKYDATA_GRAPH_NAMESPACE = '2f3e8ab8-8684-5c6a-9fd2-c5467b94251d';
export const RICKYDATA_GRAPH_SCHEMA_VERSION = 'rickydata.repo_execution_graph.v1';
const UNIT_SEPARATOR = '\u001f';

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/-/g, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToUuid(b: Uint8Array): string {
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0'));
  return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h.slice(6, 8).join('')}-${h
    .slice(8, 10)
    .join('')}-${h.slice(10, 16).join('')}`;
}

export function uuidv5(name: string, namespace = HOME_NAMESPACE): string {
  const ns = hexToBytes(namespace);
  const data = Buffer.concat([Buffer.from(ns), Buffer.from(name, 'utf8')]);
  const hash = createHash('sha1').update(data).digest();
  const bytes = new Uint8Array(hash.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return bytesToUuid(bytes);
}

export function deriveOpenQuestionId(sourceRef: string, question: string): string {
  const normalizedSource = sourceRef.trim();
  const normalizedQuestion = question.trim();
  if (!normalizedSource) throw new Error('OpenQuestion source_ref must not be empty');
  if (!normalizedQuestion) throw new Error('OpenQuestion question must not be empty');
  return uuidv5(
    `${RICKYDATA_GRAPH_SCHEMA_VERSION}:${['OpenQuestion', normalizedSource, normalizedQuestion].join(UNIT_SEPARATOR)}`,
    RICKYDATA_GRAPH_NAMESPACE,
  );
}

export function stableVoiceId(kind: string, parts: Array<string | undefined | null>): string {
  const clean = parts.map((p) => (p ?? '').trim()).join(UNIT_SEPARATOR);
  return uuidv5(`voice:${kind}:${clean}`);
}
