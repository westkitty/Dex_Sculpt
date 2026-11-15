# Operational State — DEX//SCULPT

Last Reviewed: 2026-11-15  
Repository: `westkitty/Dex_Sculpt`  
Feature Branch: `feat/dex-sculpt-character-foundry`  

## Evidence Status Matrix

### IMPLEMENTED & TESTED (Vitest — `npm test`, `6/6` passed)
- **Phase A Rig-Safe Sculpt & GLB Round-Trip Proof (`tests/phaseA_rigSafeProof.test.ts`)**:
  - Procedural 20-bone skinned humanoid with 4 morph targets, UVs, procedural texture, and 3 `AnimationClip`s.
  - Multi-dab X-symmetrical sculpt stroke (`maxDisplacement > 0.02m`), byte-exact Undo/Redo, sparse delta extraction, non-bind-pose animation playback followed by clean bind-pose GLB export.
  - Independent binary GLB 2.0 validation (`compareRigPreservation`) proving bone hierarchy, `inverseBindMatrices`, `JOINTS_0`, `WEIGHTS_0`, `TEXCOORD_0`, morph target deltas, and animation clips remain intact.
  - Re-import & skeletal/morph deformation verified in both **Three.js `0.186.1`** and **Three.js `0.185.1`** (`three-r185`), plus GPU disposal (`skeleton.dispose()`).
- **Brushes, Masking, Catalog, Modular Assembly & Recipes (`tests/coreAndCatalog.test.ts`)**:
  - All 8 displacement brushes (`draw`, `inflate`, `clay`, `smooth`, `flatten`, `pinch`, `crease`, `grab`) produce pairwise-distinct geometry hashes; freeze mask locks vertices (`delta === 0`).
  - Sparse `CharacterRecipeV1` serialization and reconstruction (`maxPositionDelta < 1e-6`).
  - `786` catalog records, `43` sources, and compatibility matrix rules verified; incompatible skeleton bindings blocked cleanly.
  - Static OBJ import warns honestly that rigging/animations are unavailable.

### VERIFIED IN BROWSER (Playwright Chromium + SwiftShader WebGL2 — `npm run test:e2e`, `2/2` passed)
- WebGL2 viewport boots with 0 console/page errors and renders the rigged humanoid (`Rigged · 20 bones · 4 morphs · 3 clips`).
- Real pointer-based sculpt stroke on `#viewport-canvas`, Undo/Redo, Before/After toggle, morph target slider (`Broaden_Shoulders`), `Walk_Cycle` animation playback, modular attachments (`Foundry Visor Crest` + `Foundry Cloak (Skinned)`), `.glb` download + independent validation modal (`VERIFIED PASS`), one-click **Verify Re-Import in Studio**, second sculpt on re-imported GLB, `.dexsculpt.json` recipe download, 786-record Catalog tab, keyboard shortcuts (`?`, `Escape`), and IndexedDB autosave recovery across `page.reload()`.
- Simulated S Pen PointerEvents: hover without sculpting, pressure + tilt widening (`maxRadiusScale > 1.3`), palm touch rejection (`rejectedTouches === 1`), and zero horizontal overflow at `1480×924` (tablet landscape aspect) and `390×844` (mobile).

### AWAITING REAL CHARACTER FILE (PENDING)
- Testing with genuine licensed third-party library GLB binaries (e.g. Microsoft Rocketbox, KayKit, Quaternius, GDQuest) is **PENDING** because private Google Drive model binaries are intentionally absent from this public repository. Local file import and SHA-256 catalog matching are implemented and ready for user-supplied `.glb` files.

### AWAITING PHYSICAL DEVICE TEST
- Real Samsung Galaxy Tab S9 Ultra physical S Pen hardware validation (barrel button firmware behavior, physical palm-rejection ergonomics, hardware GPU frame pacing) has **not** been executed; only simulated PointerEvents in Chromium were tested.

### NOT IMPLEMENTED
- Dynamic topology / voxel remeshing / multiresolution subdivision (deliberately excluded to preserve fixed vertex correspondence for skin weights and morph targets).
- Automated cross-skeleton animation retargeting solver (incompatible skeletons are detected and blocked/warned rather than silently retargeted).
- Cloud storage, accounts, or telemetry (intentionally local-only).
