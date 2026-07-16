import { expect, test } from "@playwright/test";

test("asks a question through the browser-backed server", async ({ page }) => {
  await page.goto("/#/settings");
  await page.getByLabel("Actor handle").fill("playwright-reviewer");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("Saved")).toBeVisible();

  await page.goto("/#/ask");
  await expect(
    page.getByRole("heading", { name: "Ask the documentation" }),
  ).toBeVisible();

  await page
    .getByLabel("Question")
    .fill("How can a reviewer work without GitHub access?");
  await page.getByRole("button", { name: "Ask the documentation" }).click();

  await expect(
    page.getByRole("region", { name: "Conversation" }),
  ).toContainText(/review|logged|documentation/iu);
});
