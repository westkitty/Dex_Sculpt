# DEX//SCULPT Character DNA V2 — Delivery Report

**Branch:** `arena/9dff85d7-dex-sculpt` (Arena-pinned; fallback plan per instructions)  
**Base:** `6211b19e5dc60caf39d7addd7bcd5f4865aec5ee` = `feat/dex-sculpt-character-foundry` (verified)  
**Date:** 2026-11-16

---

## Result matrix (each claim is independently reproducible)

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
