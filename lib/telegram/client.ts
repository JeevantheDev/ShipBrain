const telegramApiBase = "https://api.telegram.org";

export function hasTelegramConfig() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN);
}

export async function sendTelegramMessage(input: {
  chatId: number | string;
  text: string;
  parseMode?: "Markdown" | "MarkdownV2" | "HTML";
}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required.");

  const payload: Record<string, unknown> = {
    chat_id: input.chatId,
    text: input.text.slice(0, 3900),
    disable_web_page_preview: true
  };
  if (input.parseMode) payload.parse_mode = input.parseMode;

  const response = await fetch(`${telegramApiBase}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.ok === false) {
    throw new Error(json.description ?? "Telegram rejected the message.");
  }
  return json;
}

export async function setTelegramWebhook(webhookUrl: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required.");

  const response = await fetch(`${telegramApiBase}/bot${token}/setWebhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: webhookUrl,
      secret_token: process.env.TELEGRAM_WEBHOOK_SECRET,
      allowed_updates: ["message"]
    })
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.ok === false) {
    throw new Error(json.description ?? "Unable to set Telegram webhook.");
  }
  return json;
}

export async function setTelegramCommands() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required.");

  const response = await fetch(`${telegramApiBase}/bot${token}/setMyCommands`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      commands: [
        { command: "prs", description: "Pending PRs and release PRs" },
        { command: "status", description: "Release trace pending-action summary" },
        { command: "traces", description: "Active release traces" },
        { command: "trace", description: "Release trace detail by id" },
        { command: "verify", description: "Verify preview or production trace by id" },
        { command: "approve", description: "Approve pending release action by id" },
        { command: "plan", description: "Analyze a spec and save an AI plan" },
        { command: "draft_pr", description: "Create Draft PR from spec id or ticket" },
        { command: "deployments", description: "Pending dev/prod deployment queue" },
        { command: "deploy", description: "Deploy the next valid stage by id" },
        { command: "deploy_dev", description: "Deploy a pending develop preview by id" },
        { command: "deploy_prod", description: "Tag and deploy a pending production release by id" },
        { command: "redeploy_dev", description: "Re-run develop preview deployment by id" },
        { command: "redeploy_prod", description: "Re-run production deployment by id" },
        { command: "incidents", description: "Open incidents" },
        { command: "incident", description: "Incident detail by id" },
        { command: "analyze_incident", description: "Analyze incident with AI by id" },
        { command: "create_hotfix", description: "Create hotfix Draft PR by incident id" },
        { command: "sync_hotfix", description: "Refresh hotfix PR commits by incident id" },
        { command: "approve_fix", description: "Approve and merge incident hotfix by id" },
        { command: "postmortem", description: "Generate incident post-mortem by id" },
        { command: "releases", description: "Recent releases" },
        { command: "ci", description: "Latest CI workflow runs" },
        { command: "help", description: "Show available commands" }
      ]
    })
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.ok === false) {
    throw new Error(json.description ?? "Unable to set Telegram commands.");
  }
  return json;
}
