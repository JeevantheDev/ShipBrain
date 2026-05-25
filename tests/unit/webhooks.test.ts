import { describe, expect, it } from "vitest";
import { isBranchDeleteEvent, signWebhookPayload, statusFromPullRequestEvent, verifyWebhookSignature } from "@/lib/github/webhooks";

describe("GitHub webhook signatures", () => {
  it("accepts a valid HMAC-SHA256 signature", () => {
    const payload = JSON.stringify({ ok: true });
    const signature = signWebhookPayload(payload, "secret");
    expect(verifyWebhookSignature(payload, signature, "secret")).toBe(true);
  });

  it("rejects a wrong secret", () => {
    const payload = JSON.stringify({ ok: true });
    const signature = signWebhookPayload(payload, "secret");
    expect(verifyWebhookSignature(payload, signature, "other")).toBe(false);
  });

  it("rejects a tampered payload", () => {
    const payload = JSON.stringify({ ok: true });
    const signature = signWebhookPayload(payload, "secret");
    expect(verifyWebhookSignature(JSON.stringify({ ok: false }), signature, "secret")).toBe(false);
  });

  it("maps closed pull requests to closed or merged app statuses", () => {
    expect(statusFromPullRequestEvent({ action: "closed", pull_request: { merged: false } })).toBe("closed");
    expect(statusFromPullRequestEvent({ action: "closed", pull_request: { merged: true } })).toBe("merged");
  });

  it("maps open pull request activity to draft_created", () => {
    expect(statusFromPullRequestEvent({ action: "reopened", pull_request: { state: "open" } })).toBe("draft_created");
    expect(statusFromPullRequestEvent({ action: "synchronize", pull_request: { state: "open" } })).toBe("draft_created");
  });

  it("detects branch deletion events", () => {
    expect(isBranchDeleteEvent({ ref_type: "branch", ref: "feat/demo", repository: { full_name: "owner/repo" } })).toBe(true);
    expect(isBranchDeleteEvent({ ref_type: "tag", ref: "v1.0.0", repository: { full_name: "owner/repo" } })).toBe(false);
  });
});
