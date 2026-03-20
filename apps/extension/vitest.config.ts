import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
    test: {
        environment: "jsdom",
        setupFiles: ["../../tests/extension/setupTests.ts"],
        include: ["../../tests/extension/**/*.test.ts"],
        coverage: {
            provider: "v8",
            include: ["src/**/*.ts"],
            exclude: [
                "src/**/*.d.ts",
                // Page-level scripts tightly coupled to Chrome/DOM — not unit-testable
                "src/scripts/**",
                "src/background.ts",
                "src/content.ts",
                "src/background/**",
                // DOM-heavy page helpers (require document.getElementById + event wiring)
                "src/utils/byok.ts",
                "src/utils/setup.ts",
            ],
            reporter: ["text", "lcov", "html"],
            all: true,
            reportsDirectory: "../../coverage/extension",
        },
    },
    resolve: {
        alias: {
            // Mirror the extension's src path so imports like "../types/recipe"
            // resolve correctly when tests import from src/utils/*.
            "@src": path.resolve(__dirname, "src"),
        },
    },
});
