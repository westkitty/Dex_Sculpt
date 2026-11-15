# DEX//SCULPT — Character Foundry

A local-first, browser-based 3D character customization, sculpting workbench, and GLB foundry.

## Purpose

DEX//SCULPT lets artists import authorized rigged characters (or explore with the built-in procedural technical humanoid), sculpt and customize proportions, adjust materials, attach compatible modular gear, inspect rigs and animations, save non-destructive character recipes, and export game-ready GLB 2.0 files **without silently discarding skeletons, skin weights, morph targets, UVs, or animations**.

## Verified Capabilities (Current Branch)

- **Rig-Safe Non-Destructive Sculpting (`src/core/`)**:
  - 9 brushes: `Draw`, `Clay`, `Smooth`, `Inflate`, `Crease`, `Grab`, `Flatten`, `Pinch`, and `Mask` with `X/Y/Z` mirror symmetry and bounded byte-exact undo/redo.
  - Operates in welded unique-vertex space and applies exact position deltas back to render buffers in-place, preserving `JOINTS_0`, `WEIGHTS_0`, `TEXCOORD_0`, `morphAttributes`, and `Skeleton` bindings.
  - Non-destructive `sculptMask` shader visualization via `onBeforeCompile` (never pollutes `COLOR_0`).
- **Original Technical Humanoid & Modular Fixtures (`src/fixtures/`)**:
  - **DEX Foundry Technical Humanoid**: 20-bone hierarchy, smooth multi-bone skin weights, 4 relative morph targets (`Broaden_Shoulders`, `Heroic_Chest`, `Jaw_Width`, `Torso_Volume`), procedural suit UV texture, and 3 skeletal clips (`Idle_Breathing`, `Walk_Cycle`, `Wave_Greeting`).
  - Procedural modular attachments: `Foundry Visor Crest`, `Shoulder Pauldron (L)`, and `Foundry Cloak (Skinned)`.
- **GLB Import, Bind-Pose Export & Independent Binary Validator (`src/io/`)**:
  - Preserves skinning, morph targets, UVs, materials, and animations across GLB round-trips.
  - Independent zero-Three.js binary GLB 2.0 auditor (`validateGlbBinary` + `compareRigPreservation`) verified against both **Three.js `0.186.1`** and an independent **Three.js `0.185.1`** consumer.
- **Character Recipes & Local Persistence (`src/core/recipe.ts`, `src/io/projectStorage.ts`)**:
  - Exports/imports `dexsculpt.recipe.v1` JSON recording sparse vertex deltas, morph weights, material overrides, attachments, source SHA-256, and license/provenance metadata (with explicit Source GLB Relink workflow when local binaries are needed).
  - Crash-safe alternating A/B IndexedDB autosave.
- **Humanoid Catalog Metadata & Modular Compatibility (`src/catalog/`, `src/modular/`)**:
  - Indexes `786` sanitized metadata records (`43` sources, `25` skeleton families) from `modern_3d_browser_game_toolkit` (`private_locator` omitted).
  - Compatibility-aware bone-socket, static-prop, and skinned-clothing assembly.
- **Studio Viewport & Pen/Touch Pipeline (`src/app/`, `src/ui/`)**:
  - WebGL2 viewport with `3/4`, `Front`, `Back`, `Left`, `Right` camera presets, Perspective/Orthographic toggle, Grid/Axes/Skeleton overlays, 4 lighting presets (`Studio`, `Rim`, `Warm`, `Clay`), Before/After toggle, and S Pen / multi-touch Pointer Events support.

## Run Locally

```bash
npm install
npm run dev        # http://127.0.0.1:5190
npm run typecheck  # TypeScript check
npm test           # Vitest unit + r186/r185 rig-preservation proof
npm run build      # Production build -> dist/
npm run test:e2e   # Playwright Chromium WebGL2 E2E suite
```

## Related Projects (Read-Only Upstream References)

- [FORM//ENGINE](https://github.com/westkitty/form-engine) — browser 3D sculpting and tablet interaction reference. Its `0.2.0` `normaliseGeometry()` drops skinning and morph targets; DEX//SCULPT avoids this via in-place delta-preserving buffers.
- [DEX//RIG](https://github.com/westkitty/Dex_Rig) — independent offline **2D** layered character animation workbench, not a 3D mesh-skinning engine. See [ARCHITECTURE.md](./ARCHITECTURE.md) for boundary and future integration notes.
- [Humanoid Character Library](https://github.com/westkitty/modern_3d_browser_game_toolkit/tree/feat/humanoid-asset-catalog-20261113/catalog/humanoids) — source metadata, skeleton compatibility matrix, and catalog records.

## Boundaries & Security

This repository is **public**. No private Google Drive IDs, signed URLs, API keys, restricted third-party asset binaries, or unapproved canonical character art are committed here. Users supply local third-party GLB files via the browser file picker; nothing is uploaded to any server.
