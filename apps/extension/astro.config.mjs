// @ts-check
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
  output: 'static',
  build: {
    format: 'file',
    assets: 'assets',
  },
  vite: {
    // Prevent Vite pre-bundling Transformers.js since it relies on WASM loaded at runtime
    optimizeDeps: {
      exclude: ["@xenova/transformers", "onnxruntime-web"],
    },
    build: {
      chunkSizeWarningLimit: 1500,
      rollupOptions: {
        onwarn(warning, warn) {
          if (warning.code === 'EVAL' && warning.id?.includes('onnxruntime-web')) {
            return;
          }
          warn(warning);
        },
        input: {
          background: "src/background.ts"
        },
        output: {
          entryFileNames: (chunk) => {
            if (chunk.name === "background") return "background.js";
            return "assets/[name].[hash].js";
          }
        }
      }
    }
  }
});

