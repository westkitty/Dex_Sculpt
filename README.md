# DEX//SCULPT

A local-first, browser-based 3D character customization and sculpting studio.

## Purpose

DEX//SCULPT will let artists import authorized rigged characters, shape and customize their appearance, preview animation, save non-destructive recipes, and export game-ready GLBs **without silently discarding skeletons, skin weights, morph targets, or animations**.

This is a new project. Features below are design goals, not implemented capabilities.

## Related projects (read-only upstream references)

- [FORM//ENGINE](https://github.com/westkitty/form-engine) — browser 3D sculpting and tablet interaction. Its current rigged-model sculpt import drops skinning and morph targets; this must not be inherited.
- [DEX//RIG](https://github.com/westkitty/Dex_Rig) — independent offline **2D** layered character animation workbench, not a 3D rigging engine.
- [Humanoid Character Library](https://github.com/westkitty/modern_3d_browser_game_toolkit/tree/feat/humanoid-asset-catalog-20261113/catalog/humanoids) — shared source metadata, skeleton compatibility families, and validated model catalog.

## First technical proof

Before expanding the UI, demonstrate one reproducible GLB round-trip with a genuinely skinned, animated test character and morph targets: edit visible geometry, export, re-import independently, and prove preserved joints, inverse-bind matrices, weights, morphs, materials, animations, and correct deformation. If real licensed character bytes are available, repeat the test on one authorized library model.

## Boundaries

This repository is **public**. Do not commit private Google Drive IDs, signed URLs, API keys, restricted third-party asset binaries, or unapproved canonical character references. Keep the existing upstream repositories unchanged. License and provenance must be verified before adapting upstream code or publishing assets.

## Status

**Bootstrap only.** No implemented editor, rig-safe sculpt proof, exported character, browser QA, or production approval is implied by this README.
