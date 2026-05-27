import { describe, expect, it } from "vitest";
import { workflowFiles } from "@/lib/github/setup";

const baseInput = {
  devBranch: "develop",
  prodBranch: "main",
  includeCloudflare: true,
  includeIncidents: true,
  ciExists: false,
  previewExists: false,
  productionExists: false,
  notifyExists: false,
  deployExists: false,
  incidentsExists: false,
  packageJson: true,
  buildOutputDir: "dist",
  buildCommand: "npm run build"
};

describe("ShipBrain repo setup workflow generation", () => {
  it("adds the full workflow set for a fresh develop/main repo", () => {
    const files = workflowFiles(baseInput);
    expect(Object.keys(files).sort()).toEqual([
      ".github/workflows/shipbrain-ci.yml",
      ".github/workflows/shipbrain-notify.yml",
      ".github/workflows/shipbrain-preview.yml",
      ".github/workflows/shipbrain-production.yml"
    ]);
    expect(files[".github/workflows/shipbrain-ci.yml"]).toContain("branches: [develop, main]");
    expect(files[".github/workflows/shipbrain-ci.yml"]).toContain("Smoke test");
    expect(files[".github/workflows/shipbrain-preview.yml"]).toContain("workflow_dispatch");
  });

  it("never overwrites existing ShipBrain workflows and adds only the notify companion", () => {
    const files = workflowFiles({
      ...baseInput,
      ciExists: true,
      deployExists: true,
      incidentsExists: true
    });

    expect(Object.keys(files).sort()).toEqual([
      ".github/workflows/shipbrain-notify.yml",
      ".github/workflows/shipbrain-preview.yml"
    ]);
    expect(files[".github/workflows/shipbrain-ci.yml"]).toBeUndefined();
    expect(files[".github/workflows/shipbrain-production.yml"]).toBeUndefined();
    expect(files[".github/workflows/shipbrain-notify.yml"]).toContain("ShipBrain Notify");
  });

  it("omits Cloudflare preview work when Cloudflare is skipped", () => {
    const files = workflowFiles({ ...baseInput, includeCloudflare: false });
    expect(files[".github/workflows/shipbrain-preview.yml"]).toBeUndefined();
    expect(files[".github/workflows/shipbrain-production.yml"]).toBeUndefined();
  });

  it("uses production-only branch lists when no development branch is configured", () => {
    const files = workflowFiles({ ...baseInput, devBranch: null });
    expect(files[".github/workflows/shipbrain-ci.yml"]).toContain("branches: [main]");
    expect(files[".github/workflows/shipbrain-preview.yml"]).toBeUndefined();
  });
});
