# DEX//SCULPT Character DNA V2 — Delivery Report

**Current patch target:** PR #3 exact head `0a25eee2dc030aa787b9271ab5cbb44fcaedbaed`
**Active Arena checkout:** `arena/88aa43b0-dex-sculpt` at unrelated bootstrap base `c0cc55196d29681c75611f7ef8a012474ea0078f` (left untouched)
**Date:** 2026-11-17 (UTC)

> The first sections below preserve historical V2 delivery evidence from 2026-11-16. The later **Latest continuation verification — third-party browser journey** section is the current state and supersedes any earlier `PENDING` or `BLOCKED` browser claims. Delivery is a portable patch against the exact PR #3 head; no remote publication or Actions run was performed.

---

## Historical initial V2 result matrix (2026-11-16)

The following results describe the earlier V2 branch and remain historical evidence; they are not the current PR #3 delivery status.

| Gate | Status | Proof |
|---|---|---|
| **PATCH APPLIES** | ✅ PASS | `dna-safety-increment.patch` applied **cleanly, exactly once** onto verified base `6211b19e` (`git apply --check` first). The superseded `dna-sha256.patch` / DNA overlay were **not** applied. Baseline reproduced before any V2 work: typecheck 0 errors, **18/18 unit**, build ok, **2/2 V1 browser** (headless Chromium 153). |
| **TESTS COMPILE** | ✅ PASS | `npm run typecheck` (strict, `noUnusedLocals`/`noUnusedParameters`) — 0 errors across src + tests + e2e. |
| **UNIT TESTS PASS** | ✅ PASS | **29/29** (`npm test`): 18 baseline (1 Phase-A GLB round-trip, 9 safety-increment incl. legacy-hash fail-closed, 3 dnaLayers core, 5 layer math) + **11 new V2 integration tests** (`tests/v2/dnaWorkflow.test.ts`). |
| **BROWSER WORKFLOW PASSES** | ✅ PASS | **4/4** Playwright (real Chromium): 2 V1 regressions (full studio journey + S Pen) + **2 V2** (`e2e/dnaWorkflow.spec.ts`): the complete 20-step layered authoring journey with render-pixel evidence, and a negative suite (malformed recipe + corrupted GLB leave the character intact). |
| **DELIVERED TO GITHUB** | see §Delivery | One NEW draft PR `arena/9dff85d7-dex-sculpt` → `feat/dex-sculpt-character-foundry`. PR #1 and PR #2 untouched. Portable patch + manifest exported as backup. |

Commands (Chromium harness; Playwright CDN is blocked in this environment — Chromium 153 + AL2023 libs supplied out-of-band, never in package.json/lock):

```bash
npm ci --legacy-peer-deps
npm run typecheck && npm test && npm run build
DEX_CHROME=/tmp/chromium LD_LIBRARY_PATH=/tmp/al2023-lib/lib:/tmp npm run test:e2e
```

---

## What was built (ONE authoritative character state)

`CharacterSession.dna` (schema `dexsculpt.dna.v2`) is the **single source of truth**. The scene is a deterministic projection: `compose(immutable sourcePos + enabled layers × strength)` → rig-safe projection → morphs → materials. No parallel state managers; no mutable geometry snapshots as second truth.

- **Non-destructive sculpt layers** (create / rename / select-active / sculpt-into / toggle visibility / set strength / duplicate / reset / delete, all undo-redo, persisted & restored). Stroke capture is exact: `delta_after = delta_before + (pos_now − pos_preStroke)` on touched render vertices only; untouched vertices stay bit-identical. Strength scales at composition time. Hiding a layer never deletes edits (proven pixel-identical on re-show).
- **Character variants** (create / duplicate / rename / switch / compare / reset / delete with confirmation), each owning layers, morphs, material overrides and accessories. Switching is a deterministic recomposition of the same immutable source — switching back and forth is render-pixel-identical (evidence below). Accessories per variant are visibility-scoped (same object tree, `onlyVisible` export), duplicating rebuilds from procedural id or cached local bytes, otherwise it preserves metadata and reports a relink warning — never invents geometry.
- **Recipes**: schema `dexsculpt.recipe.v2` embeds the full DNA document; legacy `v1` migrates explicitly into one "Imported V1 sculpt" layer. Real SHA-256 source verification everywhere: a non-64-hex legacy identity (e.g. FNV fingerprint) is **rejected** until explicit relink + re-verification; ambiguous/missing mesh names are skipped with a warning (never guessed); malformed deltas/indices abort **atomically** before any state change. Failed relinks/malformed recipes leave the loaded character intact (e2e negative).
- **One history**: all layer/variant/recipe edits and strokes flow through one bounded undo-redo stack whose applyState restores both geometry and document state exactly.
- **IndexedDB autosave** with dual rotating slots, stable project key, cached source bytes for byte-deterministic recovery, and an honest recovery-status readout (RECOVERABLE / RELINK NEEDED + SHA-256).
- **UI** (viewport stays dominant; V1 tools/tablet preserved): Sculpt Layers panel (with undo/redo feedback), Character Variants panel (switch + rename + duplicate/reset/delete), **A/B comparison modal** with identical canonical camera framing/lighting plus computed pixel-difference statistics, and a Project Status card (autosave, recoverability, relink, validation notes).
- **GLB export** composes the active variant into the rig-safe render state and preserves skeleton/IBMs/joints/weights/UVs/morphs/materials/animations (bind-pose export, editor-mask stripped) — verified by the zero-Three structural auditor plus an independent reimport diff.

### Stroke & history semantics (decisive test evidence)
`tests/v2/dnaWorkflow.test.ts` proves with real `StrokeEngine` dabs: jaw-band displacement appears only in the Jaw layer, shoulder-band only in Shoulders; hiding Jaw removes exactly the jaw displacement and re-showing restores it; strength 0.5 reproduces exactly at 0.5× with **bit-identical** recomposition on repeat; undo/redo walk the exact LIFO stack across strokes, visibility toggles and doc edits.

---

## Browser evidence (real rendering, real pixels)

All screenshots in [`e2e-artifacts/`](e2e-artifacts/) (this run, headless Chromium 153). Machine-readable summary: [`e2e-artifacts/pixel-evidence.json`](e2e-artifacts/pixel-evidence.json).

Canonical captures are taken with a fixed bbox-framed camera + studio light + bind pose (`session.captureCanonicalPng()`), transient brush cursors excluded; diffs computed in-page over decoded pixels (`session.diffPngDataUrls`) — **canvas size is never used as evidence**.

| Comparison | changed pixels | max channel Δ | Meaning |
|---|---|---|---|
| jaw-only vs both layers | **1.23 %** | 54 | Shoulders sculpt renders different geometry |
| both vs jaw-hidden | **0.66 %** | 97 | Hiding a layer visibly changes the render |
| reshown vs both | **0.000 %** | 0 | Show restores **bit-identical** pixels — edits were never lost |
| Hero vs Hero Alt | **12.15 %** | 178 | Variant differences (layer + morph + material) are real |
| before reload vs after reload | **0.000 %** | 0 | Browser reload restores **pixel-identical** state |

Journey screenshots: `step01-loaded-humanoid` (20 bones · 4 morphs · 3 clips), `step02/03` Jaw layer + sculpt, `step04` both layers, `step05-jaw-hidden` / `step06` hide+show with independent geometry verification, `step10/11` variants, `step12-hero-alt-modified`, `step15-ab-compare-modal` (side-by-side canonical captures + diff stats in the modal), `step16-recipe-saved` (downloaded recipe validates as `dexsculpt.recipe.v2`), `step18-restored-after-reload` (active variant, 3 layers, morph 0.5, region displacements restored), `step19-export-modal` (VERIFIED PASS + full rig-preservation diff: 20 bone names/hierarchy, IBM < 1e-6, joints exact, weights/UV/morph deltas 0, 3/3 animation names, sculpt delta survived export), `step20-animation-playing` (Walk_Cycle plays on the reimported model). Negative: `negative-character-intact.png`.

### ⚠️ Real defect found and fixed by this verification pass
The V2 pixel evidence exposed a **pre-existing rendering defect**: `main.ts` constructed `StudioViewport` on a detached staging `div`, and `studioUi` later adopted only the canvas — so the ResizeObserver watched a 0×0 orphan and the **WebGL drawing buffer stayed 1×1 while the canvas displayed at 886×854**. Every previous test passed because nothing ever asserted pixels (raycasts/sculpt/export are camera-math and scene-graph based). The fix (`viewport.attach(el)` re-parent + re-observe) is in this PR; the blank-viewport screenshots from the failing run were the proof. After the fix the buffer is 886×854 and captures carry real pixels (~160 KB PNGs vs 88-byte 1×1 blanks).

---

## Negative tests (fail-safe, atomic)

- Legacy recipe with non-SHA-256 identity ("deadbeef") → rejected with explicit re-verification message (unit + migration tests; safety-increment test preserved).
- Malformed sculpt deltas (NaN / OOB / duplicate indices) → whole migration aborts; prior state untouched (unit).
- Ambiguous/missing mesh names → skipped with warning, never guessed (unit).
- V2 recipe with tampered `sourceSha256` → rejected atomically; geometry buffer byte-identical before/after (unit).
- Corrupted GLB bytes → independent validator reports `validGlb2=false` with errors (unit), and a corrupted GLB upload through the real file input leaves the loaded character fully intact (e2e).
- Malformed recipe file through the real recipe input → rejected; character intact (e2e).

## Honest limitations & seam-crack evaluation

- **Seams**: the rig-safe mask deforms vertices adjacent to rigid-weighted regions; vertices are welded **only** when all protected attributes (bone indices, weights, UVs, morph deltas) match exactly (`compatKey` in `core/topology.ts`). Incompatible vertices are never blindly welded — a visible crack at skinning-region boundaries remains possible and is not hidden. The procedural fixture shows no crack; a production character with dense rigid weights may.
- **Layer strength** commits on slider release (consistent with V1 morph sliders); drag preview updates the label only.
- **Duplicate variant attachments**: local-GLB accessories are rebuilt from cached bytes captured during the session; an accessory first imported in an earlier session and never re-attached reports a relink warning with metadata preserved (no fabricated geometry).
- **REAL_ASSET_VALIDATION_PENDING**: the journey runs on the deterministic procedural rigged humanoid. A third-party rigged character (Quaternius, ~393 KB) exists in the maintainer's private storage, but its per-file license/provenance cannot be verified from inside this environment without fabricating proof, and private model archives must not be uploaded — so no licensing claim is made. Re-running the journey with an audited CC0 asset is a drop-in replacement (`e2e/dnaWorkflow.spec.ts` steps are model-agnostic apart from the two stroke coordinates).

## V1 preservation

All 18 baseline unit tests and both V1 e2e journeys pass unchanged against the V2 tree (assertions not weakened; the V1 recipe APIs remain as derived views — `buildRecipe`/`loadRecipe` call sites were migrated to `buildProjectRecipe`/`loadProjectRecipe`). FORM//ENGINE and DEX//RIG untouched. PR #1, PR #2 and both existing branches untouched.

---

## Delivery

- All work committed to the Arena-pinned branch `arena/9dff85d7-dex-sculpt` (base `6211b19e`, ff'd onto V1 base `feat/dex-sculpt-character-foundry`).
- **One** new draft PR: `arena/9dff85d7-dex-sculpt` → `feat/dex-sculpt-character-foundry`.
- Portable backup: `dex-sculpt-dna-v2.patch` (full `git diff 6211b19e..HEAD`) + `dex-sculpt-dna-v2-manifest.json` (per-file SHA-256 + checksums + reproduce commands) exported in the workspace root.
- Final diff scan performed: no secrets, no private paths/Drive IDs/signed URLs, no model binaries (`google_drive/` ignored and untracked; exported GLB evidence regenerable and ignored), no unintended source changes, V1 tests intact, provenance documented.

### Reproduce everything
See `dex-sculpt-dna-v2-manifest.json` → `verify` block for exact commands and expected counts: typecheck 0 errors · unit 29/29 · build ok · e2e 4/4 · pixel-evidence.json diff table as above.

---

# Independent hardening pass — 2026-11-17

> This pass was performed against a clean extraction of PR #3 head `0a25eee2dc030aa787b9271ab5cbb44fcaedbaed`. It is separate from the historical V2 run above. The current Arena checkout is on a different branch based on `c0cc551`; therefore the changes below are being delivered as a portable patch, not represented as already merged into PR #3.

## Verified test results

- `npm ci` — **PASS** from the lockfile (64 packages installed; audit reports one high dev-only `happy-dom` advisory).
- `npm run typecheck` — **PASS**.
- `npm test` — **38/38 PASS** (includes adversarial topology/attribute compatibility and seam-preflight regressions plus four viewport-fit tests).
- `npm run build` — **PASS** (Vite reports the existing large JS chunk warning).
- `npm run test:real-character` — **1/1 PASS in this execution**, after the pinned fixture was acquired and SHA/length checked; this is Node/core-pipeline evidence, not the full browser authoring workflow.
- `npm run test:e2e` — **BLOCKED before test bodies**: 4 tests could not launch because Playwright's Chromium headless shell is absent at `/home/user/.cache/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell`. No app/browser regression result can be inferred from this launch failure.
- GitHub Actions — **NOT RUN / NOT VERIFIED**. A CI workflow is included in the patch; there is no observed successful run.
- `npm audit` — **1 high advisory** in direct dev dependency `happy-dom@20.14.6` (the suggested fix is a major update to `21.0.4`). This is test-only rather than shipped runtime code; no compatibility-blind major upgrade was included. A focused upgrade/review remains pending.

## Third-party character acceptance (local core pipeline, not browser visual proof)

**Asset:** Cesium Man, authored/published by Cesium (2017), from KhronosGroup/glTF-Sample-Assets pinned at commit `f0920f5b32d172a30efe3f9257e965918831e6ea`. Exact binary path: `Models/CesiumMan/glTF-Binary/CesiumMan.glb`; URL: `https://github.com/KhronosGroup/glTF-Sample-Assets/blob/f0920f5b32d172a30efe3f9257e965918831e6ea/Models/CesiumMan/glTF-Binary/CesiumMan.glb`.

Per-asset license is **CC BY 4.0** for model files, with the Cesium logo/trademark explicitly excluded (see the same commit's `Models/CesiumMan/LICENSE.md`, `README.md`, and `metadata.json`). Attribution: **Cesium, 2017**. The binary contains a Cesium mark, so it is fetched only into an ignored test folder and is not redistributed in this patch/repository. Size **438,044 bytes**; SHA-256 **`b7001eaeea8254bd44773bcd247e78696d94169388fbb2a1800fc69434e777d9`**.

Source metrics independently inspected: GLB 2.0; **1** skinned mesh; **3,273** render vertices; **4,672** triangles; POSITION/NORMAL/TEXCOORD_0/JOINTS_0/WEIGHTS_0; **19 joints**, 19 inverse-bind matrices, 57 animation channels, one **2-second** animation, one material; skin weights have up to four influences and maximum per-vertex sum error `8.94e-8`. No morph targets. Khronos glTF Validator `2.0.0-dev.3.10` reported **0 errors, 1 warning** (`NODE_SKINNED_MESH_NON_ROOT`, node 2).

The opt-in test imported the model through `importCharacterBytes`/`CharacterSession.loadLocalFile`, sculpted distinct upper/lower regions in two named layers, hid/restored one layer while measuring only its region, created an isolated second variant and observed distinct positions, serialized a V2 recipe to JSON and reconstructed two variants against the exact source bytes, exported, independently audited the GLB and rig invariants, reimported it, and sampled actual skinned vertex positions before/after animation. Export measurements: inverse-bind maximum diff **0**, joint indices exact, UV maximum diff **0**, skin-weight maximum diff `5.96e-8`, animation count/name and hierarchy preserved, sculpt displacement max **0.0130166 model units**. The reimported animation produced a maximum vertex deformation above **0.01 model units** (asserted numerically).

In this execution, the independent Khronos glTF Validator npm package `2.0.0-dev.3.10` was run on the source and exported GLBs. Source: **0 errors, 1 warning** (`NODE_SKINNED_MESH_NON_ROOT`). Export (**298,712 bytes**): **0 errors, 1 warning, 1 info** (same skinned-mesh warning plus `UNUSED_OBJECT` for TEXCOORD_0). In the Node-only pipeline test, Three.js logged that it could not decode the embedded image texture; therefore material/UV structure was measured but textured rendered appearance was **not** validated. Browser visual animation and texture acceptance remain pending. The single-mesh, no-morph character is not evidence for multi-mesh or third-party morph-target coverage; the procedural morph fixture covers only the separate local test case.

### Confirmed validator correction

The source asset omits the glTF animation `name`. DEX's auditor previously synthesized `Animation_0`, whereas Three.js reimported it as `animation_0`; the export/reimport comparison falsely reported that the clip had been renamed. The hardening patch aligns the audit fallback with Three.js (`animation_${index}`). Animation channel count, duration, and measured skeletal deformation were independently checked, so this correction avoids masking actual clip loss.

## Confirmed viewport framing defect and bounded correction

Visual inspection of the historical Playwright screenshots showed the procedural character cropped at the viewport top and bottom, despite the actual WebGL canvas rendering. The camera used a fixed distance of `2.45 × boundingSphereRadius` with a 36-degree vertical field of view; that is too close to fit the focus sphere. The hardening patch computes a padded perspective fit distance from the actual camera FOV and canvas aspect ratio. Four unit cases check desktop, tablet-landscape, narrow-canvas fit, and invalid inputs. This corrects the mathematical cause; **browser confirmation is pending** because Chromium could not be launched in this environment.

## Seam/topology stress findings

The synthetic split-edge fixture exercises coincident render positions with differing UVs, hard normals, material groups, joint indices, skin weights, and morph deltas. Each protected-data mismatch remains a separate render/sculpt vertex group. A controlled Smooth stroke across the UV/hard-normal/material split measured a `0.2960245861` model-unit gap (historical characterization). A conservative fail-closed guard is now implemented: geometry-displacing dabs are preflighted against original coincident positions split by protected attributes; an active stroke is canceled and rolled back before a segment reaching such a seam can mutate it. Mask painting is exempt because it does not displace geometry. A regression test applies the exact historical dab center/radius and verifies rejection with position bytes unchanged. No protected attributes are welded or overwritten.

**Guard limits:** unit tests cover the geometry preflight predicate and historical footprint, but browser-level pointer interaction, mid-stroke rollback, warning display, performance on dense production meshes, and multiple skinned meshes in one character remain unverified. The guard intentionally sacrifices sculpt reach near any protected-attribute split rather than risk a crack; it does not coordinate displacement across semantically distinct copies.

## CI/evidence changes included in the patch

- Adds a locked-install GitHub Actions gate on Node `22.22.3`: typecheck, unit suite, production build, Playwright Chromium installation with Linux dependencies, and the complete non-skipping E2E suite under SwiftShader. Failure artifacts are retained for 14 days.
- Adds a test-only, pinned GitHub API acquisition command with exact SHA/length checks; normal app startup has no network dependency.
- Adds strict WebGL software-renderer launch flags and a 64-KiB cap for future `pixel-evidence.json` summaries. The historical approximately **1.36-MB** JSON remains intact; it contains verbose typed-array-expanded validation output but no raw image pixels. Future runs summarize the numeric structural proof instead of serializing those arrays.
- Updates current status and V2 architecture documentation, retaining historical PR #3 evidence and provenance.

## Current release decision

**PARTIAL — not a production-readiness PASS.** The third-party browser journey and complete local Playwright suite now pass, as detailed in the current continuation update below. GitHub Actions has no observed run, physical tablet/S Pen validation remains pending, and seam-browser warning UX, dense-mesh behavior, and broader asset coverage remain unverified. See `OPERATIONAL_STATE.md` for the current status matrix.

---

# Latest continuation verification — third-party browser journey (2026-11-17)

This is the current evidence update and supersedes the earlier hardening-only statement that the real-character browser test had not run. The exact PR #3 head remains the portable patch base. The active Arena checkout is unrelated and remained untouched. No push, PR update, merge, or GitHub Actions run occurred.

## Reproduced commands and results

Against the inspection tree with the hardening patch and the scoped seam change:

```text
npm ci                                    PASS — 65 packages installed; one high dev-only audit advisory
npm run typecheck                         PASS
npm test                                   PASS — 40/40 tests, 7 files
npm run build                              PASS — existing large-chunk advisory
npm run test:e2e                           PASS — 5/5 Playwright browser tests
```

The browser command now invokes the pinned, byte-checked model acquisition script before Playwright. Local E2E ran in Chromium 153 with WebGL2/SwiftShader. A standard reproducible runner should install Chromium via `npx playwright install --with-deps chromium`; no sandbox-only path or bundled browser binary is part of the project. The complete suite retains the procedural DNA pixel workflow, negative import/recovery, existing studio/render/S Pen simulations, and the new third-party browser journey. No test assertions were removed or weakened.

## Real character identity and limits

- **Asset:** Cesium Man, authored/published by Cesium (2017); KhronosGroup `glTF-Sample-Assets`, pinned repository commit `f0920f5b32d172a30efe3f9257e965918831e6ea`.
- **Exact source:** `Models/CesiumMan/glTF-Binary/CesiumMan.glb`; [pinned source page](https://github.com/KhronosGroup/glTF-Sample-Assets/blob/f0920f5b32d172a30efe3f9257e965918831e6ea/Models/CesiumMan/glTF-Binary/CesiumMan.glb).
- **License:** CC BY 4.0 for the model files; the Cesium logo/trademark is explicitly excluded (pinned `LICENSE.md`, `README.md`, and `metadata.json`). The local test fixture, exported GLB, and downloaded recipe are not included in the patch. The screenshots also reproduce the excluded mark, so screenshots are retained only in the local evidence directory and are not redistributed with the patch.
- **Integrity:** 438,044 bytes; SHA-256 `b7001eaeea8254bd44773bcd247e78696d94169388fbb2a1800fc69434e777d9`. The acquisition script rejects any size/hash mismatch.
- **Observed import attributes:** one skinned mesh; 3,273 render vertices; 4,672 triangles; 19 bones and inverse-bind matrices; 57 animation channels; one 2.00-second animation; one material; zero morph targets; JOINTS_0, WEIGHTS_0 and TEXCOORD_0 present. No multi-skinned-mesh or third-party morph-target claim is made.

## Browser workflow and measured evidence

`e2e/realCharacterWorkflow.spec.ts` drives the actual studio browser: file-picker import and SHA verification; two named sculpt layers with independent region displacement and visibility; independent A/B variants with actual position differences; downloaded `dexsculpt.recipe.v2`; IndexedDB autosave and page reload; GLB export; independent Khronos validation; application reimport; and playback of the reimported animation. Pixel evidence is captured from the actual WebGL canvas for import, reload and animation. Export is additionally checked with DEX's structural preservation audit.

| Measurement | Observed result |
|---|---:|
| Head / body sculpt maximum regional displacement | 0.0333677964 / 0.0307954522 model units |
| Head region after hiding its layer | 0 (body region remained 0.0307954522) |
| A/B variant maximum position difference | 0.0356012210 model units |
| Autosave reload canonical render difference | 0.000% changed pixels; max channel delta 0 |
| Export sculpt displacement maximum | 0.0702960155 model units |
| Export bytes | 416,340 |
| Joint indices / UV / hierarchy / animation / material checks | exact/passed |
| Skin weight max diff after export audit / browser reimport | 5.9604645e-8 / 2.9802322e-8 |
| Inverse bind matrix max diff | 0 |
| Post-reimport animation vertex motion (sampled) | 0.4698927212 model units |
| Actual viewport rest-vs-playing pixel diff | 9.498390% changed; max channel delta 221 |

Khronos glTF Validator `2.0.0-dev.3.10` on the source: **0 errors, 1 warning**. Export: **0 errors, 1 warning, 0 infos** in this run. The warning on both is `NODE_SKINNED_MESH_NON_ROOT`; it is reported, not suppressed. Reimport checks include exact JOINTS_0 and UV values, near-exact WEIGHTS_0, skeleton names/parents/hierarchy, material properties, morph-attribute layout, and animation names. The character has no morph targets, so that check confirms the empty layout remains empty only.

Machine-readable measurements: `e2e-artifacts/real-character-evidence.json`. Local browser screenshots: `real-character-imported.png`, `real-character-two-layers.png`, `real-character-restored.png`, `real-character-animation-rest.png`, `real-character-animation-playing.png`, and `real-character-animation.png` under `e2e-artifacts/`. The latter remain workspace-only to avoid redistribution of the logo excluded from the model license. The local GLB export and downloaded recipe are also excluded; source bytes and model-derived files are ignored and must not be uploaded.

## Seam scope, CI and release decision

The adversarial two-triangle fixture measured a position gap of `0.2960245861029953` for Smooth and `0.09042204899280248` for Inflate. Draw, Clay, Crease, Grab, Flatten and Pinch measured zero on that fixture. The current production safety gate is limited to Smooth and Inflate; tests verify their measured footprint is rejected without mutating geometry and verify other brushes do not route through that gate. These fixture measurements are not a universal guarantee for all brushes/meshes. The project does not blindly weld incompatible positions. Browser warning visibility, dense production mesh performance, and user experience near legitimate seams remain unverified.

**GitHub Actions: NOT RUN / NOT VERIFIED.** The proposed workflow is not installed on a remotely updated branch, and no successful Actions URL exists. The active Arena branch is based on `c0cc55196d29681c75611f7ef8a012474ea0078f`, not PR #3; the permitted deliverable is a complete patch against PR #3 head `0a25eee2dc030aa787b9271ab5cbb44fcaedbaed`. Physical tablet/S Pen testing is pending. The existing one high dev-only `happy-dom` advisory and large bundle advisory are disclosed above.

**Overall outcome: PARTIAL.** The independently attributable third-party character completed the requested browser workflow locally with measured model edits, rendered pixels, save/reload, export/reimport, protected-data comparisons, and animation proof. Repository checks also pass. This is not a successful GitHub Actions run, hardware stylus validation, universal model compatibility, or production-readiness PASS.

### Current evidence index

- `e2e/realCharacterWorkflow.spec.ts` — real browser journey and hard assertions, including pixel/render checks.
- `scripts/acquire-real-character.mjs` — pinned acquisition plus byte-count/SHA verification; no model binary is committed.
- `scripts/validate-real-character.mjs` — independent Khronos validator report for source and export bytes.
- `tests/fixtures/README.md` — source attribution, exact license boundary, hash, rig/mesh/animation measurements, and test limitations.
- `e2e-artifacts/real-character-evidence.json` — compact numerical evidence and validator findings.
- `e2e-artifacts/real-character-*.png` — local-only browser captures; not in the portable patch because they display the excluded Cesium trademark.
- `OPERATIONAL_STATE.md` — current status matrix, reproduction commands, safety limits, and PARTIAL release posture.
