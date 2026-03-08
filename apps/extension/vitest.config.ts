import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
    test: {
        environment: "jsdom",
        setupFiles: ["../../tests/extension/setupTests.ts"],
        include: ["../../tests/extension/**/*.test.ts"],
    },
    resolve: {
        alias: {
            // Mirror the extension's src path so imports like "../types/recipe"
            // resolve correctly when tests import from src/utils/*.
            "@src": path.resolve(__dirname, "src"),
        },
    },
});
