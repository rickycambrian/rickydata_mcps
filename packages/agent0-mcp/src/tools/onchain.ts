/**
 * On-chain query tools for ERC-8004 agents.
 *
 * Provides direct blockchain access: wallet balance checks, USDC balance,
 * and generic JSON-RPC calls. Uses dRPC for reliable multi-chain RPC.
 */
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { resolvePrivateKey, getAuthStatus } from "../auth/sdk-client.js";
import { getDrpcUrl, getChain } from "../utils/chains.js";

// USDC contract addresses per chain
const USDC_ADDRESSES: Record<number, string> = {
  1: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",     // Ethereum
  8453: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",   // Base
  137: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",    // Polygon
  42161: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",  // Arbitrum
  10: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",     // Optimism
};

// ERC-20 balanceOf(address) selector
const BALANCE_OF_SELECTOR = "0x70a08231";

export const onchainTools: Tool[] = [
  {
    name: "get_wallet_balance",
    description:
      "Check the derived wallet's ETH and USDC balance on a specific chain. " +
      "Defaults to Base mainnet (8453). Returns balances in human-readable format. " +
      "Useful for checking if you have enough USDC for x402 payments or enough ETH for gas.",
    inputSchema: {
      type: "object" as const,
      properties: {
        chainId: {
          type: "number",
          description: "Chain ID to check balance on (default: 8453 for Base)",
        },
        address: {
          type: "string",
          description: "Wallet address to check (default: your derived wallet address)",
        },
      },
    },
  },
  {
    name: "rpc_call",
    description:
      "Make a raw JSON-RPC call to any supported chain. " +
      "Supports standard Ethereum JSON-RPC methods like eth_call, eth_getBalance, " +
      "eth_blockNumber, eth_getTransactionReceipt, etc. " +
      "Uses dRPC for reliable access across 35+ chains.",
    inputSchema: {
      type: "object" as const,
      properties: {
        method: {
          type: "string",
          description: "JSON-RPC method (e.g., 'eth_call', 'eth_getBalance', 'eth_blockNumber')",
        },
        params: {
          type: "array",
          description: "JSON-RPC params array (method-specific)",
          items: {},
        },
        chainId: {
          type: "number",
          description: "Chain ID (default: 8453 for Base)",
        },
      },
      required: ["method"],
    },
  },
];

function getRpcUrl(chainId: number): string {
  const drpcUrl = getDrpcUrl(chainId);
  if (drpcUrl) return drpcUrl;
  const config = getChain(chainId);
  if (config?.rpcUrl) return config.rpcUrl;
  throw new Error(`No RPC URL available for chain ${chainId}`);
}

async function rpcFetch(
  rpcUrl: string,
  method: string,
  params: unknown[] = [],
): Promise<unknown> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) {
    throw new Error(`RPC request failed: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as { result?: unknown; error?: { message: string; code: number } };
  if (data.error) {
    throw new Error(`RPC error: ${data.error.message} (code: ${data.error.code})`);
  }
  return data.result;
}

function hexToDecimal(hex: string): string {
  return BigInt(hex).toString();
}

function formatUnits(rawHex: string, decimals: number): string {
  const raw = BigInt(rawHex);
  const divisor = 10n ** BigInt(decimals);
  const intPart = raw / divisor;
  const fracPart = raw % divisor;
  const fracStr = fracPart.toString().padStart(decimals, "0").replace(/0+$/, "") || "0";
  return `${intPart}.${fracStr}`;
}

async function handleGetWalletBalance(args: Record<string, unknown>) {
  const chainId = (typeof args.chainId === "number" ? args.chainId : 8453);
  let address = args.address as string | undefined;

  // Resolve address from derived wallet if not provided
  if (!address) {
    const pk = resolvePrivateKey();
    if (!pk) {
      return {
        error: "No wallet configured. Call configure_wallet first, or provide an address.",
      };
    }
    try {
      const { ethers } = await import("ethers");
      address = new ethers.Wallet(pk).address;
    } catch {
      return { error: "Failed to derive wallet address" };
    }
  }

  const rpcUrl = getRpcUrl(chainId);
  const chainConfig = getChain(chainId);
  const chainName = chainConfig?.name || `Chain ${chainId}`;

  const result: Record<string, unknown> = {
    chain: chainName,
    chainId,
    address,
  };

  // ETH balance
  try {
    const ethBalanceHex = (await rpcFetch(rpcUrl, "eth_getBalance", [address, "latest"])) as string;
    result.ethBalance = formatUnits(ethBalanceHex, 18);
    result.ethBalanceWei = hexToDecimal(ethBalanceHex);
  } catch (err) {
    result.ethBalance = "error";
    result.ethError = (err as Error).message;
  }

  // USDC balance (if USDC exists on this chain)
  const usdcAddress = USDC_ADDRESSES[chainId];
  if (usdcAddress) {
    try {
      // balanceOf(address) — encode the call
      const paddedAddress = address.toLowerCase().replace("0x", "").padStart(64, "0");
      const callData = BALANCE_OF_SELECTOR + paddedAddress;

      const usdcBalanceHex = (await rpcFetch(rpcUrl, "eth_call", [
        { to: usdcAddress, data: callData },
        "latest",
      ])) as string;

      result.usdcBalance = formatUnits(usdcBalanceHex, 6);
      result.usdcBalanceRaw = hexToDecimal(usdcBalanceHex);
      result.usdcContract = usdcAddress;
    } catch (err) {
      result.usdcBalance = "error";
      result.usdcError = (err as Error).message;
    }
  } else {
    result.usdcBalance = "N/A (no USDC on this chain)";
  }

  // Explorer link
  if (chainConfig?.explorerUrl) {
    result.explorerUrl = `${chainConfig.explorerUrl}/address/${address}`;
  }

  return result;
}

async function handleRpcCall(args: Record<string, unknown>) {
  const method = args.method as string;
  if (!method) return { error: "method is required" };

  // Block dangerous methods
  const blockedMethods = [
    "eth_sendTransaction",
    "eth_sendRawTransaction",
    "eth_sign",
    "personal_sign",
    "eth_signTransaction",
    "eth_signTypedData",
    "eth_accounts",
    "eth_requestAccounts",
  ];
  if (blockedMethods.includes(method)) {
    return { error: `Method ${method} is blocked for security. Use dedicated tools for write operations.` };
  }

  const chainId = (typeof args.chainId === "number" ? args.chainId : 8453);
  const params = Array.isArray(args.params) ? args.params : [];

  const rpcUrl = getRpcUrl(chainId);
  const chainConfig = getChain(chainId);

  try {
    const result = await rpcFetch(rpcUrl, method, params);
    return {
      chain: chainConfig?.name || `Chain ${chainId}`,
      chainId,
      method,
      result,
    };
  } catch (err) {
    return {
      error: (err as Error).message,
      chain: chainConfig?.name || `Chain ${chainId}`,
      chainId,
      method,
    };
  }
}

export async function handleOnchainTool(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "get_wallet_balance":
      return handleGetWalletBalance(args);
    case "rpc_call":
      return handleRpcCall(args);
    default:
      return { error: `Unknown onchain tool: ${name}` };
  }
}
