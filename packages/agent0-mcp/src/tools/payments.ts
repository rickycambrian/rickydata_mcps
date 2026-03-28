import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  hasAuthentication,
  resolvePrivateKey,
} from "../auth/sdk-client.js";
import { buildDrpcOverrides } from "../utils/chains.js";

// X402Client loaded lazily to avoid import failures in CI where rickydata may be incomplete
let _X402Client: any = null;
async function getX402Client(): Promise<any> {
  if (!_X402Client) {
    const mod = await import("rickydata") as any;
    _X402Client = mod.X402Client ?? mod.default?.X402Client;
  }
  return _X402Client;
}

const DUPLICATE_PAYMENT_TTL_MS = 120_000;

type X402SelectedOffer = {
  network?: string;
  chainId?: number | null;
  amount?: string;
};

type X402ToolResult = {
  success?: boolean;
  status?: string;
  x402?: boolean;
  error?: string;
  serverReason?: string;
  httpStatus?: number;
  paymentDetails?: unknown;
  usableOffers?: unknown[];
  selectedOffer?: X402SelectedOffer;
  paymentAttempted?: boolean;
  result?: unknown;
  payment?: unknown;
};

type RecentPaymentFailure = {
  error: string;
  serverReason?: string;
  expiresAt: number;
};

const recentPaymentFailures = new Map<string, RecentPaymentFailure>();

function buildDuplicatePaymentKey(
  url: string,
  method: string,
  body: string | undefined,
  network: string,
): string {
  return JSON.stringify([url, method, body ?? "", network]);
}

function getRecentPaymentFailure(key: string): RecentPaymentFailure | null {
  const cached = recentPaymentFailures.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    recentPaymentFailures.delete(key);
    return null;
  }
  return cached;
}

function rememberPaymentFailure(
  key: string,
  error: string,
  serverReason?: string,
): void {
  recentPaymentFailures.set(key, {
    error,
    serverReason,
    expiresAt: Date.now() + DUPLICATE_PAYMENT_TTL_MS,
  });
}

function clearPaymentFailure(key: string): void {
  recentPaymentFailures.delete(key);
}

export const paymentsTools: Tool[] = [
  {
    name: "x402_request",
    description:
      "Make an HTTP request with built-in x402 payment handling. " +
      "If the server returns 402 Payment Required, inspects payment requirements and optionally pays. " +
      "When autoPay is enabled the tool previews the payment offer first, then makes a single paid retry. " +
      "Requires configured wallet (via configure_wallet) with USDC on a supported payment chain.",
    inputSchema: {
      type: "object" as const,
      properties: {
        url: {
          type: "string",
          description: "The URL to request",
        },
        method: {
          type: "string",
          enum: ["GET", "POST", "PUT", "DELETE"],
          description: "HTTP method (default: GET)",
        },
        headers: {
          type: "object",
          description: "Additional request headers (key-value pairs)",
        },
        body: {
          type: "string",
          description: "Request body (for POST/PUT)",
        },
        autoPay: {
          type: "boolean",
          description:
            "Automatically pay and retry on 402 (default: true). " +
            "When false, returns payment requirements for inspection.",
        },
        maxPaymentUsd: {
          type: "number",
          description:
            "Maximum payment amount in USD (safety limit, default: 1.00)",
        },
        paymentChainId: {
          type: "number",
          description:
            "Optional strict payment chain override. When omitted, the first funded supported offer is selected automatically.",
        },
      },
      required: ["url"],
    },
  },
];

// ============================================================================
// HANDLERS
// ============================================================================

async function handleX402Request(
  args: Record<string, unknown>,
): Promise<unknown> {
  if (!hasAuthentication()) {
    return {
      error: "No wallet configured. Call configure_wallet first with your wallet signature.",
    };
  }

  const privateKey = resolvePrivateKey();
  if (!privateKey) return { error: "No private key available for x402 payment signing." };

  const url = args.url as string;
  const method = ((args.method as string) ?? "GET").toUpperCase();
  const autoPay = (args.autoPay as boolean) ?? true;
  const maxPaymentUsd = (args.maxPaymentUsd as number) ?? 1.0;
  const headers = (args.headers as Record<string, string>) ?? {};
  const body = args.body as string | undefined;
  const paymentChainId = typeof args.paymentChainId === "number"
    ? args.paymentChainId
    : undefined;
  const rpcUrls = buildDrpcOverrides();

  const X402Client = await getX402Client();
  if (!X402Client) return { error: "X402Client not available — rickydata SDK may need updating." };
  const client = new X402Client(privateKey, {
    ...(paymentChainId !== undefined ? { chainId: paymentChainId, strictChainId: true } : {}),
    maxPaymentUsd,
    rpcUrls,
  });

  try {
    const requestOptions = { method, headers, body, maxPaymentUsd };
    if (!autoPay) {
      return await client.request(url, { ...requestOptions, autoPay: false });
    }

    const preview = await client.request(url, {
      ...requestOptions,
      autoPay: false,
    }) as X402ToolResult;

    if (preview.status !== "payment_required") {
      return preview;
    }

    const previewNetwork = preview.selectedOffer?.network;
    if (previewNetwork) {
      const duplicateKey = buildDuplicatePaymentKey(url, method, body, previewNetwork);
      const cachedFailure = getRecentPaymentFailure(duplicateKey);
      if (cachedFailure) {
        const retryAfterSeconds = Math.max(
          1,
          Math.ceil((cachedFailure.expiresAt - Date.now()) / 1000),
        );
        return {
          ...preview,
          success: false,
          status: "payment_rejected",
          error:
            `Blocked duplicate auto-pay attempt after a recent paid failure on ${previewNetwork}. ` +
            `Last failure: ${cachedFailure.error}`,
          serverReason: cachedFailure.serverReason ?? preview.serverReason,
          paymentAttempted: false,
          duplicatePaymentBlocked: true,
          retryAfterSeconds,
        };
      }
    }

    const result = await client.request(url, {
      ...requestOptions,
      autoPay: true,
    }) as X402ToolResult;

    const selectedNetwork = result.selectedOffer?.network ?? previewNetwork;
    if (selectedNetwork) {
      const duplicateKey = buildDuplicatePaymentKey(url, method, body, selectedNetwork);
      if (result.success) {
        clearPaymentFailure(duplicateKey);
      } else if (result.paymentAttempted) {
        rememberPaymentFailure(
          duplicateKey,
          result.error ?? "Payment failed",
          result.serverReason,
        );
      }
    }

    return result;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg, paymentChainId };
  }
}

// ============================================================================
// DISPATCH
// ============================================================================

export async function handlePaymentsTool(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "x402_request":
      return handleX402Request(args);
    default:
      return { error: `Unknown payments tool: ${name}` };
  }
}
