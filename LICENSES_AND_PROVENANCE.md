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

## Public Model Gallery Render Thumbnails (2026-11-21)

- `src/data/modelThumbnailManifest.json` records **139 unambiguously mapped front-view PNG renders**. Source files originated from a bounded existing humanoid-library visual-QA archive, and each public filename is tied to the catalogue's exact asset ID, source ID, license tag, and processed GLB SHA-256. Eleven front-view source renders lacking a unique catalogue match are excluded.
- Bundled files: `public/model-thumbnails/*__posZ.png`. These are static images of models, not redistributable geometry files or local files needed by the editor. No GLBs, private Drive IDs, tokens or preview manifest are published.
- **136 renders** have catalogue source license `CC0-1.0`; **three GDQuest Mannequiny renders** have `CC-BY-4.0` and carry GDQuest attribution in the model inspector. Source collection and license identity are available for each image. Consult `docs/MODEL_GALLERY.md` before revising that allocation.
- **Quaternius transition:** Original catalogue intake lists the selected older Quaternius models as CC0; the current QAL license (effective August 28, 2026) permits publishing completed products incorporating assets but prohibits redistributing standalone source assets, and is non-retroactive. Do not use this release as authority to redistribute additional raw assets, source meshes or unrelated private QA files. Authoritative terms: https://quaternius.com/license.html.
- Unillustrated 647 catalogue entries remain metadata only. Do not invent pictures or silently substitute visually similar models.

## Public Static Model-Render Thumbnails

- 161 catalogue-aligned PNG renders in `public/model-thumbnails/`: 136 CC0-1.0, 3 GDQuest CC BY 4.0 (with required credit in the gallery), and 22 Microsoft Rocketbox avatars under the source repository's MIT licence.
- The Rocketbox renders are screenshot derivatives from the existing authorized 2026-11-13/14 WebGL2 QA captures. Each is linked to one exact catalogue asset ID, processed-GLB hash, source ID and license; oblique camera views are labelled separately in the manifest.
- Rocketbox upstream: https://github.com/microsoft/Microsoft-Rocketbox ; MIT license: https://github.com/microsoft/Microsoft-Rocketbox/blob/master/LICENSE.md . No GLB/FBX/TGA source assets, private Drive IDs, archives or QA logs are distributed.
- Image inclusion does not mean an underlying GLB is available for public download or that an artwork has human visual approval.
