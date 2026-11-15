# DEX//SCULPT

A local-first, browser-based **3D character customization and sculpting studio**.

Import a rigged character, reshape its geometry with real brushes, drive its own
morph targets, inspect its skeleton and clips, and export a GLB whose
**skeleton, skin weights, inverse bind matrices, morph targets, UVs and
animations are still intact** — then reopen the work later from a portable
recipe. Everything runs in one tab: no backend, no accounts, no telemetry, no
uploads.

> **The defect this project exists to avoid.** FORM//ENGINE 0.2.0 can drop
> skinning and morph targets when a rigged model is imported for sculpting. In
> DEX//SCULPT, sculpting is a *position-delta layer beside the imported mesh*:
> joints, weights, bind matrices, morph deltas, UVs and clips are never rewritten,
> and export refuses to proceed if the independent structural validator finds a
> lost rig.

## Quick start

```bash
npm install --legacy-peer-deps   # lockfile is committed
npm run dev                      # http://localhost:5190
npm run build                    # tsc --noEmit && vite build
npm test                         # 28 Vitest checks (sculpt, export, recipe, attachments, history)
npm run test:e2e                 # 4 Playwright flows in a real browser
```

The app opens on a generated **Foundry Humanoid**: 20 bones, four-influence skin
weights, inverse bind matrices, UV seams, three morph targets and three clips. It
is produced procedurally in the browser, serialised to GLB, and then imported
through the same loader a user file goes through — so the default experience is
the round-trip proof, not a special case.

## What is implemented

| Area | State | Notes |
| --- | --- | --- |
| Rig-safe sculpting | **VERIFIED IN BROWSER** | Clay, Draw, Smooth, Inflate, Crease, Grab, Mask. Strokes write a delta buffer; base positions and skin data are immutable. |
| Export + independent validation | **VERIFIED IN BROWSER** | Exporter rewrites only `POSITION`; a separate parser checks 19 structural facts, then the file is re-imported with a fresh `GLTFLoader` and compared (8 checks, vertex probes, morph probe). |
| Undo / redo | **TESTED + VERIFIED IN BROWSER** | Per-stroke transactions with byte-exact restore, bounded by count and memory. |
| Appearance controls | **IMPLEMENTED + VERIFIED IN BROWSER** | Morph-target sliders bound to the file's own shape keys, material colour/roughness/metalness overrides, per-edit reset, before/after compare. |
| Rig inspection | **IMPLEMENTED + VERIFIED IN BROWSER** | Bone tree with selection + viewport overlay, joint/IBM counts, weight-sum error, bind-pose reset, skeleton family compatibility note. |
| Animation | **IMPLEMENTED + VERIFIED IN BROWSER** | Clip list, play/pause, scrub, speed, bind pose, plus an in-editor skinning probe that samples a vertex in bind pose and mid-clip. |
| Projects | **IMPLEMENTED + VERIFIED IN BROWSER** | Recipe + source model in IndexedDB (memory fallback with an explicit warning), reopen after reload, delete. |
| Recipes | **IMPLEMENTED + TESTED** | `dexsculpt/recipe@1`: source hash, skeleton family, morph weights, material overrides, int16-quantised sculpt channels, masks, attachments, provenance, editor version. |
| Modular assembly | **IMPLEMENTED + VERIFIED IN BROWSER** | Rigid props attach to a bone; skinned garments are accepted only when every joint resolves on the host; incompatible parts are blocked with reasons. Clearance check reports real overlap measurements. |
| Catalog integration | **IMPLEMENTED** | 786 humanoid records (38 sources, 25 skeleton families) rendered as metadata-only entries with a relink flow. |
| Tablet / S Pen | **SIMULATED ONLY** | Pen pressure, tilt widening, hover, finger-navigation defaults, two-finger pan/zoom, palm rejection and a touch layout are implemented and unit-exercised; no physical device has been tested. |
| Real library character | **AWAITING REAL CHARACTER FILE** | Catalog records carry no binaries (originals live in a private archive), so genuine Rocketbox/Quaternius/KayKit files have not been loaded here. |

Full evidence log, exact numbers and environment recipes: [OPERATIONAL_STATE.md](docs/OPERATIONAL_STATE.md).
Design and data contracts: [ARCHITECTURE.md](docs/ARCHITECTURE.md).

## The rig-safety guarantee, concretely

1. On import, `Character` records the imported positions as **`basePosition`**
   and creates a zeroed **`delta`** buffer plus a weld map of coincident vertices
   (UV seams, hard-normal splits) so edits cannot tear a surface apart.
2. Every brush writes only into `delta`. Live positions are always
   `base + delta`, recomputed for exactly the touched groups.
3. Export clones the scene, writes `base + delta` into a fresh `POSITION`
   accessor, and carries the original `JOINTS_0`, `WEIGHTS_0`, skin, morph deltas
   and animations through untouched.
4. An independent validator (`src/validation/`) parses the exported bytes without
   Three.js and compares them to the source manifest: joint names and hierarchy,
   weight sums, inverse bind matrices, morph target counts and deltas, UV hashes,
   material names, root transform, clip names/durations. Any failure blocks the
   download.
5. The file is then re-imported with a fresh `GLTFLoader`; probe vertices must
   move under the preserved clip, and the morph target must still displace
   geometry. Without both, the export is reported as failed.

## Using your own character

- **Import local GLB** in the library rail. Files never leave the browser.
- Some files are legitimately not editable in the same way: an unrigged mesh has
  no skeleton to inspect, a rigged file without clips cannot play animation.
  Panels say so explicitly instead of showing dead controls.
- Reopening a saved recipe that does not embed its source (files over the 8 MB
  embed limit) asks you to relink the original GLB; deltas are verified against
  the imported base-mesh fingerprint before they are applied.

## Repository layout

```
src/core          math, hashing, base64, formatting
src/fixtures      SDF + surface-nets fixture generator (20-bone humanoid, bust, visor)
src/character     Character model, loader, exporter, attachments, manifest hashing
src/sculpt        weld map, spatial index, brush engine
src/validation    independent GLB parser, structural validator, re-import verifier
src/project       recipe schema + IndexedDB store
src/app           studio controller, viewport, undo history
src/ui            DOM panels (library, inspector, dock, HUD, dialogs, report)
src/catalog       catalog summary loader + compatibility helpers
public/catalog    generated metadata-only humanoid summary
tests             Vitest suites + Playwright flows
tools             catalog summary builder, headless-browser setup/smoke
```

## Boundaries and provenance

This repository is **public**. It contains no private storage identifiers, signed
URLs, credentials, third-party character binaries or personal source images. The
bundled examples are original procedural work (CC0-1.0) generated at runtime.

- [FORM//ENGINE](https://github.com/westkitty/form-engine) — read-only reference
  for browser sculpt interaction and its known rig-loss defect. No code is
  vendored.
- [DEX//RIG](https://github.com/westkitty/Dex_Rig) — independent **2D** layered
  animation tool; not a 3D rigging engine and not integrated here.
- [Humanoid Character Library](https://github.com/westkitty/modern_3d_browser_game_toolkit/tree/feat/humanoid-asset-catalog-20261113/catalog/humanoids) —
  metadata only. Originals live in a private archive and are never redistributed.

See [docs/PROVENANCE.md](docs/PROVENANCE.md) for licence details and
[docs/OPERATIONAL_STATE.md](docs/OPERATIONAL_STATE.md) for what has actually been
run, with numbers.

## Licence

MIT for the DEX//SCULPT source (see [LICENSE](LICENSE)). Bundled procedural
fixtures are dedicated to the public domain (CC0-1.0). Three.js is MIT.
