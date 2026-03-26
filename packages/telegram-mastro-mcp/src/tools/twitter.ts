import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { kfdbWrite, wrapString, type WriteOp } from "../kfdb.js";
import { telegramUserId } from "../ids.js";
import { v5 as uuidv5 } from "uuid";

// Namespace for Twitter user IDs
const TWITTER_NAMESPACE = "b2c3d4e5-f6a7-8901-bcde-f12345678901";

function twitterUserId(twitterHandle: string): string {
  return uuidv5(
    `twitter-user://${twitterHandle.toLowerCase()}`,
    TWITTER_NAMESPACE,
  );
}

// ============================================================================
// TOOL DEFINITIONS
// ============================================================================

export const twitterTools: Tool[] = [
  {
    name: "telegram_twitter_link",
    description:
      "Create a SAME_PERSON_AS edge between a Telegram user and a Twitter/X account in KFDB. " +
      "This links cross-platform identities so you can query across both networks. " +
      "The Twitter user node is created if it doesn't exist.",
    inputSchema: {
      type: "object" as const,
      properties: {
        telegram_id: {
          type: "number",
          description: "Telegram user ID to link",
        },
        twitter_handle: {
          type: "string",
          description: "Twitter/X handle (with or without @)",
        },
        twitter_id: {
          type: "string",
          description: "Twitter numeric user ID (optional)",
        },
        confidence: {
          type: "string",
          enum: ["confirmed", "likely", "possible"],
          description:
            "Confidence level of the identity link (default: confirmed)",
        },
      },
      required: ["telegram_id", "twitter_handle"],
    },
  },
  {
    name: "telegram_twitter_auth_url",
    description:
      "Generate a Twitter/X OAuth authorization URL for linking a Twitter account. " +
      "The user visits this URL to authorize the connection. " +
      "Note: Requires TWITTER_CLIENT_ID and TWITTER_REDIRECT_URI env vars to be set.",
    inputSchema: {
      type: "object" as const,
      properties: {
        telegram_id: {
          type: "number",
          description: "Telegram user ID to generate the auth URL for",
        },
      },
      required: ["telegram_id"],
    },
  },
];

// ============================================================================
// HANDLERS
// ============================================================================

async function handleTwitterLink(
  args: Record<string, unknown>,
): Promise<string> {
  const tgId = args.telegram_id as number;
  let handle = args.twitter_handle as string;
  const twitterId = args.twitter_id as string | undefined;
  const confidence = (args.confidence as string) ?? "confirmed";

  if (!tgId) return "Error: telegram_id is required";
  if (!handle) return "Error: twitter_handle is required";

  // Normalize handle
  handle = handle.replace(/^@/, "").toLowerCase();

  const tgNodeId = telegramUserId(tgId);
  const twNodeId = twitterUserId(handle);

  const ops: WriteOp[] = [];

  // Create/upsert Twitter user node
  const twProps: Record<string, unknown> = {
    handle: wrapString(handle),
    platform: wrapString("twitter"),
    source: wrapString("telegram_mastro"),
    linked_at: wrapString(new Date().toISOString()),
  };
  if (twitterId) twProps.twitter_id = wrapString(twitterId);

  ops.push({
    operation: "create_node",
    label: "TwitterUser",
    id: twNodeId,
    properties: twProps,
  });

  // Create SAME_PERSON_AS edge in both directions
  ops.push({
    operation: "create_edge",
    edge_type: "SAME_PERSON_AS",
    from_id: tgNodeId,
    to_id: twNodeId,
    properties: {
      confidence: wrapString(confidence),
      linked_at: wrapString(new Date().toISOString()),
    },
  });

  ops.push({
    operation: "create_edge",
    edge_type: "SAME_PERSON_AS",
    from_id: twNodeId,
    to_id: tgNodeId,
    properties: {
      confidence: wrapString(confidence),
      linked_at: wrapString(new Date().toISOString()),
    },
  });

  await kfdbWrite(ops);
  return (
    `Successfully linked Telegram user ${tgId} to Twitter @${handle} ` +
    `with confidence "${confidence}". SAME_PERSON_AS edges created in both directions.`
  );
}

function handleTwitterAuthUrl(args: Record<string, unknown>): string {
  const tgId = args.telegram_id as number;
  if (!tgId) return "Error: telegram_id is required";

  const clientId = process.env.TWITTER_CLIENT_ID;
  const redirectUri = process.env.TWITTER_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    return (
      "Error: TWITTER_CLIENT_ID and TWITTER_REDIRECT_URI environment variables " +
      "must be set to generate OAuth URLs. Set them via environment or " +
      "telegram_configure_credentials."
    );
  }

  const state = Buffer.from(
    JSON.stringify({ telegram_id: tgId, ts: Date.now() }),
  ).toString("base64url");

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "tweet.read users.read",
    state,
    code_challenge: "challenge",
    code_challenge_method: "plain",
  });

  const url = `https://twitter.com/i/oauth2/authorize?${params.toString()}`;

  return (
    `# Twitter OAuth URL\n\n` +
    `**Telegram User**: ${tgId}\n` +
    `**URL**: ${url}\n\n` +
    `Direct the user to visit this URL to authorize the Twitter connection. ` +
    `After authorization, the callback will link the accounts.`
  );
}

// ============================================================================
// DISPATCH
// ============================================================================

export async function handleTwitterTool(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "telegram_twitter_link":
      return handleTwitterLink(args);
    case "telegram_twitter_auth_url":
      return handleTwitterAuthUrl(args);
    default:
      return `Unknown twitter tool: ${name}`;
  }
}
