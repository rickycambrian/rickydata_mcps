import { createHash } from 'node:crypto';

export const PRODUCT_COPILOT_APP_ID = 'rickydata.product-copilot';
export const PRODUCT_COPILOT_SCHEMA_VERSION = '1.0.0';
const PRODUCT_COPILOT_SCHEMA_NAMESPACE = '9f8cb3a6-7964-58d6-8e7c-7ce30ecdb9cc';

export interface PrivateTenantConfig {
  baseUrl: string;
  apiKey: string;
  walletAddress: string;
  deriveSessionId: string;
  deriveKey: string;
}

export interface SetupProductCopilotOptions {
  env?: Record<string, string | undefined>;
  fetcher?: typeof fetch;
  now?: () => string;
  dryRun?: boolean;
  schemaVersion?: string;
}

export interface SetupStatus {
  ok: boolean;
  status: 'missing_private_tenant_config' | 'dry_run' | 'initialized_or_already_exists';
  appId: string;
  schemaVersion: string;
  idempotent: true;
  missingEnv?: string[];
  feedConfigured: boolean;
  operationsPlanned?: number;
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
  missingEnv: string[];
  feedConfigured: boolean;
} {
  const baseUrl = env.PRODUCT_COPILOT_KFDB_API_URL || env.RICKYDATA_KFDB_URL || env.KFDB_API_URL;
  const apiKey = env.PRODUCT_COPILOT_KFDB_API_KEY || env.RICKYDATA_KFDB_API_KEY || env.KFDB_API_KEY || env.PRODUCT_COPILOT_PM_REPORT_BEARER_TOKEN;
  const walletAddress = env.PRODUCT_COPILOT_WALLET_ADDRESS || env.RICKYDATA_KFDB_WALLET_ADDRESS;
  const deriveSessionId = env.PRODUCT_COPILOT_KFDB_DERIVE_SESSION_ID || env.RICKYDATA_KFDB_DERIVE_SESSION_ID;
  const deriveKey = env.PRODUCT_COPILOT_KFDB_DERIVE_KEY || env.RICKYDATA_KFDB_DERIVE_KEY;
  const missingEnv: string[] = [];
  if (!baseUrl) missingEnv.push('PRODUCT_COPILOT_KFDB_API_URL or KFDB_API_URL');
  if (!apiKey) missingEnv.push('PRODUCT_COPILOT_KFDB_API_KEY or RICKYDATA_KFDB_API_KEY or KFDB_API_KEY');
  if (!walletAddress) missingEnv.push('PRODUCT_COPILOT_WALLET_ADDRESS or RICKYDATA_KFDB_WALLET_ADDRESS');
  if (!deriveSessionId) missingEnv.push('PRODUCT_COPILOT_KFDB_DERIVE_SESSION_ID or RICKYDATA_KFDB_DERIVE_SESSION_ID');
  if (!deriveKey) missingEnv.push('PRODUCT_COPILOT_KFDB_DERIVE_KEY or RICKYDATA_KFDB_DERIVE_KEY');

  return {
    config: missingEnv.length === 0 ? { baseUrl: baseUrl!, apiKey: apiKey!, walletAddress: walletAddress!, deriveSessionId: deriveSessionId!, deriveKey: deriveKey! } : undefined,
    missingEnv,
    feedConfigured: Boolean(env.PRODUCT_COPILOT_PM_REPORT_URL || env.PRODUCT_COPILOT_PM_REPORT_PATH),
  };
}

export function productCopilotSchemaOperations(config: PrivateTenantConfig, opts: { now: string; schemaVersion?: string }): Array<Record<string, unknown>> {
  const schemaVersion = opts.schemaVersion ?? PRODUCT_COPILOT_SCHEMA_VERSION;
  const wallet = config.walletAddress.toLowerCase();
  const tenantId = uuidV5(`wallet-tenant:${wallet}`, PRODUCT_COPILOT_SCHEMA_NAMESPACE);
  const schemaId = uuidV5(`schema:${PRODUCT_COPILOT_APP_ID}:${schemaVersion}`, PRODUCT_COPILOT_SCHEMA_NAMESPACE);
  const bootstrapId = uuidV5(`bootstrap:${wallet}:${PRODUCT_COPILOT_APP_ID}:${schemaVersion}`, PRODUCT_COPILOT_SCHEMA_NAMESPACE);
  const tenantSchemaEdgeId = uuidV5(`edge:${tenantId}:HAS_SCHEMA_BOOTSTRAP:${bootstrapId}`, PRODUCT_COPILOT_SCHEMA_NAMESPACE);
  const bootstrapSchemaEdgeId = uuidV5(`edge:${bootstrapId}:USES_SCHEMA_VERSION:${schemaId}`, PRODUCT_COPILOT_SCHEMA_NAMESPACE);
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
      id: tenantId,
      label: 'WalletTenant',
      properties: {
        wallet_address: kfStr(wallet),
        private_tenant: kfBool(true),
        updated_at: kfStr(opts.now),
      },
    },
    {
      operation: 'create_node',
      mode: 'merge',
      id: schemaId,
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
      id: bootstrapId,
      label: 'SchemaBootstrap',
      properties: {
        app_id: kfStr(PRODUCT_COPILOT_APP_ID),
        schema_version: kfStr(schemaVersion),
        wallet_address: kfStr(wallet),
        idempotency_key: kfStr(`${wallet}:${PRODUCT_COPILOT_APP_ID}:${schemaVersion}`),
        status: kfStr('initialized'),
        initialized_at: kfStr(opts.now),
      },
    },
    {
      operation: 'create_edge',
      mode: 'merge',
      id: tenantSchemaEdgeId,
      from: tenantId,
      to: bootstrapId,
      edge_type: 'HAS_SCHEMA_BOOTSTRAP',
      properties: { app_id: kfStr(PRODUCT_COPILOT_APP_ID) },
    },
    {
      operation: 'create_edge',
      mode: 'merge',
      id: bootstrapSchemaEdgeId,
      from: bootstrapId,
      to: schemaId,
      edge_type: 'USES_SCHEMA_VERSION',
      properties: { app_id: kfStr(PRODUCT_COPILOT_APP_ID) },
    },
  ];
}

export function privateSetupGuidance(error?: unknown, env: Record<string, string | undefined> = process.env): SetupStatus {
  const resolved = resolvePrivateTenantConfig(env);
  return {
    ok: false,
    status: 'missing_private_tenant_config',
    appId: PRODUCT_COPILOT_APP_ID,
    schemaVersion: PRODUCT_COPILOT_SCHEMA_VERSION,
    idempotent: true,
    missingEnv: resolved.missingEnv,
    feedConfigured: resolved.feedConfigured,
    proof: error instanceof Error ? [`blocked_before_private_read: ${error.message}`] : undefined,
    nextSteps: [
      'Run setup_private_product_copilot after RickyData Gateway injects the active wallet sign-to-derive material.',
      'Configure PRODUCT_COPILOT_PM_REPORT_URL or PRODUCT_COPILOT_PM_REPORT_PATH for the private HIL feed once the tenant is initialized.',
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
      status: 'missing_private_tenant_config',
      appId: PRODUCT_COPILOT_APP_ID,
      schemaVersion,
      idempotent: true,
      missingEnv: resolved.missingEnv,
      feedConfigured: resolved.feedConfigured,
      nextSteps: [
        'Authenticate through RickyData Gateway / Privy and complete wallet sign-to-derive.',
        'Inject KFDB endpoint, service bearer, wallet address, derive session id, and derive key into this private MCP runtime.',
        'Rerun setup_private_product_copilot; it is safe to run repeatedly.',
      ],
    };
  }

  const now = options.now?.() ?? new Date().toISOString();
  const operations = productCopilotSchemaOperations(resolved.config, { now, schemaVersion });
  const labels = operations.filter((op) => op.operation === 'create_node').map((op) => String(op.label));
  const edges = operations.filter((op) => op.operation === 'create_edge').map((op) => String(op.edge_type));

  if (options.dryRun) {
    return {
      ok: true,
      status: 'dry_run',
      appId: PRODUCT_COPILOT_APP_ID,
      schemaVersion,
      idempotent: true,
      feedConfigured: resolved.feedConfigured,
      operationsPlanned: operations.length,
      labels,
      edges,
      proof: ['planned deterministic merge operations only; no network write performed'],
      nextSteps: ['Run setup_private_product_copilot with dry_run=false to initialize or verify the private tenant schema.'],
    };
  }

  const fetcher = options.fetcher ?? fetch;
  const base = resolved.config.baseUrl.replace(/\/$/, '');
  const res = await fetcher(`${base}/api/v1/write`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${resolved.config.apiKey}`,
      'X-Wallet-Address': resolved.config.walletAddress,
      'X-Derive-Session-Id': resolved.config.deriveSessionId,
      'X-Derive-Key': resolved.config.deriveKey,
    },
    body: JSON.stringify({ operations }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Product Copilot private schema setup failed: ${res.status} ${text.slice(0, 300)}`);
  }

  return {
    ok: true,
    status: 'initialized_or_already_exists',
    appId: PRODUCT_COPILOT_APP_ID,
    schemaVersion,
    idempotent: true,
    feedConfigured: resolved.feedConfigured,
    operationsPlanned: operations.length,
    labels,
    edges,
    proof: [
      'private tenant headers were sent with values redacted',
      'deterministic merge ids make reruns safe when schema already exists',
      `kfdb_write_status: ${res.status}`,
    ],
    nextSteps: resolved.feedConfigured
      ? ['Private schema is initialized; read tools can now use the configured private HIL feed.']
      : ['Private schema is initialized; configure PRODUCT_COPILOT_PM_REPORT_URL or PRODUCT_COPILOT_PM_REPORT_PATH before using feed read tools.'],
  };
}
