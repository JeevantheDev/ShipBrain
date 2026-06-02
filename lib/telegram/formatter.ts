export function escapeTelegram(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Escape text for Telegram Markdown parse mode.
 * This escapes all markdown special characters to prevent parsing errors.
 */
export function escapeMarkdown(value: unknown) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\*/g, "\\*")
    .replace(/_/g, "\\_")
    .replace(/`/g, "\\`")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/~/g, "\\~")
    .replace(/>/g, "\\>")
    .replace(/#/g, "\\#")
    .replace(/\+/g, "\\+")
    .replace(/-/g, "\\-")
    .replace(/=/g, "\\=")
    .replace(/\|/g, "\\|")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/\./g, "\\.")
    .replace(/!/g, "\\!");
}

/**
 * Convert standard markdown to Telegram-compatible markdown.
 * Telegram uses:
 * - *bold* (single asterisk, not double)
 * - _italic_ (underscore)
 * - `code` (backticks)
 * - [text](url) for links
 *
 * This function tries to fix unbalanced markdown entities that would cause
 * Telegram API to reject the message.
 */
export function toTelegramMarkdown(text: string): string {
  let result = text
    // Convert **bold** to *bold* (Telegram uses single asterisk for bold)
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    // Convert __text__ to _text_ (already Telegram italic format)
    .replace(/__(.+?)__/g, "_$1_");

  // Count occurrences of formatting characters
  // If there's an odd number of any character, we have unbalanced formatting
  // which will cause Telegram to reject the message
  const countOccurrences = (str: string, char: string) => {
    let count = 0;
    for (let i = 0; i < str.length; i++) {
      if (str[i] === char && (i === 0 || str[i - 1] !== '\\')) {
        count++;
      }
    }
    return count;
  };

  // Check for unbalanced formatting characters and escape if needed
  const formatChars = ['*', '_', '`'];
  for (const char of formatChars) {
    const count = countOccurrences(result, char);
    if (count % 2 !== 0) {
      // Unbalanced - escape ALL occurrences of this character
      result = result.replace(new RegExp(`(?<!\\\\)\\${char}`, 'g'), `\\${char}`);
    }
  }

  return result;
}

export function formatNotificationForTelegram(item: {
  title: string;
  body?: string | null;
  repo_full_name?: string | null;
  severity?: string | null;
  href?: string | null;
}) {
  const icon = item.severity === "critical" || item.severity === "warning" ? "🚨" : item.severity === "success" ? "✅" : "🔔";
  return [
    `${icon} <b>${escapeTelegram(item.title)}</b>`,
    item.body ? escapeTelegram(item.body) : "",
    item.repo_full_name ? `<code>${escapeTelegram(item.repo_full_name)}</code>` : "",
    item.href ? `Open in ShipBrain: ${escapeTelegram(item.href)}` : ""
  ].filter(Boolean).join("\n");
}
