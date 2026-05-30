export function escapeTelegram(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Convert standard markdown to Telegram-compatible markdown.
 * Telegram uses:
 * - *bold* (single asterisk, not double)
 * - _italic_ (underscore)
 * - `code` (backticks)
 * - [text](url) for links
 */
export function toTelegramMarkdown(text: string): string {
  return text
    // Convert **bold** to *bold* (Telegram uses single asterisk for bold)
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    // Convert __text__ to _text_ (already Telegram italic format)
    .replace(/__(.+?)__/g, "_$1_")
    // Escape special characters that might break Telegram markdown
    // but preserve intentional formatting
    .replace(/([_*`\[])/g, (match, char, offset, str) => {
      // Check if this is part of a formatting pair
      const before = str.slice(Math.max(0, offset - 2), offset);
      const after = str.slice(offset + 1, offset + 3);
      // If it looks like intentional formatting, keep it
      if (char === '*' || char === '_' || char === '`' || char === '[') {
        return match;
      }
      return '\\' + char;
    });
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
