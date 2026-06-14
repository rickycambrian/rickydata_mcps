import { createHash } from 'node:crypto';

export const PRODUCT_COPILOT_APP_ID = 'rickydata.product-copilot';
export const PRODUCT_COPILOT_SCHEMA_VERSION = '1.0.0';
const PRODUCT_COPILOT_SCHEMA_NAMESPACE = '9f8cb3a6-7964-58d6-8e7c-7ce30ecdb9cc';

export interface PrivateTenantConfig {
  baseUrl?: string;
  walletAddress: string;
  authToken?: string;
  deriveSessionId?: string;
  deriveKey?: string;
}

export interface SetupProductCopilotOptions {
  env?: Record<string, string | undefined>;
  fetcher?: typeof fetch;
  now?: () => string;
  dryRun?: boolean;
  schemaVersion?: string;
}

export interface TenantSchemaIds {
  wallet: string;
  tenantId: string;
  schemaId: string;
  bootstrapId: string;
  tenantSchemaEdgeId: string;
  bootstrapSchemaEdgeId: string;
}

export interface SetupStatus {
  ok: boolean;
  status: 'missing_wallet_context' | 'wallet_auth_write_unavailable' | 'dry_run' | 'initialized' | 'already_initialized' | 'initialized_or_already_exists';
  appId: string;
  schemaVersion: string;
  idempotent: true;
  missingContext?: string[];
  feedConfigured: boolean;
  existingSchema?: boolean;
  operationsPlanned?: number;
  operationsWritten?: number;
  ids?: TenantSchemaIds;
  labels?: string[];
  edges?: string[];
  proof?: string[];
  nextSteps: string[];
}

export function uuidV5(name: string, namespace: string): string {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const hash = createHash('sha1').update(Buffer.concat([ns, Buffer.from(name)])).digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const kfStr = (value: string) => ({ String: value });
const kfBool = (value: boolean) => ({ Boolean: value });

export function resolvePrivateTenantConfig(env: Record<string, string | undefined> = process.env): {
  config?: PrivateTenantConfig;
  missingContext: string[];
  feedConfigured: boolean;
} {
  const baseUrl = env.PRODUCT_COPILOT_KFDB_API_URL || env.RICKYDATA_KFDB_URL || env.KFDB_API_URL;
  const walletAddress = env.PRODUCT_COPILOT_WALLET_ADDRESS
    || env.RICKYDATA_KFDB_WALLET_ADDRESS
    || env.RICKYDATA_AUTH_WALLET_ADDRESS
    || env.RICKYDATA_WALLET_ADDRESS;
  const authToken = env.RICKYDATA_KFDB_AUTH_TOKEN || env.RICKYDATA_AUTH_TOKEN;
  const deriveSessionId = env.RICKYDATA_KFDB_DERIVE_SESSION_ID
    || env.RICKYDATA_DERIVE_SESSION_ID
    || env.PRODUCT_COPILOT_KFDB_DERIVE_SESSION_ID;
  const deriveKey = env.RICKYDATA_KFDB_DERIVE_KEY
    || env.RICKYDATA_DERIVE_KEY
    || env.PRODUCT_COPILOT_KFDB_DERIVE_KEY;
  const missingContext: string[] = [];
  if (!walletAddress) missingContext.push('authenticated wallet context from RickyData Gateway');

  return {
    config: missingContext.length === 0 ? {
      baseUrl,
      walletAddress: walletAddress!,
      authToken,
      deriveSessionId,
      deriveKey,
    } : undefined,
    missingContext,
    feedConfigured: Boolean(env.PRODUCT_COPILOT_PM_REPORT_URL || env.PRODUCT_COPILOT_PM_REPORT_PATH),
  };
}

export function productCopilotSchemaIds(walletAddress: string, schemaVersion = PRODUCT_COPILOT_SCHEMA_VERSION): TenantSchemaIds {
  const wallet = walletAddress.toLowerCase();
  const tenantId = uuidV5(`wallet-tenant:${wallet}`, PRODUCT_COPILOT_SCHEMA_NAMESPACE);
  const schemaId = uuidV5(`schema:${PRODUCT_COPILOT_APP_ID}:${schemaVersion}`, PRODUCT_COPILOT_SCHEMA_NAMESPACE);
  const bootstrapId = uuidV5(`bootstrap:${wallet}:${PRODUCT_COPILOT_APP_ID}:${schemaVersion}`, PRODUCT_COPILOT_SCHEMA_NAMESPACE);
  return {
    wallet,
    tenantId,
    schemaId,
    bootstrapId,
    tenantSchemaEdgeId: uuidV5(`edge:${tenantId}:HAS_SCHEMA_BOOTSTRAP:${bootstrapId}`, PRODUCT_COPILOT_SCHEMA_NAMESPACE),
    bootstrapSchemaEdgeId: uuidV5(`edge:${bootstrapId}:USES_SCHEMA_VERSION:${schemaId}`, PRODUCT_COPILOT_SCHEMA_NAMESPACE),
  };
}

export function productCopilotSchemaOperations(config: PrivateTenantConfig, opts: { now: string; schemaVersion?: string }): Array<Record<string, unknown>> {
  const schemaVersion = opts.schemaVersion ?? PRODUCT_COPILOT_SCHEMA_VERSION;
  const ids = productCopilotSchemaIds(config.walletAddress, schemaVersion);
  const labels = [
    'WalletTenant',
    'AppSchemaVersion',
    'SchemaBootstrap',
    'RoadmapItem',
    'EvidenceRecord',
    'DecisionRecord',
    'ProductCopilotFeedSnapshot',
  ];

  return [
    {
      operation: 'create_node',
      mode: 'merge',
      id: ids.tenantId,
      label: 'WalletTenant',
      properties: {
        wallet_address: kfStr(ids.wallet),
        private_tenant: kfBool(true),
        updated_at: kfStr(opts.now),
      },
    },
    {
      operation: 'create_node',
      mode: 'merge',
      id: ids.schemaId,
      label: 'AppSchemaVersion',
      properties: {
        app_id: kfStr(PRODUCT_COPILOT_APP_ID),
        schema_version: kfStr(schemaVersion),
        schema_labels_json: kfStr(JSON.stringify(labels)),
        private_tenant_required: kfBool(true),
        status: kfStr('active'),
        updated_at: kfStr(opts.now),
      },
    },
    {
      operation: 'create_node',
      mode: 'merge',
      id: ids.bootstrapId,
      label: 'SchemaBootstrap',
      properties: {
        app_id: kfStr(PRODUCT_COPILOT_APP_ID),
        schema_version: kfStr(schemaVersion),
        wallet_address: kfStr(ids.wallet),
        idempotency_key: kfStr(`${ids.wallet}:${PRODUCT_COPILOT_APP_ID}:${schemaVersion}`),
        status: kfStr('initialized'),
        initialized_at: kfStr(opts.now),
      },
    },
    {
      operation: 'create_edge',
      mode: 'merge',
      id: ids.tenantSchemaEdgeId,
      from: ids.tenantId,
      to: ids.bootstrapId,
      edge_type: 'HAS_SCHEMA_BOOTSTRAP',
      properties: { app_id: kfStr(PRODUCT_COPILOT_APP_ID) },
    },
    {
      operation: 'create_edge',
      mode: 'merge',
      id: ids.bootstrapSchemaEdgeId,
      from: ids.bootstrapId,
      to: ids.schemaId,
      edge_type: 'USES_SCHEMA_VERSION',
      properties: { app_id: kfStr(PRODUCT_COPILOT_APP_ID) },
    },
  ];
}

function privateTenantHeaders(config: PrivateTenantConfig): HeadersInit {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'X-Wallet-Address': config.walletAddress,
  };
  if (config.authToken) headers.authorization = `Bearer ${config.authToken}`;
  if (config.deriveSessionId) headers['X-Derive-Session-Id'] = config.deriveSessionId;
  if (config.deriveKey) headers['X-Derive-Key'] = config.deriveKey;
  return headers;
}

function extractRows(payload: unknown): unknown[] {
  if (!payload || typeof payload !== 'object') return [];
  const obj = payload as Record<string, unknown>;
  if (Array.isArray(obj.rows)) return obj.rows;
  if (Array.isArray(obj.data)) return obj.data;
  const result = obj.result;
  if (result && typeof result === 'object') {
    const nested = result as Record<string, unknown>;
    if (Array.isArray(nested.rows)) return nested.rows;
    if (Array.isArray(nested.data)) return nested.data;
  }
  return [];
}

export async function productCopilotSchemaExists(
  config: PrivateTenantConfig,
  opts: { fetcher?: typeof fetch; schemaVersion?: string } = {},
): Promise<boolean> {
  if (!config.baseUrl || !config.authToken || !config.deriveSessionId || !config.deriveKey) return false;
  const ids = productCopilotSchemaIds(config.walletAddress, opts.schemaVersion ?? PRODUCT_COPILOT_SCHEMA_VERSION);
  const fetcher = opts.fetcher ?? fetch;
  const base = config.baseUrl.replace(/\/$/, '');
  const query = `MATCH (b:SchemaBootstrap) WHERE b.id = '${ids.bootstrapId}' RETURN b.id LIMIT 1`;
  const res = await fetcher(`${base}/api/v1/query`, {
    method: 'POST',
    headers: privateTenantHeaders(config),
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Product Copilot private schema check failed: ${res.status} ${text.slice(0, 300)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = {};
  }
  return extractRows(parsed).length > 0;
}

export function privateSetupGuidance(error?: unknown, env: Record<string, string | undefined> = process.env): SetupStatus {
  const resolved = resolvePrivateTenantConfig(env);
  return {
    ok: false,
    status: resolved.config ? 'wallet_auth_write_unavailable' : 'missing_wallet_context',
    appId: PRODUCT_COPILOT_APP_ID,
    schemaVersion: PRODUCT_COPILOT_SCHEMA_VERSION,
    idempotent: true,
    missingContext: resolved.missingContext,
    feedConfigured: resolved.feedConfigured,
    proof: error instanceof Error ? [`blocked_before_private_read: ${error.message}`] : undefined,
    nextSteps: resolved.config
      ? [
        'Gateway provided wallet context, but the MCP runtime is missing wallet-auth private tenant read/write capability.',
        'Forward the logged-in wallet/session token as platform context; do not ask the user to store KFDB/API keys.',
        'Rerun setup_private_product_copilot; it will check existing schema and only create it if missing.',
      ]
      : [
        'Authenticate through RickyData Gateway / Privy so the MCP receives wallet context automatically.',
        'Do not store Product Copilot KFDB API keys as user secrets.',
        'Do not enable public/shared fallback for Product Copilot user/app data.',
      ],
  };
}

export async function setupProductCopilotPrivateTenant(options: SetupProductCopilotOptions = {}): Promise<SetupStatus> {
  const env = options.env ?? process.env;
  const schemaVersion = options.schemaVersion ?? PRODUCT_COPILOT_SCHEMA_VERSION;
  const resolved = resolvePrivateTenantConfig(env);
  if (!resolved.config) {
    return {
      ok: false,
      status: 'missing_wallet_context',
      appId: PRODUCT_COPILOT_APP_ID,
      schemaVersion,
      idempotent: true,
      missingContext: resolved.missingContext,
      feedConfigured: resolved.feedConfigured,
      nextSteps: [
        'Authenticate through RickyData Gateway / Privy; the logged-in wallet is the auth boundary.',
        'Rerun setup_private_product_copilot; it is safe to run repeatedly.',
      ],
    };
  }

  const now = options.now?.() ?? new Date().toISOString();
  const ids = productCopilotSchemaIds(resolved.config.walletAddress, schemaVersion);
  const operations = productCopilotSchemaOperations(resolved.config, { now, schemaVersion });
  const labels = operations.filter((op) => op.operation === 'create_node').map((op) => String(op.label));
  const edges = operations.filter((op) => op.operation === 'create_edge').map((op) => String(op.edge_type));

  if (options.dryRun || !resolved.config.baseUrl || !resolved.config.authToken || !resolved.config.deriveSessionId || !resolved.config.deriveKey) {
    return {
      ok: true,
      status: options.dryRun ? 'dry_run' : 'wallet_auth_write_unavailable',
      appId: PRODUCT_COPILOT_APP_ID,
      schemaVersion,
      idempotent: true,
      feedConfigured: resolved.feedConfigured,
      existingSchema: false,
      operationsPlanned: operations.length,
      ids,
      labels,
      edges,
      proof: [
        'planned deterministic schema ids only; no unauthenticated private write performed',
        `wallet_context_present: ${Boolean(resolved.config.walletAddress)}`,
        `wallet_auth_endpoint_present: ${Boolean(resolved.config.baseUrl && resolved.config.authToken)}`,
        `wallet_derive_session_present: ${Boolean(resolved.config.deriveSessionId && resolved.config.deriveKey)}`,
      ],
      nextSteps: options.dryRun
        ? ['Run setup_private_product_copilot with dry_run=false after gateway provides wallet-auth KFDB write capability.']
        : ['Gateway wallet context is present, but the wallet sign-to-derive session headers are not exposed to this MCP runtime yet.'],
    };
  }

  const fetcher = options.fetcher ?? fetch;
  const base = resolved.config.baseUrl.replace(/\/$/, '');
  const existing = await productCopilotSchemaExists(resolved.config, { fetcher, schemaVersion });
  if (existing) {
    return {
      ok: true,
      status: 'already_initialized',
      appId: PRODUCT_COPILOT_APP_ID,
      schemaVersion,
      idempotent: true,
      feedConfigured: resolved.feedConfigured,
      existingSchema: true,
      operationsPlanned: 0,
      operationsWritten: 0,
      ids,
      labels,
      edges,
      proof: [
        'wallet-auth private tenant schema check succeeded',
        'existing SchemaBootstrap found; no schema write performed',
      ],
      nextSteps: ['Private schema already exists for this wallet/app/version; read tools can use existing tenant records.'],
    };
  }

  const res = await fetcher(`${base}/api/v1/write`, {
    method: 'POST',
    headers: privateTenantHeaders(resolved.config),
    body: JSON.stringify({ operations }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Product Copilot private schema setup failed: ${res.status} ${text.slice(0, 300)}`);
  }

  return {
    ok: true,
    status: 'initialized',
    appId: PRODUCT_COPILOT_APP_ID,
    schemaVersion,
    idempotent: true,
    feedConfigured: resolved.feedConfigured,
    existingSchema: false,
    operationsPlanned: operations.length,
    operationsWritten: operations.length,
    ids,
    labels,
    edges,
    proof: [
      'wallet-auth private tenant headers were sent with values redacted',
      'schema was absent before setup, so deterministic merge operations were written once',
      `kfdb_write_status: ${res.status}`,
    ],
    nextSteps: ['Private schema is initialized; future runs check and reuse this schema before reading/writing Product Copilot records.'],
  };
}
