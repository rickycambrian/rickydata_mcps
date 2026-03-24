import type { Tool } from "@modelcontextprotocol/sdk/types.js";
// Lazy import to avoid module-level init
async function getX402Helper() { return (await import("agent0-sdk")).isX402Required; }
import {
  getAuthenticatedSDK,
  hasAuthentication,
} from "../auth/sdk-client.js";

// Operator wallet key for x402 payments (uses platform funds on Base)
const OPERATOR_PRIVATE_KEY = process.env.AGENT_GATEWAY_PRIVATE_KEY || process.env.OPERATOR_WALLET_PRIVATE_KEY;
// Default payment chain: Base mainnet (8453) where operator has USDC
const DEFAULT_PAYMENT_CHAIN = 8453;

export const paymentsTools: Tool[] = [
  {
    name: "x402_request",
    description:
      "Make an HTTP request with built-in x402 payment handling. " +
      "If the server returns 402 Payment Required, inspects payment requirements and optionally pays. " +
      "Uses operator wallet on Base mainnet for payments by default.",
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
            "Automatically pay and retry on 402 (default: false). " +
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
  // Resolve the payment key: operator wallet (preferred) or derived wallet
  const paymentChainId = (args.paymentChainId as number) ?? DEFAULT_PAYMENT_CHAIN;
  let sdk: any;

  if (OPERATOR_PRIVATE_KEY) {
    // Use operator wallet for x402 payments (platform-funded model)
    const { SDK } = await import("agent0-sdk");
    sdk = new SDK({ chainId: paymentChainId, privateKey: OPERATOR_PRIVATE_KEY });
  } else if (hasAuthentication()) {
    // Fallback to derived wallet on the specified payment chain
    sdk = await getAuthenticatedSDK(paymentChainId);
  } else {
    return {
      error: "No wallet configured. Call configure_wallet first, or ensure AGENT_GATEWAY_PRIVATE_KEY is set for operator-funded x402 payments.",
    };
  }

  if (!sdk) return { error: "Failed to initialize SDK for x402 payment." };

  const url = args.url as string;
  const method = ((args.method as string) ?? "GET").toUpperCase();
  const autoPay = (args.autoPay as boolean) ?? false;
  const maxPaymentUsd = (args.maxPaymentUsd as number) ?? 1.0;
  const headers = (args.headers as Record<string, string>) ?? {};
  const body = args.body as string | undefined;

  const fetchOptions: RequestInit = {
    method,
    headers: { ...headers },
  };
  if (body && (method === "POST" || method === "PUT")) {
    fetchOptions.body = body;
    if (!headers["Content-Type"]) {
      (fetchOptions.headers as Record<string, string>)["Content-Type"] = "application/json";
    }
  }

  const result = await sdk.request({
    url,
    method: method as "GET" | "POST" | "PUT" | "DELETE",
    headers,
    body: body ? JSON.parse(body) : undefined,
  });

  const isX402Required = await getX402Helper();
  if (isX402Required(result)) {
    const payment = result.x402Payment;

    if (!autoPay) {
      return {
        status: "payment_required",
        x402: true,
        paymentDetails: {
          note: "Server requires x402 payment. Set autoPay: true to pay automatically.",
        },
      };
    }

    // Auto-pay: execute payment and retry
    try {
      const paidResult = await payment.pay();
      return {
        status: "paid",
        x402: true,
        result: paidResult,
      };
    } catch (payError: unknown) {
      const msg = payError instanceof Error ? payError.message : String(payError);
      return {
        status: "payment_failed",
        x402: true,
        error: msg,
      };
    }
  }

  // Successful response (no 402)
  // Guard against non-JSON responses (e.g. SSE streams) — stringify safely
  let safeResult = result;
  if (typeof result === 'string' && result.startsWith('event:')) {
    return {
      status: "error",
      x402: false,
      error: "Response is an SSE stream, not JSON. This endpoint does not support x402 — use a direct API endpoint instead of streaming endpoints.",
    };
  }
  return {
    status: "ok",
    x402: false,
    result: safeResult,
  };
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
