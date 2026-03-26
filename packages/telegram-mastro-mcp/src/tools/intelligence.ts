import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  kfdbKQL,
  kfdbWrite,
  extractKqlNode,
  wrapString,
  wrapInteger,
} from "../kfdb.js";
import { v5 as uuidv5 } from "uuid";

// Namespace UUID for Telegram Mastro (same as ids.ts)
const TELEGRAM_NAMESPACE = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

function telegramAlertId(groupName: string, keywords: string): string {
  return uuidv5(
    `telegram-alert://${groupName}:${keywords}`,
    TELEGRAM_NAMESPACE,
  );
}

// ============================================================================
// TOOL DEFINITIONS
// ============================================================================

export const intelligenceTools: Tool[] = [
  {
    name: "telegram_community_report",
    description:
      "Generate a comprehensive community report for a Telegram group. " +
      "Queries KFDB for all members and messages, returns member count, top contributors, " +
      "message activity timeline, key topics, and group health metrics.",
    inputSchema: {
      type: "object" as const,
      properties: {
        group_name: {
          type: "string",
          description: "Group title to generate report for",
        },
        limit: {
          type: "number",
          description:
            "Max messages to analyze (default: 200, max: 500)",
        },
      },
      required: ["group_name"],
    },
  },
  {
    name: "telegram_lead_enrichment",
    description:
      "Enrich a list of Telegram users with profile data, group memberships, " +
      "and activity levels. Returns structured profile cards for each user.",
    inputSchema: {
      type: "object" as const,
      properties: {
        telegram_user_ids: {
          type: "array",
          items: { type: "number" },
          description: "Array of Telegram user IDs to enrich",
        },
      },
      required: ["telegram_user_ids"],
    },
  },
  {
    name: "telegram_conversation_summary",
    description:
      "Summarize a Telegram conversation within a time range. " +
      "Returns message count, active participants, key discussion threads, " +
      "and notable messages.",
    inputSchema: {
      type: "object" as const,
      properties: {
        source_chat: {
          type: "string",
          description:
            "Chat title or chat ID to summarize",
        },
        after: {
          type: "string",
          description:
            "Start of time range (ISO 8601 timestamp, e.g. 2025-01-01T00:00:00Z)",
        },
        before: {
          type: "string",
          description:
            "End of time range (ISO 8601 timestamp, e.g. 2025-12-31T23:59:59Z)",
        },
        limit: {
          type: "number",
          description: "Max messages to fetch (default: 100, max: 500)",
        },
      },
      required: ["source_chat"],
    },
  },
  {
    name: "telegram_member_network",
    description:
      "Analyze member overlap across multiple Telegram groups. " +
      "Returns which members appear in multiple groups, overlap percentages, " +
      "and network adjacency data for visualization.",
    inputSchema: {
      type: "object" as const,
      properties: {
        group_names: {
          type: "array",
          items: { type: "string" },
          description: "Array of group titles to compare (minimum 2)",
        },
      },
      required: ["group_names"],
    },
  },
  {
    name: "telegram_alert_setup",
    description:
      "Create a keyword alert for a Telegram group. " +
      "Stores a TelegramAlert entity in KFDB that can be queried later " +
      "to check for matching messages.",
    inputSchema: {
      type: "object" as const,
      properties: {
        group_name: {
          type: "string",
          description: "Group title to monitor",
        },
        keywords: {
          type: "array",
          items: { type: "string" },
          description: "Keywords to watch for in messages",
        },
      },
      required: ["group_name", "keywords"],
    },
  },
];

// ============================================================================
// HANDLERS
// ============================================================================

async function handleCommunityReport(
  args: Record<string, unknown>,
): Promise<string> {
  const groupName = args.group_name as string;
  if (!groupName) return "Error: group_name is required";
  const limit = Math.min(Math.max(1, (args.limit as number) ?? 200), 500);

  const safeGroup = groupName.replace(/'/g, "\\'");

  // Find the group
  const groupKql = `MATCH (n:TelegramGroup) WHERE n.title CONTAINS '${safeGroup}' RETURN n LIMIT 1`;
  const groupRows = await kfdbKQL(groupKql);
  const group = groupRows.length > 0 ? extractKqlNode(groupRows[0]) : null;

  if (!group) {
    return `# Community Report\n\nNo group found matching "${groupName}". Ensure the group has been ingested into KFDB.`;
  }

  const gid = group.group_id;

  // Fetch members
  let members: Record<string, unknown>[] = [];
  try {
    const memberKql = `MATCH (u:TelegramUser)-[:MEMBER_OF]->(g:TelegramGroup) WHERE g.group_id = ${gid} RETURN u LIMIT 500`;
    const memberRows = await kfdbKQL(memberKql);
    members = memberRows
      .map((r) => extractKqlNode(r, "u"))
      .filter(Boolean) as Record<string, unknown>[];
  } catch {
    // Graph traversal may not be available
  }

  // Fetch messages
  let messages: Record<string, unknown>[] = [];
  try {
    const msgKql = `MATCH (n:TelegramMessage) WHERE n.chat_title CONTAINS '${safeGroup}' RETURN n ORDER BY n.date DESC LIMIT ${limit}`;
    const msgRows = await kfdbKQL(msgKql);
    messages = msgRows
      .map((r) => extractKqlNode(r))
      .filter(Boolean) as Record<string, unknown>[];
  } catch {
    // May not have messages
  }

  // Compute top contributors
  const senderCounts = new Map<string, number>();
  for (const msg of messages) {
    const sender = String(msg.sender_id ?? "unknown");
    senderCounts.set(sender, (senderCounts.get(sender) ?? 0) + 1);
  }
  const topContributors = [...senderCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  // Compute activity by date
  const dateCounts = new Map<string, number>();
  for (const msg of messages) {
    const date = String(msg.date ?? "");
    const day = date.slice(0, 10); // YYYY-MM-DD
    if (day) {
      dateCounts.set(day, (dateCounts.get(day) ?? 0) + 1);
    }
  }
  const sortedDates = [...dateCounts.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  );

  // Extract key topics (simple word frequency from message text)
  const wordCounts = new Map<string, number>();
  const stopWords = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been",
    "being", "have", "has", "had", "do", "does", "did", "will",
    "would", "could", "should", "may", "might", "can", "shall",
    "to", "of", "in", "for", "on", "with", "at", "by", "from",
    "as", "into", "through", "during", "before", "after", "and",
    "but", "or", "nor", "not", "so", "yet", "both", "either",
    "neither", "each", "every", "all", "any", "few", "more",
    "most", "other", "some", "such", "no", "only", "own", "same",
    "than", "too", "very", "just", "about", "above", "below",
    "between", "up", "down", "out", "off", "over", "under",
    "again", "further", "then", "once", "here", "there", "when",
    "where", "why", "how", "what", "which", "who", "whom", "this",
    "that", "these", "those", "i", "me", "my", "we", "our", "you",
    "your", "he", "him", "his", "she", "her", "it", "its", "they",
    "them", "their",
  ]);
  for (const msg of messages) {
    const text = String(msg.text ?? "").toLowerCase();
    const words = text.split(/\s+/).filter((w) => w.length > 3 && !stopWords.has(w));
    for (const word of words) {
      const clean = word.replace(/[^a-z0-9]/g, "");
      if (clean.length > 3) {
        wordCounts.set(clean, (wordCounts.get(clean) ?? 0) + 1);
      }
    }
  }
  const topWords = [...wordCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15);

  // Build report
  const lines = [
    `# Community Report: ${group.title || groupName}`,
    "",
    `## Overview`,
    `- **Group ID**: ${gid}`,
    `- **Members Found**: ${members.length}${group.member_count ? ` (reported: ${group.member_count})` : ""}`,
    `- **Messages Analyzed**: ${messages.length}`,
    "",
  ];

  // Top Contributors
  lines.push(`## Top Contributors`);
  if (topContributors.length === 0) {
    lines.push("No message data available.");
  } else {
    for (let i = 0; i < topContributors.length; i++) {
      const [senderId, count] = topContributors[i];
      lines.push(`${i + 1}. User ${senderId} -- ${count} messages`);
    }
  }
  lines.push("");

  // Activity Timeline
  lines.push(`## Activity Timeline`);
  if (sortedDates.length === 0) {
    lines.push("No date data available.");
  } else {
    for (const [day, count] of sortedDates) {
      lines.push(`- ${day}: ${count} messages`);
    }
  }
  lines.push("");

  // Key Topics
  lines.push(`## Key Topics`);
  if (topWords.length === 0) {
    lines.push("Not enough message text to identify topics.");
  } else {
    for (const [word, count] of topWords) {
      lines.push(`- **${word}**: mentioned ${count} times`);
    }
  }
  lines.push("");

  // Health Metrics
  const uniqueSenders = senderCounts.size;
  const activeDays = dateCounts.size;
  const avgMsgsPerDay =
    activeDays > 0 ? (messages.length / activeDays).toFixed(1) : "0";
  const participationRate =
    members.length > 0
      ? ((uniqueSenders / members.length) * 100).toFixed(1)
      : "N/A";

  lines.push(`## Group Health Metrics`);
  lines.push(`- **Unique Contributors**: ${uniqueSenders}`);
  lines.push(`- **Active Days**: ${activeDays}`);
  lines.push(`- **Avg Messages/Day**: ${avgMsgsPerDay}`);
  lines.push(
    `- **Participation Rate**: ${participationRate}${participationRate !== "N/A" ? "%" : ""}`,
  );

  return lines.join("\n");
}

async function handleLeadEnrichment(
  args: Record<string, unknown>,
): Promise<string> {
  const userIds = args.telegram_user_ids as number[];
  if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
    return "Error: telegram_user_ids must be a non-empty array of user IDs";
  }

  const lines = [
    `# Lead Enrichment Report`,
    `**Users Requested**: ${userIds.length}`,
    "",
  ];

  for (const uid of userIds) {
    // Fetch user profile
    const userKql = `MATCH (n:TelegramUser) WHERE n.telegram_id = ${uid} RETURN n LIMIT 1`;
    let user: Record<string, unknown> | null = null;
    try {
      const userRows = await kfdbKQL(userKql);
      user = userRows.length > 0 ? extractKqlNode(userRows[0]) : null;
    } catch {
      // continue
    }

    lines.push(`## User ${uid}`);

    if (!user) {
      lines.push("Profile not found in KFDB.");
      lines.push("");
      continue;
    }

    // Profile card
    if (user.display_name || user.first_name) {
      lines.push(
        `**Name**: ${user.display_name || [user.first_name, user.last_name].filter(Boolean).join(" ")}`,
      );
    }
    if (user.username) lines.push(`**Username**: @${user.username}`);
    if (user.phone) lines.push(`**Phone**: ${user.phone}`);
    if (user.bio) lines.push(`**Bio**: ${(user.bio as string).slice(0, 300)}`);
    if (user.is_premium) lines.push(`**Premium**: yes`);
    if (user.is_bot) lines.push(`**Bot**: yes`);

    // Find group memberships
    try {
      const groupKql = `MATCH (u:TelegramUser)-[:MEMBER_OF]->(g:TelegramGroup) WHERE u.telegram_id = ${uid} RETURN g LIMIT 50`;
      const groupRows = await kfdbKQL(groupKql);
      const groups = groupRows
        .map((r) => extractKqlNode(r, "g"))
        .filter(Boolean) as Record<string, unknown>[];

      if (groups.length > 0) {
        lines.push(`**Groups**: ${groups.length}`);
        for (const g of groups) {
          lines.push(`- ${g.title || `Group ${g.group_id}`}`);
        }
      }
    } catch {
      // Graph traversal may not be available
    }

    // Activity level: count messages from this user
    try {
      const activityKql = `MATCH (n:TelegramMessage) WHERE n.sender_id = ${uid} RETURN n LIMIT 200`;
      const activityRows = await kfdbKQL(activityKql);
      const msgCount = activityRows.length;
      let level = "Low";
      if (msgCount >= 100) level = "High";
      else if (msgCount >= 30) level = "Medium";
      lines.push(`**Activity Level**: ${level} (${msgCount} messages found)`);
    } catch {
      // continue
    }

    lines.push("");
  }

  return lines.join("\n");
}

async function handleConversationSummary(
  args: Record<string, unknown>,
): Promise<string> {
  const sourceChat = args.source_chat as string;
  if (!sourceChat) return "Error: source_chat is required";
  const limit = Math.min(Math.max(1, (args.limit as number) ?? 100), 500);
  const before = args.before as string | undefined;
  const after = args.after as string | undefined;

  const safeChat = sourceChat.replace(/'/g, "\\'");

  // Try to match by chat title or chat ID
  const isNumeric = /^\d+$/.test(sourceChat);
  let whereClause: string;
  if (isNumeric) {
    whereClause = `n.chat_id = ${sourceChat}`;
  } else {
    whereClause = `n.chat_title CONTAINS '${safeChat}'`;
  }
  if (before) whereClause += ` AND n.date < '${before.replace(/'/g, "\\'")}'`;
  if (after) whereClause += ` AND n.date > '${after.replace(/'/g, "\\'")}'`;

  const kql = `MATCH (n:TelegramMessage) WHERE ${whereClause} RETURN n ORDER BY n.date ASC LIMIT ${limit}`;

  let messages: Record<string, unknown>[] = [];
  try {
    const rows = await kfdbKQL(kql);
    messages = rows
      .map((r) => extractKqlNode(r))
      .filter(Boolean) as Record<string, unknown>[];
  } catch {
    return `# Conversation Summary\n\nFailed to query messages for "${sourceChat}". Check KFDB connection.`;
  }

  if (messages.length === 0) {
    return `# Conversation Summary: ${sourceChat}\n\nNo messages found for this chat${after ? ` after ${after}` : ""}${before ? ` before ${before}` : ""}.`;
  }

  // Compute participants
  const participants = new Map<string, number>();
  for (const msg of messages) {
    const sender = String(msg.sender_id ?? "unknown");
    participants.set(sender, (participants.get(sender) ?? 0) + 1);
  }
  const sortedParticipants = [...participants.entries()].sort(
    (a, b) => b[1] - a[1],
  );

  // Find notable messages (longest messages likely carry more content)
  const sortedByLength = [...messages]
    .filter((m) => typeof m.text === "string" && (m.text as string).length > 0)
    .sort(
      (a, b) =>
        (b.text as string).length - (a.text as string).length,
    )
    .slice(0, 5);

  // Time range
  const firstDate = messages[0]?.date ?? "unknown";
  const lastDate = messages[messages.length - 1]?.date ?? "unknown";
  const chatTitle =
    messages[0]?.chat_title ?? sourceChat;

  const lines = [
    `# Conversation Summary: ${chatTitle}`,
    "",
    `## Overview`,
    `- **Messages**: ${messages.length}`,
    `- **Active Participants**: ${participants.size}`,
    `- **Time Range**: ${firstDate} to ${lastDate}`,
    "",
    `## Participants (by message count)`,
  ];

  for (const [senderId, count] of sortedParticipants) {
    lines.push(`- User ${senderId}: ${count} messages`);
  }
  lines.push("");

  // Notable messages
  lines.push(`## Notable Messages`);
  if (sortedByLength.length === 0) {
    lines.push("No text messages found.");
  } else {
    for (const msg of sortedByLength) {
      const sender = msg.sender_id ?? "unknown";
      const date = msg.date ?? "";
      const text = (msg.text as string).slice(0, 300);
      lines.push(`- **[${date}] User ${sender}**: ${text}`);
    }
  }

  return lines.join("\n");
}

async function handleMemberNetwork(
  args: Record<string, unknown>,
): Promise<string> {
  const groupNames = args.group_names as string[];
  if (!groupNames || !Array.isArray(groupNames) || groupNames.length < 2) {
    return "Error: group_names must be an array of at least 2 group titles";
  }

  // For each group name, find group and its members
  const groupMembers = new Map<string, Set<string>>();
  const groupInfo = new Map<string, Record<string, unknown>>();
  const allMemberInfo = new Map<string, Record<string, unknown>>();

  for (const name of groupNames) {
    const safeName = name.replace(/'/g, "\\'");

    // Find group
    const groupKql = `MATCH (n:TelegramGroup) WHERE n.title CONTAINS '${safeName}' RETURN n LIMIT 1`;
    let group: Record<string, unknown> | null = null;
    try {
      const groupRows = await kfdbKQL(groupKql);
      group = groupRows.length > 0 ? extractKqlNode(groupRows[0]) : null;
    } catch {
      // continue
    }

    if (!group) {
      groupMembers.set(name, new Set());
      continue;
    }

    groupInfo.set(name, group);
    const gid = group.group_id;

    // Find members
    try {
      const memberKql = `MATCH (u:TelegramUser)-[:MEMBER_OF]->(g:TelegramGroup) WHERE g.group_id = ${gid} RETURN u LIMIT 500`;
      const memberRows = await kfdbKQL(memberKql);
      const members = new Set<string>();
      for (const row of memberRows) {
        const user = extractKqlNode(row, "u");
        if (user && user.telegram_id) {
          const tid = String(user.telegram_id);
          members.add(tid);
          allMemberInfo.set(tid, user);
        }
      }
      groupMembers.set(name, members);
    } catch {
      groupMembers.set(name, new Set());
    }
  }

  // Compute overlaps
  const memberGroupMap = new Map<string, string[]>();
  for (const [name, members] of groupMembers) {
    for (const mid of members) {
      if (!memberGroupMap.has(mid)) memberGroupMap.set(mid, []);
      memberGroupMap.get(mid)!.push(name);
    }
  }

  const overlapping = [...memberGroupMap.entries()].filter(
    ([, groups]) => groups.length >= 2,
  );

  // Build adjacency data for group pairs
  const pairOverlap = new Map<string, number>();
  for (let i = 0; i < groupNames.length; i++) {
    for (let j = i + 1; j < groupNames.length; j++) {
      const a = groupMembers.get(groupNames[i]) ?? new Set();
      const b = groupMembers.get(groupNames[j]) ?? new Set();
      let shared = 0;
      for (const mid of a) {
        if (b.has(mid)) shared++;
      }
      pairOverlap.set(`${groupNames[i]} <-> ${groupNames[j]}`, shared);
    }
  }

  const lines = [
    `# Member Network Analysis`,
    "",
    `## Groups`,
  ];

  for (const name of groupNames) {
    const info = groupInfo.get(name);
    const count = groupMembers.get(name)?.size ?? 0;
    const title = info ? (info.title as string) : name;
    lines.push(
      `- **${title}**: ${count} members${!info ? " (not found in KFDB)" : ""}`,
    );
  }
  lines.push("");

  // Pairwise overlaps
  lines.push(`## Pairwise Overlap`);
  for (const [pair, count] of pairOverlap) {
    const [nameA, nameB] = pair.split(" <-> ");
    const sizeA = groupMembers.get(nameA)?.size ?? 0;
    const sizeB = groupMembers.get(nameB)?.size ?? 0;
    const minSize = Math.min(sizeA, sizeB);
    const pct = minSize > 0 ? ((count / minSize) * 100).toFixed(1) : "0";
    lines.push(`- ${pair}: **${count} shared** (${pct}% of smaller group)`);
  }
  lines.push("");

  // Shared members
  lines.push(`## Shared Members (${overlapping.length})`);
  if (overlapping.length === 0) {
    lines.push("No members found in common across the specified groups.");
  } else {
    overlapping.sort((a, b) => b[1].length - a[1].length);
    for (const [mid, groups] of overlapping) {
      const info = allMemberInfo.get(mid);
      const name = info
        ? (info.display_name as string) ||
          (info.first_name as string) ||
          mid
        : mid;
      const uname = info?.username ? ` (@${info.username})` : "";
      lines.push(
        `- **${name}${uname}** -- in ${groups.length} groups: ${groups.join(", ")}`,
      );
    }
  }
  lines.push("");

  // Adjacency list for visualization
  lines.push(`## Network Adjacency Data`);
  lines.push("```json");
  const adjacency: Record<string, string[]> = {};
  for (const name of groupNames) {
    adjacency[name] = [];
  }
  for (const [pair, count] of pairOverlap) {
    if (count > 0) {
      const [nameA, nameB] = pair.split(" <-> ");
      adjacency[nameA].push(nameB);
      adjacency[nameB].push(nameA);
    }
  }
  lines.push(JSON.stringify(adjacency, null, 2));
  lines.push("```");

  return lines.join("\n");
}

async function handleAlertSetup(
  args: Record<string, unknown>,
): Promise<string> {
  const groupName = args.group_name as string;
  const keywords = args.keywords as string[];

  if (!groupName) return "Error: group_name is required";
  if (!keywords || !Array.isArray(keywords) || keywords.length === 0) {
    return "Error: keywords must be a non-empty array of strings";
  }

  const keywordsStr = keywords.join(",");
  const alertId = telegramAlertId(groupName, keywordsStr);

  try {
    await kfdbWrite([
      {
        operation: "create_node",
        label: "TelegramAlert",
        id: alertId,
        properties: {
          group_name: wrapString(groupName),
          keywords: wrapString(keywordsStr),
          keyword_count: wrapInteger(keywords.length),
          created_at: wrapString(new Date().toISOString()),
          status: wrapString("active"),
        },
      },
    ]);
  } catch (e) {
    return `# Alert Setup Failed\n\nCould not write alert to KFDB: ${(e as Error).message}`;
  }

  const lines = [
    `# Alert Created`,
    "",
    `- **Group**: ${groupName}`,
    `- **Keywords**: ${keywords.join(", ")}`,
    `- **Alert ID**: ${alertId}`,
    `- **Status**: active`,
    "",
    `The alert entity has been stored in KFDB as a TelegramAlert node. ` +
      `Query it with: \`MATCH (n:TelegramAlert) WHERE n.group_name = '${groupName.replace(/'/g, "\\'")}' RETURN n\``,
  ];

  return lines.join("\n");
}

// ============================================================================
// DISPATCH
// ============================================================================

export async function handleIntelligenceTool(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "telegram_community_report":
      return handleCommunityReport(args);
    case "telegram_lead_enrichment":
      return handleLeadEnrichment(args);
    case "telegram_conversation_summary":
      return handleConversationSummary(args);
    case "telegram_member_network":
      return handleMemberNetwork(args);
    case "telegram_alert_setup":
      return handleAlertSetup(args);
    default:
      return `Unknown intelligence tool: ${name}`;
  }
}
