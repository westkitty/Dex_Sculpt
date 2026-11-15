# DEX//SCULPT Architecture

## Core Principle: Non-Destructive Rig-Safe Sculpting

In `FORM//ENGINE 0.2.0`, `normaliseGeometry()` constructs a brand-new `THREE.BufferGeometry` carrying only `position`, `uv`, and `index`, discarding `skinIndex`, `skinWeight`, `morphAttributes`, `Skeleton` bindings, and `AnimationClip` tracks.

**DEX//SCULPT** solves this by locking mesh topology and vertex correspondence at import time:

1. **In-Place Buffer Preservation (`src/core/rigSafeSculpt.ts`)**
   - `ensureEditableVertexBuffers()` expands interleaved or quantized `position`/`normal` attributes into `Float32Array` buffers in-place without touching `index`, `uv`, `skinIndex`, `skinWeight`, `color`, or `morphAttributes`.
   - `normalizeMorphTargetsRelative()` converts any non-relative morph targets into relative deltas (`morphTargetsRelative = true`) so sculpting the base pose composes additively with morph sliders and exports cleanly to glTF 2.0.
   - `RigSafeSculptTarget` captures an immutable `SourceMeshSnapshot` (base positions, base normals, UV/skin hashes, bone names, morph target names).

2. **Welded Unique Sculpt Space -> Exact Render Delta Sync (`src/core/topology.ts`, `src/core/brushes.ts`)**
   - `SculptMesh` builds a welded unique-vertex topology (`renderToUniq`, `uniqRenderStart`, `uniqRenderList`, neighbour & triangle CSR tables) so brushes never tear UV/normal seams.
   - During sculpting, displacements in unique space are applied as exact deltas from the initial unique positions (`m.pos[v] - origUniqPos[v]`) onto `snapshot.sourcePos[r]`. Unmodified vertices remain bit-for-bit identical to the imported mesh, and undo/redo restores exact pre-stroke bytes.
   - Freeze masking is stored in an editor-only `sculptMask` attribute rendered via `material.onBeforeCompile` (`attachMaskShaderHook`), never overwriting `geometry.attributes.color`, and stripped cleanly before GLB export.

3. **Bind-Pose Export & Independent Binary GLB2 Validation (`src/io/glbPipeline.ts`, `src/io/glbValidator.ts`)**
   - `exportRigSafeGlb()` saves active animation/pose transforms, resets skeletons to clean bind pose (`skeleton.pose()`), exports GLB 2.0 via `GLTFExporter`, and restores the preview pose immediately afterward.
   - `validateGlbBinary()` independently parses the exported GLB's JSON and BIN chunks without Three.js to audit `POSITION`, `NORMAL`, `TEXCOORD_0`, `JOINTS_0`, `WEIGHTS_0`, `inverseBindMatrices`, `targets`, `animations`, and `materials`.
   - `compareRigPreservation()` compares the exported GLB against the baseline GLB to verify measurable sculpt displacement alongside rig invariant preservation.

## Non-Destructive Character Recipes (`src/core/recipe.ts`, `src/io/projectStorage.ts`)

A `dexsculpt.recipe.v1` file records:
- Project ID, schema/editor version, timestamps
- Source asset metadata (`kind`, `assetId`, `fileName`, `sha256`, `skeletonFamily`, `licenseId`, `attribution`, `requiresSourceRelink`)
- Sparse vertex deltas (`meshName`, `vertexCount`, `indices`, `deltas`)
- Morph target weights
- PBR material overrides
- Modular attachment descriptors and transforms

Recipes for local third-party GLBs explicitly set `requiresSourceRelink: true` and verify the relinked GLB's SHA-256 rather than claiming a lightweight JSON file embeds copyrighted or external mesh binaries. Crash-safe dual-slot IndexedDB autosave (`A/B` slots + separate `head` commit) protects work across reloads and WebGL context loss.

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
