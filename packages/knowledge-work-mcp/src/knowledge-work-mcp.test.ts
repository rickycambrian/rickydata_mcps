import { describe, expect, it, vi } from 'vitest';
import { buildDiscoveryCapture, buildOpenQuestionCapture } from './atoms.js';
import { ApiError, FailClosedError } from './errors.js';
import { HomeKnowledgeClient } from './home-client.js';
import { KfdbKnowledgeClient, RECENT_ACTIVITY_SOURCE_LABELS } from './kfdb-client.js';
import { deriveOpenQuestionId } from './ids.js';
import { capKnowledgeBundleArgs, recentActivityRequest, resolveNextQuestions, resolveReviewPending, resolveSessionBrief, resolveTrace, reviewPendingFallbackFromQuestions, shouldPreferKfdbTrace, shouldUseKfdbTraceFallback, TRACE_KIND_DESCRIPTION, TRACE_TOOL_DESCRIPTION, withAssertionVoiceAnswer } from './tools.js';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, ...init, headers: { 'content-type': 'application/json' } });
}

describe('trace tool guidance', () => {
  it('advertises exact lifecycle subjects that Home can trace', () => {
    expect(TRACE_TOOL_DESCRIPTION).toContain('operator request');
    expect(TRACE_TOOL_DESCRIPTION).toContain('chat session');
    expect(TRACE_KIND_DESCRIPTION).toContain('operator-request');
    expect(TRACE_KIND_DESCRIPTION).toContain('chat-session');
  });
});

describe('home auth fail-closed', () => {
  it('uses an injected gateway JWT without requiring the legacy wallet signer', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ results: [] }));
    const mintToken = vi.fn().mockRejectedValue(new Error('legacy mint must not run'));
    const home = new HomeKnowledgeClient({
      baseUrl: 'https://home.test',
      signer: null,
      gatewayJwt: 'gateway.jwt.token',
      mintToken,
      s2d: {
        ensure: async () => ({ sessionId: 's2d-session', keyHex: 'a'.repeat(64), walletAddress: '0x1111111111111111111111111111111111111111' }),
      },
      fetchImpl,
    });

    await home.wikiSearch('hitl');

    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect(init.headers).toMatchObject({ authorization: 'Bearer gateway.jwt.token' });
    expect(mintToken).not.toHaveBeenCalled();
  });

  it('prefers the injected gateway JWT over legacy scwt_ minting when both are configured', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ results: [] }));
    const mintToken = vi.fn().mockResolvedValue('scwt_legacy');
    const home = new HomeKnowledgeClient({
      baseUrl: 'https://home.test',
      signer: { address: '0x1111111111111111111111111111111111111111', signMessage: async () => '0xsig' },
      gatewayJwt: 'gateway.jwt.token',
      mintToken,
      s2d: {
        ensure: async () => ({ sessionId: 's2d-session', keyHex: 'a'.repeat(64), walletAddress: '0x1111111111111111111111111111111111111111' }),
      },
      fetchImpl,
    });

    await home.wikiSearch('hitl');

    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect(init.headers).toMatchObject({ authorization: 'Bearer gateway.jwt.token' });
    expect(mintToken).not.toHaveBeenCalled();
  });

  it('refuses home-backed tools before fetch when no signer is configured', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const home = new HomeKnowledgeClient({ baseUrl: 'https://home.test', signer: null, fetchImpl });

    await expect(home.wikiSearch('hitl')).rejects.toBeInstanceOf(FailClosedError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses home-backed tools before fetch when no S2D session provider is configured', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const home = new HomeKnowledgeClient({
      baseUrl: 'https://home.test',
      signer: { address: '0x1111111111111111111111111111111111111111', signMessage: async () => '0xsig' },
      mintToken: async () => 'scwt_test',
      s2d: null,
      fetchImpl,
    });

    await expect(home.wikiSearch('hitl')).rejects.toBeInstanceOf(FailClosedError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('falls back to legacy scwt_ minting and adds S2D headers', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ results: [] }));
    const home = new HomeKnowledgeClient({
      baseUrl: 'https://home.test',
      signer: { address: '0x1111111111111111111111111111111111111111', signMessage: async () => '0xsig' },
      mintToken: async () => 'scwt_test',
      s2d: {
        ensure: async () => ({ sessionId: 's2d-session', keyHex: 'a'.repeat(64), walletAddress: '0x1111111111111111111111111111111111111111' }),
      },
      fetchImpl,
    });

    await home.wikiSearch('hitl');
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect(init.headers).toMatchObject({
      authorization: 'Bearer scwt_test',
      'x-derive-session-id': 's2d-session',
      'x-derive-key': 'a'.repeat(64),
    });
  });
});

describe('KFDB read/write auth split', () => {
  it('pins recent activity to an explicit UTC projection clock', () => {
    expect(recentActivityRequest({
      hours: 24,
      limit: 100,
      asOf: '2026-07-20T02:31:04.123Z',
    })).toEqual({
      hours: 24,
      limit: 100,
      now: new Date('2026-07-20T02:31:04.123Z'),
    });
    expect(recentActivityRequest({ hours: 24, limit: 100 })).toEqual({ hours: 24, limit: 100 });
    expect(() => recentActivityRequest({ hours: 24, limit: 100, asOf: 'not-a-time' }))
      .toThrow('recent_activity as_of value is invalid');
  });

  it('keeps the verified knowledge bundle as the primary session brief', async () => {
    const bundle = { pages: [{ slug: 'authority' }], claims: [{ verified: true }], reproducibility_hash: 'bundle-hash' };
    const reader = {
      knowledgeBundle: vi.fn().mockResolvedValue(bundle),
      recentActivity: vi.fn(),
    };

    await expect(resolveSessionBrief(reader)).resolves.toBe(bundle);
    expect(reader.knowledgeBundle).toHaveBeenCalledWith({
      token_budget: 2500,
      page_limit: 8,
      claim_limit: 20,
      include_questions: true,
      question_limit: 12,
    });
    expect(reader.recentActivity).not.toHaveBeenCalled();
  });

  it('keeps session_brief useful with an honest chronological fallback when the bundle endpoint is unavailable', async () => {
    const recent = {
      schema: 'rickydata.recent-activity.v1',
      counts: { DEV: 2, PROOF: 1, KNOWLEDGE: 1, LEARN: 3, MEDIA: 2 },
      complete: false,
      omissions: ['WikiPage: 503'],
      reproducibility_hash: 'receipt-hash',
    };
    const reader = {
      knowledgeBundle: vi.fn().mockRejectedValue(new Error('overloaded')),
      recentActivity: vi.fn().mockResolvedValue(recent),
    };

    await expect(resolveSessionBrief(reader)).resolves.toEqual(expect.objectContaining({
      status: 'partial',
      recent_activity: recent,
      reproducibility_hash: 'receipt-hash',
      diagnostics: expect.objectContaining({
        source_coverage: 'partial',
        knowledge_bundle_status: 'temporarily_unavailable',
        fallback: 'recent_activity',
      }),
    }));
    expect(reader.recentActivity).toHaveBeenCalledWith({ hours: 24, limit: 24 });
  });

  it('projects exact recent activity with provenance, partial-source status, and a stable receipt', async () => {
    const rowsByLabel: Record<string, Array<Record<string, unknown>>> = {
      RickydataGitCommit: [{
        _id: 'git-1', commit_sha: '457d238', repo_id: 'rickydata_home',
        subject: 'Keep partner authority wallet-scoped', committed_at: '2026-07-13T11:05:00.000Z',
      }],
      RickydataDevelopmentEpisode: [{
        _id: 'episode-1', episode_id: 'episode-1', commit_sha: '457d238', repo_id: 'rickydata_home',
        title: 'Knowledge Partner authority', implementation_summary: 'Separated billing from data authority.',
        occurred_at: '2026-07-13T11:06:00.000Z',
      }],
      RickydataChangeEvidence: [{
        _id: 'change-1', title: 'Partner authority landed', summary: 'Wallet-scoped MCP reads are live.',
        repo_id: 'mcp_deployments_registry', commit_sha: '607c4c491', created_at: '2026-07-13T11:00:00.000Z',
      }],
      EvidenceRecord: [{
        _id: 'proof-1', evidence_record_id: 'proof-1', roadmap_item_id: 'partner-authority', kind: 'roundtrip',
        status: 'passed', commit_sha: '607c4c491', created_at: '2026-07-13T11:10:00.000Z',
      }],
      RickydataWikiCompilerRun: [{
        _id: 'wiki-run-1', run_id: 'wiki-run-1', atom_count: 8,
        diffs_json: JSON.stringify([{ status: 'applied', diff: { page_slug: 'delegated-knowledge' } }]),
        cursor_to: 'cursor-8', finished_at: '2026-07-13T11:20:00.000Z',
      }],
      RickydataLearningDraft: [{
        _id: 'draft-1', artifact_kind: 'curriculum_text', status: 'published', title: 'Delegated knowledge lesson',
        course_slug: 'verification-claims', lesson_id: 'lesson-7', source_refs_json: JSON.stringify(['proof-1']),
        updated_at: '2026-07-13T11:30:00.000Z',
      }],
      RickydataVideoBrief: [{
        _id: 'video-1', status: 'rendered', title: 'Delegated knowledge explainer',
        course_slug: 'verification-claims', lesson_id: 'lesson-7', video_kind: 'lesson_video',
        updated_at: '2026-07-13T11:40:00.000Z',
      }],
      RickydataContentCandidate: [{
        _id: 'candidate-1', candidate_id: 'candidate-1', title: 'Deepen delegated authority', text_status: 'ready',
        status: 'proposed', updated_at: '2026-07-13T11:45:00.000Z',
        quality_json: JSON.stringify({ passed: true, overall: 91 }),
        curriculum_impact_json: JSON.stringify({ action: 'new_lesson', targetCourse: 'verification-claims', targetPhase: 'in practice' }),
        agent_recommendation_json: JSON.stringify({ action: 'add_to_curriculum', priority: 'now', rationale: 'Closes a verified operational gap.' }),
        source_refs_json: JSON.stringify(['proof-1']),
      }],
      RickydataContentJob: [{
        _id: 'job-1', job_id: 'job-1', candidate_id: 'candidate-1', kind: 'lesson_video', status: 'running',
        stage: 'render', detail: 'Rendering lesson reel', updated_at: '2026-07-13T11:50:00.000Z',
      }],
      RickydataCourse: [{ _id: 'course-1', slug: 'verification-claims' }],
      RickydataLesson: [{ _id: 'lesson-7', course_slug: 'verification-claims', content: 'A'.repeat(120) }],
      RickydataLessonVideo: [{ _id: 'published-video-1', lesson_id: 'lesson-7', published_at: '2026-07-13T11:42:00.000Z' }],
    };
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body ?? '{}')) as { query?: string; scope?: string };
      expect(body.scope).toBe('private');
      const label = body.query?.match(/MATCH \(n:([^\)]+)\)/)?.[1] ?? '';
      if (label === 'WikiPage') return jsonResponse({ error: 'temporary source outage' }, { status: 503 });
      return jsonResponse({ data: rowsByLabel[label] ?? [] });
    });
    const kfdb = new KfdbKnowledgeClient({
      baseUrl: 'https://kfdb.test', apiKey: 'key', walletAddress: '0xb3e6', s2d: null, fetchImpl,
    });

    const result = await kfdb.recentActivity({
      hours: 24,
      limit: 20,
      now: new Date('2026-07-13T12:00:00.000Z'),
    }) as Record<string, unknown>;

    expect(result).toMatchObject({
      window: { from: '2026-07-12T12:00:00.000Z', to: '2026-07-13T12:00:00.000Z', hours: 24 },
      counts: { DEV: 3, PROOF: 1, KNOWLEDGE: 1, LEARN: 1, MEDIA: 2 },
      complete: false,
      curriculum: { course_count: 1, lesson_count: 1, playable_video_lessons: 1 },
    });
    expect(result['events']).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'DEV', source: expect.objectContaining({ label: 'RickydataChangeEvidence', id: 'change-1' }), commit_sha: '607c4c491' }),
      expect.objectContaining({
        kind: 'DEV',
        title: 'Keep partner authority wallet-scoped',
        source: expect.objectContaining({ label: 'RickydataGitCommit', id: 'git-1' }),
        commit_sha: '457d238',
      }),
      expect.objectContaining({ kind: 'LEARN', source: expect.objectContaining({ label: 'RickydataLearningDraft', id: 'draft-1' }), course_slug: 'verification-claims' }),
      expect.objectContaining({ kind: 'MEDIA', source: expect.objectContaining({ label: 'RickydataVideoBrief', id: 'video-1' }) }),
    ]));
    expect(result['recommendations']).toEqual([
      expect.objectContaining({ id: 'candidate-1', quality: 91, priority: 'now', source_refs: ['proof-1'] }),
    ]);
    expect(result['active_jobs']).toEqual([
      expect.objectContaining({ id: 'job-1', status: 'running', stage: 'render' }),
    ]);
    expect(result['sources']).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'WikiPage', ok: false, omission: expect.stringContaining('503') }),
    ]));
    expect(result['reproducibility_hash']).toMatch(/^[a-f0-9]{64}$/);
  });

  it('uses the exact same 20-source registry as the learner Pulse projection', () => {
    expect(RECENT_ACTIVITY_SOURCE_LABELS).toEqual([
      'RickydataGitCommit',
      'RickydataDevelopmentEpisode',
      'RickydataDailyLearningBrief',
      'EvidenceRecord',
      'RickydataChangeEvidence',
      'RickydataWikiCompilerRun',
      'WikiPage',
      'RickydataCourse',
      'RickydataLearningJob',
      'RickydataLessonVideo',
      'RickydataCourseAudio',
      'RickydataLearningDraft',
      'RickydataVideoBrief',
      'RickydataLesson',
      'RickydataLessonProgress',
      'RickydataFeedComment',
      'RickydataLearningChallenge',
      'RickydataAnswerFeedback',
      'RickydataContentCandidate',
      'RickydataContentJob',
    ]);
  });

  it('bounds recent activity scans and paginates the complete whole-label Git commit source', async () => {
    let active = 0;
    let peak = 0;
    const requests: Array<{ query: string; pageSize?: number; cursor?: string }> = [];
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body ?? '{}')) as {
        query?: string;
        scope?: string;
        page_size?: number;
        cursor?: string;
      };
      expect(body.scope).toBe('private');
      requests.push({
        query: body.query ?? '',
        ...(body.page_size ? { pageSize: body.page_size } : {}),
        ...(body.cursor ? { cursor: body.cursor } : {}),
      });
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      if ((body.query ?? '').startsWith('MATCH (n:RickydataGitCommit)')) {
        const suffix = body.cursor ? '2' : '1';
        return jsonResponse({
          data: [{
            _id: `git-${suffix}`,
            commit_sha: suffix.repeat(40),
            repo_id: 'rickydata_home',
            committed_at: `2026-07-13T11:0${suffix}:00.000Z`,
            subject: `Commit ${suffix}`,
          }],
          has_more: !body.cursor,
          ...(!body.cursor ? { next_cursor: 'opaque-git-page-2' } : {}),
        });
      }
      return jsonResponse({ data: [] });
    });
    const kfdb = new KfdbKnowledgeClient({
      baseUrl: 'https://kfdb.test', apiKey: 'key', walletAddress: '0xb3e6', s2d: null, fetchImpl,
    });

    const result = await kfdb.recentActivity({
      now: new Date('2026-07-13T12:00:00.000Z'),
    }) as { counts: { DEV: number }; sources: Array<{ label: string; row_count: number }> };

    expect(peak).toBe(4);
    expect(requests).toHaveLength(RECENT_ACTIVITY_SOURCE_LABELS.length + 1);
    const gitCommit = requests.filter(({ query }) => query.startsWith('MATCH (n:RickydataGitCommit)'));
    expect(gitCommit).toEqual([
      {
        query: 'MATCH (n:RickydataGitCommit) RETURN n.* LIMIT 100000',
        pageSize: 500,
      },
      {
        query: 'MATCH (n:RickydataGitCommit) RETURN n.* LIMIT 100000',
        pageSize: 500,
        cursor: 'opaque-git-page-2',
      },
    ]);
    expect(result.counts.DEV).toBe(2);
    expect(result.sources.find(({ label }) => label === 'RickydataGitCommit')?.row_count).toBe(2);
  });

  it('caps broad knowledge bundles before they can spill into engine result files', () => {
    expect(capKnowledgeBundleArgs({
      token_budget: 32000,
      page_limit: 200,
      claim_limit: 500,
    })).toEqual({
      token_budget: 4000,
      page_limit: 20,
      claim_limit: 40,
    });
  });

  it('fails closed before private reads when delegated S2D authority is unavailable', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        pages: [],
        claims: [],
        open_questions: [],
        reproducibility_hash: 'hash',
        diagnostics: { s2d_active: false, undecrypted_skipped: 12 },
      }),
    );
    const kfdb = new KfdbKnowledgeClient({
      baseUrl: 'https://kfdb.test',
      apiKey: 'key',
      walletAddress: '0xb3e6',
      s2d: null,
      requireS2D: true,
      fetchImpl,
    });

    await expect(kfdb.knowledgeBundle({ token_budget: 2500 })).rejects.toThrow(/sign-to-derive.*private read/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a delegated wallet that differs from the gateway request wallet', async () => {
    const { StaticS2DProvider } = await import('./s2d.js');
    expect(() => new KfdbKnowledgeClient({
      baseUrl: 'https://kfdb.test',
      walletAddress: '0x1111111111111111111111111111111111111111',
      requestWalletAddress: '0x2222222222222222222222222222222222222222',
      s2d: new StaticS2DProvider('session-abc', 'a'.repeat(64), '0x1111111111111111111111111111111111111111'),
      requireS2D: true,
    })).toThrow(/wallet authority mismatch/i);
  });

  it('rejects ciphertext instead of silently projecting an empty private graph', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      pages: [{ title: { String: '__enc_v1_foreign_ciphertext' } }],
      claims: [],
      open_questions: [],
    }));
    const kfdb = new KfdbKnowledgeClient({
      baseUrl: 'https://kfdb.test',
      walletAddress: '0xb3e6',
      s2d: {
        ensure: async () => ({ sessionId: 's2d-session', keyHex: 'a'.repeat(64), walletAddress: '0xb3e6' }),
      },
      requireS2D: true,
      fetchImpl,
    });

    await expect(kfdb.knowledgeBundle({ token_budget: 2500 })).rejects.toThrow(/ciphertext boundary violation/i);
  });

  it('retries one transient KFDB read failure', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ error: 'temporary' }, { status: 502 }))
      .mockResolvedValueOnce(jsonResponse({
        pages: [],
        claims: [],
        open_questions: [],
        reproducibility_hash: 'recovered',
        diagnostics: { s2d_active: true },
      }));
    const kfdb = new KfdbKnowledgeClient({
      baseUrl: 'https://kfdb.test',
      apiKey: 'key',
      walletAddress: '0xb3e6',
      s2d: null,
      fetchImpl,
    });

    await expect(kfdb.knowledgeBundle({ token_budget: 2500 })).resolves.toMatchObject({
      reproducibility_hash: 'recovered',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('hydrates semantic hits into safe title, summary, and slug projections', async () => {
    const longSummary = `Compiler overview ${'x'.repeat(240)}`;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body ?? '{}')) as Record<string, unknown>;
      expect(body['include_entities']).toBe(true);
      if (body['label'] === 'WikiPage') {
        return jsonResponse({
          results: [{
            id: 'embedding-doc-page',
            labels: ['WikiPage'],
            similarity: 0.75,
            properties: {
              entity_label: 'WikiPage',
              file_path: 'WikiPage://11111111-1111-4111-8111-111111111111',
              repo_id: 'repo-home',
            },
            entity: {
              _id: '11111111-1111-4111-8111-111111111111',
              slug: 'agentic-knowledge-compiler',
              title: 'The Agentic Knowledge Compiler',
              summary: longSummary,
              body_md: 'must not escape the safe projection',
            },
          }],
          total_hits: 1,
          took_ms: 12,
        });
      }
      return jsonResponse({
        results: [{
          id: 'embedding-doc-question',
          labels: ['OpenQuestion'],
          similarity: 0.68,
          properties: {
            entity_label: 'OpenQuestion',
            file_path: 'OpenQuestion://22222222-2222-4222-8222-222222222222',
          },
          entity: {
            _id: '22222222-2222-4222-8222-222222222222',
            question: 'Do coding sessions flow into private KFDB automatically?',
            why_it_matters: 'This distinguishes an automatic loop from an operator-only workflow.',
          },
        }],
        total_hits: 1,
        took_ms: 9,
      });
    });
    const kfdb = new KfdbKnowledgeClient({
      baseUrl: 'https://kfdb.test',
      apiKey: 'key',
      walletAddress: '0xb3e6',
      s2d: null,
      fetchImpl,
    });

    await expect(kfdb.semanticSearch({
      query: 'automatic knowledge loop',
      labels: ['WikiPage', 'OpenQuestion'],
      minSimilarity: 0.45,
      limit: 8,
    })).resolves.toMatchObject({
      labels: [
        {
          label: 'WikiPage',
          ok: true,
          result: {
            results: [{
              node_id: '11111111-1111-4111-8111-111111111111',
              embedding_id: 'embedding-doc-page',
              title: 'The Agentic Knowledge Compiler',
              summary: longSummary.slice(0, 200),
              slug: 'agentic-knowledge-compiler',
            }],
          },
        },
        {
          label: 'OpenQuestion',
          ok: true,
          result: {
            results: [{
              node_id: '22222222-2222-4222-8222-222222222222',
              embedding_id: 'embedding-doc-question',
              title: 'Do coding sessions flow into private KFDB automatically?',
              summary: 'This distinguishes an automatic loop from an operator-only workflow.',
              slug: '22222222-2222-4222-8222-222222222222',
            }],
          },
        },
      ],
    });
    const serialized = JSON.stringify(await kfdb.semanticSearch({
      query: 'automatic knowledge loop',
      labels: ['WikiPage'],
      minSimilarity: 0.45,
      limit: 8,
    }));
    expect(serialized).not.toContain('must not escape the safe projection');
  });

  it('bounds transcript-like semantic titles without dropping the full safe summary signal', async () => {
    const question = `Detached pump details ${'x'.repeat(260)}?`;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      results: [{
        id: 'embedding-noisy-question',
        labels: ['OpenQuestion'],
        similarity: 0.71,
        properties: {
          entity_label: 'OpenQuestion',
          file_path: 'OpenQuestion://33333333-3333-4333-8333-333333333333',
        },
        entity: {
          _id: '33333333-3333-4333-8333-333333333333',
          question,
          answer: 'The automatic mirror now runs after every completed turn.',
        },
      }],
      total_hits: 1,
      took_ms: 4,
    }));
    const kfdb = new KfdbKnowledgeClient({
      baseUrl: 'https://kfdb.test',
      apiKey: 'key',
      walletAddress: '0xb3e6',
      s2d: null,
      fetchImpl,
    });

    const response = await kfdb.semanticSearch({
      query: 'automatic mirror',
      labels: ['OpenQuestion'],
      minSimilarity: 0.45,
      limit: 8,
    }) as { labels: Array<{ result: { results: Array<Record<string, unknown>> } }> };
    const hit = response.labels[0]?.result.results[0];

    expect(hit?.title).toBe(`${question.slice(0, 159)}…`);
    expect(String(hit?.title)).toHaveLength(160);
    expect(hit?.summary).toBe('The automatic mirror now runs after every completed turn.');
    expect(hit?.title_truncated).toBe(true);
  });

  it('caps the label fan-out and reports truncation so a caller cannot storm KFDB', async () => {
    // Fresh Response per call — a shared one has a single-read body and would
    // trip the transient-read retry, inflating the call count.
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse({ results: [], total_hits: 0, took_ms: 1 }));
    const kfdb = new KfdbKnowledgeClient({
      baseUrl: 'https://kfdb.test',
      apiKey: 'key',
      walletAddress: '0xb3e6',
      s2d: null,
      fetchImpl,
    });
    const labels = Array.from({ length: 50 }, (_, i) => `Label${i}`);
    const response = await kfdb.semanticSearch({
      query: 'everything', labels, minSimilarity: 0.45, limit: 8,
    }) as { labels: unknown[]; labels_truncated?: number; label_cap?: number };

    expect(response.labels).toHaveLength(40);   // capped
    expect(response.labels_truncated).toBe(10);
    expect(response.label_cap).toBe(40);
    expect(fetchImpl).toHaveBeenCalledTimes(40); // one HNSW search per kept label, no more
  });

  it('resolves human repository names before requesting scoped code context', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      if (String(url).endsWith('/api/v1/import/github')) {
        return jsonResponse({
          repositories: [
            {
              repo_id: '11111111-1111-4111-8111-111111111111',
              owner: 'rickycambrian',
              name: 'rickydata_home',
              full_name: 'rickycambrian/rickydata_home',
            },
            {
              repo_id: '22222222-2222-4222-8222-222222222222',
              owner: 'rickycambrian',
              name: 'rickydata_product_research',
              full_name: 'rickycambrian/rickydata_product_research',
            },
          ],
        });
      }
      const body = JSON.parse(String((init as RequestInit).body ?? '{}')) as Record<string, unknown>;
      expect(body.repo_scope).toEqual([
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
      ]);
      expect(body).toMatchObject({
        evidence_limit: 4,
        token_budget: 3000,
        include_tests: false,
        include_graph: true,
        graph_top_k: 3,
        graph_depth: 1,
        strict_scope: true,
        enable_sufficiency_gate: false,
      });
      return jsonResponse({ evidence_items: [{ file_path: 'src/context/pack.ts', stream_hits: ['fts'] }] });
    });
    const kfdb = new KfdbKnowledgeClient({
      baseUrl: 'https://kfdb.test',
      apiKey: 'key',
      walletAddress: '0xb3e6',
      s2d: null,
      fetchImpl,
    });

    await expect(kfdb.codeContext({
      task: 'Find the shared graph contracts.',
      repo: 'rickycambrian/rickydata_home, rickycambrian/rickydata_product_research',
    })).resolves.toMatchObject({
      evidence_items: [{ file_path: 'src/context/pack.ts', stream_hits: ['fts'] }],
      repo_resolution: {
        status: 'resolved',
        resolved: [
          { repo: 'rickycambrian/rickydata_home', repo_id: '11111111-1111-4111-8111-111111111111' },
          { repo: 'rickycambrian/rickydata_product_research', repo_id: '22222222-2222-4222-8222-222222222222' },
        ],
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('turns explicit source paths in the task into bounded KFDB anchors', async () => {
    const repoId = '11111111-1111-4111-8111-111111111111';
    const contextBodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      if (String(url).endsWith('/api/v1/import/github')) {
        return jsonResponse({
          repositories: [{
            repo_id: repoId,
            owner: 'rickycambrian',
            name: 'rickydata_learn',
            full_name: 'rickycambrian/rickydata_learn',
          }],
        });
      }
      const body = JSON.parse(String((init as RequestInit).body ?? '{}')) as Record<string, unknown>;
      contextBodies.push(body);
      return jsonResponse({
        evidence_items: [{
          node_id: 'compose-feed',
          file_path: 'src/feed/compose.ts',
          stream_hits: ['symbol'],
        }],
      });
    });
    const kfdb = new KfdbKnowledgeClient({
      baseUrl: 'https://kfdb.test',
      apiKey: 'key',
      walletAddress: '0xb3e6',
      s2d: null,
      fetchImpl,
    });

    await kfdb.codeContext({
      task: 'Read `src/feed/compose.ts` and src/feed/xp.ts; compare src/feed/compose.ts exactly.',
      repo: 'rickycambrian/rickydata_learn',
    });

    expect(contextBodies).toHaveLength(1);
    expect(contextBodies[0]).toMatchObject({
      repo_scope: [repoId],
      strict_scope: true,
      anchors: [
        { file_path: 'src/feed/compose.ts', anchor_reason: 'explicit_task_path' },
        { file_path: 'src/feed/xp.ts', anchor_reason: 'explicit_task_path' },
      ],
    });
  });

  it('drops graph-only code evidence that cannot prove repository scope', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      if (String(url).endsWith('/api/v1/import/github')) {
        return jsonResponse({
          repositories: [{
            repo_id: '11111111-1111-4111-8111-111111111111',
            owner: 'rickycambrian',
            name: 'rickydata_home',
            full_name: 'rickycambrian/rickydata_home',
          }],
        });
      }
      return jsonResponse({
        evidence_items: [
          { node_id: 'scoped', file_path: 'src/kfdb/project.ts', stream_hits: ['symbol', 'graph'] },
          { node_id: 'graph-only', file_path: 'vendor/unrelated.ts', stream_hits: ['graph'] },
        ],
        diagnostics: { evidence_count: 2 },
      });
    });
    const kfdb = new KfdbKnowledgeClient({
      baseUrl: 'https://kfdb.test',
      apiKey: 'key',
      walletAddress: '0xb3e6',
      s2d: null,
      fetchImpl,
    });

    await expect(kfdb.codeContext({
      task: 'Find the Project schema.',
      repo: 'rickycambrian/rickydata_home',
    })).resolves.toMatchObject({
      evidence_items: [{ node_id: 'scoped' }],
      diagnostics: {
        evidence_count: 1,
        repo_scope_graph_only_dropped: 1,
      },
    });
  });

  it('keeps graph neighborhoods inside the resolved repository scope', async () => {
    const repoId = '11111111-1111-4111-8111-111111111111';
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      if (String(url).endsWith('/api/v1/import/github')) {
        return jsonResponse({
          repositories: [{
            repo_id: repoId,
            owner: 'rickycambrian',
            name: 'rickydata_home',
            full_name: 'rickycambrian/rickydata_home',
          }],
        });
      }
      return jsonResponse({
        evidence_items: [{ node_id: 'scoped-file', stream_hits: ['fts'] }],
        graph_neighborhood: [{
          seed_node_id: 'scoped-file',
          nodes: [
            { id: 'scoped-file', label: 'File', properties: { repo_id: repoId } },
            { id: 'scoped-function', label: 'Function', properties: { repo_id: repoId } },
            { id: 'foreign-function', label: 'Function', properties: { repo_id: 'foreign-repo' } },
          ],
          edges: [
            { edge_type: 'DEFINES', from_node: 'scoped-file', to_node: 'scoped-function' },
            { edge_type: 'CALLS', from_node: 'scoped-function', to_node: 'foreign-function' },
          ],
        }],
        diagnostics: { evidence_count: 1, graph_neighborhoods: 1 },
      });
    });
    const kfdb = new KfdbKnowledgeClient({
      baseUrl: 'https://kfdb.test',
      apiKey: 'key',
      walletAddress: '0xb3e6',
      s2d: null,
      fetchImpl,
    });

    await expect(kfdb.codeContext({
      task: 'How does Home define context packs?',
      repo: 'rickycambrian/rickydata_home',
    })).resolves.toMatchObject({
      graph_neighborhood: [{
        seed_node_id: 'scoped-file',
        nodes: [
          { id: 'scoped-file' },
          { id: 'scoped-function' },
        ],
        edges: [
          { edge_type: 'DEFINES', from_node: 'scoped-file', to_node: 'scoped-function' },
        ],
      }],
      diagnostics: {
        graph_neighborhoods: 1,
        repo_scope_graph_nodes_dropped: 1,
        repo_scope_graph_edges_dropped: 1,
      },
    });
  });

  it('supplements broad code context with focused compound-identifier evidence', async () => {
    const queries: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body ?? '{}')) as Record<string, unknown>;
      queries.push(String(body.query));
      if (body.query === 'ProductProfile schema contract') {
        return jsonResponse({
          evidence_items: [{
            node_id: 'product-profile',
            file_path: 'src/kfdb/product-profile.ts',
            name: 'ProductProfile',
            content: 'interface ProductProfile { productId: string; }',
            stream_hits: ['symbol'],
          }],
          diagnostics: { total_ms: 12, evidence_count: 1 },
        });
      }
      return jsonResponse({
        evidence_items: [{
          node_id: 'clarification',
          file_path: 'src/queue/sources.ts',
          name: 'clarificationItemId',
          content: 'function clarificationItemId(projectId: string, index: number): string',
          stream_hits: ['symbol'],
        }],
        diagnostics: { total_ms: 10, evidence_count: 1, token_budget: 3000 },
      });
    });
    const kfdb = new KfdbKnowledgeClient({
      baseUrl: 'https://kfdb.test',
      apiKey: 'key',
      walletAddress: '0xb3e6',
      s2d: null,
      fetchImpl,
    });

    await expect(kfdb.codeContext({
      task: 'Project ProductProfile Clarification',
      repo: '11111111-1111-4111-8111-111111111111',
    })).resolves.toMatchObject({
      evidence_items: [
        { node_id: 'clarification' },
        { node_id: 'product-profile', name: 'ProductProfile' },
      ],
      diagnostics: {
        evidence_count: 2,
        query_expansions: ['ProductProfile schema contract'],
        repo_scope_filter_applied: true,
      },
    });
    expect(queries).toEqual([
      'Project ProductProfile Clarification',
      'ProductProfile schema contract',
    ]);
  });

  it('returns the primary code context when an optional supplement query fails', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body ?? '{}')) as Record<string, unknown>;
      if (body.query === 'ProductProfile schema contract') {
        return jsonResponse({ error: 'internal' }, { status: 500 });
      }
      return jsonResponse({
        evidence_items: [{
          node_id: 'clarification',
          file_path: 'src/queue/sources.ts',
          name: 'clarificationItemId',
          stream_hits: ['symbol'],
        }],
        diagnostics: { total_ms: 10, evidence_count: 1 },
      });
    });
    const kfdb = new KfdbKnowledgeClient({
      baseUrl: 'https://kfdb.test',
      apiKey: 'key',
      walletAddress: '0xb3e6',
      s2d: null,
      fetchImpl,
    });

    await expect(kfdb.codeContext({
      task: 'Project ProductProfile Clarification',
      repo: '11111111-1111-4111-8111-111111111111',
    })).resolves.toMatchObject({
      evidence_items: [{ node_id: 'clarification' }],
      diagnostics: {
        evidence_count: 1,
        query_expansions: ['ProductProfile schema contract'],
        query_expansion_failures: [{
          query: 'ProductProfile schema contract',
          error_category: 'route_unavailable',
        }],
      },
    });
    const failures = JSON.stringify(await kfdb.codeContext({
      task: 'Project ProductProfile Clarification',
      repo: '11111111-1111-4111-8111-111111111111',
    }));
    expect(failures).not.toContain('internal');
  });

  it('returns an honest diagnostic instead of broad code results for an unindexed repo', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ repositories: [] }));
    const kfdb = new KfdbKnowledgeClient({
      baseUrl: 'https://kfdb.test',
      apiKey: 'key',
      walletAddress: '0xb3e6',
      s2d: null,
      fetchImpl,
    });

    await expect(kfdb.codeContext({
      task: 'Find the Project schema.',
      repo: 'rickycambrian/rickydata_home',
    })).resolves.toMatchObject({
      evidence_items: [],
      diagnostics: { repo_scope_unavailable: true },
      repo_resolution: {
        status: 'not_indexed',
        missing: ['rickycambrian/rickydata_home'],
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refuses an empty repository selector instead of issuing an unscoped code query', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const kfdb = new KfdbKnowledgeClient({
      baseUrl: 'https://kfdb.test',
      apiKey: 'key',
      walletAddress: '0xb3e6',
      s2d: null,
      fetchImpl,
    });

    await expect(kfdb.codeContext({
      task: 'Find the Project schema.',
      repo: ', ,',
    })).resolves.toMatchObject({
      evidence_items: [],
      diagnostics: { repo_scope_unavailable: true },
      repo_resolution: {
        status: 'invalid',
        requested: [],
      },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses capture writes before fetch when S2D is unavailable', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const kfdb = new KfdbKnowledgeClient({
      baseUrl: 'https://kfdb.test',
      apiKey: 'key',
      walletAddress: '0xb3e6',
      s2d: null,
      fetchImpl,
    });

    await expect(kfdb.writeData(buildDiscoveryCapture({ idea: 'Use voice for question triage.' }))).rejects.toBeInstanceOf(
      FailClosedError,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('adds S2D headers to capture writes when a session is available', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ operations_executed: 1, affected_ids: ['x'] }));
    const kfdb = new KfdbKnowledgeClient({
      baseUrl: 'https://kfdb.test',
      apiKey: 'key',
      walletAddress: '0xb3e6',
      s2d: {
        ensure: async () => ({ sessionId: 's2d-session', keyHex: 'abc123', walletAddress: '0xb3e6' }),
      },
      fetchImpl,
    });

    await kfdb.writeData(buildDiscoveryCapture({ idea: 'Use voice for question triage.' }));
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect(init.headers).toMatchObject({
      authorization: 'Bearer key',
      'x-wallet-address': '0xb3e6',
      'x-derive-session-id': 's2d-session',
      'x-derive-key': 'abc123',
    });
  });

  it('does not retry capture writes after a transient KFDB failure', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ error: 'temporary' }, { status: 502 }),
    );
    const kfdb = new KfdbKnowledgeClient({
      baseUrl: 'https://kfdb.test',
      apiKey: 'key',
      walletAddress: '0xb3e6',
      s2d: {
        ensure: async () => ({ sessionId: 's2d-session', keyHex: 'abc123', walletAddress: '0xb3e6' }),
      },
      fetchImpl,
    });

    await expect(kfdb.writeData(buildDiscoveryCapture({ idea: 'Keep writes fail-closed.' })))
      .rejects.toBeInstanceOf(ApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('maps direct KFDB knowledge bundle pages into wiki search hits', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        pages: [
          {
            slug: 'voice-guide',
            title: 'The VoiceGuide overlay',
            summary: 'Voice overlay facts.',
            kind: 'subsystem',
            score: 1,
            verified_claim_count: 2,
            claim_count: 3,
          },
        ],
        claims: [],
        diagnostics: { s2d_active: true, total_ms: 20 },
        reproducibility_hash: 'hash',
      }),
    );
    const kfdb = new KfdbKnowledgeClient({
      baseUrl: 'https://kfdb.test',
      apiKey: 'key',
      walletAddress: '0xb3e6',
      s2d: null,
      fetchImpl,
    });

    await expect(kfdb.wikiSearch('voice guide', 5)).resolves.toMatchObject({
      hits: [{ slug: 'voice-guide', source: 'kfdb_bundle', verifiedClaimCount: 2 }],
      fallback: { source: 'kfdb_agent_knowledge', reproducibility_hash: 'hash' },
    });
  });

  it('reads direct KFDB wiki page rows and overlays verified claim flags from the bundle', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body ?? '{}')) as { query?: string };
      if (body.query?.includes('WikiPage')) {
        return jsonResponse({
          data: [
            {
              _id: { String: 'wiki-page:voice-guide' },
              slug: { String: 'voice-guide' },
              kind: { String: 'subsystem' },
              title: { String: 'The VoiceGuide overlay' },
              summary: { String: 'Voice overlay facts.' },
              body_md: { String: '# VoiceGuide' },
              status: { String: 'active' },
              source_count: { Integer: 3 },
              last_compiled_at: { String: '2026-07-08T12:00:00.000Z' },
              compiler_version: { String: 'test' },
              rickydata_wiki_schema_version: { String: 'v1' },
            },
          ],
        });
      }
      if (body.query?.includes('WikiClaim')) {
        return jsonResponse({
          data: [
            {
              _id: { String: 'claim:voice-guide:1' },
              page_slug: { String: 'voice-guide' },
              text: { String: 'VoiceGuide uses home companion events.' },
              confidence_tier: { String: 'EXTRACTED' },
              confidence_score: { Float: 1 },
              status: { String: 'active' },
              source_ref: { String: 'wiki-page:voice-guide' },
              updated_at: { String: '2026-07-08T12:00:00.000Z' },
              rickydata_wiki_schema_version: { String: 'v1' },
            },
          ],
        });
      }
      return jsonResponse({
        pages: [],
        claims: [{ id: 'claim:voice-guide:1', page_slug: 'voice-guide', verified: true }],
        diagnostics: { s2d_active: true },
        reproducibility_hash: 'hash',
      });
    });
    const kfdb = new KfdbKnowledgeClient({
      baseUrl: 'https://kfdb.test',
      apiKey: 'key',
      walletAddress: '0xb3e6',
      s2d: null,
      fetchImpl,
    });

    await expect(kfdb.wikiPage('voice-guide')).resolves.toMatchObject({
      page: { slug: 'voice-guide', body_md: '# VoiceGuide' },
      claims: [{ id: 'claim:voice-guide:1', verified: true }],
      verifiedClaimIds: ['claim:voice-guide:1'],
      fallback: { source: 'kfdb_query', reproducibility_hash: 'hash' },
    });
  });

  it('traces WikiClaim rows by source_ref and returns the exact verified claim', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body ?? '{}')) as { query?: string; query_text?: string };
      if (body.query?.includes('WikiPage')) {
        return jsonResponse({
          data: [
            {
              _id: { String: 'wiki-page:agentic-knowledge-compiler' },
              slug: { String: 'agentic-knowledge-compiler' },
              kind: { String: 'program' },
              title: { String: 'The Agentic Knowledge Compiler' },
              summary: { String: 'AKC facts.' },
              body_md: { String: '# AKC' },
              status: { String: 'active' },
              source_count: { Integer: 3 },
              last_compiled_at: { String: '2026-07-08T12:00:00.000Z' },
              compiler_version: { String: 'test' },
              rickydata_wiki_schema_version: { String: 'v1' },
            },
          ],
        });
      }
      if (body.query?.includes('WikiClaim')) {
        return jsonResponse({
          data: [
            {
              _id: { String: 'claim:wrong' },
              page_slug: { String: 'agentic-knowledge-compiler' },
              text: { String: 'Nearby but wrong claim.' },
              confidence_tier: { String: 'EXTRACTED' },
              confidence_score: { Float: 1 },
              status: { String: 'active' },
              source_ref: { String: 'roadmap:other' },
              updated_at: { String: '2026-07-08T12:00:00.000Z' },
              rickydata_wiki_schema_version: { String: 'v1' },
            },
            {
              _id: { String: 'claim:target' },
              page_slug: { String: 'agentic-knowledge-compiler' },
              text: { String: 'Phase 10 passed build gate in 1.93s.' },
              confidence_tier: { String: 'EXTRACTED' },
              confidence_score: { Float: 1 },
              status: { String: 'active' },
              source_ref: { String: 'evidence:akc-p10-code-integration:build:50cb7f' },
              updated_at: { String: '2026-07-08T12:00:00.000Z' },
              rickydata_wiki_schema_version: { String: 'v1' },
            },
          ],
        });
      }
      return jsonResponse({
        pages: [],
        claims: body.query === 'Phase 10 passed build gate in 1.93s.'
          ? [{ id: 'claim:target', page_slug: 'agentic-knowledge-compiler', verified: true }]
          : [],
        diagnostics: { s2d_active: true },
        reproducibility_hash: 'hash',
      });
    });
    const kfdb = new KfdbKnowledgeClient({
      baseUrl: 'https://kfdb.test',
      apiKey: 'key',
      walletAddress: '0xb3e6',
      s2d: null,
      fetchImpl,
    });

    await expect(kfdb.trace('wiki-claim', 'evidence:akc-p10-code-integration:build:50cb7f')).resolves.toMatchObject({
      answer: 'Page agentic-knowledge-compiler; claim claim:target; verified. Phase 10 passed build gate in one point nine three seconds.',
      rawAnswer: 'Page agentic-knowledge-compiler; claim claim:target; verified. Phase 10 passed build gate in 1.93s.',
      claimText: 'Phase 10 passed build gate in 1.93s.',
      spokenClaimText: 'Phase 10 passed build gate in one point nine three seconds.',
      claimId: 'claim:target',
      pageSlug: 'agentic-knowledge-compiler',
      kind: 'wiki-claim',
      id: 'claim:target',
      sourceRef: 'evidence:akc-p10-code-integration:build:50cb7f',
      verified: true,
      citation: { pageSlug: 'agentic-knowledge-compiler', claimId: 'claim:target', verified: true },
      page: { slug: 'agentic-knowledge-compiler', title: 'The Agentic Knowledge Compiler' },
      fallback: { source: 'kfdb_trace' },
      authority: {
        effective_wallet_address: '0xb3e6',
        tenant_scope: 'wallet-private',
        query_scope: 'private',
        credential_type: 'kfdb-api-key',
      },
    });
    const trace = await kfdb.trace('wiki-claim', 'evidence:akc-p10-code-integration:build:50cb7f') as {
      page?: Record<string, unknown>;
    };
    expect(trace.page).not.toHaveProperty('bodyMd');
    expect(trace.page).not.toHaveProperty('body_md');
  });

  it('traces knowledge assertions directly from the KFDB assertion projection', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      const body = JSON.parse(String((init as RequestInit).body ?? '{}')) as Record<string, unknown>;
      if (String(url).endsWith('/api/v1/query') && String(body['query']).includes('RickydataKnowledgeAssertion')) {
        return jsonResponse({ data: [{
          slug: 'zero-schema-law',
          title: 'Zero schema law',
          origin: 'repo',
          status: 'active',
          severity: 'hard',
          comparator: 'atLeast',
          expect_json: '{"n":1}',
          anchor_json: '{"kind":"page","key":"dev-tycoon"}',
          oracle_json: '{"kind":"wiki-query","claimTextRegex":"does not add schema"}',
          source_sha256: 'abc',
          created_by: 'repo:test',
          updated_at: '2026-07-10T00:00:00.000Z',
          rationale: 'Keep the invariant visible.',
        }] });
      }
      return jsonResponse({}, { status: 404 });
    });
    const kfdb = new KfdbKnowledgeClient({
      baseUrl: 'https://kfdb.test',
      apiKey: 'key',
      walletAddress: '0xb3e6',
      s2d: null,
      fetchImpl,
    });

    await expect(kfdb.trace('knowledge-assertion', 'zero-schema-law')).resolves.toMatchObject({
      subject: { kind: 'knowledge-assertion', id: 'zero-schema-law' },
      confidence: 'recorded',
      nodes: [{
        type: 'knowledge-assertion',
        data: {
          comparator: 'atLeast',
          expectJson: '{"n":1}',
          anchorJson: '{"kind":"page","key":"dev-tycoon"}',
          oracleJson: '{"kind":"wiki-query","claimTextRegex":"does not add schema"}',
        },
      }],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('traces an exact EvidenceRecord source reference to its private commit receipt', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body ?? '{}')) as { query?: string; scope?: string };
      expect(body.scope).toBe('private');
      if (body.query?.includes('EvidenceRecord')) {
        return jsonResponse({ data: [{
          _id: 'evidence-node-1',
          evidence_record_id: 'authority-proof-1',
          roadmap_item_id: 'knowledge-partner-authority',
          kind: 'production-proof',
          status: 'passed',
          summary: 'The wallet-private partner path passed.',
          repo_id: 'rickydata_home',
          commit_sha: 'abc1234',
          created_at: '2026-07-14T12:00:00.000Z',
        }] });
      }
      return jsonResponse({ data: [] });
    });
    const kfdb = new KfdbKnowledgeClient({
      baseUrl: 'https://kfdb.test',
      apiKey: 'key',
      walletAddress: '0xb3e6',
      s2d: null,
      fetchImpl,
    });

    await expect(kfdb.trace('wiki-claim', 'evidence:authority-proof-1')).resolves.toMatchObject({
      subject: { kind: 'evidence-record', id: 'authority-proof-1' },
      kind: 'evidence-record',
      id: 'authority-proof-1',
      commitSha: 'abc1234',
      repo: 'rickydata_home',
      nodes: [
        { type: 'EvidenceRecord', data: { status: 'passed', commitSha: 'abc1234' } },
        { type: 'CommitReference', data: { commitSha: 'abc1234', repo: 'rickydata_home', provenance: 'EvidenceRecord.commit_sha' } },
      ],
      edges: [{ relation: 'records_commit' }],
      authority: {
        effective_wallet_address: '0xb3e6',
        tenant_scope: 'wallet-private',
        query_scope: 'private',
        credential_type: 'kfdb-api-key',
      },
    });
  });

  it('ranks the fast KFDB knowledge-bundle OpenQuestion projection for next_questions', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      const body = JSON.parse(String((init as RequestInit).body ?? '{}')) as Record<string, unknown>;
      if (String(url).endsWith('/api/v1/agent/knowledge')) {
        expect(body).toMatchObject({
          page_limit: 1,
          claim_limit: 1,
          include_questions: true,
        });
        return jsonResponse({
          open_questions: [
            {
              id: 'oq-live',
              question: 'Which voice-relay commit last streamed from the Core2 device?',
              question_kind: 'question',
              why_it_matters: 'Blocks the device proof.',
              category: 'voice',
              source_ref: 'voice-proof:t4',
              created_at: '2026-01-01T00:00:00.000Z',
              priority: 7,
              status: 'open',
            },
            {
              id: 'oq-answered',
              question: 'Which stale question is already answered?',
              answer: 'Already answered.',
              status: 'answered',
            },
          ],
          diagnostics: { scanned_questions: 2, pruned_questions: 0 },
          reproducibility_hash: 'questions-hash',
        });
      }
      return jsonResponse({}, { status: 404 });
    });
    const kfdb = new KfdbKnowledgeClient({
      baseUrl: 'https://kfdb.test',
      apiKey: 'key',
      walletAddress: '0xb3e6',
      s2d: null,
      fetchImpl,
    });

    await expect(kfdb.nextQuestions({ limit: 3 })).resolves.toMatchObject({
      ranked: [
        {
          id: 'oq-live',
          question: 'Which voice-relay commit last streamed from the Core2 device?',
          questionKind: 'question',
          value: 0.1,
          components: { blocking: 0.2, gap: 0.5, freshness: 1, answerability: 1 },
          answerability: { phrasing: 'specific', rewriteHint: null },
          blockingRefs: [],
          whyItMatters: 'Blocks the device proof.',
          category: 'voice',
          sourceRef: 'voice-proof:t4',
        },
      ],
      total_ranked: 1,
      fallback: { source: 'kfdb_agent_knowledge', total_open: 1 },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('distinguishes an empty topic match from an empty OpenQuestion queue', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      if (String(url).endsWith('/api/v1/agent/knowledge')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { query?: string };
        if (body.query) {
          return jsonResponse({
            open_questions: [],
            diagnostics: {
              scanned_questions: 9053,
              pruned_questions: 8899,
              sources: { questions: { complete: false } },
            },
            reproducibility_hash: 'scoped-topic-hash',
          });
        }
        return jsonResponse({
          open_questions: [{
            id: 'oq-core2',
            question: 'Which commit last streamed from the Core2 device?',
            why_it_matters: 'Blocks the device proof.',
            status: 'open',
          }],
          diagnostics: {
            scanned_questions: 9053,
              pruned_questions: 8899,
              sources: { questions: { complete: false } },
          },
          reproducibility_hash: 'topic-hash',
        });
      }
      return jsonResponse({}, { status: 404 });
    });
    const kfdb = new KfdbKnowledgeClient({
      baseUrl: 'https://kfdb.test',
      apiKey: 'key',
      walletAddress: '0xb3e6',
      s2d: null,
      fetchImpl,
    });

    await expect(kfdb.nextQuestions({ topic: 'agentic-knowledge-compiler', limit: 3 })).resolves.toMatchObject({
      ranked: [],
      total_ranked: 0,
      fallback: {
        total_open: 1,
        queue_projection_complete: false,
        total_open_is_lower_bound: true,
        topic: 'agentic-knowledge-compiler',
        topic_matches: 0,
        retry_hint: 'Omit topic to request the global highest-value ranking.',
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('projects pending WikiDiffs ahead of OpenQuestions for review_pending', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      if (String(url).endsWith('/api/v1/query')) {
        return jsonResponse({
          data: [{
            _id: 'run-node-1',
            run_id: 'run-1',
            started_at: '2026-07-10T05:38:24.390Z',
            diffs_json: JSON.stringify([{
              kind: 'wiki_update',
              status: 'pending',
              diff: {
                pageSlug: 'rickydata-main-branch-policy',
                op: 'create',
                title: 'rickydata Main-Branch Policy',
                rationale: 'The operator answered the branch-policy question.',
              },
            }]),
          }],
        });
      }
      if (String(url).endsWith('/api/v1/agent/knowledge')) {
        return jsonResponse({
          open_questions: [{
            id: 'oq-core2',
            question: 'Has the physical Core2 streaming proof passed?',
            status: 'open',
          }],
        });
      }
      return jsonResponse({}, { status: 404 });
    });
    const kfdb = new KfdbKnowledgeClient({
      baseUrl: 'https://kfdb.test',
      apiKey: 'key',
      walletAddress: '0xb3e6',
      s2d: null,
      fetchImpl,
    });

    await expect(kfdb.reviewPending(3)).resolves.toMatchObject({
      counts: { wiki_update: 1, open_question: 1 },
      items: [
        {
          id: 'wiki-update:rickydata-main-branch-policy:run-1',
          kind: 'wiki_update',
          title: 'Wiki create: rickydata Main-Branch Policy',
          sourceRef: { label: 'RickydataWikiCompilerRun', nodeId: 'run-node-1', scope: 'private' },
        },
        {
          id: 'oq-core2',
          kind: 'open_question',
          title: 'Has the physical Core2 streaming proof passed?',
        },
      ],
      fallback: { source: 'kfdb_pending_projection' },
    });
  });

  it('returns a nonempty topic-scoped KFDB projection without waiting for Home', async () => {
    const home = {
      nextQuestions: vi.fn(async () => {
        throw new Error('topic-scoped fast path should not call Home');
      }),
    };
    const kfdb = {
      nextQuestions: vi.fn(async () => ({
        ranked: [{ id: 'core2' }],
        total_ranked: 1,
      })),
    };

    await expect(
      resolveNextQuestions(home, kfdb, { topic: 'Core2', limit: 3 }),
    ).resolves.toMatchObject({
      ranked: [{ id: 'core2' }],
      topic_scoped_fast_path: true,
    });
    expect(home.nextQuestions).not.toHaveBeenCalled();
    expect(kfdb.nextQuestions).toHaveBeenCalledWith({ topic: 'Core2', limit: 3 });
  });

  it('redacts raw Home authorization errors when the KFDB question fallback succeeds', async () => {
    const home = {
      nextQuestions: vi.fn(async () => {
        throw new Error('home API 401: {"error":"Invalid or expired token"}');
      }),
    };
    const kfdb = {
      nextQuestions: vi.fn(async () => ({
        ranked: [{ id: 'global-question' }],
        total_ranked: 1,
      })),
    };

    const result = await resolveNextQuestions(home, kfdb, { limit: 3 }) as Record<string, unknown>;

    expect(result).toMatchObject({
      ranked: [{ id: 'global-question' }],
      home_status: 'route_unavailable',
      home_error_category: 'authorization_unavailable',
    });
    expect(result).not.toHaveProperty('home_error');
    expect(JSON.stringify(result)).not.toContain('Invalid or expired token');
  });

  it('maps KFDB OpenQuestions into a spoken review_pending fallback digest', () => {
    expect(
      reviewPendingFallbackFromQuestions(
        {
          ranked: [
            {
              id: 'oq-live',
              question: 'Which voice-relay commit last streamed from the Core2 device?',
              whyItMatters: 'Blocks the device proof.',
            },
            {
              id: 'oq-second',
              question: 'Which pending item should stay second?',
            },
          ],
          total_ranked: 12,
        },
        1,
      ),
    ).toMatchObject({
      counts: { open_question: 1 },
      items: [
        {
          id: 'oq-live',
          kind: 'open_question',
          title: 'Which voice-relay commit last streamed from the Core2 device?',
          reason: 'Blocks the device proof.',
          sourceRef: { label: 'OpenQuestion', nodeId: 'oq-live', scope: 'private' },
        },
      ],
      fallback: { source: 'kfdb_open_questions', total_open: 12 },
    });
  });

  it('returns the KFDB review digest when Home exceeds the voice budget', async () => {
    const home = {
      reviewPending: vi.fn(() => new Promise<unknown>(() => {})),
    };
    const kfdb = {
      reviewPending: vi.fn(async () => ({
        items: [{ id: 'core2', kind: 'open_question', title: 'Has the physical Core2 streaming proof passed?' }],
        counts: { open_question: 1 },
        fallback: { source: 'kfdb_pending_projection' },
      })),
    };

    await expect(resolveReviewPending(home, kfdb, 5, 0)).resolves.toMatchObject({
      items: [{ id: 'core2', title: 'Has the physical Core2 streaming proof passed?' }],
      home_review_pending_timed_out: true,
      fallback: { source: 'kfdb_pending_projection' },
    });
    expect(home.reviewPending).toHaveBeenCalledWith(5);
    expect(kfdb.reviewPending).toHaveBeenCalledWith(5);
  });

  it('merges fresh KFDB pending diffs ahead of a nonempty Home queue', async () => {
    const home = {
      reviewPending: vi.fn(async () => ({
        items: [{ id: 'issue-1', kind: 'issue', title: 'Review issue one' }],
        counts: { issue: 1 },
      })),
    };
    const kfdb = {
      reviewPending: vi.fn(async () => ({
        items: [{ id: 'wiki-update:policy:run-1', kind: 'wiki_update', title: 'Wiki create: Policy' }],
        counts: { wiki_update: 1 },
        fallback: { source: 'kfdb_pending_projection' },
      })),
    };

    await expect(resolveReviewPending(home, kfdb, 5)).resolves.toMatchObject({
      items: [
        { id: 'wiki-update:policy:run-1' },
        { id: 'issue-1' },
      ],
      counts: { wiki_update: 1, issue: 1 },
      home_counts: { issue: 1 },
      merged_pending_sources: true,
    });
  });
});

describe('trace fallback detection', () => {
  it('preserves verified KFDB authority when an exact evidence trace falls back to Home', async () => {
    const authority = {
      effective_wallet_address: '0xb3e6',
      tenant_scope: 'wallet-private',
      query_scope: 'private',
      credential_type: 'kfdb-s2d-session',
      session_id_provenance: 'delegated-grant',
    };
    const home = { trace: vi.fn(async () => ({
      nodes: [{ id: 'evidence-1', type: 'EvidenceRecord' }, { id: 'page-1', type: 'WikiPage' }],
    })) };
    const kfdb = {
      trace: vi.fn(async () => { throw new Error('wiki claim trace not found'); }),
      authority: vi.fn(async () => authority),
    };

    await expect(resolveTrace(home, kfdb, 'wiki-claim', 'evidence:evidence-1', 5)).resolves.toMatchObject({
      nodes: [{ id: 'evidence-1' }, { id: 'page-1' }],
      authority,
      kfdb_trace_error_category: 'not_found',
    });
    expect(kfdb.authority).toHaveBeenCalledOnce();
  });

  it('returns a structured KFDB fallback when the Home trace route times out', async () => {
    const home = { trace: vi.fn(() => new Promise<unknown>(() => undefined)) };
    const kfdb = { trace: vi.fn(async () => ({ kind: 'wiki-page', id: 'agentic-knowledge-compiler', title: 'Agentic Knowledge Compiler' })) };

    await expect(resolveTrace(home, kfdb, 'wiki-page', 'agentic-knowledge-compiler', 5)).resolves.toMatchObject({
      status: 'route_unavailable',
      fallback: 'kfdb_trace',
      kind: 'wiki-page',
      id: 'agentic-knowledge-compiler',
      title: 'Agentic Knowledge Compiler',
      home_error_category: 'timeout',
      fallback_status: 'evidence_returned',
      answer: 'The primary knowledge route is unavailable, but fallback evidence was found for wiki page agentic-knowledge-compiler.',
    });
  });

  it('returns a structured route-unavailable result when both trace readers fail', async () => {
    const home = { trace: vi.fn(async () => { throw new Error('home route failed'); }) };
    const kfdb = { trace: vi.fn(async () => { throw new Error('kfdb trace failed'); }) };

    await expect(resolveTrace(home, kfdb, 'wiki-page', 'missing-page', 5)).resolves.toMatchObject({
      status: 'route_unavailable',
      fallback: 'kfdb_trace',
      home_error_category: 'route_unavailable',
      fallback_error_category: 'route_unavailable',
      fallback_status: 'unavailable',
      answer: 'The primary knowledge route is unavailable, and no complete fallback evidence is available for wiki page missing-page.',
      subject: { kind: 'wiki-page', id: 'missing-page' },
    });

    const result = await resolveTrace(home, kfdb, 'wiki-page', 'missing-page', 5);
    expect(result).not.toHaveProperty('home_error');
    expect(result).not.toHaveProperty('fallback_error');
    expect(JSON.stringify(result)).not.toContain('home route failed');
    expect(JSON.stringify(result)).not.toContain('kfdb trace failed');
  });

  it('turns a missing fallback trace into a plain user-safe answer without raw auth or status text', async () => {
    const home = { trace: vi.fn(async () => { throw new Error('home API 401: {"error":"Invalid or expired token"}'); }) };
    const kfdb = { trace: vi.fn(async () => { throw new Error('home API 404: page not found'); }) };

    const result = await resolveTrace(home, kfdb, 'wiki-page', 'definitely-missing', 5);
    expect(result).toMatchObject({
      status: 'route_unavailable',
      fallback: 'kfdb_trace',
      home_error_category: 'authorization_unavailable',
      fallback_error_category: 'not_found',
      fallback_status: 'not_found',
      answer: 'No matching knowledge evidence was found for wiki page definitely-missing. The primary knowledge route was unavailable, but the rest of the session can continue.',
    });
    expect(JSON.stringify(result)).not.toMatch(/401|404|invalid or expired token|home API/i);
  });

  it('preserves independently verified KFDB authority when both trace readers fail', async () => {
    const authority = {
      effective_wallet_address: '0xb3e6',
      tenant_scope: 'wallet-private',
      query_scope: 'private',
      credential_type: 'kfdb-s2d-session',
    };
    const home = { trace: vi.fn(async () => { throw new Error('home trace failed'); }) };
    const kfdb = {
      trace: vi.fn(async () => { throw new Error('kfdb trace failed'); }),
      authority: vi.fn(async () => authority),
    };

    await expect(resolveTrace(home, kfdb, 'wiki-claim', 'evidence:missing', 5)).resolves.toMatchObject({
      status: 'route_unavailable',
      subject: { kind: 'wiki-claim', id: 'evidence:missing' },
      authority,
    });
    expect(kfdb.authority).toHaveBeenCalledOnce();
  });

  it('adds a canonical exact answer to knowledge-assertion traces', () => {
    expect(withAssertionVoiceAnswer('knowledge-assertion', 'zero-schema-law', {
      nodes: [{
        type: 'knowledge-assertion',
        data: {
          comparator: 'atLeast',
          expectJson: '{"n":1}',
          anchorJson: '{"kind":"page","key":"dev-tycoon"}',
          oracleJson: '{"kind":"wiki-query","claimTextRegex":"does not add schema"}',
        },
      }],
      edges: [{ relation: 'evaluated_by', data: { status: 'pass' } }],
    })).toMatchObject({
      answer: 'Assertion slug zero-schema-law: comparator atLeast; expect {"n":1}; anchor {"kind":"page","key":"dev-tycoon"}; oracle {"kind":"wiki-query","claimTextRegex":"does not add schema"}; latest lint status pass.',
    });
  });

  it('falls back when home trace returns a partial read-failed omission with no nodes', () => {
    expect(shouldUseKfdbTraceFallback({
      confidence: 'partial',
      nodes: [],
      omissions: [{ reason: 'wiki-claim-read-failed', detail: 'Failed to query KQL: 401 Invalid API key' }],
    })).toBe(true);
  });

  it('keeps complete home traces even when stale omissions exist', () => {
    expect(shouldUseKfdbTraceFallback({
      confidence: 'high',
      nodes: [{ id: 'claim:1' }],
      omissions: [{ reason: 'old-warning', detail: '401 Invalid API key' }],
    })).toBe(false);
  });

  it('prefers KFDB for exact wiki-claim and source-ref traces', () => {
    expect(shouldPreferKfdbTrace('wiki-claim', 'claim-id')).toBe(true);
    expect(shouldPreferKfdbTrace('knowledge-assertion', 'zero-schema-law')).toBe(true);
    expect(shouldPreferKfdbTrace('anything', 'evidence:akc:build:abc')).toBe(true);
    expect(shouldPreferKfdbTrace('anything', 'roadmap:akc-p10')).toBe(true);
    expect(shouldPreferKfdbTrace('wiki-page', 'b53bcdec-0c17-5ce6-96ef-146361649858')).toBe(true);
    expect(shouldPreferKfdbTrace('wiki-page', 'agentic-knowledge-compiler')).toBe(false);
  });
});

describe('compiler-safe capture atoms', () => {
  it('derives memory-v1 OpenQuestion ids from source_ref + question and writes no wiki labels', () => {
    const a = buildOpenQuestionCapture({
      question: 'Which Core2 relay URL actually streamed last time?',
      whyItMatters: 'Blocks device bring-up proof.',
      category: 'environment',
      now: '2026-07-08T12:00:00.000Z',
    });
    const b = buildOpenQuestionCapture({
      question: 'Which Core2 relay URL actually streamed last time?',
      whyItMatters: 'Blocks device bring-up proof.',
      category: 'environment',
      now: '2026-07-08T12:00:00.000Z',
    });
    const c = buildOpenQuestionCapture({
      question: 'Which Cartesia voice UUID worked last time?',
      whyItMatters: 'Blocks marketplace audio.',
      category: 'environment',
      now: '2026-07-08T12:00:00.000Z',
    });

    expect(a.nodeId).toBe(b.nodeId);
    expect(a.nodeId).not.toBe(c.nodeId);
    const firstProps = (a.operations[0] as { properties: { question: { String: string } } }).properties;
    expect(a.nodeId).toBe(deriveOpenQuestionId('voice-open-question:environment', firstProps.question.String));
    expect(a.operations.map((op) => op['label'])).toEqual(['OpenQuestion']);
    expect(a.operations.map((op) => op['label'])).not.toContain('WikiPage');
    expect(a.operations.map((op) => op['label'])).not.toContain('WikiClaim');
  });

  it('captures ideas as Discovery atoms with voice provenance', () => {
    const req = buildDiscoveryCapture({
      idea: 'Ask only one ranked open question at a time.',
      sessionId: 'voice-session-1',
      now: '2026-07-08T12:00:00.000Z',
    });
    const op = req.operations[0]!;

    expect(op['label']).toBe('Discovery');
    expect(op['properties']).toMatchObject({
      finding: { String: 'Ask only one ranked open question at a time.' },
      source: { String: 'voice' },
      origin: { String: 'voice' },
      session_id: { String: 'voice-session-1' },
    });
  });
});

describe('operator lane', () => {
  function authedHome(fetchImpl: typeof fetch): HomeKnowledgeClient {
    return new HomeKnowledgeClient({
      baseUrl: 'https://home.test',
      signer: { address: '0x1111111111111111111111111111111111111111', signMessage: async () => '0xsig' },
      mintToken: async () => 'scwt_test',
      s2d: {
        ensure: async () => ({ sessionId: 's2d-session', keyHex: 'a'.repeat(64), walletAddress: '0x1111111111111111111111111111111111111111' }),
      },
      fetchImpl,
    });
  }

  function timeoutError(): TypeError {
    const err = new TypeError('fetch failed');
    (err as { cause?: { code: string } }).cause = { code: 'UND_ERR_HEADERS_TIMEOUT' };
    return err;
  }

  it('queue_census counts the whole fetch, filters the sample, and flags truncation', async () => {
    const items = [
      { id: 'a', kind: 'wiki_update', title: 'A', sourceRef: { label: 'X', scope: 'private' } },
      { id: 'b', kind: 'open_question', title: 'B', sourceRef: { label: 'X', scope: 'private' } },
      { id: 'c', kind: 'open_question', title: 'C', sourceRef: { label: 'X', scope: 'private' } },
    ];
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ items }));
    const census = (await authedHome(fetchImpl).queueCensus({ limit: 3, kind: 'open_question', top: 1 })) as Record<string, unknown>;

    expect(String(fetchImpl.mock.calls[0]![0])).toContain('/api/hitl/queue?limit=3');
    expect(census['total']).toBe(3);
    expect(census['truncated']).toBe(true); // items.length === limit → the census may undercount
    expect(census['counts']).toEqual({ wiki_update: 1, open_question: 2 });
    expect((census['sample'] as unknown[]).length).toBe(1);
    expect((census['sample'] as Array<{ kind: string }>)[0]!.kind).toBe('open_question');
  });

  it('resolve_item reuses a recently read queue item instead of rebuilding the live queue', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ decision: { verified: true } }));
    const home = authedHome(fetchImpl);
    home.rememberQueueItems([{
      id: 'wiki-update:policy:run-1',
      kind: 'wiki_update',
      title: 'Wiki update: Policy',
      sourceRef: { label: 'RickydataWikiCompilerRun', nodeId: 'run-1', scope: 'private' },
    }]);

    await home.resolveItem('wiki-update:policy:run-1', 'approve', 'Operator approved.');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]![0])).toBe('https://home.test/api/hitl/decision');
    expect(JSON.parse(String((fetchImpl.mock.calls[0]![1] as RequestInit).body))).toEqual({
      item: {
        id: 'wiki-update:policy:run-1',
        kind: 'wiki_update',
        title: 'Wiki update: Policy',
        sourceRef: { label: 'RickydataWikiCompilerRun', nodeId: 'run-1', scope: 'private' },
      },
      action: 'approve',
      answer: 'Operator approved.',
      confidence: 1,
    });
  });

  it('bulk_decide enforces the 100-id chunk cap before any network egress', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const home = authedHome(fetchImpl);
    await expect(home.bulkDecide(Array.from({ length: 101 }, (_, i) => `id-${i}`), 'reject')).rejects.toThrow(/100 ids/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('batch-approve converts a client timeout into started:true (server keeps applying)', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(timeoutError());
    const result = (await authedHome(fetchImpl).batchApproveWikiDiffs()) as Record<string, unknown>;
    expect(result['started']).toBe(true);
    expect(result['client_timeout']).toBe(true);
  });

  it('lint refresh converts a client timeout into refresh_started:true, but a plain read rethrows', async () => {
    const timeoutFetch = vi.fn<typeof fetch>().mockRejectedValue(timeoutError());
    const refreshed = (await authedHome(timeoutFetch).lintStatus(true)) as Record<string, unknown>;
    expect(refreshed['refresh_started']).toBe(true);

    await expect(authedHome(timeoutFetch).lintStatus(false)).rejects.toThrow('fetch failed');
  });

  it('lint status summarizes findings and surfaces only high-severity details', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        run: { id: 'run-1', knownGood: true, startedAt: '2026-07-09T00:00:00Z' },
        findings: [
          { check: 'stale_claims', severity: 'med', subjectRef: 'wiki-page:x', detail: 'old' },
          { check: 'shipped_without_evidence', severity: 'high', subjectRef: 'roadmap-item:y', detail: 'no commit satisfies' },
        ],
      }),
    );
    const status = (await authedHome(fetchImpl).lintStatus(false)) as Record<string, unknown>;
    expect(status['knownGood']).toBe(true);
    expect(status['findings_total']).toBe(2);
    expect(status['findings_by_check']).toEqual({ stale_claims: 1, shipped_without_evidence: 1 });
    expect(status['high_findings']).toEqual([
      { check: 'shipped_without_evidence', subjectRef: 'roadmap-item:y', detail: 'no commit satisfies' },
    ]);
  });
});

describe('static S2D provider (keyless delegation)', () => {
  it('returns injected credentials without any network or key material', async () => {
    const { StaticS2DProvider } = await import('./s2d.js');
    const provider = new StaticS2DProvider(
      'session-abc',
      '0x' + 'a'.repeat(64),
      '0xABCDEF1234567890abcdef1234567890ABCDEF12',
    );
    const creds = await provider.ensure();
    expect(creds).toEqual({
      sessionId: 'session-abc',
      keyHex: 'a'.repeat(64), // 0x prefix stripped for X-Derive-Key header
      walletAddress: '0xabcdef1234567890abcdef1234567890abcdef12', // lowercased
    });
  });

  it('prefers static session env over the legacy private key', async () => {
    const { loadS2DProviderFromEnv, StaticS2DProvider } = await import('./s2d.js');
    const provider = loadS2DProviderFromEnv(
      {
        S2D_SESSION_ID: 'session-abc',
        S2D_DERIVED_KEY: 'b'.repeat(64),
        KFDB_WALLET_ADDRESS: '0x1111111111111111111111111111111111111111',
        KNOWLEDGE_MCP_PRIVATE_KEY: '59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
      },
      'https://db.test',
    );
    expect(provider).toBeInstanceOf(StaticS2DProvider);
  });

  it('falls back to the key-based manager when static env is incomplete', async () => {
    const { loadS2DProviderFromEnv, S2DSessionManager, StaticS2DProvider } = await import('./s2d.js');
    const provider = loadS2DProviderFromEnv(
      {
        S2D_SESSION_ID: 'session-abc', // key + wallet missing → not enough
        KNOWLEDGE_MCP_PRIVATE_KEY: '59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
      },
      'https://db.test',
    );
    expect(provider).toBeInstanceOf(S2DSessionManager);
    expect(provider).not.toBeInstanceOf(StaticS2DProvider);
  });

  it('returns null when neither credential style is configured', async () => {
    const { loadS2DProviderFromEnv } = await import('./s2d.js');
    expect(loadS2DProviderFromEnv({}, 'https://db.test')).toBeNull();
  });

  it('kfdb client sends static session credentials as X-Derive headers', async () => {
    const { StaticS2DProvider } = await import('./s2d.js');
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ pages: [] }));
    const kfdb = new KfdbKnowledgeClient({
      baseUrl: 'https://db.test',
      apiKey: 'k',
      s2d: new StaticS2DProvider('session-abc', 'c'.repeat(64), '0x2222222222222222222222222222222222222222'),
      fetchImpl,
    });
    const result = await kfdb.knowledgeBundle({ query: 'test' }) as Record<string, unknown>;
    const headers = fetchImpl.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers['x-derive-session-id']).toBe('session-abc');
    expect(headers['x-derive-key']).toBe('c'.repeat(64));
    expect(headers['x-wallet-address']).toBe('0x2222222222222222222222222222222222222222');
    expect(result['authority']).toMatchObject({
      effective_wallet_address: '0x2222222222222222222222222222222222222222',
      tenant_scope: 'wallet-private',
      query_scope: 'private',
      credential_type: 'kfdb-s2d-session',
    });
    expect(JSON.stringify(result)).not.toContain('c'.repeat(64));
    expect(JSON.stringify(result)).not.toContain('session-abc');
  });

  it('constructs the KFDB client from delegated S2D credentials without a legacy API key', async () => {
    const { loadKfdbClientFromEnv } = await import('./kfdb-client.js');
    const { StaticS2DProvider } = await import('./s2d.js');
    const provider = new StaticS2DProvider(
      'session-abc',
      'd'.repeat(64),
      '0x3333333333333333333333333333333333333333',
    );

    expect(loadKfdbClientFromEnv({ KFDB_API_URL: 'https://db.test' }, provider))
      .toBeInstanceOf(KfdbKnowledgeClient);
  });

  it('uses S2D authorization headers without emitting an empty legacy bearer', async () => {
    const { StaticS2DProvider } = await import('./s2d.js');
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ pages: [] }));
    const kfdb = new KfdbKnowledgeClient({
      baseUrl: 'https://db.test',
      s2d: new StaticS2DProvider('session-abc', 'e'.repeat(64), '0x4444444444444444444444444444444444444444'),
      fetchImpl,
    });

    await kfdb.knowledgeBundle({ query: 'delegated' });

    const headers = fetchImpl.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers).not.toHaveProperty('authorization');
    expect(headers['x-derive-session-id']).toBe('session-abc');
    expect(headers['x-derive-key']).toBe('e'.repeat(64));
  });
});

describe('revoked/expired S2D session guidance', () => {
  it('rewrites KFDB 403 sign-to-derive rejections into reconnect guidance', async () => {
    const { StaticS2DProvider } = await import('./s2d.js');
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('Invalid sign-to-derive session: Derive session not found or expired', { status: 403 }),
    );
    const kfdb = new KfdbKnowledgeClient({
      baseUrl: 'https://db.test',
      apiKey: 'k',
      s2d: new StaticS2DProvider('revoked-session', 'd'.repeat(64), '0x3333333333333333333333333333333333333333'),
      fetchImpl,
    });
    await expect(kfdb.knowledgeBundle({ query: 'x' })).rejects.toThrow(/s2d_unavailable.*Reconnect your second brain/is);
  });

  it('leaves unrelated 403s untouched', async () => {
    const { decorateS2DRejection } = await import('./kfdb-client.js');
    const original = new ApiError('kfdb', 403, 'Forbidden: wrong tenant');
    expect(decorateS2DRejection(original)).toBe(original);
    const serverError = new ApiError('kfdb', 500, 'sign-to-derive exploded');
    expect(decorateS2DRejection(serverError)).toBe(serverError);
  });
});

describe('self-minting S2D label', () => {
  it('passes the label through to derive-key when configured', async () => {
    const { S2DSessionManager } = await import('./s2d.js');
    const calls: Array<{ url: string; body?: string }> = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), body: init?.body ? String(init.body) : undefined });
      if (String(url).includes('derive-challenge')) {
        return jsonResponse({
          challenge_id: 'ch-1',
          typed_data: {
            domain: { name: 'KnowledgeFlowDB', version: '1', chainId: 1 },
            types: { AuthMessage: [
              { name: 'message', type: 'string' },
              { name: 'nonce', type: 'string' },
              { name: 'issuedAt', type: 'uint256' },
              { name: 'expiresAt', type: 'uint256' },
            ] },
            message: { message: 'derive', nonce: 'n1', issuedAt: 1, expiresAt: 9999999999 },
          },
        });
      }
      return jsonResponse({ session_id: 's1', key_hex: 'e'.repeat(64) });
    };
    const globalFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      const manager = new S2DSessionManager(
        'https://db.test',
        '59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
        'agent:rickydata-knowledge-partner',
      );
      const creds = await manager.ensure();
      expect(creds?.sessionId).toBe('s1');
      const deriveCall = calls.find((c) => c.url.includes('derive-key'));
      expect(deriveCall?.body).toContain('"label":"agent:rickydata-knowledge-partner"');
    } finally {
      globalThis.fetch = globalFetch;
    }
  });
});
