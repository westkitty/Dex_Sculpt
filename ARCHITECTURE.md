# DEX//SCULPT Architecture

## Core Principle: Non-Destructive Rig-Safe Sculpting

In `FORM//ENGINE 0.2.0`, `normaliseGeometry()` constructs a brand-new `THREE.BufferGeometry` carrying only `position`, `uv`, and `index`, discarding `skinIndex`, `skinWeight`, `morphAttributes`, `Skeleton` bindings, and `AnimationClip` tracks.

**DEX//SCULPT** solves this by locking mesh topology and vertex correspondence at import time:

1. **In-Place Buffer Preservation (`src/core/rigSafeSculpt.ts`)**
   - `ensureEditableVertexBuffers()` expands interleaved or quantized `position`/`normal` attributes into `Float32Array` buffers in-place without touching `index`, `uv`, `skinIndex`, `skinWeight`, `color`, or `morphAttributes`.
   - `normalizeMorphTargetsRelative()` converts any non-relative morph targets into relative deltas (`morphTargetsRelative = true`) so sculpting the base pose composes additively with morph sliders and exports cleanly to glTF 2.0.
   - `RigSafeSculptTarget` captures an immutable `SourceMeshSnapshot` (base positions, base normals, UV/skin hashes, bone names, morph target names).

2. **Welded Unique Sculpt Space -> Exact Render Delta Sync (`src/core/topology.ts`, `src/core/brushes.ts`)**
   - `SculptMesh` builds a unique-vertex topology (`renderToUniq`, `uniqRenderStart`, `uniqRenderList`, neighbour & triangle CSR tables). Coincident render vertices are grouped only when their protected attributes and material-group membership match; position equality alone never welds different UVs, normals, skin assignments, or morph deltas.
   - During sculpting, displacement is synchronized to the render vertices belonging to each compatible unique vertex using exact deltas from the initial position. Protected buffers and topology are not rebuilt. **Important limitation:** a synthetic hard-normal/UV/material split-edge test shows that a neighborhood-based Smooth stroke can move separate coincident vertices differently and open a gap. Attribute-safe separation is not a guarantee of geometric continuity. Until a coordinated-displacement solution or operation guard is implemented, avoid sculpting across split seams; see `OPERATIONAL_STATE.md` and the hardening test.
   - Freeze masking is stored in an editor-only `sculptMask` attribute rendered via `material.onBeforeCompile` (`attachMaskShaderHook`), never overwriting `geometry.attributes.color`, and stripped cleanly before GLB export.

3. **Bind-Pose Export & Independent Binary GLB2 Validation (`src/io/glbPipeline.ts`, `src/io/glbValidator.ts`)**
   - `exportRigSafeGlb()` saves active animation/pose transforms, resets skeletons to clean bind pose (`skeleton.pose()`), exports GLB 2.0 via `GLTFExporter`, and restores the preview pose immediately afterward.
   - `validateGlbBinary()` independently parses the exported GLB's JSON and BIN chunks without Three.js to audit `POSITION`, `NORMAL`, `TEXCOORD_0`, `JOINTS_0`, `WEIGHTS_0`, `inverseBindMatrices`, `targets`, `animations`, and `materials`.
   - `compareRigPreservation()` compares the exported GLB against the baseline GLB to verify measurable sculpt displacement alongside rig invariant preservation.

## Non-Destructive Character Recipes (`src/core/recipe.ts`, `src/io/projectStorage.ts`)

A `dexsculpt.recipe.v2` file records project/source metadata plus the complete `dexsculpt.dna.v2` document: independently owned character variants, named layer metadata and render-vertex deltas, per-variant morph weights, material overrides, and attachment descriptors. V1 sparse-delta recipes are explicitly migrated into a single `Imported V1 sculpt` layer; they are not treated as V2 documents.

`CharacterSession.dna` is the only authoritative editable character state. Scene geometry is projected from immutable source positions and the selected variant's visible, strength-scaled layers. Variants are isolated copies; changing the active variant recomposes rather than incrementally mutating another variant's source. Source verification uses SHA-256 over source bytes; a local third-party GLB recipe requires the original/relinked source bytes and exact digest match. Recipe parse, validation, and source checks occur before state installation so failures leave the current character intact. Crash-safe dual-slot IndexedDB autosave (`A/B` slots plus a head pointer) stores the recipe and recoverable source bytes locally; this is not a cloud backup.

GLB export uses the active composed variant in bind pose and audits structure/rig attributes through the independent in-repository binary parser and a source-to-export comparison. That proves specific measured invariants, not full compatibility with every game engine, vendor extension, texture decoder, arbitrary animation controller, or visual appearance. The optional extended Khronos Cesium Man test is a local-pipeline test only; browser visual acceptance and CI execution remain separate gates.

## Modular Character Assembly (`src/modular/assembly.ts`)

Modular assembly enforces three explicit attachment modes:
1. `bone-attached`: rigid props/hair/accessories parented to a validated bone (using `THREE.PropertyBinding.sanitizeNodeName` fallback).
2. `static-prop`: root-attached non-deforming props.
3. `skinned-compatible`: skinned clothing/parts whose required bone names are validated against the active skeleton and rebound onto the character's `THREE.Skeleton`. Incompatible bone sets are blocked with an explanatory error rather than silently broken.

## Ecosystem Boundaries & Future Integration

| Project | Role | Relationship to DEX//SCULPT |
|---|---|---|
| `westkitty/form-engine` | 3D sculpting & tablet Pointer Events reference | Read-only upstream reference. Sculpt core & pen/touch patterns adapted into rig-safe modules; never modified. |
| `westkitty/Dex_Rig` | 2D layered cutout animation workbench | Independent **2D** transform-rigging app, not a 3D mesh-skinning engine. Future integration could export orthographically rendered 2D sprite cutouts/turntables from DEX//SCULPT into DEX//RIG layers; `Dex_Rig` itself is unmodified. |
| `westkitty/modern_3d_browser_game_toolkit` | Humanoid Character Library (`catalog/humanoids/`) | Read-only metadata & compatibility source (`786` catalog records, `43` sources, `25` skeleton families) sanitized into `src/data/` without private Drive locators. |
