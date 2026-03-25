import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  hasAuthentication,
  resolvePrivateKey,
} from "../auth/sdk-client.js";
// X402Client loaded lazily to avoid import failures in CI where rickydata may be incomplete
let _X402Client: any = null;
async function getX402Client(): Promise<any> {
  if (!_X402Client) {
    const mod = await import("rickydata") as any;
    _X402Client = mod.X402Client ?? mod.default?.X402Client;
  }
  return _X402Client;
}

// Default payment chain: Base mainnet (8453) — most x402 agents accept USDC on Base
const DEFAULT_PAYMENT_CHAIN = 8453;

export const paymentsTools: Tool[] = [
  {
    name: "x402_request",
    description:
      "Make an HTTP request with built-in x402 payment handling. " +
      "If the server returns 402 Payment Required, inspects payment requirements and optionally pays. " +
      "Requires configured wallet (via configure_wallet) with USDC on the payment chain (default: Base).",
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
            "Chain ID for x402 payment (default: 8453 Base). Must match a chain where the wallet has USDC.",
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
  const paymentChainId = (args.paymentChainId as number) ?? DEFAULT_PAYMENT_CHAIN;

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

  const X402Client = await getX402Client();
  if (!X402Client) return { error: "X402Client not available — rickydata SDK may need updating." };
  const client = new X402Client(privateKey, { chainId: paymentChainId, maxPaymentUsd });

  try {
    const res = await client.request(url, { method, headers, body, autoPay, maxPaymentUsd });
    return res;
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
