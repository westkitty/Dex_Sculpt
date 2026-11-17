# DEX//SCULPT — Character Foundry

A local-first, browser-based 3D character customization, sculpting workbench, and GLB foundry.

## Purpose

DEX//SCULPT lets artists import authorized rigged characters (or explore with the built-in procedural technical humanoid), sculpt and customize proportions, adjust materials, attach compatible modular gear, inspect rigs and animations, save non-destructive character recipes, and export game-ready GLB 2.0 files **without silently discarding skeletons, skin weights, morph targets, UVs, or animations**.

## Implemented Capabilities (Character DNA V2)

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
npx playwright install --with-deps chromium  # one-time browser setup (standard Playwright Chromium)
npm run test:e2e   # acquires the pinned fixture, then runs Chromium/WebGL2 E2E suite
```

Playwright enables SwiftShader WebGL2 in `playwright.config.ts`; browser rendering failures are fatal. No sandbox-specific browser paths or Chromium binaries are committed.

## Related Projects (Read-Only Upstream References)

- [FORM//ENGINE](https://github.com/westkitty/form-engine) — browser 3D sculpting and tablet interaction reference. Its `0.2.0` `normaliseGeometry()` drops skinning and morph targets; DEX//SCULPT avoids this via in-place delta-preserving buffers.
- [DEX//RIG](https://github.com/westkitty/Dex_Rig) — independent offline **2D** layered character animation workbench, not a 3D mesh-skinning engine. See [ARCHITECTURE.md](./ARCHITECTURE.md) for boundary and future integration notes.
- [Humanoid Character Library](https://github.com/westkitty/modern_3d_browser_game_toolkit/tree/feat/humanoid-asset-catalog-20261113/catalog/humanoids) — source metadata, skeleton compatibility matrix, and catalog records.

## Boundaries & Security

This repository is **public**. No private Google Drive IDs, signed URLs, API keys, restricted third-party asset binaries, or unapproved canonical character art are committed here. Users supply local third-party GLB files via the browser file picker; nothing is uploaded to any server.

## Release evidence and known limits (2026-11-17)

- **Implemented:** V2 Character DNA layers and variants remain owned by `CharacterSession.dna`; V2 recipes and V1 migration, SHA-256 relink checks, IndexedDB dual-slot recovery, rig-safe GLB pipeline, and the existing sculpt/rig/catalog UI remain the product architecture.
- **Verified locally against PR #3 head `0a25eee2dc030aa787b9271ab5cbb44fcaedbaed` plus the hardening changes:** typecheck, 40 unit tests, production build, and the complete Playwright suite (5/5) passed. This includes a real browser import/sculpt/layers/variants/autosave reload/export/reimport/animation journey on pinned Cesium Man, using actual WebGL render pixels and captured screenshots. Khronos glTF Validator reported zero errors for source and export; one known warning remains on each. See [Operational State](./OPERATIONAL_STATE.md) and [Delivery Report](./DELIVERY_REPORT.md).
- **Not tested in GitHub Actions:** A reproducible workflow is included in the portable patch, but the active Arena branch is an unrelated bootstrap checkout and no remote run has been observed. Do not treat the workflow file or local software-renderer run as a green GitHub check.
- **Physical device pending:** Playwright simulates stylus/touch events; physical Samsung Galaxy Tab S9 Ultra / S Pen, palm rejection, and device GPU behavior were not tested.
- **Targeted viewport correction:** Camera fit derives distance from perspective FOV and actual canvas aspect; desktop/tablet/narrow-aspect math is unit-tested, and the actual browser captures now show full-character framing.
- **Seam safety guard:** On the adversarial split-edge fixture, Smooth and Inflate produced measured gaps (0.2960 and 0.0904 model units); those two tools route through a conservative seam gate. Draw, Clay, Crease, Grab, Flatten, and Pinch produced no gap on that fixture and do not use that gate. This scoped finding does not generalize to every production mesh; browser warning UX and dense-mesh performance remain unverified.
- **Not implemented:** Dynamic topology/remeshing, automatic cross-skeleton animation retargeting, cloud services, and telemetry.

To run baseline checks: `npm ci && npm run typecheck && npm test && npm run build && npm run test:e2e`.

`npm run test:e2e` first acquires the pinned Khronos Cesium Man fixture into a Git-ignored local directory, then runs all Playwright tests, including the third-party studio journey. It needs access to the GitHub API once; normal app startup, typecheck, unit tests, and build do not need the asset. The binary is intentionally not committed because the model contains a Cesium logo excluded from its CC BY license; exact provenance, source hash, license details, and fixture limitations are documented in `tests/fixtures/README.md`. Numeric results are in `e2e-artifacts/real-character-evidence.json`. Browser screenshots are retained in the working evidence directory but omitted from the portable patch because they reproduce the excluded logo.
