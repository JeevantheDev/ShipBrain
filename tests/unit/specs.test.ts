import { describe, expect, it } from "vitest";
import { isSpecId } from "@/components/ui/SpecCitation";

describe("isSpecId validation", () => {
  it("matches valid full UUIDs", () => {
    expect(isSpecId("1851df18-71fd-4943-bdb9-238399c40c64")).toBe(true);
    expect(isSpecId("df476a1e-5891-4ac1-8208-b7e905a87cb3")).toBe(true);
    expect(isSpecId("  DF476A1E-5891-4AC1-8208-B7E905A87CB3  ")).toBe(true);
  });

  it("matches valid 8-character hex spec IDs", () => {
    expect(isSpecId("df476a1e")).toBe(true);
    expect(isSpecId("1851df18")).toBe(true);
    expect(isSpecId("DF476A1E")).toBe(true);
  });

  it("matches other valid partial UUID hex prefixes with hyphens", () => {
    expect(isSpecId("df476a1e-5891")).toBe(true);
    expect(isSpecId("df476a1e-5891-4ac1")).toBe(true);
    expect(isSpecId("df476a1e-5891-4ac1-8208")).toBe(true);
  });

  it("does not match non-hex or invalid length strings", () => {
    expect(isSpecId("df476a1")).toBe(false); // length 7
    expect(isSpecId("nonhex8c")).toBe(false); // contains non-hex characters
    expect(isSpecId("123")).toBe(false); // too short
    expect(isSpecId("deploying")).toBe(false); // regular word
    expect(isSpecId("incident")).toBe(false); // regular word
  });
});
