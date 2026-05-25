import { expect, test } from "@playwright/test";

test("spec-to-pr happy path with approval gate", async ({ page }) => {
  await page.goto("/spec-to-pr");
  await page.getByRole("button", { name: /generate pr/i }).click();
  await expect(page.getByRole("dialog")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: /^approve$/i }).click();
  await expect(page.getByRole("link", { name: /draft pr/i })).toBeVisible({ timeout: 20_000 });
});
