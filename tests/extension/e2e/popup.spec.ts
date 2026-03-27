/**
 * Popup page smoke test.
 *
 * Run just this suite:
 *   pnpm exec playwright test --project=popup
 *
 * Requires a built extension in apps/extension/dist/.
 * Run `pnpm run ext:build` first.
 */

import { test, expect } from "./fixtures";

test("popup renders the main view after setup", async ({ popupPage }) => {
    await expect(popupPage.locator("#main-view")).toBeVisible();
    await expect(popupPage.locator("h1")).toHaveText("MyPantry Clip");
    await expect(popupPage.locator("#profile-badge-btn")).toBeVisible();
});
