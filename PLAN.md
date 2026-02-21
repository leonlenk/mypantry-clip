# Scaffolding the Astro Extension

This plan outlines the initialization of an empty Astro project tailored for a Chrome extension, setting up SCSS for styling, and creating the necessary UI components for the action panel, onboarding flow, and dashboard.

## Overview of Changes

1. **Astro Initialization:**
   - Execute `pnpm create astro@latest . --template minimal --no-git` in the root folder.
   - Install SCSS support with `pnpm add -D sass`.

2. **Astro Configuration (`astro.config.mjs`):**
   - Update `build.format` to `'file'` to output exact `popup.html`, `setup.html`, and `pantry.html` files needed for Chrome Extension routing (preventing Astro from generating `popup/index.html` structure).

3. **Core Entry Files:**
   - `src/pages/popup.astro`: The Action Panel HTML skeleton.
   - `src/pages/setup.astro`: The Onboarding Flow HTML skeleton.
   - `src/pages/pantry.astro`: The internal Dashboard HTML skeleton.

4. **Styling and Layout Architecture:**
   - `src/styles/global.scss`: Defines global variables, typography choices (serif-heavy aesthetic using modern clean rules), and dark/light color palettes.
   - Ensure styling is modular to avoid CSS bleed during content script injection (if we later use popup styling in content paths).

## User Review
Please review this approach. If it sounds correct, I will execute the commands to scaffold the project, set up the pages, and output the directory tree.
