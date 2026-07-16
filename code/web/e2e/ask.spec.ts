import { expect, test, type Response } from "@playwright/test";

function apiResponse(pathname: string, method: string) {
  return (response: Response) =>
    new URL(response.url()).pathname === pathname &&
    response.request().method() === method;
}

test("asks a question through the browser-backed server", async ({
  page,
}, testInfo) => {
  const actor = `playwright-reviewer-${testInfo.retry}`;
  const question = "How can a reviewer work without GitHub access?";

  await page.goto("/#/settings");
  await expect(
    page.getByText("Demo provider mode", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Actor handle").fill(actor);
  const saveButton = page.getByRole("button", { name: "Save settings" });
  await expect(saveButton).toBeEnabled();
  const [saveResponse] = await Promise.all([
    page.waitForResponse(apiResponse("/api/settings", "PUT")),
    saveButton.click(),
  ]);
  expect(saveResponse.ok()).toBe(true);
  await expect(page.getByText("Settings saved", { exact: true })).toBeVisible();
  expect(await saveResponse.json()).toMatchObject({
    key: "identity.actorHandle",
    value: actor,
    scope: "personal",
  });

  const settingsResponse = await page.request.get("/api/settings");
  expect(settingsResponse.ok()).toBe(true);
  expect((await settingsResponse.json()).items).toContainEqual(
    expect.objectContaining({
      key: "identity.actorHandle",
      value: actor,
      scope: "personal",
    }),
  );

  await page.goto("/#/ask");
  await expect(
    page.getByRole("heading", { name: "Ask the documentation" }),
  ).toBeVisible();

  await page
    .getByRole("textbox", { name: "Question", exact: true })
    .fill(question);
  const askButton = page.getByRole("button", {
    name: "Ask the documentation",
  });
  await expect(askButton).toBeEnabled();
  const [askResponse] = await Promise.all([
    page.waitForResponse(apiResponse("/api/ask", "POST")),
    askButton.click(),
  ]);
  expect(askResponse.ok()).toBe(true);
  const payload = await askResponse.json();
  expect(payload).toMatchObject({
    kind: "logged",
    question: {
      rawQuestion: question,
      askers: [actor],
    },
  });

  const questionResponse = await page.request.get(
    `/api/questions/${encodeURIComponent(payload.question.id)}`,
  );
  expect(questionResponse.ok()).toBe(true);
  expect(await questionResponse.json()).toMatchObject({
    id: payload.question.id,
    rawQuestion: question,
    askers: [actor],
  });

  await expect(
    page.getByText("Knowledge gap captured", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Librarian is checking the repository", { exact: true }),
  ).toBeHidden();
});
