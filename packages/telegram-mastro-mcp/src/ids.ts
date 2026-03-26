// ============================================================================
// DETERMINISTIC ID GENERATION
// ============================================================================
// Uses UUID v5 to generate deterministic IDs for Telegram entities.
// This ensures idempotent writes — re-ingesting the same data produces
// the same node IDs, so KFDB upserts rather than duplicates.

import { v5 as uuidv5 } from "uuid";

// Namespace UUID for Telegram Mastro (generated once, never changes)
const TELEGRAM_NAMESPACE = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

export function telegramUserId(telegramId: number | string): string {
  return uuidv5(`telegram-user://${telegramId}`, TELEGRAM_NAMESPACE);
}

export function telegramMessageId(
  chatId: number | string,
  messageId: number | string,
): string {
  return uuidv5(
    `telegram-msg://${chatId}:${messageId}`,
    TELEGRAM_NAMESPACE,
  );
}

export function telegramGroupId(groupId: number | string): string {
  return uuidv5(`telegram-group://${groupId}`, TELEGRAM_NAMESPACE);
}

export function telegramConversationId(chatId: number | string): string {
  return uuidv5(`telegram-conv://${chatId}`, TELEGRAM_NAMESPACE);
}
