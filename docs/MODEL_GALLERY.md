# Model Gallery — publish-safe browser

## What it does

`gallery.html` is a second Vite HTML entrypoint alongside the DEX//SCULPT editor. It provides a responsive, searchable, scrolling catalogue of the same `src/data/humanoidCatalog.json` records used by the editor. **161 of the 786 catalogue records now have committed, source-matched static PNG render thumbnails.** The default view shows illustrated records; the full 786-record metadata catalogue remains available through the **All 786 records** filter.

- Search by name, source, type, skeleton family, or style tags.
- View genuine static model renders from the existing visual-QA archive for 139 unequivocally matched IDs, without supplying the GLB binaries. The per-ID mapping is in `src/data/modelThumbnailManifest.json`, which includes source GLB SHA-256 and license tags.
- Filter by collection, type, and whether the model is available to preview.
- Incrementally render cards as the user scrolls, with accessible detail dialogs.
- Match local user-selected GLB files by catalogued **size and SHA-256**, not merely filename. Each selected file remains in the browser; it is not uploaded.
- Lazily load bundled static PNG thumbnails for illustrated records; when a matching GLB is selected, create actual WebGL thumbnails and show a 3D inspection viewer. IndexedDB may store generated thumbnails only, not GLB binaries.
- Where available in a *local private installation*, use the loopback-only `__dex_catalog` bridge for verified cached models and an optional private `gallery-drive-previews.json` for visual-QA previews. Both dependencies are optional. The public deployment works without them.
- `Open in DEX//SCULPT` selects the model's catalogue record. In the private edition with a verified local bridge, the local editor may also directly load the GLB. In the public edition, you must use **Import GLB** to edit the selected local file; file selection is not automatically transferred between browser tabs.

## Non-negotiable publication boundary

The public repository and GitHub Pages build **do include** the 161 vetted static, public-purpose model-render images under `public/model-thumbnails/`. They **do not include** the Google Drive archive, original third-party GLB files, other unreviewed private preview image bytes, private Drive file IDs, private connector credentials, Google authorization tokens, local Mac paths, or the implementation of the private catalog bridge. Do not copy `scripts/privateCatalogBridge.ts` or the private working tree onto a public branch.

The local-only manifest `gallery-drive-previews.json` must remain ignored and untracked. The optional manifest is only interpreted at runtime; its absence is normal and is not a build error. **Do not commit or publish** this JSON. This is intentionally more conservative than assuming third-party thumbnail redistribution rights.

The core 786 metadata records are already part of the public repository. Of 150 front-view expansion QA images found, 139 match a single catalogue record; 11 remain excluded. A separate Rocketbox visual-QA series provided 22 additional exact basename-matched oblique renders. The remaining 625 catalogue entries are metadata-only until verified imagery is available. Listing or illustrating a model does not assert its binary can be fetched publicly.

## Build and verification

```sh
npm run typecheck
npm test
npm run build
# Must exist as Vite's multi-page output:
test -s dist/gallery.html
test -s dist/index.html
# No private preview manifest in built output:
test ! -e dist/gallery-drive-previews.json
# Public thumbnails are in the built site, but GLB binaries are not:
test -s dist/model-thumbnails/quaternius-cube-world-kit__wizard__posZ.png
```

Verify `gallery.html` in local development and in `vite preview` against a build. Exercise search, illustrated-by-default filter, metadata-only fallback, filter reset, scrolling beyond the first 30 cards, detail close, source links, static PNG loading, and local file SHA-256 matching; confirm models without matched imagery never pretend to have a thumbnail. Test repeated preview open/close for WebGL resource cleanup. An end-to-end browser check on macOS should be reported separately; a build alone is not proof of actual GPU rendering.


## Static thumbnail provenance and licensing

- **Source evidence:** Existing model-derived `__posZ.png` renders generated in the owner's 2026-11-14 humanoid expansion QA run, plus 22 positive-Z oblique Microsoft Rocketbox renders from the 2026-11-13/14 browser QA batches. Not synthetic character illustrations, stock photography, a model download service, or an imagined stand-in. The public manifest maps each file to one authoritative catalogue asset ID and retains the catalogued processed-GLB SHA-256 for traceability.
- **Publication scope:** 161 PNGs: 136 tagged CC0-1.0, 3 tagged CC-BY-4.0, and 22 Rocketbox model renders tagged MIT. The three GDQuest Mannequiny renders require attribution; the UI displays GDQuest credit and an official source link. Public image delivery does not convey the right to distribute GLBs, which remain excluded.
- **Source license evidence:** The source catalog records the relevant assets as CC0-1.0 or CC-BY-4.0 at intake. The [Quaternius license](https://quaternius.com/license.html) has since changed to QAL 1.0 (August 2026), which allows distributing completed visual products but restricts standalone asset redistribution; it explicitly does not retroactively relicense previously obtained assets. Do not generalize this image-release decision to future packs or raw asset files.
- **Performance:** Static images are loaded only as cards enter the viewport. The public image bundle is roughly 25 MB, but the gallery does not fetch all images at startup; future responsive WebP derivatives can reduce aggregate transfer without changing catalogue identity.
- **Coverage policy:** Do not reassign a thumbnail to a similar-looking record, use the same source image as multiple unrelated models, present an illustration as a photographed GLB, expose Drive file IDs, or mark an asset as locally loadable merely because a thumbnail exists.

## Push only the public branch

Use a clean worktree created from `main`; never stage from `local/private-catalog`.

```sh
git status --short
git add -- gallery.html .gitignore vite.config.ts src/main.ts src/ui/studioUi.ts README.md OPERATIONAL_STATE.md docs/MODEL_GALLERY.md tests/galleryPublicBoundary.test.ts
git diff --cached --check
git diff --cached --stat
# Inspect the actual staged source and ensure no private reference IDs or source binaries:
git diff --cached -- gallery.html vite.config.ts src/main.ts src/ui/studioUi.ts .gitignore
git commit -m "feat: add public-safe visual model gallery"
git push -u origin feat/model-gallery-publishable
```

This guide does not imply a commit or deployment was performed. A push to this feature branch is not a merge to `main` and does not publish GitHub Pages by itself.

### Rocketbox visual-QA expansion (2026-11-21)

- Added 22 existing positive-Z oblique screenshots captured during the November 13–14 Rocketbox WebGL2 QA runs (Batch 02, Batch 03, Delivery Male 01, Medical Female 01). Only exact matches to `microsoft-rocketbox` catalogue `processed_glb_basename`, source ID, processed-GLB SHA-256, and recorded MIT license are eligible.
- Public files use `microsoft-rocketbox__<model_name>__posZ.png` and the per-model manifest records `view: "positive-z oblique"`; no source GLB, private Drive locator, raw ZIP, QA report, or token is bundled.
- Attribution/rights reference: [Microsoft Rocketbox (MIT)](https://github.com/microsoft/Microsoft-Rocketbox) and its [license](https://github.com/microsoft/Microsoft-Rocketbox/blob/master/LICENSE.md). This evidence does not confer rights to unrelated source models or creative derivatives.
- Added browser and unit regressions for the 161-image count, actual Rocketbox PNG loading, exact identity/filename association, and a still-metadata-only collection.
- Future coverage: Batch 04 archive contains additional zipped QA images not yet examined or published in this pass. Never treat the existence of a QA ZIP as proof of image identity or publication clearance.
