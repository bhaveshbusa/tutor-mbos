import { expect, test } from "@playwright/test";

test("sign-in and recovery forms fail closed when Auth cannot complete", async ({
  page,
}) => {
  await page.goto("/login");
  await page.getByLabel("Email").first().fill("synthetic@example.com");
  await page.getByLabel("Password").fill("synthetic-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(
    page.getByText(/Sign-in failed\.|Sign-in could not be completed\./),
  ).toBeVisible();

  await page.goto("/login");
  await page.getByLabel("Email").nth(1).fill("synthetic@example.com");
  await page.getByRole("button", { name: "Email a recovery link" }).click();
  await expect(
    page.getByText("Account recovery could not be started."),
  ).toBeVisible();
});

test("a short recovery password is rejected before Auth is called", async ({
  page,
}) => {
  await page.goto("/auth/update-password");
  await page.getByLabel("New password").fill("        ");
  await page.getByRole("button", { name: "Update password" }).click();
  await expect(page.getByText("invalid_password")).toBeVisible();
});

test("onboarding without a session is unauthorized", async ({ page }) => {
  await page.goto("/onboarding");
  await expect(
    page.getByRole("heading", { name: "Create your business" }),
  ).toBeVisible();
  await page.getByLabel("Business name").fill("North Bridge Tutoring");
  await page.getByRole("button", { name: "Create business" }).click();
  await expect(
    page.getByText("A valid UI session or delegated access token is required."),
  ).toBeVisible();
});

test("consent without an authorization request explains the page", async ({
  page,
}) => {
  await page.goto("/oauth/consent");
  await expect(
    page.getByRole("heading", { name: "Authorize a client" }),
  ).toBeVisible();
  await expect(
    page.getByText("This page opens from a Supabase authorization request."),
  ).toBeVisible();
});
