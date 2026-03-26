import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  setKfdbApiKey,
  setWalletAddress,
  getKfdbApiKey,
  getWalletAddress,
} from "../kfdb.js";

// ============================================================================
// IN-MEMORY TELEGRAM API CREDENTIALS
// ============================================================================

let telegramApiId = process.env.TELEGRAM_API_ID || "";
let telegramApiHash = process.env.TELEGRAM_API_HASH || "";
let telegramSession = process.env.TELEGRAM_SESSION || "";

export function getTelegramCredentials() {
  return {
    apiId: telegramApiId,
    apiHash: telegramApiHash,
    session: telegramSession,
  };
}

// ============================================================================
// TOOL DEFINITIONS
// ============================================================================

export const configTools: Tool[] = [
  {
    name: "telegram_configure_credentials",
    description:
      "Set Telegram API credentials (api_id, api_hash, session string) for direct Telegram API access. " +
      "These are stored in memory only — they are not persisted to disk.",
    inputSchema: {
      type: "object" as const,
      properties: {
        api_id: {
          type: "string",
          description: "Telegram API ID (from my.telegram.org)",
        },
        api_hash: {
          type: "string",
          description: "Telegram API hash (from my.telegram.org)",
        },
        session: {
          type: "string",
          description: "Telegram session string (from GramJS or similar)",
        },
      },
    },
  },
  {
    name: "telegram_configure_kfdb",
    description:
      "Set KFDB connection parameters: wallet address and API key. " +
      "The wallet address scopes all reads/writes to your private tenant. " +
      "These are stored in memory only — they are not persisted to disk.",
    inputSchema: {
      type: "object" as const,
      properties: {
        wallet_address: {
          type: "string",
          description: "Your wallet address (used as X-Wallet-Address header)",
        },
        api_key: {
          type: "string",
          description: "KFDB API key (used as Authorization: Bearer header)",
        },
      },
    },
  },
];

// ============================================================================
// HANDLERS
// ============================================================================

function handleConfigureCredentials(
  args: Record<string, unknown>,
): string {
  const apiId = args.api_id as string | undefined;
  const apiHash = args.api_hash as string | undefined;
  const session = args.session as string | undefined;

  const updated: string[] = [];
  if (apiId) {
    telegramApiId = apiId;
    updated.push("api_id");
  }
  if (apiHash) {
    telegramApiHash = apiHash;
    updated.push("api_hash");
  }
  if (session) {
    telegramSession = session;
    updated.push("session");
  }

  if (updated.length === 0) {
    const configured: string[] = [];
    if (telegramApiId) configured.push("api_id");
    if (telegramApiHash) configured.push("api_hash");
    if (telegramSession) configured.push("session");
    return `No parameters provided. Currently configured: ${configured.length > 0 ? configured.join(", ") : "none"}`;
  }

  return `Telegram credentials updated: ${updated.join(", ")}. Stored in memory only.`;
}

function handleConfigureKfdb(args: Record<string, unknown>): string {
  const wallet = args.wallet_address as string | undefined;
  const apiKey = args.api_key as string | undefined;

  const updated: string[] = [];
  if (wallet) {
    setWalletAddress(wallet);
    updated.push("wallet_address");
  }
  if (apiKey) {
    setKfdbApiKey(apiKey);
    updated.push("api_key");
  }

  if (updated.length === 0) {
    const currentWallet = getWalletAddress();
    const hasKey = !!getKfdbApiKey();
    return `No parameters provided. Current: wallet_address=${currentWallet || "not set"}, api_key=${hasKey ? "set" : "not set"}`;
  }

  return `KFDB config updated: ${updated.join(", ")}. Stored in memory only.`;
}

// ============================================================================
// DISPATCH
// ============================================================================

export async function handleConfigTool(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "telegram_configure_credentials":
      return handleConfigureCredentials(args);
    case "telegram_configure_kfdb":
      return handleConfigureKfdb(args);
    default:
      return `Unknown config tool: ${name}`;
  }
}
