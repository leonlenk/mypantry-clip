import { defineConfig } from "@playwright/test";
import path from "path";

export default defineConfig({
    testDir: "../../tests/extension/e2e",
    timeout: 40_000,
    retries: 0,
    // Each test gets an isolated Chrome context (separate process + temp dir),
    // so tests are fully independent and can run in parallel.
    fullyParallel: true,
    workers: process.env.CI ? 2 : 4,
    reporter: [
        ["list"],
        ["html", { outputFolder: "../../coverage/e2e/html", open: "never" }],
    ],

    // Each project maps to one page/feature area so you can run them independently:
    //   pnpm exec playwright test --project=pantry
    //   pnpm exec playwright test --project=recipe
    //   pnpm exec playwright test --project=recipe-edit
    //   pnpm exec playwright test --project=popup
    projects: [
        {
            name: "pantry",
            testMatch: "pantry.spec.ts",
        },
        {
            name: "recipe",
            testMatch: "recipe.spec.ts",
        },
        {
            name: "recipe-edit",
            testMatch: "recipe-edit.spec.ts",
        },
        {
            name: "popup",
            testMatch: "popup.spec.ts",
        },
    ],
});
