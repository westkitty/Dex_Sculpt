# Operational state

Everything here was produced by running the code in this repository. Numbers are
copied from the actual runs; nothing is projected or estimated except where it is
labelled as such.

Environment used for every measurement below:

- Node v22.22.3, npm 10.9.8, Linux x64 (2 vCPU, ~3 GB RAM, no GPU)
- Three r186 (`three@0.186.1`, `@types/three@0.186.0`), Vite 8.3.5, TypeScript 6.0.3,
  Vitest 4.1.12, Playwright 1.56.1
- Chromium 153 headless with `--use-gl=angle --use-angle=swiftshader
  --enable-unsafe-swiftshader --no-sandbox --disable-dev-shm-usage`, i.e. **software**
  WebGL2 (SwiftShader). Frame times and fps from these runs are not representative
  of a real GPU.

## 1. Unit and integration tests

```
$ npx vitest run
 ✓ tests/attachments.test.ts (4)
 ✓ tests/history.test.ts (5)
 ✓ tests/recipe.test.ts (4)
 ✓ tests/roundtrip.test.ts (4)
 ✓ tests/sculpt.test.ts (7)
 ✓ tests/validation.test.ts (4)
Test Files  6 passed (6)
     Tests  28 passed (28)
  Duration  ~19 s
```

What each run proves, in the assertions themselves:

- `roundtrip.test.ts` — one clay stroke with X-symmetry moves >100 vertices with
  max Δ > 5 mm, base positions and skin-attribute hashes unchanged, morph count and
  clip count unchanged; the export passes every structural check (`inverse-bind-matrices`,
  `joints-Body`, `positions-Body`, `uv-Body`, `materials`, …); the re-import moves
  probe vertices > 4 mm under a preserved clip, a morph target still displaces
  geometry, and `maxPositionError < 1e-5`.
- `sculpt.test.ts` — weld groups merge duplicated seam vertices, the spatial index is
  queried with group ids, clay/smooth/grab/mask behave, cancel restores exactly, and
  fully masked groups move < 0.15 mm while unmasked neighbours move more.
- `recipe.test.ts` — a recipe records the source hash/family/licence, sculpt groups,
  morph value, material override and a bone-attached prop; replaying it on a fresh
  import reproduces deltas within `1e-4` and masks within one uint8 step; a tampered
  `baseHash` is refused with no deltas applied; `embedSource:false` marks the source
  as pending relink; the embedded accessory bytes re-attach to the same bone with the
  same transform.
- `attachments.test.ts` — a rigid prop attaches to `Head` (417 vertices, 3 meshes);
  a skinned copy of the host is accepted as `skinned-compatible` (20 joints); the same
  skinned file is **blocked** against an unrigged bust because its joints do not
  exist there; non-GLB bytes are rejected.
- `history.test.ts` — undo/redo ordering, redo-stack invalidation, same-key
  coalescing that keeps the original undo value, count and byte budgets, labels.
- `validation.test.ts` — the validator passes a real export and **fails** when the
  JSON is patched to drop `skins`, `animations`, or morph targets, so the checks are
  not vacuous.

## 2. Browser verification (Playwright, real WebGL2)

```
$ PLAYWRIGHT_CHROMIUM_EXECUTABLE=/tmp/chromium \
  LD_LIBRARY_PATH=… npx playwright test
  ✓ 1 loads the fixture, sculpts, undoes, morphs and verifies an export (50.6s)
  ✓ 2 saves a project and reopens it after a reload (1.9m)
  ✓ 3 degrades honestly for an unrigged mesh and attaches a prop (2.3m)
  ✓ 4 keeps library records metadata-only and renders the catalog (31.9s)
  4 passed (6.1m)
```

Measurements from the diagnostic run (`tools/headless-browser/smoke.mjs`, same
software renderer):

| Step | Result |
| --- | --- |
| Fixture generated, exported to GLB, re-imported | 1.4–1.9 s (16,287 vertices, 31,772 triangles, 20 bones, 3 clips, 3 morphs) |
| One clay stroke (radius 62 px, strength 0.55, 6 moves) | 3,707 vertices moved, max Δ 0.106 m, history size 1 |
| Invariants after the stroke | `skinHash` identical, `baseHash` identical, positions changed |
| Undo | delta hash returns to the pre-stroke value exactly |
| Redo | delta hash returns to the post-stroke value exactly |
| In-editor skinning probe | vertex 14,798 of `Body` moves 21.8 mm with `Foundry_Idle` at 1.35 s |
| Export + validation | 1,887,028 bytes, 19/19 structural checks pass |
| Re-import | 8/8 checks pass, max position error < 1e-5 m, probe max 480.7 mm, `Build_Tall` moves 110 vertices (max 85.6 mm) |
| Console | no errors during the whole run |
| Catalog | 786 records / 38 sources / 25 families loaded; rail renders 83 rows (3 examples + 80 catalog entries) |

Screenshots produced during review (not committed): sculpt mode, rig tree, animate
timeline, attach panel, project panel — all rendered at 1180×760 in the same
software-rendered Chromium.

## 3. Project persistence

`saveProject()` writes the recipe plus the source GLB and accessory blobs to
IndexedDB. After a full page reload the tests open the stored project and confirm
`movedVertices > 50` with `maxDelta` within `1e-3` of the pre-reload value. The
difference is the deliberate int16 quantisation of sculpt channels (≈ max|delta| /
32767 per axis), not lost data. If IndexedDB is unavailable the status bar reads
"Projects: memory only" and a toast explains the limitation.

## 4. Reproducing the headless browser

On a normal machine:

```bash
npm install --legacy-peer-deps
npx playwright install chromium
npm run test:e2e
```

`npm run browser:setup` (`tools/headless-browser/setup.mjs`) verifies that a
Chromium build can produce a WebGL2 context and prints the renderer string; it
honours `PLAYWRIGHT_CHROMIUM_EXECUTABLE` and `PLAYWRIGHT_CHROMIUM_ARGS`, and fails
loudly instead of skipping.

In the restricted sandbox used for this report the Playwright download endpoint was
blocked (`ECONNRESET`), so an existing Chromium build was used directly with:

- a stub `libnss3`/`libnssutil3`/`libnspr4` trio in `LD_LIBRARY_PATH` (the build's
  NSS dependencies are not installed in the image),
- SwiftShader's `libEGL.so`/`libGLESv2.so` for ANGLE's Vulkan backend,
- the four Chromium flags listed at the top.

These sandbox paths live in `/tmp` and are **not** part of the repository; they are
environment setup, not project code.

## 5. Known limitations and open items

**Real character file — AWAITING REAL CHARACTER FILE.** Every measurement above
uses the original procedural fixture. The humanoid catalog in this repository is
metadata only (786 records, no binaries); the licensed originals are kept in a
private archive. Loading a real Rocketbox / Quaternius / KayKit / GDQuest file and
repeating the round trip has **not** been done here. The relink flow is implemented
and exercised only against bundled examples.

**Physical device — AWAITING PHYSICAL DEVICE TEST.** Pen pressure, tilt widening,
hover, palm rejection (320 ms pen window), finger navigation and two-finger
pan/zoom are implemented and routed through standard Pointer Events, and the touch
layout is responsive. No S Pen, Galaxy Tab S9 Ultra or other physical tablet has
been tested; the browser suite uses synthetic mouse/pointer events.

**Software rendering.** All browser timings come from SwiftShader. Frame times of
~400 ms and the reported fps are a property of the sandbox, not of the app on a GPU.

**Cosmetic fixture surface.** The procedural humanoid is meshed with surface nets
at 12.5 mm cells, so its surface carries voxel-scale normal variation that shows up
as mottled shading under the environment light. It is a fixture-quality detail, not
a rig or sculpt defect; the exported geometry matches the editor exactly.

**Mirror symmetry precision.** Symmetry mirrors the stroke plane exactly, but the
fixture's sampled surface is not perfectly mirror-symmetric, so the mirrored
displacement magnitudes differ slightly from the original side (the test asserts
both sides are edited and their total displacement stays within 0.6×–1.6×).

**No mesh compression.** Exports are uncompressed glTF (≈1.9 MB for the fixture);
Draco/meshopt are not implemented. Export time is dominated by cloning and
validation, both of which run in the tab.

**Attachment clearance is conservative.** `checkClearance` reports sampled accessory
vertices inside the host surface; it is a signal, not a solved clipping/weight
painting pipeline. The bundled visor reports "touching: 13 of 417 sampled accessory
vertices overlap the host surface by up to 3.3 mm" at its default offset, which is
the intended honest output.

**Out of scope in v0.1 (documented, not faked):** retargeting clips between skeleton
families, weight painting, texture painting, UV editing, multi-character scenes,
Draco, cloud sync and accounts.
