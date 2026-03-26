import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { kfdbKQL, kfdbLabels, extractKqlNode } from "../kfdb.js";

// ============================================================================
// TOOL DEFINITIONS
// ============================================================================

export const analyticsTools: Tool[] = [
  {
    name: "telegram_stats",
    description:
      "Get aggregate statistics about ingested Telegram data in KFDB. " +
      "Returns counts of users, messages, groups, conversations, and edges.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "telegram_group_analysis",
    description:
      "Analyze a specific Telegram group's membership composition. " +
      "Returns member list with profile details and activity summary.",
    inputSchema: {
      type: "object" as const,
      properties: {
        group_id: {
          type: "number",
          description: "Telegram group ID to analyze",
        },
        group_title: {
          type: "string",
          description: "Group title to search for (if group_id unknown)",
        },
      },
    },
  },
  {
    name: "telegram_cross_group_overlap",
    description:
      "Find users who are members of multiple Telegram groups. " +
      "Identifies shared members across two or more groups to discover community overlaps. " +
      "Provide two or more group IDs to compare.",
    inputSchema: {
      type: "object" as const,
      properties: {
        group_ids: {
          type: "array",
          items: { type: "number" },
          description: "Array of Telegram group IDs to compare (minimum 2)",
        },
      },
      required: ["group_ids"],
    },
  },
];

// ============================================================================
// HANDLERS
// ============================================================================

async function handleStats(): Promise<string> {
  const labelsData = await kfdbLabels();
  const labelMap = new Map<string, number>();
  for (const l of labelsData.labels) {
    labelMap.set(l.label, l.count);
  }

  const telegramLabels = [
    "TelegramUser",
    "TelegramMessage",
    "TelegramGroup",
    "TelegramConversation",
  ];

  const lines = [
    `# Telegram Mastro Statistics (KFDB)`,
    "",
    `## Entity Counts`,
  ];

  let hasData = false;
  for (const label of telegramLabels) {
    const count = labelMap.get(label) ?? 0;
    if (count > 0) hasData = true;
    lines.push(`- **${label}**: ${count.toLocaleString()}`);
  }

  if (!hasData) {
    lines.push("");
    lines.push(
      "No Telegram data found. Use the ingestion tools to import data first.",
    );
  }

  return lines.join("\n");
}

async function handleGroupAnalysis(
  args: Record<string, unknown>,
): Promise<string> {
  const groupId = args.group_id as number | undefined;
  const groupTitle = args.group_title as string | undefined;

  if (!groupId && !groupTitle) {
    return "Error: provide either group_id or group_title";
  }

  // Find the group
  let groupKql: string;
  if (groupId) {
    groupKql = `MATCH (n:TelegramGroup) WHERE n.group_id = ${groupId} RETURN n LIMIT 1`;
  } else {
    const safeTitle = (groupTitle as string).replace(/'/g, "\\'");
    groupKql = `MATCH (n:TelegramGroup) WHERE n.title CONTAINS '${safeTitle}' RETURN n LIMIT 1`;
  }

  const groupRows = await kfdbKQL(groupKql);
  const group = groupRows.length > 0 ? extractKqlNode(groupRows[0]) : null;

  if (!group) {
    return `No group found matching ${groupId ? `ID ${groupId}` : `title "${groupTitle}"`}.`;
  }

  const gid = group.group_id ?? groupId;
  const lines = [
    `# Group Analysis: ${group.title || "Unknown"}`,
    `**Group ID**: ${gid}`,
  ];
  if (group.member_count) {
    lines.push(`**Total Members**: ${group.member_count}`);
  }
  lines.push("");

  // Find members via MEMBER_OF edges
  const memberKql = `MATCH (u:TelegramUser)-[:MEMBER_OF]->(g:TelegramGroup) WHERE g.group_id = ${gid} RETURN u LIMIT 100`;
  try {
    const memberRows = await kfdbKQL(memberKql);
    const members = memberRows
      .map((r) => extractKqlNode(r, "u"))
      .filter(Boolean) as Record<string, unknown>[];

    lines.push(`## Members (${members.length} found)`);
    for (const m of members) {
      const name = m.display_name || m.first_name || "Unknown";
      const uname = m.username ? ` (@${m.username})` : "";
      lines.push(`- ${name}${uname}`);
    }
  } catch {
    lines.push("Could not retrieve member list via graph traversal.");
  }

  return lines.join("\n");
}

async function handleCrossGroupOverlap(
  args: Record<string, unknown>,
): Promise<string> {
  const groupIds = args.group_ids as number[];
  if (!groupIds || !Array.isArray(groupIds) || groupIds.length < 2) {
    return "Error: group_ids must be an array of at least 2 group IDs";
  }

  // For each group, get members
  const groupMembers = new Map<number, Set<string>>();
  const groupTitles = new Map<number, string>();
  const allMemberInfo = new Map<string, Record<string, unknown>>();

  for (const gid of groupIds) {
    const memberKql = `MATCH (u:TelegramUser)-[:MEMBER_OF]->(g:TelegramGroup) WHERE g.group_id = ${gid} RETURN u, g LIMIT 500`;
    try {
      const rows = await kfdbKQL(memberKql);
      const members = new Set<string>();
      for (const row of rows) {
        const user = extractKqlNode(row, "u");
        const group = extractKqlNode(row, "g");
        if (user && user.telegram_id) {
          const tid = String(user.telegram_id);
          members.add(tid);
          allMemberInfo.set(tid, user);
        }
        if (group && group.title && !groupTitles.has(gid)) {
          groupTitles.set(gid, group.title as string);
        }
      }
      groupMembers.set(gid, members);
    } catch {
      groupMembers.set(gid, new Set());
    }
  }

  // Find overlapping members (present in 2+ groups)
  const memberGroupCount = new Map<string, number[]>();
  for (const [gid, members] of groupMembers) {
    for (const mid of members) {
      if (!memberGroupCount.has(mid)) memberGroupCount.set(mid, []);
      memberGroupCount.get(mid)!.push(gid);
    }
  }

  const overlapping = [...memberGroupCount.entries()].filter(
    ([, groups]) => groups.length >= 2,
  );

  const lines = [
    `# Cross-Group Overlap Analysis`,
    "",
    `## Groups Compared`,
  ];

  for (const gid of groupIds) {
    const title = groupTitles.get(gid) || "Unknown";
    const count = groupMembers.get(gid)?.size ?? 0;
    lines.push(`- **${title}** (ID: ${gid}): ${count} members`);
  }

  lines.push("");
  lines.push(`## Overlap: ${overlapping.length} shared member(s)`);

  if (overlapping.length === 0) {
    lines.push("No members found in common across the specified groups.");
  } else {
    overlapping.sort((a, b) => b[1].length - a[1].length);
    for (const [mid, groups] of overlapping) {
      const info = allMemberInfo.get(mid);
      const name = info
        ? (info.display_name as string) || (info.first_name as string) || mid
        : mid;
      const uname = info?.username ? ` (@${info.username})` : "";
      const groupNames = groups
        .map((g) => groupTitles.get(g) || String(g))
        .join(", ");
      lines.push(`- **${name}${uname}** -- in ${groups.length} groups: ${groupNames}`);
    }
  }

  return lines.join("\n");
}

// ============================================================================
// DISPATCH
// ============================================================================

export async function handleAnalyticsTool(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "telegram_stats":
      return handleStats();
    case "telegram_group_analysis":
      return handleGroupAnalysis(args);
    case "telegram_cross_group_overlap":
      return handleCrossGroupOverlap(args);
    default:
      return `Unknown analytics tool: ${name}`;
  }
}
