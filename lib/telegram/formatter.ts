export function escapeTelegram(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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
