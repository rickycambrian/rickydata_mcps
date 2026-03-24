import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  hasAuthentication,
  resolvePrivateKey,
} from "../auth/sdk-client.js";

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

  // Build fetch options
  const fetchHeaders: Record<string, string> = { ...headers };
  if (body && (method === "POST" || method === "PUT") && !fetchHeaders["Content-Type"]) {
    fetchHeaders["Content-Type"] = "application/json";
  }

  // Step 1: Make the initial request with plain fetch (no SDK wrapping)
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: fetchHeaders,
      body: (method === "POST" || method === "PUT") ? body : undefined,
    });
  } catch (fetchError: unknown) {
    const msg = fetchError instanceof Error ? fetchError.message : String(fetchError);
    return { success: false, error: msg, paymentChainId };
  }

  // Step 2: If not 402, return the response directly
  if (response.status !== 402) {
    if (response.ok) {
      try {
        const data = await response.json();
        return { success: true, status: "ok", x402: false, result: data };
      } catch {
        const text = await response.text();
        return { success: true, status: "ok", x402: false, result: text };
      }
    }
    return {
      success: false,
      error: `HTTP ${response.status}: ${response.statusText}`,
      paymentChainId,
    };
  }

  // Step 3: Parse x402 payment requirements from 402 response
  let x402Body: any;
  try {
    x402Body = await response.json();
  } catch {
    return { success: false, error: "402 response was not valid JSON", x402: true };
  }

  const accepts = x402Body?.accepts;
  if (!accepts || !Array.isArray(accepts) || accepts.length === 0) {
    return {
      success: false,
      error: "402 response missing accepts array",
      x402: true,
      raw: x402Body,
    };
  }

  if (!autoPay) {
    return {
      status: "payment_required",
      x402: true,
      paymentDetails: {
        accepts: accepts.map((a: any) => ({
          network: a.network,
          amount: a.amount,
          asset: a.asset,
          payTo: a.payTo,
        })),
        note: "Set autoPay: true to pay automatically.",
      },
    };
  }

  // Step 4: Find matching payment option for our chain
  const chainNetwork = `eip155:${paymentChainId}`;
  const match = accepts.find((a: any) => a.network === chainNetwork);
  if (!match) {
    const available = accepts.map((a: any) => a.network).join(", ");
    return {
      success: false,
      error: `No payment option for chain ${paymentChainId}. Available: ${available}`,
      x402: true,
    };
  }

  // Safety check: amount in base units (USDC has 6 decimals)
  const amountUsd = parseInt(match.amount, 10) / 1_000_000;
  if (amountUsd > maxPaymentUsd) {
    return {
      success: false,
      error: `Payment amount $${amountUsd.toFixed(4)} exceeds maxPaymentUsd $${maxPaymentUsd}`,
      x402: true,
    };
  }

  // Step 5: Sign x402 payment using ethers EIP-712
  try {
    const { ethers } = await import("ethers");
    const wallet = new ethers.Wallet(privateKey);

    // Sign EIP-712 TransferWithAuthorization for USDC
    const usdcAddress = match.asset as string;
    const payTo = match.payTo as string;
    const validAfter = "0";
    const validBefore = String(Math.floor(Date.now() / 1000) + 3600);
    const nonce = ethers.hexlify(ethers.randomBytes(32));

    const domain = {
      name: match.extra?.name || "USD Coin",
      version: match.extra?.version || "2",
      chainId: paymentChainId,
      verifyingContract: usdcAddress,
    };

    const types = {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    };

    const message = {
      from: wallet.address,
      to: payTo,
      value: match.amount,
      validAfter,
      validBefore,
      nonce,
    };

    const signature = await wallet.signTypedData(domain, types, message);

    // Build x402 payment header
    const paymentPayload = {
      x402Version: 2,
      scheme: "exact",
      network: chainNetwork,
      payload: {
        signature,
        authorization: {
          from: wallet.address,
          to: payTo,
          value: match.amount,
          validAfter: "0",
          validBefore: validBefore.toString(),
          nonce,
        },
      },
    };

    const paymentHeader = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");

    // Step 6: Retry with payment header
    const paidResponse = await fetch(url, {
      method,
      headers: {
        ...fetchHeaders,
        "X-PAYMENT": paymentHeader,
      },
      body: (method === "POST" || method === "PUT") ? body : undefined,
    });

    if (!paidResponse.ok) {
      const errText = await paidResponse.text().catch(() => "");
      return {
        success: false,
        status: "payment_rejected",
        x402: true,
        httpStatus: paidResponse.status,
        error: errText || paidResponse.statusText,
        paymentAmount: `$${amountUsd.toFixed(4)} USDC`,
      };
    }

    let paidData: any;
    try {
      paidData = await paidResponse.json();
    } catch {
      paidData = await paidResponse.text();
    }

    return {
      success: true,
      status: "paid",
      x402: true,
      result: paidData,
      payment: {
        amount: `$${amountUsd.toFixed(4)} USDC`,
        network: chainNetwork,
        from: wallet.address,
        to: payTo,
      },
    };
  } catch (payError: unknown) {
    const msg = payError instanceof Error ? payError.message : String(payError);
    return {
      success: false,
      status: "payment_failed",
      x402: true,
      error: msg,
      paymentChainId,
    };
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
