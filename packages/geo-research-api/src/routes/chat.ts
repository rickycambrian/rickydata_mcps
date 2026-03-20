import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { authRequired } from '../middleware/auth.js';
import * as AgentProxy from '../services/AgentProxy.js';
import * as KfdbService from '../services/KfdbService.js';
import * as ChatContextService from '../services/ChatContextService.js';
import * as AgentActionExecutor from '../services/AgentActionExecutor.js';
import type { AgentType, SSEEvent } from '../services/AgentProxy.js';

const router = Router();

interface SessionMeta {
  agentId: AgentType;
  createdBy: string;
  createdAt: string;
  model?: string;
  threadId?: string;
  contextType?: ChatContextService.ChatContextType;
  contextRefId?: string;
}

const sessionMeta = new Map<string, SessionMeta>();

const VALID_AGENTS: AgentType[] = ['research-paper-analyst', 'research-paper-analyst-geo-uploader'];
const DEFAULT_AGENT: AgentType = 'research-paper-analyst-geo-uploader';
const STREAM_TIMEOUT_MS = 5 * 60 * 1000;

function asValidAgent(agentId?: string): AgentType {
  if (agentId && VALID_AGENTS.includes(agentId as AgentType)) {
    return agentId as AgentType;
  }
  return DEFAULT_AGENT;
}

function normalizeEvent(event: SSEEvent): SSEEvent | null {
  const { type } = event;

  if (type === 'text' && typeof event.data === 'object' && event.data?.text) return event;

  if (type === 'text' && typeof event.data === 'string') {
    return { type: 'text', data: { text: event.data } };
  }

  if (type === 'content_block_delta') {
    const text = event.delta?.text || event.delta?.content || '';
    if (text) return { type: 'text', data: { text } };
    return null;
  }

  if (type === 'message_delta') {
    const text = event.delta?.text || event.delta?.content || '';
    if (text) return { type: 'text', data: { text } };
    return null;
  }

  if (type === 'assistant_text') {
    const text = event.data?.text || event.message || event.text || '';
    if (text) return { type: 'text', data: { text } };
    return null;
  }

  if (type === 'content') {
    const text = event.data?.text || event.content || event.text || '';
    if (text) return { type: 'text', data: { text } };
    return null;
  }

  if (type === 'content_block_start') {
    const text = event.content_block?.text || '';
    if (text) return { type: 'text', data: { text } };
    return null;
  }

  if (type === 'tool_call') {
    const data = (event.data && typeof event.data === 'object') ? event.data : {};
    const normalized = {
      id: data.id || event.id || '',
      name: data.name || event.name || 'tool_call',
      displayName: data.displayName || data.display_name || data.name || event.name || 'tool_call',
      args: data.args || data.input || data.arguments || {},
    };
    return { type: 'tool_call', data: normalized };
  }

  if (type === 'tool_result') {
    const data = (event.data && typeof event.data === 'object') ? event.data : {};
    const normalized = {
      id: data.id || event.id || '',
      name: data.name || event.name || 'tool_result',
      isError: Boolean(data.isError || data.is_error || event.isError || event.error),
      result: data.result || data.content || event.result || event.content || '',
      content: data.content || data.result || event.content || event.result || '',
    };
    return { type: 'tool_result', data: normalized };
  }

  if ([
    'done', 'error', 'stream_end', 'paper_created', 'extraction_complete',
    'agent_action_proposed', 'agent_action_completed', 'agent_action_failed',
    'ui_highlight', 'ui_navigate',
  ].includes(type)) {
    return event;
  }

  const possibleText = event.data?.text || event.text || event.message || event.content;
  if (typeof possibleText === 'string' && possibleText.length > 0) {
    return { type: 'text', data: { text: possibleText } };
  }

  return event;
}

function stripResearchUpdatesBlocks(text: string): string {
  const fullBlock = /```research_updates\s*[\s\S]*?```/gi;
  const trailingPartialBlock = /```research_updates\s*[\s\S]*$/i;
  return text.replace(fullBlock, '').replace(trailingPartialBlock, '').trimEnd();
}

function parseResearchUpdates(text: string): Array<{
  draft_type: KfdbService.AssistantDraft['draft_type'];
  payload_json: Record<string, unknown>;
}> {
  const blocks = [...text.matchAll(/```research_updates\s*([\s\S]*?)```/gi)];
  const result: Array<{ draft_type: KfdbService.AssistantDraft['draft_type']; payload_json: Record<string, unknown> }> = [];

  for (const block of blocks) {
    const body = block[1]?.trim();
    if (!body) continue;

    try {
      const parsed = JSON.parse(body) as { updates?: unknown[] } | unknown[];
      const updates = Array.isArray(parsed) ? parsed : parsed.updates;
      if (!Array.isArray(updates)) continue;

      for (const raw of updates) {
        if (!raw || typeof raw !== 'object') continue;
        const candidate = raw as Record<string, unknown>;
        const draftTypeRaw = String(candidate.draft_type || 'question').toLowerCase();
        const draftType: KfdbService.AssistantDraft['draft_type'] =
          draftTypeRaw === 'claim' ||
          draftTypeRaw === 'topic' ||
          draftTypeRaw === 'relation' ||
          draftTypeRaw === 'question'
            ? (draftTypeRaw as KfdbService.AssistantDraft['draft_type'])
            : 'question';

        const payloadJson: Record<string, unknown> = {
          title: candidate.title || '',
          content: candidate.content || '',
          evidence: candidate.evidence || '',
          confidence: typeof candidate.confidence === 'number' ? candidate.confidence : undefined,
          role: candidate.role || '',
          raw: candidate,
        };

        result.push({ draft_type: draftType, payload_json: payloadJson });
      }
    } catch {
      // Ignore malformed machine block and continue.
    }
  }

  return result;
}

function stripAgentActionsBlocks(text: string): string {
  const fullBlock = /```agent_actions\s*[\s\S]*?```/gi;
  const trailingPartialBlock = /```agent_actions\s*[\s\S]*$/i;
  return text.replace(fullBlock, '').replace(trailingPartialBlock, '').trimEnd();
}

function parseAgentActions(text: string): Array<{
  action: string;
  params: Record<string, unknown>;
  description?: string;
}> {
  const blocks = [...text.matchAll(/```agent_actions\s*([\s\S]*?)```/gi)];
  const result: Array<{ action: string; params: Record<string, unknown>; description?: string }> = [];

  for (const block of blocks) {
    const body = block[1]?.trim();
    if (!body) continue;

    try {
      const parsed = JSON.parse(body) as { actions?: unknown[] } | unknown[];
      const actions = Array.isArray(parsed) ? parsed : parsed.actions;
      if (!Array.isArray(actions)) continue;

      for (const raw of actions) {
        if (!raw || typeof raw !== 'object') continue;
        const candidate = raw as Record<string, unknown>;
        const action = String(candidate.action || '');
        if (!action) continue;

        const params: Record<string, unknown> = (candidate.params && typeof candidate.params === 'object')
          ? candidate.params as Record<string, unknown>
          : {};

        result.push({
          action,
          params,
          description: candidate.description ? String(candidate.description) : undefined,
        });
      }
    } catch {
      // Ignore malformed agent_actions block.
    }
  }

  return result;
}

function draftFingerprint(draftType: string, payload: Record<string, unknown>): string {
  const basis = {
    draft_type: draftType,
    title: String(payload.title || '').trim().toLowerCase(),
    content: String(payload.content || '').trim().toLowerCase(),
  };
  return crypto.createHash('sha1').update(JSON.stringify(basis)).digest('hex');
}

async function persistStructuredAssistantOutput(params: {
  thread: KfdbService.AssistantThread;
  rawText: string;
  onDraftCreated?: (draft: KfdbService.AssistantDraft) => void;
  onActionProposed?: (proposal: KfdbService.AgentActionProposal) => void;
}): Promise<{ createdDrafts: KfdbService.AssistantDraft[]; createdActions: KfdbService.AgentActionProposal[] }> {
  const { thread, rawText, onDraftCreated, onActionProposed } = params;
  const createdDrafts: KfdbService.AssistantDraft[] = [];
  const createdActions: KfdbService.AgentActionProposal[] = [];

  const updates = parseResearchUpdates(rawText);
  for (const update of updates) {
    const fingerprint = draftFingerprint(update.draft_type, update.payload_json);
    const existing = await KfdbService.findAssistantDraftByFingerprint(thread.id, fingerprint);
    if (existing) continue;

    const created = await KfdbService.createAssistantDraft({
      thread_id: thread.id,
      entity_id: thread.context_ref_id || thread.entity_id,
      draft_type: update.draft_type,
      payload_json: update.payload_json,
      status: 'draft',
      fingerprint,
    });
    createdDrafts.push(created);
    onDraftCreated?.(created);
  }

  const agentActions = parseAgentActions(rawText);
  for (const action of agentActions) {
    try {
      const proposalId = crypto.randomUUID();
      const proposal = await KfdbService.createActionProposal({
        proposal_id: proposalId,
        action_type: action.action,
        description: action.description || `${action.action} action`,
        params_json: action.params,
        status: 'pending',
        wallet_address: thread.wallet_address,
        thread_id: thread.id,
      });
      createdActions.push(proposal);
      onActionProposed?.(proposal);
    } catch (err) {
      console.warn(`[Chat] Failed to create action proposal for ${action.action}:`, err);
    }
  }

  return { createdDrafts, createdActions };
}

async function verifyThreadOwnership(threadId: string, walletAddress: string): Promise<KfdbService.AssistantThread> {
  const thread = await KfdbService.getAssistantThread(threadId);
  if (thread.wallet_address.toLowerCase() !== walletAddress.toLowerCase()) {
    throw new Error('forbidden_thread_owner');
  }
  return thread;
}

async function getOrCreateThreadForContext(params: {
  walletAddress: string;
  agentId: AgentType;
  context: ChatContextService.ChatContext;
}): Promise<KfdbService.AssistantThread> {
  const { walletAddress, agentId, context } = params;
  const resolved = ChatContextService.resolveContext(context);

  if (context.threadId) {
    const existing = await verifyThreadOwnership(context.threadId, walletAddress);
    const existingContext = ChatContextService.getThreadContext(existing);
    if (
      existingContext.type !== resolved.type ||
      existingContext.refId.replace(/-/g, '').toLowerCase() !== resolved.refId.replace(/-/g, '').toLowerCase()
    ) {
      throw new Error('thread_context_mismatch');
    }
    return existing;
  }

  if (!context.newThread) {
    const active = await KfdbService.findActiveAssistantThread(walletAddress, resolved.type, resolved.refId);
    if (active) return active;
  }
  const title = await ChatContextService.getContextTitle(context);

  return KfdbService.createAssistantThread({
    entity_id: resolved.entityId,
    context_type: resolved.type,
    context_ref_id: resolved.refId,
    wallet_address: walletAddress,
    agent_id: agentId,
    title,
    status: 'active',
    latest_gateway_text_session_id: '',
    latest_gateway_voice_session_id: '',
  });
}

async function streamLegacySessionMessage(params: {
  res: Response;
  sessionId: string;
  meta: SessionMeta;
  message: string;
  model?: string;
  userGatewayToken?: string;
}) {
  const { res, sessionId, meta, message, model, userGatewayToken } = params;

  const stream = await AgentProxy.sendMessage(sessionId, message, meta.agentId, model || meta.model, userGatewayToken);
  if (!stream) {
    res.write(`data: ${JSON.stringify({ type: 'error', data: { message: 'No response stream from agent' } })}\n\n`);
    res.end();
    return;
  }

  const discoveredArxivIds = new Set<string>();

  for await (const event of AgentProxy.parseSSEStream(stream)) {
    const normalized = normalizeEvent(event);
    if (normalized) {
      res.write(`data: ${JSON.stringify(normalized)}\n\n`);
    }

    if (normalized?.type === 'text' && normalized.data?.text) {
      const arxivMatches = String(normalized.data.text).match(/\d{4}\.\d{4,5}/g);
      if (arxivMatches) {
        for (const arxivId of arxivMatches) {
          if (!discoveredArxivIds.has(arxivId)) {
            discoveredArxivIds.add(arxivId);
            res.write(`data: ${JSON.stringify({ type: 'paper_discovered', data: { arxivId } })}\n\n`);
          }
        }
      }
    }

    if (event.type === 'tool_result' && event.data?.name?.includes('create_research_ontology')) {
      let paperId: string | undefined;
      let title: string | undefined;
      let arxivId: string | undefined;

      try {
        const result = typeof event.data.result === 'string'
          ? JSON.parse(event.data.result.split('\n{"_payment"')[0])
          : event.data.result;
        paperId = result?.paper?.id || result?.paperId || result?.id;
        title = result?.paper?.name || result?.title || result?.paper?.title;
        arxivId = result?.arxivId || result?.paper?.arxivId;
      } catch {
        // Non-fatal parsing miss.
      }

      if (paperId || title) {
        res.write(`data: ${JSON.stringify({
          type: 'paper_created',
          data: { paperId, title, arxivId },
        })}\n\n`);
      }
    }
  }
}

async function streamThreadMessage(params: {
  res: Response;
  thread: KfdbService.AssistantThread;
  userMessage: string;
  model?: string;
  sessionId?: string;
  userGatewayToken?: string;
}) {
  const { res, thread, userMessage, model, sessionId, userGatewayToken } = params;
  const agentId = asValidAgent(thread.agent_id);

  await KfdbService.createAssistantMessage({
    thread_id: thread.id,
    role: 'user',
    content: userMessage,
    source: 'text',
  });

  const recentMessages = await KfdbService.listAssistantMessages(thread.id, 200);
  const drafts = await KfdbService.listAssistantDrafts(thread.id, undefined, 300);
  const hiddenPreamble = await ChatContextService.buildThreadContextPreamble({
    thread,
    recentMessages,
    drafts,
  });

  const composedMessage = `${hiddenPreamble}\n\nUSER MESSAGE:\n${userMessage}`;

  let effectiveSessionId = sessionId || thread.latest_gateway_text_session_id || '';
  if (!effectiveSessionId) {
    effectiveSessionId = await AgentProxy.createSession(agentId, model || 'haiku', userGatewayToken);
  }

  let stream: ReadableStream<Uint8Array> | null = null;
  try {
    stream = await AgentProxy.sendMessage(effectiveSessionId, composedMessage, agentId, model, userGatewayToken);
  } catch {
    // Session may be stale; create a fresh one and retry once.
    effectiveSessionId = await AgentProxy.createSession(agentId, model || 'haiku', userGatewayToken);
    stream = await AgentProxy.sendMessage(effectiveSessionId, composedMessage, agentId, model, userGatewayToken);
  }

  if (!stream) {
    throw new Error('No response stream from agent');
  }

  await KfdbService.updateAssistantThread(thread.id, {
    latest_gateway_text_session_id: effectiveSessionId,
  });

  let assistantRawText = '';
  let assistantTextSentLength = 0;
  const discoveredArxivIds = new Set<string>();

  for await (const event of AgentProxy.parseSSEStream(stream)) {
    const normalized = normalizeEvent(event);
    if (!normalized) continue;

    if (normalized.type === 'text' && normalized.data?.text) {
      assistantRawText += String(normalized.data.text);
      const cleanText = stripAgentActionsBlocks(stripResearchUpdatesBlocks(assistantRawText));
      const delta = cleanText.slice(assistantTextSentLength);
      if (delta.length > 0) {
        assistantTextSentLength = cleanText.length;
        res.write(`data: ${JSON.stringify({ type: 'text', data: { text: delta } })}\n\n`);

        const arxivMatches = delta.match(/\d{4}\.\d{4,5}/g);
        if (arxivMatches) {
          for (const arxivId of arxivMatches) {
            if (!discoveredArxivIds.has(arxivId)) {
              discoveredArxivIds.add(arxivId);
              res.write(`data: ${JSON.stringify({ type: 'paper_discovered', data: { arxivId } })}\n\n`);
            }
          }
        }
      }
      continue;
    }

    if (
      normalized.type === 'tool_call' ||
      normalized.type === 'tool_result' ||
      normalized.type === 'error' ||
      normalized.type === 'done'
    ) {
      res.write(`data: ${JSON.stringify(normalized)}\n\n`);
    }
  }

  const cleanAssistantText = stripAgentActionsBlocks(stripResearchUpdatesBlocks(assistantRawText));
  if (cleanAssistantText.trim().length > 0) {
    await KfdbService.createAssistantMessage({
      thread_id: thread.id,
      role: 'assistant',
      content: cleanAssistantText,
      source: 'text',
    });
  }

  await persistStructuredAssistantOutput({
    thread,
    rawText: assistantRawText,
    onDraftCreated: (created) => {
      res.write(`data: ${JSON.stringify({ type: 'draft_created', data: created })}\n\n`);
    },
    onActionProposed: (proposal) => {
      res.write(`data: ${JSON.stringify({ type: 'agent_action_proposed', data: proposal })}\n\n`);
    },
  });

  await KfdbService.updateAssistantThread(thread.id, {
    latest_gateway_text_session_id: effectiveSessionId,
  });
}

async function bootstrapVoiceSessionForThread(params: {
  thread: KfdbService.AssistantThread;
  agentId?: string;
  model?: string;
  voice?: string;
  userGatewayToken?: string;
}) {
  const { thread, agentId, model, voice, userGatewayToken } = params;
  const resolvedAgentId = asValidAgent(agentId || thread.agent_id);
  const effectiveModel = model || 'haiku';

  const contextBrief = await ChatContextService.buildVoiceContextBrief(thread);

  const livekit = await AgentProxy.requestLivekitVoiceToken(resolvedAgentId, { voice }, userGatewayToken);

  // Keep the gateway billing/session tracking aligned with Agentbook's voice flow.
  let billingSessionId = livekit.sessionId;
  try {
    const started = await AgentProxy.startVoiceSession(resolvedAgentId, { model: effectiveModel }, userGatewayToken);
    if (started.sessionId) billingSessionId = started.sessionId;
  } catch {
    // Non-fatal: livekit session is still valid for transport.
  }

  const seedMessage = `Internal context bootstrap for voice session. Do not acknowledge this message.\n\n${contextBrief}`;
  const seedStream = await AgentProxy.sendMessage(livekit.sessionId, seedMessage, resolvedAgentId, effectiveModel, userGatewayToken);
  if (!seedStream) {
    throw new Error('Failed to seed voice session context');
  }
  for await (const _event of AgentProxy.parseSSEStream(seedStream)) {
    // Drain stream; we only need the session primed with context.
  }

  await KfdbService.updateAssistantThread(thread.id, {
    latest_gateway_voice_session_id: billingSessionId,
  });

  return {
    agentId: resolvedAgentId,
    threadId: thread.id,
    entityId: thread.entity_id,
    livekit,
    billingSessionId,
    contextSeeded: true,
  };
}

router.post('/sessions', authRequired, async (req: Request, res: Response) => {
  try {
    const userGatewayToken = req.headers['x-gateway-token'] as string | undefined;
    console.log('[Chat] POST /sessions - X-Gateway-Token header:', userGatewayToken ? 'present' : 'missing');
    const { agentId, model, context } = req.body as {
      agentId?: string;
      model?: string;
      context?: ChatContextService.ChatContext;
    };

    if (!agentId) {
      res.status(400).json({ error: 'agentId is required' });
      return;
    }

    if (!VALID_AGENTS.includes(agentId as AgentType)) {
      res.status(400).json({ error: `Invalid agentId. Must be one of: ${VALID_AGENTS.join(', ')}` });
      return;
    }

    let thread: KfdbService.AssistantThread | null = null;
    if (context) {
      const isValidContext =
        (context.type === 'published_paper' && Boolean(context.entityId)) ||
        (context.type === 'discovery_paper' && Boolean(context.paperId)) ||
        (context.type === 'review_item' && Boolean(context.reviewId)) ||
        context.type === 'general';

      if (!isValidContext) {
        res.status(400).json({ error: 'Invalid context payload' });
        return;
      }
      thread = await getOrCreateThreadForContext({
        walletAddress: req.wallet!.address,
        agentId: agentId as AgentType,
        context,
      });
    }

    const sessionId = await AgentProxy.createSession(agentId as AgentType, model, userGatewayToken);
    const meta: SessionMeta = {
      agentId: agentId as AgentType,
      createdBy: req.wallet!.address,
      createdAt: new Date().toISOString(),
      model,
      threadId: thread?.id,
      contextType: thread?.context_type,
      contextRefId: thread?.context_ref_id,
    };
    sessionMeta.set(sessionId, meta);

    if (thread) {
      await KfdbService.updateAssistantThread(thread.id, {
        latest_gateway_text_session_id: sessionId,
      });
    }

    res.json({
      sessionId,
      agentId,
      createdAt: meta.createdAt,
      threadId: thread?.id || null,
      contextType: thread?.context_type || null,
      contextRefId: thread?.context_ref_id || null,
    });
  } catch (err: any) {
    if (err?.message === 'forbidden_thread_owner') {
      res.status(403).json({ error: 'Thread does not belong to this wallet' });
      return;
    }
    if (err?.message === 'thread_context_mismatch') {
      res.status(400).json({ error: 'Provided thread does not match requested entity context' });
      return;
    }
    res.status(500).json({ error: err.message });
  }
});

router.get('/sessions/:sessionId', authRequired, async (req: Request, res: Response) => {
  const sessionId = req.params.sessionId as string;
  const meta = sessionMeta.get(sessionId);

  if (!meta) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  if (meta.createdBy.toLowerCase() !== req.wallet!.address.toLowerCase()) {
    res.status(403).json({ error: 'Session does not belong to this wallet' });
    return;
  }

  res.json({ sessionId, ...meta });
});

router.get('/threads', authRequired, async (req: Request, res: Response) => {
  try {
    const entityId = String(req.query.entityId || '');
    const contextType = String(req.query.contextType || '') as KfdbService.AssistantThread['context_type'] | '';
    const contextRefId = String(req.query.contextRefId || '');
    const status = String(req.query.status || '') as KfdbService.AssistantThread['status'] | '';

    const threads = await KfdbService.listAssistantThreads({
      walletAddress: req.wallet!.address,
      entityId: entityId || undefined,
      contextType: contextType || undefined,
      contextRefId: contextRefId || undefined,
      status: status || undefined,
      limit: 200,
    });

    res.json({ threads });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/threads/:threadId', authRequired, async (req: Request, res: Response) => {
  try {
    const threadId = req.params.threadId as string;
    const thread = await verifyThreadOwnership(threadId, req.wallet!.address);
    res.json({ thread });
  } catch (err: any) {
    if (err?.message === 'forbidden_thread_owner') {
      res.status(403).json({ error: 'Thread does not belong to this wallet' });
      return;
    }
    res.status(404).json({ error: 'Thread not found' });
  }
});

router.get('/threads/:threadId/messages', authRequired, async (req: Request, res: Response) => {
  try {
    const threadId = req.params.threadId as string;
    await verifyThreadOwnership(threadId, req.wallet!.address);
    const messages = await KfdbService.listAssistantMessages(threadId, 1000);
    res.json({ messages });
  } catch (err: any) {
    if (err?.message === 'forbidden_thread_owner') {
      res.status(403).json({ error: 'Thread does not belong to this wallet' });
      return;
    }
    res.status(404).json({ error: 'Thread not found' });
  }
});

router.get('/threads/:threadId/drafts', authRequired, async (req: Request, res: Response) => {
  try {
    const threadId = req.params.threadId as string;
    await verifyThreadOwnership(threadId, req.wallet!.address);
    const status = String(req.query.status || '') as KfdbService.AssistantDraft['status'] | '';
    const drafts = await KfdbService.listAssistantDrafts(threadId, status || undefined, 1000);
    res.json({ drafts });
  } catch (err: any) {
    if (err?.message === 'forbidden_thread_owner') {
      res.status(403).json({ error: 'Thread does not belong to this wallet' });
      return;
    }
    res.status(404).json({ error: 'Thread not found' });
  }
});

router.post('/threads/:threadId/messages', authRequired, async (req: Request, res: Response) => {
  const threadId = req.params.threadId as string;
  const userGatewayToken = req.headers['x-gateway-token'] as string | undefined;
  console.log('[Chat] POST /threads/:threadId/messages - X-Gateway-Token header:', userGatewayToken ? 'present' : 'missing');
  const { message, model, sessionId } = req.body as {
    message?: string;
    model?: string;
    sessionId?: string;
  };

  if (!message?.trim()) {
    res.status(400).json({ error: 'message is required' });
    return;
  }

  try {
    const thread = await verifyThreadOwnership(threadId, req.wallet!.address);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    let streamTimedOut = false;
    const timeoutId = setTimeout(() => {
      streamTimedOut = true;
      res.write(`data: ${JSON.stringify({ type: 'error', data: { message: 'Agent stream timed out' } })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'stream_end' })}\n\n`);
      res.end();
    }, STREAM_TIMEOUT_MS);

    try {
      await streamThreadMessage({
        res,
        thread,
        userMessage: message.trim(),
        model,
        sessionId,
        userGatewayToken,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!streamTimedOut) {
      res.write(`data: ${JSON.stringify({ type: 'stream_end' })}\n\n`);
      res.end();
    }
  } catch (err: any) {
    if (err?.message === 'forbidden_thread_owner') {
      res.status(403).json({ error: 'Thread does not belong to this wallet' });
      return;
    }
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.write(`data: ${JSON.stringify({ type: 'error', data: { message: err.message } })}\n\n`);
    res.end();
  }
});

router.post('/threads/:threadId/voice-transcript', authRequired, async (req: Request, res: Response) => {
  try {
    const threadId = req.params.threadId as string;
    const { role, content, gatewayMessageId } = req.body as {
      role?: KfdbService.AssistantMessage['role'];
      content?: string;
      gatewayMessageId?: string;
    };

    if (!content?.trim()) {
      res.status(400).json({ error: 'content is required' });
      return;
    }

    const thread = await verifyThreadOwnership(threadId, req.wallet!.address);
    const roleValue = role || 'assistant';
    const rawContent = content.trim();
    const visibleContent = roleValue === 'assistant'
      ? stripAgentActionsBlocks(stripResearchUpdatesBlocks(rawContent)).trim()
      : rawContent;

    let message: KfdbService.AssistantMessage | null = null;
    if (visibleContent.length > 0) {
      message = await KfdbService.createAssistantMessage({
        thread_id: threadId,
        role: roleValue,
        content: visibleContent,
        source: 'voice',
        gateway_message_id: gatewayMessageId || '',
      });
    }

    let createdDrafts: KfdbService.AssistantDraft[] = [];
    let createdActions: KfdbService.AgentActionProposal[] = [];
    if (roleValue === 'assistant') {
      const structured = await persistStructuredAssistantOutput({
        thread,
        rawText: rawContent,
      });
      createdDrafts = structured.createdDrafts;
      createdActions = structured.createdActions;
    }

    res.json({ message, drafts: createdDrafts, actions: createdActions });
  } catch (err: any) {
    if (err?.message === 'forbidden_thread_owner') {
      res.status(403).json({ error: 'Thread does not belong to this wallet' });
      return;
    }
    res.status(404).json({ error: 'Thread not found' });
  }
});

router.post('/voice/connect', authRequired, async (req: Request, res: Response) => {
  try {
    const userGatewayToken = req.headers['x-gateway-token'] as string | undefined;
    const { threadId, agentId, model, voice } = req.body as {
      threadId?: string;
      agentId?: string;
      model?: string;
      voice?: string;
    };

    if (!threadId) {
      res.status(400).json({ error: 'threadId is required' });
      return;
    }

    const thread = await verifyThreadOwnership(threadId, req.wallet!.address);
    const started = await bootstrapVoiceSessionForThread({
      thread,
      agentId,
      model,
      voice,
      userGatewayToken,
    });

    res.json(started);
  } catch (err: any) {
    if (err?.message === 'forbidden_thread_owner') {
      res.status(403).json({ error: 'Thread does not belong to this wallet' });
      return;
    }
    res.status(500).json({ error: err.message || 'Failed to bootstrap voice session' });
  }
});

router.post('/voice/disconnect', authRequired, async (req: Request, res: Response) => {
  try {
    const userGatewayToken = req.headers['x-gateway-token'] as string | undefined;
    const { threadId, agentId, sessionId, durationMs } = req.body as {
      threadId?: string;
      agentId?: string;
      sessionId?: string;
      durationMs?: number;
    };

    if (!threadId) {
      res.status(400).json({ error: 'threadId is required' });
      return;
    }

    const thread = await verifyThreadOwnership(threadId, req.wallet!.address);
    const resolvedAgentId = asValidAgent(agentId || thread.agent_id);
    const targetSessionId = sessionId || thread.latest_gateway_voice_session_id || '';
    if (!targetSessionId) {
      res.json({ ended: false, warning: 'No active voice session id found' });
      return;
    }

    const safeDurationMs = Math.max(0, Math.floor(Number(durationMs) || 0));
    let ended = false;
    let warning: string | null = null;

    try {
      await AgentProxy.endVoiceSession(resolvedAgentId, {
        sessionId: targetSessionId,
        durationMs: safeDurationMs,
      }, userGatewayToken);
      ended = true;
    } catch (err: any) {
      warning = err?.message || 'Failed to end voice session cleanly';
    }

    await KfdbService.updateAssistantThread(thread.id, {
      latest_gateway_voice_session_id: targetSessionId,
    });

    res.json({
      ended,
      warning,
      sessionId: targetSessionId,
    });
  } catch (err: any) {
    if (err?.message === 'forbidden_thread_owner') {
      res.status(403).json({ error: 'Thread does not belong to this wallet' });
      return;
    }
    res.status(500).json({ error: err.message || 'Failed to end voice session' });
  }
});

router.post('/drafts/:draftId/accept', authRequired, async (req: Request, res: Response) => {
  try {
    const draftId = req.params.draftId as string;
    const draft = await KfdbService.getAssistantDraft(draftId);
    const thread = await verifyThreadOwnership(draft.thread_id, req.wallet!.address);

    let promotedClaimId: string | null = null;

    if (draft.draft_type === 'claim') {
      const promotionPaperId = await ChatContextService.resolveDraftPromotionPaperId(thread);
      if (promotionPaperId) {
        const existingClaims = await KfdbService.getClaimsForPaper(promotionPaperId);
        const claimContent = String(draft.payload_json.content || draft.payload_json.title || '').trim();

        if (claimContent) {
          const created = await KfdbService.createExtractedClaim({
            paper_kfdb_id: promotionPaperId,
            text: claimContent,
            position: existingClaims.length,
            role: String(draft.payload_json.role || 'contribution') || 'contribution',
            source_quote: String(draft.payload_json.evidence || ''),
            status: 'pending',
            edited_text: '',
            edited_by: '',
            confidence_score: typeof draft.payload_json.confidence === 'number' ? Number(draft.payload_json.confidence) : undefined,
          });
          promotedClaimId = created.id;
        }
      }
    }

    const updated = await KfdbService.updateAssistantDraft(draft.id, {
      status: 'accepted',
      payload_json: {
        ...draft.payload_json,
        promoted_claim_id: promotedClaimId,
      },
    });

    res.json({ draft: updated, promotedClaimId });
  } catch (err: any) {
    if (err?.message === 'forbidden_thread_owner') {
      res.status(403).json({ error: 'Draft does not belong to this wallet' });
      return;
    }
    res.status(404).json({ error: 'Draft not found' });
  }
});

router.put('/drafts/:draftId', authRequired, async (req: Request, res: Response) => {
  try {
    const draftId = req.params.draftId as string;
    const draft = await KfdbService.getAssistantDraft(draftId);
    await verifyThreadOwnership(draft.thread_id, req.wallet!.address);

    const { payload_json, draft_type } = req.body as {
      payload_json?: Record<string, unknown>;
      draft_type?: KfdbService.AssistantDraft['draft_type'];
    };

    const updated = await KfdbService.updateAssistantDraft(draft.id, {
      draft_type: draft_type || draft.draft_type,
      payload_json: payload_json || draft.payload_json,
    });

    res.json({ draft: updated });
  } catch (err: any) {
    if (err?.message === 'forbidden_thread_owner') {
      res.status(403).json({ error: 'Draft does not belong to this wallet' });
      return;
    }
    res.status(404).json({ error: 'Draft not found' });
  }
});

router.post('/drafts/:draftId/dismiss', authRequired, async (req: Request, res: Response) => {
  try {
    const draftId = req.params.draftId as string;
    const draft = await KfdbService.getAssistantDraft(draftId);
    await verifyThreadOwnership(draft.thread_id, req.wallet!.address);
    const updated = await KfdbService.updateAssistantDraft(draft.id, { status: 'dismissed' });
    res.json({ draft: updated });
  } catch (err: any) {
    if (err?.message === 'forbidden_thread_owner') {
      res.status(403).json({ error: 'Draft does not belong to this wallet' });
      return;
    }
    res.status(404).json({ error: 'Draft not found' });
  }
});

router.get('/voice/context-brief', authRequired, async (req: Request, res: Response) => {
  try {
    const threadId = String(req.query.threadId || '');
    if (!threadId) {
      res.status(400).json({ error: 'threadId is required' });
      return;
    }

    const thread = await verifyThreadOwnership(threadId, req.wallet!.address);
    const brief = await ChatContextService.buildVoiceContextBrief(thread);
    const threadContext = ChatContextService.getThreadContext(thread);

    res.json({
      threadId: thread.id,
      entityId: thread.entity_id,
      contextType: threadContext.type,
      contextRefId: threadContext.refId,
      latestGatewayVoiceSessionId: thread.latest_gateway_voice_session_id || null,
      contextBrief: brief,
    });
  } catch (err: any) {
    if (err?.message === 'forbidden_thread_owner') {
      res.status(403).json({ error: 'Thread does not belong to this wallet' });
      return;
    }
    res.status(404).json({ error: 'Thread not found' });
  }
});

router.post('/sessions/:sessionId/messages', authRequired, async (req: Request, res: Response) => {
  const sessionId = req.params.sessionId as string;
  const userGatewayToken = req.headers['x-gateway-token'] as string | undefined;
  console.log('[Chat] POST /sessions/:sessionId/messages - X-Gateway-Token header:', userGatewayToken ? 'present' : 'missing');
  const { message, model } = req.body as { message?: string; model?: string };

  if (!message?.trim()) {
    res.status(400).json({ error: 'message is required' });
    return;
  }

  const meta = sessionMeta.get(sessionId);
  if (!meta) {
    res.status(404).json({ error: 'Session not found. Create a session first.' });
    return;
  }

  if (meta.createdBy.toLowerCase() !== req.wallet!.address.toLowerCase()) {
    res.status(403).json({ error: 'Session does not belong to this wallet' });
    return;
  }

  try {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    let streamTimedOut = false;
    const timeoutId = setTimeout(() => {
      streamTimedOut = true;
      res.write(`data: ${JSON.stringify({ type: 'error', data: { message: 'Agent stream timed out' } })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'stream_end' })}\n\n`);
      res.end();
    }, STREAM_TIMEOUT_MS);

    try {
      if (meta.threadId) {
        const thread = await verifyThreadOwnership(meta.threadId, req.wallet!.address);
        await streamThreadMessage({
          res,
          thread,
          userMessage: message.trim(),
          model,
          sessionId,
          userGatewayToken,
        });
      } else {
        await streamLegacySessionMessage({
          res,
          sessionId,
          meta,
          message: message.trim(),
          model,
          userGatewayToken,
        });
      }
    } finally {
      clearTimeout(timeoutId);
    }

    if (!streamTimedOut) {
      res.write(`data: ${JSON.stringify({ type: 'stream_end' })}\n\n`);
      res.end();
    }
  } catch (err: any) {
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.write(`data: ${JSON.stringify({ type: 'error', data: { message: err.message } })}\n\n`);
    res.end();
  }
});

router.post('/actions/:proposalId/confirm', authRequired, async (req: Request, res: Response) => {
  try {
    const proposalId = req.params.proposalId as string;
    const proposal = await KfdbService.getActionProposal(proposalId);

    if (proposal.wallet_address.toLowerCase() !== req.wallet!.address.toLowerCase()) {
      res.status(403).json({ error: 'Action proposal does not belong to this wallet' });
      return;
    }

    if (proposal.status !== 'pending') {
      res.status(400).json({ error: `Proposal status is "${proposal.status}", expected "pending"` });
      return;
    }

    await KfdbService.updateActionProposal(proposal.id, { status: 'confirmed' });

    try {
      const result = await AgentActionExecutor.executeAction(
        proposal.action_type as AgentActionExecutor.ActionType,
        proposal.params_json,
        req.wallet!.address,
      );

      await KfdbService.updateActionProposal(proposal.id, {
        status: 'completed',
        result_json: result.result,
        completed_at: new Date().toISOString(),
      });

      res.json({ result, revalidateKeys: result.revalidateKeys });
    } catch (execErr: any) {
      await KfdbService.updateActionProposal(proposal.id, {
        status: 'failed',
        result_json: { error: execErr.message },
        completed_at: new Date().toISOString(),
      });

      res.status(500).json({ error: execErr.message });
    }
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.post('/actions/:proposalId/reject', authRequired, async (req: Request, res: Response) => {
  try {
    const proposalId = req.params.proposalId as string;
    const proposal = await KfdbService.getActionProposal(proposalId);

    if (proposal.wallet_address.toLowerCase() !== req.wallet!.address.toLowerCase()) {
      res.status(403).json({ error: 'Action proposal does not belong to this wallet' });
      return;
    }

    if (proposal.status !== 'pending') {
      res.status(400).json({ error: `Proposal status is "${proposal.status}", expected "pending"` });
      return;
    }

    await KfdbService.updateActionProposal(proposal.id, { status: 'rejected' });

    res.json({ status: 'rejected' });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

export default router;
