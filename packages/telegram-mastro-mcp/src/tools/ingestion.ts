import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  kfdbWrite,
  wrapString,
  wrapInteger,
  wrapBoolean,
  type WriteOp,
} from "../kfdb.js";
import {
  telegramUserId,
  telegramMessageId,
  telegramGroupId,
  telegramConversationId,
} from "../ids.js";

// ============================================================================
// TOOL DEFINITIONS
// ============================================================================

export const ingestionTools: Tool[] = [
  {
    name: "telegram_ingest_profiles",
    description:
      "Batch import Telegram user profiles as TelegramUser nodes in the KFDB knowledge graph. " +
      "Creates deterministic node IDs from Telegram user IDs for idempotent upserts. " +
      "Each profile should include telegram_id, first_name, and optionally last_name, username, phone, bio.",
    inputSchema: {
      type: "object" as const,
      properties: {
        profiles: {
          type: "array",
          description: "Array of Telegram user profile objects to import",
          items: {
            type: "object",
            properties: {
              telegram_id: {
                type: "number",
                description: "Telegram user ID",
              },
              first_name: {
                type: "string",
                description: "First name",
              },
              last_name: {
                type: "string",
                description: "Last name",
              },
              username: {
                type: "string",
                description: "Telegram username (without @)",
              },
              phone: {
                type: "string",
                description: "Phone number",
              },
              bio: {
                type: "string",
                description: "User bio/about text",
              },
              is_bot: {
                type: "boolean",
                description: "Whether the user is a bot",
              },
              is_premium: {
                type: "boolean",
                description: "Whether the user has Telegram Premium",
              },
            },
            required: ["telegram_id", "first_name"],
          },
        },
      },
      required: ["profiles"],
    },
  },
  {
    name: "telegram_ingest_messages",
    description:
      "Import Telegram messages as TelegramMessage nodes with SENT edges from the sender " +
      "and IN_CONVERSATION edges to the chat. Optionally creates REPLY_TO edges. " +
      "Messages are deduplicated by chat_id + message_id.",
    inputSchema: {
      type: "object" as const,
      properties: {
        messages: {
          type: "array",
          description: "Array of message objects to import",
          items: {
            type: "object",
            properties: {
              chat_id: {
                type: "number",
                description: "Chat/conversation ID",
              },
              message_id: {
                type: "number",
                description: "Message ID within the chat",
              },
              sender_id: {
                type: "number",
                description: "Telegram user ID of the sender",
              },
              text: {
                type: "string",
                description: "Message text content",
              },
              date: {
                type: "string",
                description: "ISO 8601 timestamp of the message",
              },
              reply_to_msg_id: {
                type: "number",
                description: "Message ID this is replying to (if any)",
              },
              media_type: {
                type: "string",
                description:
                  "Type of media attachment (photo, video, document, etc.)",
              },
              chat_title: {
                type: "string",
                description: "Title of the chat/group for context",
              },
            },
            required: ["chat_id", "message_id", "sender_id", "text", "date"],
          },
        },
      },
      required: ["messages"],
    },
  },
  {
    name: "telegram_ingest_contacts",
    description:
      "Import Telegram contacts as TelegramUser nodes. Similar to telegram_ingest_profiles " +
      "but designed for the contact list export format with phone-centric data.",
    inputSchema: {
      type: "object" as const,
      properties: {
        contacts: {
          type: "array",
          description: "Array of contact objects to import",
          items: {
            type: "object",
            properties: {
              telegram_id: {
                type: "number",
                description: "Telegram user ID",
              },
              first_name: {
                type: "string",
                description: "First name",
              },
              last_name: {
                type: "string",
                description: "Last name",
              },
              phone: {
                type: "string",
                description: "Phone number",
              },
              username: {
                type: "string",
                description: "Telegram username",
              },
              mutual: {
                type: "boolean",
                description: "Whether the contact is mutual",
              },
            },
            required: ["telegram_id", "first_name"],
          },
        },
      },
      required: ["contacts"],
    },
  },
  {
    name: "telegram_ingest_mutual_groups",
    description:
      "Import group membership data. Creates TelegramGroup nodes and MEMBER_OF edges " +
      "between TelegramUser nodes and groups. Use this to map which users share which groups.",
    inputSchema: {
      type: "object" as const,
      properties: {
        groups: {
          type: "array",
          description: "Array of group membership records",
          items: {
            type: "object",
            properties: {
              group_id: {
                type: "number",
                description: "Telegram group/supergroup ID",
              },
              group_title: {
                type: "string",
                description: "Group title/name",
              },
              member_ids: {
                type: "array",
                items: { type: "number" },
                description: "Array of Telegram user IDs who are members",
              },
              member_count: {
                type: "number",
                description: "Total member count (may exceed member_ids length)",
              },
            },
            required: ["group_id", "group_title", "member_ids"],
          },
        },
      },
      required: ["groups"],
    },
  },
];

// ============================================================================
// HANDLERS
// ============================================================================

interface ProfileInput {
  telegram_id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  phone?: string;
  bio?: string;
  is_bot?: boolean;
  is_premium?: boolean;
}

async function handleIngestProfiles(
  args: Record<string, unknown>,
): Promise<string> {
  const profiles = args.profiles as ProfileInput[];
  if (!profiles || !Array.isArray(profiles) || profiles.length === 0) {
    return "Error: profiles array is required and must not be empty";
  }

  const ops: WriteOp[] = profiles.map((p) => {
    const props: Record<string, unknown> = {
      telegram_id: wrapInteger(p.telegram_id),
      first_name: wrapString(p.first_name),
      source: wrapString("telegram_mastro"),
      ingested_at: wrapString(new Date().toISOString()),
    };
    if (p.last_name) props.last_name = wrapString(p.last_name);
    if (p.username) props.username = wrapString(p.username);
    if (p.phone) props.phone = wrapString(p.phone);
    if (p.bio) props.bio = wrapString(p.bio);
    if (p.is_bot !== undefined) props.is_bot = wrapBoolean(p.is_bot);
    if (p.is_premium !== undefined) props.is_premium = wrapBoolean(p.is_premium);
    props.display_name = wrapString(
      [p.first_name, p.last_name].filter(Boolean).join(" "),
    );

    return {
      operation: "create_node" as const,
      label: "TelegramUser",
      id: telegramUserId(p.telegram_id),
      properties: props,
    };
  });

  await kfdbWrite(ops);
  return `Successfully ingested ${profiles.length} Telegram user profile(s) into KFDB.`;
}

interface MessageInput {
  chat_id: number;
  message_id: number;
  sender_id: number;
  text: string;
  date: string;
  reply_to_msg_id?: number;
  media_type?: string;
  chat_title?: string;
}

async function handleIngestMessages(
  args: Record<string, unknown>,
): Promise<string> {
  const messages = args.messages as MessageInput[];
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return "Error: messages array is required and must not be empty";
  }

  const ops: WriteOp[] = [];

  for (const msg of messages) {
    const msgNodeId = telegramMessageId(msg.chat_id, msg.message_id);
    const senderNodeId = telegramUserId(msg.sender_id);
    const convNodeId = telegramConversationId(msg.chat_id);

    // Create TelegramMessage node
    const props: Record<string, unknown> = {
      chat_id: wrapInteger(msg.chat_id),
      message_id: wrapInteger(msg.message_id),
      sender_id: wrapInteger(msg.sender_id),
      text: wrapString(msg.text),
      date: wrapString(msg.date),
      source: wrapString("telegram_mastro"),
    };
    if (msg.media_type) props.media_type = wrapString(msg.media_type);
    if (msg.chat_title) props.chat_title = wrapString(msg.chat_title);

    ops.push({
      operation: "create_node",
      label: "TelegramMessage",
      id: msgNodeId,
      properties: props,
    });

    // Ensure conversation node exists
    const convProps: Record<string, unknown> = {
      chat_id: wrapInteger(msg.chat_id),
    };
    if (msg.chat_title) convProps.title = wrapString(msg.chat_title);
    ops.push({
      operation: "create_node",
      label: "TelegramConversation",
      id: convNodeId,
      properties: convProps,
    });

    // SENT edge: user -> message
    ops.push({
      operation: "create_edge",
      edge_type: "SENT",
      from_id: senderNodeId,
      to_id: msgNodeId,
    });

    // IN_CONVERSATION edge: message -> conversation
    ops.push({
      operation: "create_edge",
      edge_type: "IN_CONVERSATION",
      from_id: msgNodeId,
      to_id: convNodeId,
    });

    // REPLY_TO edge if applicable
    if (msg.reply_to_msg_id) {
      const replyToNodeId = telegramMessageId(msg.chat_id, msg.reply_to_msg_id);
      ops.push({
        operation: "create_edge",
        edge_type: "REPLY_TO",
        from_id: msgNodeId,
        to_id: replyToNodeId,
      });
    }
  }

  await kfdbWrite(ops);
  return `Successfully ingested ${messages.length} message(s) with edges into KFDB.`;
}

interface ContactInput {
  telegram_id: number;
  first_name: string;
  last_name?: string;
  phone?: string;
  username?: string;
  mutual?: boolean;
}

async function handleIngestContacts(
  args: Record<string, unknown>,
): Promise<string> {
  const contacts = args.contacts as ContactInput[];
  if (!contacts || !Array.isArray(contacts) || contacts.length === 0) {
    return "Error: contacts array is required and must not be empty";
  }

  const ops: WriteOp[] = contacts.map((c) => {
    const props: Record<string, unknown> = {
      telegram_id: wrapInteger(c.telegram_id),
      first_name: wrapString(c.first_name),
      source: wrapString("telegram_mastro"),
      is_contact: wrapBoolean(true),
      ingested_at: wrapString(new Date().toISOString()),
    };
    if (c.last_name) props.last_name = wrapString(c.last_name);
    if (c.phone) props.phone = wrapString(c.phone);
    if (c.username) props.username = wrapString(c.username);
    if (c.mutual !== undefined) props.mutual_contact = wrapBoolean(c.mutual);
    props.display_name = wrapString(
      [c.first_name, c.last_name].filter(Boolean).join(" "),
    );

    return {
      operation: "create_node" as const,
      label: "TelegramUser",
      id: telegramUserId(c.telegram_id),
      properties: props,
    };
  });

  await kfdbWrite(ops);
  return `Successfully ingested ${contacts.length} contact(s) into KFDB.`;
}

interface GroupInput {
  group_id: number;
  group_title: string;
  member_ids: number[];
  member_count?: number;
}

async function handleIngestMutualGroups(
  args: Record<string, unknown>,
): Promise<string> {
  const groups = args.groups as GroupInput[];
  if (!groups || !Array.isArray(groups) || groups.length === 0) {
    return "Error: groups array is required and must not be empty";
  }

  const ops: WriteOp[] = [];
  let totalMembers = 0;

  for (const g of groups) {
    const groupNodeId = telegramGroupId(g.group_id);

    // Create TelegramGroup node
    const props: Record<string, unknown> = {
      group_id: wrapInteger(g.group_id),
      title: wrapString(g.group_title),
      source: wrapString("telegram_mastro"),
      ingested_at: wrapString(new Date().toISOString()),
    };
    if (g.member_count !== undefined) {
      props.member_count = wrapInteger(g.member_count);
    }

    ops.push({
      operation: "create_node",
      label: "TelegramGroup",
      id: groupNodeId,
      properties: props,
    });

    // MEMBER_OF edges for each member
    for (const memberId of g.member_ids) {
      const userNodeId = telegramUserId(memberId);
      ops.push({
        operation: "create_edge",
        edge_type: "MEMBER_OF",
        from_id: userNodeId,
        to_id: groupNodeId,
      });
      totalMembers++;
    }
  }

  await kfdbWrite(ops);
  return (
    `Successfully ingested ${groups.length} group(s) with ${totalMembers} ` +
    `membership edge(s) into KFDB.`
  );
}

// ============================================================================
// DISPATCH
// ============================================================================

export async function handleIngestionTool(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "telegram_ingest_profiles":
      return handleIngestProfiles(args);
    case "telegram_ingest_messages":
      return handleIngestMessages(args);
    case "telegram_ingest_contacts":
      return handleIngestContacts(args);
    case "telegram_ingest_mutual_groups":
      return handleIngestMutualGroups(args);
    default:
      return `Unknown ingestion tool: ${name}`;
  }
}
