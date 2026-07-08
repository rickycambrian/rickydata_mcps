import { deriveOpenQuestionId, stableVoiceId } from './ids.js';

type WrappedValue =
  | { String: string }
  | { Integer: number }
  | { Float: number }
  | { Boolean: boolean }
  | { Null: null };

const s = (v: string): { String: string } => ({ String: v });
const i = (v: number): { Integer: number } => ({ Integer: Math.trunc(v) });
const f = (v: number): { Float: number } => ({ Float: v });

export interface WriteRequest {
  operations: Array<Record<string, unknown>>;
  skip_embedding?: boolean;
}

export interface OpenQuestionCaptureInput {
  question: string;
  whyItMatters: string;
  category: string;
  now?: string;
}

export function buildOpenQuestionCapture(input: OpenQuestionCaptureInput): WriteRequest & { nodeId: string; sourceRef: string } {
  const question = input.question.trim();
  const category = input.category.trim() || 'clarification';
  const why = input.whyItMatters.trim();
  if (!question) throw new Error('question is required');
  if (!why) throw new Error('why_it_matters is required');
  const now = input.now ?? new Date().toISOString();
  const sourceRef = `voice-open-question:${category}`;
  const nodeId = deriveOpenQuestionId(sourceRef, question);
  return {
    nodeId,
    sourceRef,
    operations: [
      {
        operation: 'create_node',
        id: nodeId,
        label: 'OpenQuestion',
        mode: 'merge',
        properties: {
          question: s(question),
          category: s(category),
          topic: s(category),
          why_it_matters: s(why),
          priority: i(8),
          answer: s(''),
          status: s('open'),
          scope: s('private'),
          source_ref: s(sourceRef),
          created_by: s('voice-agent'),
          confidence: f(0.9),
          valid_from: s(now),
          valid_to: { Null: null },
          superseded_by: { Null: null },
          origin: s('voice'),
          asked_by: s('rickydata-knowledge-partner'),
          created_at: s(now),
          updated_at: s(now),
          rickydata_memory_schema_version: s('rickydata.memory.v1'),
          rickydata_memory_kind: s('OpenQuestion'),
        } satisfies Record<string, WrappedValue>,
      },
    ],
    skip_embedding: true,
  };
}

export interface DiscoveryCaptureInput {
  idea: string;
  sessionId?: string;
  now?: string;
}

export function buildDiscoveryCapture(input: DiscoveryCaptureInput): WriteRequest & { nodeId: string } {
  const idea = input.idea.trim();
  if (!idea) throw new Error('idea is required');
  const now = input.now ?? new Date().toISOString();
  const nodeId = stableVoiceId('discovery', [input.sessionId, idea]);
  return {
    nodeId,
    operations: [
      {
        operation: 'create_node',
        id: nodeId,
        label: 'Discovery',
        mode: 'merge',
        properties: {
          discovery_id: s(nodeId),
          finding: s(idea),
          source: s('voice'),
          source_ref: s(`voice:${input.sessionId?.trim() || nodeId}`),
          origin: s('voice'),
          session_id: s(input.sessionId?.trim() || ''),
          created_at: s(now),
          updated_at: s(now),
        } satisfies Record<string, WrappedValue>,
      },
    ],
    skip_embedding: true,
  };
}
