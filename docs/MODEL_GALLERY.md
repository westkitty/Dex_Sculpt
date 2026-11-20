# Model Gallery — publish-safe browser

## What it does

`gallery.html` is a second Vite HTML entrypoint alongside the DEX//SCULPT editor. It provides a responsive, searchable, scrolling catalogue of the same `src/data/humanoidCatalog.json` records used by the editor.

- Search by name, source, type, skeleton family, or style tags.
- Filter by collection, type, and whether the model is available to preview.
- Incrementally render cards as the user scrolls, with accessible detail dialogs.
- Match local user-selected GLB files by catalogued **size and SHA-256**, not merely filename. Each selected file remains in the browser; it is not uploaded.
- Lazily create actual WebGL thumbnails from verified models and show a 3D inspection viewer. IndexedDB may store generated thumbnails only, not GLB binaries.
- Where available in a *local private installation*, use the loopback-only `__dex_catalog` bridge for verified cached models and an optional private `gallery-drive-previews.json` for visual-QA previews. Both dependencies are optional. The public deployment works without them.
- `Open in DEX//SCULPT` selects the model's catalogue record. In the private edition with a verified local bridge, the local editor may also directly load the GLB. In the public edition, you must use **Import GLB** to edit the selected local file; file selection is not automatically transferred between browser tabs.

## Non-negotiable publication boundary

The public repository and GitHub Pages build **do not include** the Google Drive archive, original third-party GLB files, private preview image bytes, private Drive file IDs, private connector credentials, Google authorization tokens, local Mac paths, or the implementation of the private catalog bridge. Do not copy `scripts/privateCatalogBridge.ts` or the private working tree onto a public branch.

The local-only manifest `gallery-drive-previews.json` must remain ignored and untracked. The optional manifest is only interpreted at runtime; its absence is normal and is not a build error. **Do not commit or publish** this JSON. This is intentionally more conservative than assuming third-party thumbnail redistribution rights.

The core 786 metadata records are already part of the public repository. Listing a model does not assert its binary can be fetched publicly.

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
```

Verify `gallery.html` in local development and in `vite preview` against a build. Exercise search, filter reset, scrolling beyond the first 30 cards, detail close, and local file SHA-256 matching; confirm models with no authorized binary never pretend to have a thumbnail. Test repeated preview open/close for WebGL resource cleanup. An end-to-end browser check on macOS should be reported separately; a build alone is not proof of actual GPU rendering.

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
