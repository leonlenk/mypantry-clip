// @ts-check
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
  output: 'static',
  build: {
    format: 'file',
    assets: 'assets',
    inlineStylesheets: 'never',
  },
  vite: {
    // Prevent Vite pre-bundling Transformers.js since it relies on WASM loaded at runtime
    optimizeDeps: {
      exclude: ["@xenova/transformers", "onnxruntime-web"],
    },
    build: {
      assetsInlineLimit: 0,
      chunkSizeWarningLimit: 1500,
      rollupOptions: {
        onwarn(warning, warn) {
          if (warning.code === 'EVAL' && warning.id?.includes('onnxruntime-web')) {
            return;
          }
          warn(warning);
        },
        input: {
          background: "src/background.ts",
          content: "src/content.ts"
        },
        output: {
          entryFileNames: (chunk) => {
            if (chunk.name === "background") return "background.js";
            if (chunk.name === "content") return "content.js";
            return "assets/[name].[hash].js";
          }
        }
      }
    }
  }
});

