import { createHmac, timingSafeEqual } from "crypto";

export type GithubPullRequestWebhook = {
  action?: string;
  repository?: { full_name?: string };
  pull_request?: {
    number?: number;
    html_url?: string;
    title?: string;
    state?: string;
    draft?: boolean;
    merged?: boolean;
    head?: { ref?: string };
    base?: { ref?: string };
  };
};

export type GithubDeleteWebhook = {
  ref?: string;
  ref_type?: string;
  repository?: { full_name?: string };
};

export function signWebhookPayload(payload: string, secret: string) {
  return `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
}

export function verifyWebhookSignature(payload: string, signature: string | null, secret = process.env.GITHUB_WEBHOOK_SECRET) {
  if (!secret || !signature) return false;
  const expected = signWebhookPayload(payload, secret);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

export function statusFromPullRequestEvent(payload: GithubPullRequestWebhook) {
  const action = payload.action;
  const pullRequest = payload.pull_request;
  if (!pullRequest) return null;
  if (action === "closed") return pullRequest.merged ? "merged" : "closed";
  if (pullRequest.state === "open") return "draft_created";
  return null;
}

export function isBranchDeleteEvent(payload: GithubDeleteWebhook) {
  return payload.ref_type === "branch" && Boolean(payload.ref && payload.repository?.full_name);
}
