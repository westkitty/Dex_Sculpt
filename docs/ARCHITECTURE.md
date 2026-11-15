# DEX//SCULPT architecture

DEX//SCULPT is a single-page studio with no server. Everything below runs in the
browser tab: the fixture generator, the GLB importer/exporter, the sculpt engine,
the independent validator and the project store.

```
                        ┌──────────────────────────────────────────┐
  procedural fixture ──▶│ loader (GLTFLoader)  →  Character        │◀── local GLB file
  or user GLB           │  basePosition · delta · mask · weld      │
                        │  skeleton · morphs · clips · materials   │
                        └───────┬───────────────────────┬──────────┘
                                │                       │
                     SculptEngine (brushes)      Viewport (Three r186)
                                │                       │
                                ▼                       ▼
                        History (per stroke)      UI panels (state → DOM)
                                │
                                ▼
                        exporter (POSITION = base + delta)
                                │
                 ┌──────────────┴───────────────┐
                 ▼                              ▼
      validateExport (GLB bytes, 19 checks)   verifyReimport (fresh GLTFLoader, 8 checks)
                 └──────────────┬───────────────┘
                                ▼
                    download blocked unless both pass
```

## 1. The character data contract (`src/character/character.ts`)

| Field | Meaning | Mutability |
| --- | --- | --- |
| `basePosition` | positions exactly as imported | **immutable** |
| `delta` | accumulated sculpt offset per render vertex | mutated by brushes |
| `mask` | per-vertex freeze weight 0…1 | mutated by the mask brush |
| `positionAttr` | live GPU buffer, always `base + delta` | derived |
| `weld` | CSR map: render vertex → coincident group + members | immutable |
| `groupPositions` | one representative position per weld group | derived |
| `spatial` | uniform grid over group representatives | rebuilt after strokes |
| `groupAdjacency` / `groupTriangles` | 1-ring and group→triangle CSR | immutable |
| `groupNormal` / `triNormal` | host-computed normals (uniform inside a group) | derived |
| `skinIndex`/`skinWeight` | imported joint attributes | **never written** |
| `morphTargets` | imported shape keys + live influences | influences only |
| `materialSlots` | `MeshStandardMaterial` slots + base values | colour/roughness/metalness overrides |

Two rules keep the guarantee honest:

1. A brush can only reach `delta` and `mask`. There is no code path that writes
   `basePosition`, the index buffer, the skin attributes, `skeleton.boneInverses`
   or clip tracks.
2. All per-vertex writes inside a weld group are identical, so a UV seam or a
   hard-normal split can never tear open while sculpting.

`Character.flushNormals()` recomputes only the normals of dirty groups; normals are
averaged per weld group so the shading stays continuous across splits.

## 2. Brushes (`src/sculpt/`)

- `weld.ts` — hash-grid weld of coincident positions (ε = 1e-5 · bbox diagonal),
  CSR group lists, mean edge length, group adjacency, group→triangle lists.
- `spatialIndex.ts` — uniform grid over **group representatives**. During a stroke
  the query radius grows by the largest accumulated displacement (`slack`), so a
  stroke never needs a mid-stroke rebuild.
- `engine.ts` — `SculptEngine.begin → dab* → end` (or `begin → drag → end` for
  Grab). Dabs are spaced along the stroke by ~0.18·radius to keep fast pointer
  movement continuous. Symmetry mirrors the dab center across the user's X plane
  (computed in mesh-local space from the character root). The mask brush writes
  the freeze field; every other brush multiplies its falloff by `1 − mask`.

`end()` returns a compact transaction: changed group ids plus before/after
values only for those groups (≈24 bytes per changed group), which is what the undo
stack stores. `cancel()` restores the pre-stroke values exactly.

## 3. Input routing (`src/app/studio.ts`)

- Pointer events are captured on the **stage** element in the capture phase, so a
  sculpt stroke can `stopPropagation()` before `OrbitControls` sees the event.
  Move/up/cancel listen on `window` while the pointer is captured.
- Fingers navigate by default (one finger orbits, two fingers pan/zoom). A pen or
  mouse sculpts; the dock can enable "Finger sculpts" when no pen is available.
- Palm rejection ignores touches while the pen is down or within 320 ms of its
  last event.
- Pen pressure scales strength (0.08…1), tilt widens the brush radius by up to
  50%, and `Alt`-drag always navigates.
- Radius is authored in **screen pixels** and converted to mesh-local units at the
  hit point, so the cursor ring matches the visible footprint at any zoom.

## 4. Viewport (`src/app/viewport.ts`)

Three.js r186, WebGL2, on-demand rendering (`tick()` only draws when
`needsRender`). Perspective and orthographic cameras share OrbitControls state;
front/side/back/top presets, grid, axes, skeleton overlay, three light presets
(studio/clay/dramatic), contact-shadow disc, brush cursor ring/dot, adaptive
device-pixel-ratio budget (`PIXEL_BUDGET = 3.2 Mpx`) and WebGL context-loss
recovery (CPU-side edits survive; buffers are re-uploaded on restore).

## 5. Export and verification (`src/character/exporter.ts`, `src/validation/`)

1. `preflightExport()` rejects non-finite positions or missing meshes.
2. The scene is cloned (so the editor is untouched), each mesh geometry is
   rebuilt with `POSITION = base + delta` while keeping `JOINTS_0`, `WEIGHTS_0`,
   `TEXCOORD_0`, `skinIndex`, morph attributes and the skeleton reference.
3. `validateExportedGLB()` parses the GLB container and JSON chunk **without
   Three.js** and checks 19 facts: container integrity, skin presence, joint
   names/hierarchy, inverse bind matrices (error tolerance), weight normalisation,
   JOINTS/WEIGHTS presence, vertex counts, positions vs the editor, UV hashes,
   morph target counts and deltas, animation names/durations, materials, root
   transform, extensions and edit evidence.
4. `verifyReimport()` loads the bytes with a fresh `GLTFLoader`, rebuilds the
   scene, compares positions against the editor state, samples probe vertices in
   bind pose and mid-clip (they must move), and exercises a morph target.
5. Only when both reports pass does the UI offer the download.

## 6. Recipes and projects (`src/project/`)

`dexsculpt/recipe@1` is a plain JSON document:

```jsonc
{
  "schema": "dexsculpt/recipe@1",
  "source": { "hash": "…", "skeletonFamily": "…", "license": "…", "provenance": "…",
              "embeddedBase64": "…", "pendingRelink": false },
  "morphs":    [{ "meshName": "Body", "target": "Build_Tall", "value": 0.65 }],
  "materials": [{ "slot": 0, "materialName": "Skin_Clay", "colorHex": "#44ddcc", … }],
  "sculpt":    [{ "meshName": "Body", "baseHash": "…", "indices": "…", "deltas": "…", "scale": 0.08 }],
  "attachments": [{ "boneName": "Head", "transform": {…}, "bytesBase64": "…" }],
  "editor": { "app": "DEX//SCULPT", "version": "0.1.0", "three": "0.186.1" }
}
```

- Sculpt channels are int16 with one scale per channel (≈2.4 µm error on a 8 cm
  delta), stored as base64. Masks are uint8 indices + values.
- `applyRecipe()` refuses a channel whose `baseHash` does not match the loaded
  mesh — that is how a wrong relink is caught instead of smearing deltas.
- Sources under 8 MB are embedded; larger ones set `pendingRelink` and the UI asks
  for the original file.
- `ProjectStore` prefers IndexedDB (recipe + source bytes + attachment blobs) and
  falls back to an in-memory map with a visible warning.

## 7. UI (`src/ui/`)

Panels are pure functions of `Studio` state (`renderChips`, `renderViewControls`,
`renderToolDock`, `renderLibrary`, `renderInspector`, `showModal`,
`renderExportReport`). Controls call back into the controller, which owns history,
autosave and status text. There is no framework and no duplicated state: a panel
re-render can never disagree with the editor.

Accessibility: every control is a real `<button>`/`<input>` with an accessible
name, the mode bar and inspector tabs expose `aria-selected`, toggles expose
`aria-pressed`, dialogs are modal with Escape-to-close and focus restore, status
messages are `role="status"`, and `prefers-reduced-motion` / `forced-colors` are
honoured in the stylesheets.

## 8. Fixtures and catalog

- `src/fixtures/` builds the humanoid from a CSG SDF (capsules/boxes) sampled with
  a coarse-then-fine grid and surface nets, then computes skin weights from a
  bone-distance field (5 smoothing passes, top-4 prune, normalise) and three
  procedural clips. The body keeps cylindrical UVs with a duplicated seam so seam
  tearing has a regression target.
- `public/catalog/humanoid-summary.json` is generated by
  `tools/catalog/build-summary.mjs` from the upstream catalog branch. It contains
  records only — no binaries, no private storage locators, no hashes. Every entry
  must be relinked to a local file before it can be edited.

## 9. Testing map

| Suite | Covers |
| --- | --- |
| `tests/roundtrip.test.ts` | stroke → export → 19 structural checks → re-import → probes → morph probe, UV/material identity |
| `tests/sculpt.test.ts` | weld groups, spatial query, each brush's effect, symmetry coverage, mask freezing, cancel |
| `tests/recipe.test.ts` | recipe build, quantised replay, base-hash rejection, attachment round trip, embed limits |
| `tests/attachments.test.ts` | rigid prop attach, skinned-garment joint matching, blocked mismatch, clearance, removal |
| `tests/history.test.ts` | undo/redo order, coalescing, count + byte budgets |
| `tests/validation.test.ts` | validator passes a real export and fails on stripped skins, clips or morphs |
| `tests/e2e/studio.spec.ts` | the whole studio in Chromium: sculpt, undo, morph, probe, export, save/reload, degradation, catalog |
