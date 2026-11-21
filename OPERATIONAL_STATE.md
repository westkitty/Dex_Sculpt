# Operational State — DEX//SCULPT Character DNA V2

**Reviewed:** 2026-11-17 (UTC)
**Code under verification:** exact PR #3 head `0a25eee2dc030aa787b9271ab5cbb44fcaedbaed` plus the portable hardening changes in this workspace.
**Delivery checkout:** active Arena branch `arena/88aa43b0-dex-sculpt` is based on unrelated bootstrap commit `c0cc55196d29681c75611f7ef8a012474ea0078f`; it was not edited or used as a PR #3 base. Deliver changes as a patch against the exact PR #3 head.

## Status matrix

| Status | Capability / evidence |
|---|---|
| **IMPLEMENTED** | `CharacterSession.dna` remains authoritative; non-destructive layers, isolated variants, V1/V2 recipes, SHA-256 source verification, IndexedDB recovery, rig-safe GLB import/export, nine brushes, masks, symmetry, undo/redo, attachments, catalog and viewport remain in the PR #3 project. No Character DNA recreation or unrelated subsystem expansion was performed. |
| **LOCAL REPOSITORY CHECKS — PASS** | On the hardening tree: `npm run typecheck` passed; `npm test` passed **40/40** tests across 7 files; `npm run build` passed (existing large-JS-chunk advisory); `npm run test:e2e` passed **5/5** Playwright tests using a real Chromium/WebGL2 SwiftShader browser. Existing unit-test Three.js instance/texture warnings remain. |
| **THIRD-PARTY BROWSER JOURNEY — PASS (local only)** | The Playwright test imported pinned Cesium Man bytes through the real file picker; sculpted and toggled two layers; edited and switched isolated variants; downloaded a V2 recipe; autosaved and reloaded; exported and independently validated a GLB; used the studio reimport action; compared protected data; and played the reimported animation. Actual canvas pixels and browser screenshots were captured. This is local software-renderer/browser proof, not GitHub Actions or hardware-device proof. |
| **SOURCE / LICENSE PROVENANCE — RECORDED** | Cesium Man, Cesium (2017), Khronos `glTF-Sample-Assets` commit `f0920f5b32d172a30efe3f9257e965918831e6ea`; exact path and URL, CC BY 4.0 model license with the Cesium logo/trademark excluded, 438,044 bytes, SHA-256 `b7001eaeea8254bd44773bcd247e78696d94169388fbb2a1800fc69434e777d9`. Binary is acquired only into an ignored local fixture folder and is not in the portable patch. |
| **MEASURED IMPORT / SCULPT / ROUND-TRIP** | Browser observed 1 skinned mesh, 3,273 render vertices, 4,672 triangles, 19 bones, 1 two-second animation, 1 material, and no morph targets. Local sculpt displacement max was **0.0702960** model units on export; head/body regions measured **0.0333678 / 0.0307955** units; hidden head region returned **0**, while body remained **0.0307955**. Variant A/B position difference max **0.0356012**. Reload canvas pixel diff was **0.000%**. Exact values are in `e2e-artifacts/real-character-evidence.json`. |
| **PROTECTED DATA — PASS FOR THIS CHARACTER** | Export audit: bone hierarchy, animation names, material count, JOINTS_0 exact, UV max diff **0**, inverse bind matrix max diff **0**, skin-weight max diff `5.96e-8`. Independent in-browser post-reimport snapshot additionally matched the bone names/parents/hierarchy, UVs, material properties, morph-attribute layout (empty on this model), and animation names; skin weights max diff `2.98e-8`. This asset has no morph targets, so third-party morph-target preservation is not established by this journey. |
| **INDEPENDENT KHRONOS VALIDATOR — PASS WITH WARNING** | `gltf-validator@2.0.0-dev.3.10`: source **0 errors / 1 warning**, export **0 errors / 1 warning / 0 infos** in the latest browser test. Warning `NODE_SKINNED_MESH_NON_ROOT` is present on both. Export bytes: **416,340**. |
| **RENDERED ANIMATION — PASS (local browser)** | Reimported `animation_0 (2.00s)` changed the sampled skinned vertices by max **0.4698927** model units. Actual viewport screenshots differed by **9.4984%** of pixels (max channel delta 221). Local visual captures are under `e2e-artifacts/real-character-*.png`; these include the model's excluded Cesium mark and are intentionally not bundled into the portable patch. |
| **SPLIT-SEAM ADVERSARIAL FIXTURE — PARTIAL** | On the two-triangle split-edge fixture, Smooth opened a `0.2960245861` unit gap and Inflate `0.0904220490`; Draw, Clay, Crease, Grab, Flatten and Pinch measured zero for that fixture. The guard is scoped only to Smooth and Inflate, where the defect was reproduced, and the regression rejects the historical footprint without changing positions. This is fixture-specific evidence, not a claim that other production meshes/tools cannot crack. Browser warning UX, seam usability and dense-mesh performance remain unverified. Protected attributes are not blindly welded. |
| **GITHUB ACTIONS — NOT VERIFIED** | No remote Actions run was started or observed. The workflow is part of the proposed patch only. Local Chromium success must not be described as a successful GitHub Actions run. |
| **PHYSICAL TABLET / S PEN — PENDING** | Existing synthetic pointer-event coverage passes. No physical tablet/S Pen, palm-rejection hardware, pressure sensor or device GPU test was performed. |
| **AUDIT / BUILD NOTES** | Vite emits the existing large bundle advisory. `npm install` surfaced a high dev-only `happy-dom` advisory; no compatibility-blind major dependency upgrade was made. |
| **NOT IMPLEMENTED / OUT OF SCOPE** | Dynamic topology/remeshing, arbitrary cross-skeleton retargeting, cloud accounts/storage, telemetry, FORM//ENGINE and DEX//RIG changes. |

## Reproduction

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run test:e2e
```

`npm run test:e2e` uses `scripts/acquire-real-character.mjs` to fetch the exact pinned model from the GitHub API and verifies byte count and SHA-256 before Playwright begins. To run only the existing Node/core acceptance:

```bash
npm run test:real-character
```

Browser setup on a standard Linux runner:

```bash
npx playwright install --with-deps chromium
npm run test:e2e
```

The model and GLB export are not committed. See `tests/fixtures/README.md` for the full source, attribution, licensing boundary, mesh/rig/animation measurements, and acquisition details. `e2e-artifacts/real-character-evidence.json` is the compact machine-readable result; local screenshots are not redistributed because the model includes an explicitly excluded trademark.

## Safety and release posture

- Fixed topology is retained; no dynamic remeshing was introduced. Coincident positions are not sufficient reason to weld: UVs, normals, material groups, skin indices/weights and morph data remain compatibility dimensions.
- Smooth and Inflate route through the seam safety check based on reproduced fixture defects. Other brushes remain ungated based on zero gaps in this test fixture only. Do not generalize that measurement beyond the tested geometry.
- `npm run test:e2e` proves the local browser workflow and rendered pixels for this one third-party model; it does not certify arbitrary GLBs, multi-skinned-mesh characters, third-party morph targets, every GPU/browser, or physical S Pen behavior.
- The active Arena branch is not based on PR #3. No branch switch, push, PR update, merge or remote publication was performed. The complete portable patch must target `0a25eee2dc030aa787b9271ab5cbb44fcaedbaed` exactly and include its own manifest, checksums, commands, report and evidence index.

**Overall outcome: PARTIAL.** The requested third-party import-to-animation journey is independently reproduced in a real local browser and the code-quality checks pass. Delivery remains partial because no GitHub Actions result exists, the authorized branch is unrelated to PR #3, the physical stylus is untested, and seam-browser UX/performance and wider asset coverage remain open.


## Public-safe model gallery — 2026-11-20 (publication candidate)

- **Bounded branch:** `feat/model-gallery-publishable` based on the repository's existing `main` reference, in a separate worktree. The original private local-model checkout is excluded.
- **Added:** gallery HTML entrypoint, studio navigation, searchable/scrollable metadata cards, opt-in SHA-256 matched local GLB preview and on-demand 3D viewport, optional local-only preview index, and a two-page Vite build.
- **Privacy rule:** No private Drive IDs, third-party binary files, cached GLBs, or local preview JSON may be committed to the public repository. `gallery-drive-previews.json` is ignored. No permission to publish other private integrations is implied.
- **Verification state:** Implementation is candidate work until `npm run typecheck`, `npm test`, `npm run build`, output checks, and actual browser checks pass on the final worktree. Publishing, CI and physical-device rendering remain unverified; do not claim deployment.
- **Protected:** Existing sculpt/import/recipe/export flows, third-party license restrictions, original project checkouts, Google Drive archive and verified local model cache.

## Impeccable UI/UX gauntlet implementation (2026-11-20)

- **Scope:** On top of the unmerged Model Gallery branch, the editor and gallery receive the 8 quick wins, 5 behavior/polish repairs, and 3 structural upgrades from the November 20 review. Work is isolated on `feat/impeccable-gauntlet-20261120`; no merge or deployment is implied.
- **Safety lock:** Existing rig-safe sculpting, Character DNA V2, animation, export/reimport verification, variants, source SHA-256 validation, IndexedDB recovery, and S Pen support remain protected. Public gallery previews still require authorized models and must not bundle private original GLBs, Drive IDs or the private preview manifest.
- **Data integrity:** `associateCatalogRecord` rejects catalog records whose source SHA-256 is missing or mismatched; mismatches cannot change license/provenance metadata. Verified matches remain supported.
- **Interaction and accessibility:** Morph live input no longer recreates its own control; gesture-origin values are retained for Undo/Redo. Controls have visible focus rings, labels, larger hit targets, responsive inert drawers, native dialog focus behavior, status announcements, and meaningful loading states.
- **Navigation and imagery:** The editor groups secondary actions under More tools while preserving their handlers. Existing Playwright journeys are adapted to use this navigation. Gallery falls back to a compact searchable metadata list without authorized preview assets; detail actions do not promise automatic GLB import.
- **Validation envelope:** New `e2e/uiGauntlet.spec.ts` covers the 375/768/1024/1440px targets, gallery semantics, basic modal focus, morph Undo, A/B state, and catalog source identity. The historical GLB/Character DNA browser acceptance remains mandatory. Passing tests must be established by an actual CI run, not inferred from this note.
- **Known limits:** Physical Galaxy S Pen hardware, real third-party preview libraries, visual screen-reader certification, and automated Impeccable detector evidence remain separately unverified unless subsequently tested.
