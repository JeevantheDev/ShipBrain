import { describe, expect, it } from "vitest";
import { workflowFiles } from "@/lib/github/setup";

const baseInput = {
  devBranch: "develop",
  prodBranch: "main",
  includeVercel: true,
  includeIncidents: true,
  ciExists: false,
  deployExists: false,
  incidentsExists: false,
  packageJson: true
};

describe("ShipBrain repo setup workflow generation", () => {
  it("adds the full workflow set for a fresh develop/main repo", () => {
    const files = workflowFiles(baseInput);
    expect(Object.keys(files).sort()).toEqual([
      ".github/workflows/shipbrain-ci.yml",
      ".github/workflows/shipbrain-deploy.yml",
      ".github/workflows/shipbrain-incidents.yml"
    ]);
    expect(files[".github/workflows/shipbrain-ci.yml"]).toContain("branches: [develop, main]");
    expect(files[".github/workflows/shipbrain-ci.yml"]).toContain("Vercel preview deploy");
    expect(files[".github/workflows/shipbrain-ci.yml"]).toContain("inputs:");
    expect(files[".github/workflows/shipbrain-ci.yml"]).toContain("deploy_preview:");
    expect(files[".github/workflows/shipbrain-ci.yml"]).toContain("source_pr_number:");
    expect(files[".github/workflows/shipbrain-ci.yml"]).toContain("inputs.source_pr_number");
    expect(files[".github/workflows/shipbrain-ci.yml"]).toContain("SHIPBRAIN_FORCE_FAIL");
    expect(files[".github/workflows/shipbrain-ci.yml"]).not.toContain("shipbrain-force-fail.txt");
    expect(files[".github/workflows/shipbrain-ci.yml"]).toContain("continue-on-error: true");
    expect(files[".github/workflows/shipbrain-ci.yml"]).toContain("ShipBrain callback secrets are missing; CI notification skipped.");
    expect(files[".github/workflows/shipbrain-deploy.yml"]).toContain("workflow_dispatch");
    expect(files[".github/workflows/shipbrain-deploy.yml"]).not.toContain("push:");
  });

  it("never overwrites existing ShipBrain workflows and adds only the CI notify companion", () => {
    const files = workflowFiles({
      ...baseInput,
      ciExists: true,
      deployExists: true,
      incidentsExists: true
    });

    expect(Object.keys(files)).toEqual([".github/workflows/shipbrain-ci-notify.yml"]);
    expect(files[".github/workflows/shipbrain-ci.yml"]).toBeUndefined();
    expect(files[".github/workflows/shipbrain-deploy.yml"]).toBeUndefined();
    expect(files[".github/workflows/shipbrain-incidents.yml"]).toBeUndefined();
    expect(files[".github/workflows/shipbrain-ci-notify.yml"]).toContain("ShipBrain CI notify");
  });

  it("omits Vercel preview work when Vercel is skipped", () => {
    const files = workflowFiles({ ...baseInput, includeVercel: false });
    expect(files[".github/workflows/shipbrain-deploy.yml"]).toBeUndefined();
    expect(files[".github/workflows/shipbrain-ci.yml"]).not.toContain("Vercel preview deploy");
  });

  it("uses production-only branch lists when no development branch is configured", () => {
    const files = workflowFiles({ ...baseInput, devBranch: null });
    expect(files[".github/workflows/shipbrain-ci.yml"]).toContain("branches: [main]");
    expect(files[".github/workflows/shipbrain-ci.yml"]).not.toContain("Vercel preview deploy");
  });
});
