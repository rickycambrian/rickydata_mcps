import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  kfdbKQL,
  kfdbSemanticSearch,
  extractKqlNode,
  unwrapProps,
} from "../kfdb.js";

// ============================================================================
// TOOL DEFINITIONS
// ============================================================================

export const searchTools: Tool[] = [
  {
    name: "telegram_search_messages",
    description:
      "Semantic search across ingested Telegram messages using KFDB vector embeddings. " +
      "Find messages by meaning, not just keyword match. Returns ranked results with sender and chat context.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Natural language search query",
        },
        limit: {
          type: "number",
          description: "Max results (default: 10, max: 50)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "telegram_search_users",
    description:
      "Search Telegram users stored in KFDB by name, username, or other properties using KQL. " +
      "Supports filtering by username, name, or free text query.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description:
            "Search term — matches against display_name, username, first_name, last_name",
        },
        username: {
          type: "string",
          description: "Filter by exact username (without @)",
        },
        limit: {
          type: "number",
          description: "Max results (default: 20, max: 100)",
        },
      },
    },
  },
  {
    name: "telegram_query_kql",
    description:
      "Execute a raw KQL (Knowledge Query Language) query against the KFDB graph. " +
      "Use this for advanced queries across TelegramUser, TelegramMessage, TelegramGroup, " +
      "TelegramConversation nodes and their edges (SENT, MEMBER_OF, IN_CONVERSATION, REPLY_TO, SAME_PERSON_AS). " +
      "Example: MATCH (n:TelegramUser) WHERE n.username = 'alice' RETURN n LIMIT 10",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "KQL query string",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "telegram_get_conversation",
    description:
      "Get time-ordered messages for a specific Telegram chat/conversation. " +
      "Returns messages sorted by date with sender information. " +
      "Use chat_id (numeric) to identify the conversation.",
    inputSchema: {
      type: "object" as const,
      properties: {
        chat_id: {
          type: "number",
          description: "Telegram chat ID",
        },
        limit: {
          type: "number",
          description: "Max messages to return (default: 50, max: 200)",
        },
        before: {
          type: "string",
          description: "Only return messages before this ISO 8601 timestamp",
        },
        after: {
          type: "string",
          description: "Only return messages after this ISO 8601 timestamp",
        },
      },
      required: ["chat_id"],
    },
  },
];

// ============================================================================
// HANDLERS
// ============================================================================

async function handleSearchMessages(
  args: Record<string, unknown>,
): Promise<string> {
  const query = args.query as string;
  if (!query) return "Error: query is required";
  const limit = Math.min(Math.max(1, (args.limit as number) ?? 10), 50);

  // Try semantic search first
  const semanticResults = await kfdbSemanticSearch(query, limit, "TelegramMessage");

  if (semanticResults && semanticResults.length > 0) {
    const lines = [
      `# Telegram Message Search: "${query}"`,
      `**Results**: ${semanticResults.length} (semantic)\n`,
    ];

    for (let i = 0; i < semanticResults.length; i++) {
      const r = semanticResults[i];
      const props = r.properties
        ? unwrapProps(r.properties as Record<string, unknown>)
        : r;
      lines.push(`### ${i + 1}.`);
      if (props.text) lines.push(`**Text**: ${(props.text as string).slice(0, 500)}`);
      if (props.sender_id) lines.push(`**Sender ID**: ${props.sender_id}`);
      if (props.chat_id) lines.push(`**Chat ID**: ${props.chat_id}`);
      if (props.date) lines.push(`**Date**: ${props.date}`);
      if (props.chat_title) lines.push(`**Chat**: ${props.chat_title}`);
      if (r.similarity !== undefined)
        lines.push(`**Similarity**: ${((r.similarity as number) * 100).toFixed(1)}%`);
      lines.push("");
    }

    return lines.join("\n");
  }

  // Fall back to KQL text matching
  const safeQuery = query.replace(/'/g, "\\'");
  const kql = `MATCH (n:TelegramMessage) WHERE n.text CONTAINS '${safeQuery}' RETURN n LIMIT ${limit}`;
  const rows = await kfdbKQL(kql);
  const messages = rows
    .map((r) => extractKqlNode(r))
    .filter(Boolean) as Record<string, unknown>[];

  if (messages.length === 0) {
    return `# Telegram Message Search: "${query}"\n\nNo messages found. Messages may not be indexed yet or no matches found.`;
  }

  const lines = [
    `# Telegram Message Search: "${query}"`,
    `**Results**: ${messages.length} (text match)\n`,
  ];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    lines.push(`### ${i + 1}.`);
    if (msg.text) lines.push(`**Text**: ${(msg.text as string).slice(0, 500)}`);
    if (msg.sender_id) lines.push(`**Sender ID**: ${msg.sender_id}`);
    if (msg.chat_id) lines.push(`**Chat ID**: ${msg.chat_id}`);
    if (msg.date) lines.push(`**Date**: ${msg.date}`);
    if (msg.chat_title) lines.push(`**Chat**: ${msg.chat_title}`);
    lines.push("");
  }

  return lines.join("\n");
}

async function handleSearchUsers(
  args: Record<string, unknown>,
): Promise<string> {
  const query = args.query as string | undefined;
  const username = args.username as string | undefined;
  const limit = Math.min(Math.max(1, (args.limit as number) ?? 20), 100);

  if (!query && !username) {
    return "Error: provide either query or username to search users";
  }

  let kql: string;
  if (username) {
    const safeUsername = username.replace(/'/g, "\\'");
    kql = `MATCH (n:TelegramUser) WHERE n.username = '${safeUsername}' RETURN n LIMIT ${limit}`;
  } else {
    const safeQuery = (query as string).replace(/'/g, "\\'");
    kql = `MATCH (n:TelegramUser) WHERE n.display_name CONTAINS '${safeQuery}' OR n.username CONTAINS '${safeQuery}' OR n.first_name CONTAINS '${safeQuery}' RETURN n LIMIT ${limit}`;
  }

  const rows = await kfdbKQL(kql);
  const users = rows
    .map((r) => extractKqlNode(r))
    .filter(Boolean) as Record<string, unknown>[];

  if (users.length === 0) {
    return `# Telegram User Search\n\nNo users found matching ${username ? `username "${username}"` : `"${query}"`}.`;
  }

  const lines = [
    `# Telegram User Search`,
    `**Query**: ${username ? `@${username}` : query}`,
    `**Results**: ${users.length}\n`,
  ];

  for (const user of users) {
    lines.push(`## ${user.display_name || user.first_name || "Unknown"}`);
    if (user.username) lines.push(`**Username**: @${user.username}`);
    if (user.telegram_id) lines.push(`**Telegram ID**: ${user.telegram_id}`);
    if (user.phone) lines.push(`**Phone**: ${user.phone}`);
    if (user.bio) lines.push(`**Bio**: ${(user.bio as string).slice(0, 200)}`);
    if (user.is_bot) lines.push(`**Bot**: yes`);
    if (user.is_premium) lines.push(`**Premium**: yes`);
    lines.push("");
  }

  return lines.join("\n");
}

async function handleQueryKql(
  args: Record<string, unknown>,
): Promise<string> {
  const query = args.query as string;
  if (!query) return "Error: query is required";

  const rows = await kfdbKQL(query);

  if (rows.length === 0) {
    return `# KQL Query Results\n\n**Query**: \`${query}\`\n\nNo results returned.`;
  }

  const lines = [
    `# KQL Query Results`,
    `**Query**: \`${query}\``,
    `**Rows**: ${rows.length}\n`,
  ];

  for (let i = 0; i < rows.length; i++) {
    const node = extractKqlNode(rows[i]);
    if (node) {
      lines.push(`### Row ${i + 1}`);
      for (const [key, val] of Object.entries(node)) {
        if (val !== null && val !== undefined) {
          const display =
            typeof val === "string" && val.length > 300
              ? val.slice(0, 300) + "..."
              : String(val);
          lines.push(`- **${key}**: ${display}`);
        }
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

async function handleGetConversation(
  args: Record<string, unknown>,
): Promise<string> {
  const chatId = args.chat_id as number;
  if (!chatId) return "Error: chat_id is required";
  const limit = Math.min(Math.max(1, (args.limit as number) ?? 50), 200);
  const before = args.before as string | undefined;
  const after = args.after as string | undefined;

  let whereClause = `n.chat_id = ${chatId}`;
  if (before) whereClause += ` AND n.date < '${before.replace(/'/g, "\\'")}'`;
  if (after) whereClause += ` AND n.date > '${after.replace(/'/g, "\\'")}'`;

  const kql = `MATCH (n:TelegramMessage) WHERE ${whereClause} RETURN n ORDER BY n.date ASC LIMIT ${limit}`;
  const rows = await kfdbKQL(kql);
  const messages = rows
    .map((r) => extractKqlNode(r))
    .filter(Boolean) as Record<string, unknown>[];

  if (messages.length === 0) {
    return `# Conversation (Chat ${chatId})\n\nNo messages found for this chat.`;
  }

  const lines = [
    `# Conversation (Chat ${chatId})`,
    `**Messages**: ${messages.length}`,
  ];
  if (messages[0]?.chat_title) {
    lines.push(`**Chat**: ${messages[0].chat_title}`);
  }
  lines.push("");

  for (const msg of messages) {
    const sender = msg.sender_id ?? "unknown";
    const date = msg.date ?? "";
    const text = (msg.text as string) ?? "";
    lines.push(`**[${date}] User ${sender}**: ${text}`);
  }

  return lines.join("\n");
}

// ============================================================================
// DISPATCH
// ============================================================================

export async function handleSearchTool(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "telegram_search_messages":
      return handleSearchMessages(args);
    case "telegram_search_users":
      return handleSearchUsers(args);
    case "telegram_query_kql":
      return handleQueryKql(args);
    case "telegram_get_conversation":
      return handleGetConversation(args);
    default:
      return `Unknown search tool: ${name}`;
  }
}
