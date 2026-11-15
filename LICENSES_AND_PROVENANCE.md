# Licenses & Provenance

## Application Dependencies (Runtime & Test)

- `three` (`^0.186.1`) — MIT License
- `three-mesh-bvh` (`^0.9.16`) — MIT License
- `fflate` (`^0.8.3`) — MIT License
- `three-r185` (`npm:three@^0.185.1`, devDependency for consumer verification) — MIT License
- `vite`, `vitest`, `@playwright/test`, `typescript`, `happy-dom` (devDependencies) — MIT / Apache-2.0

## Built-In Procedural Fixtures (Original)

- `src/fixtures/proceduralHumanoid.ts` — **DEX Foundry Technical Humanoid** (20 bones, 4 morph targets, 3 skeletal clips, procedural suit `DataTexture`) — Original procedural geometry authored for DEX//SCULPT (MIT).
- `src/fixtures/proceduralAccessories.ts` — **Foundry Visor Crest**, **Shoulder Pauldron (L)**, and **Foundry Cloak (Skinned)** — Original procedural geometry authored for DEX//SCULPT (MIT).

## Humanoid Character Library Metadata (`src/data/`)

Sanitized public metadata snapshots derived from `westkitty/modern_3d_browser_game_toolkit` (`feat/humanoid-asset-catalog-20261113`, commit `43441c49d799ba83fd5a4711507c977907beb63b`):
- `src/data/humanoidCatalog.json` — 786 asset metadata entries (`private_locator` omitted).
- `src/data/humanoidSources.json` — 43 public source records with upstream URLs and license tags (`MIT`, `CC0-1.0`, `CC-BY-4.0`).
- `src/data/humanoidCompatibility.json` — 25 skeleton family specs, retargeting notes, and explicit incompatibility rules.

### Attribution Notice

No third-party model binaries are bundled in this repository. When users locally import third-party assets (such as `CC-BY-4.0` assets like GDQuest Open 3D Mannequin or `MIT` Microsoft Rocketbox avatars), DEX//SCULPT preserves source license/attribution metadata inside Character Recipes (`dexsculpt.recipe.v1`) and displays required attributions when linked to a catalog ID.

## Upstream Code Reference Note

`westkitty/form-engine` (public repo) served as a conceptual and code-pattern reference for `SculptMesh`, `VertexGrid`, `StrokeEngine`, `StrokeRecorder`, and tablet Pointer Events handling, refactored here into rig-safe delta-preserving modules.
