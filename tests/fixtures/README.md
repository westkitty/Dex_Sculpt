# Extended third-party character fixture

The extended acceptance test uses **Cesium Man**, the asset named `CesiumMan` in the Khronos Group's `glTF-Sample-Assets` repository. It is deliberately acquired into an ignored local directory and is not committed: the GLB contains a Cesium mark whose logo/trademark is excluded from the model's CC license.

- Exact model: `CesiumMan`, Khronos Sample Assets `main` commit `f0920f5b32d172a30efe3f9257e965918831e6ea`
- GLB path in source: `Models/CesiumMan/glTF-Binary/CesiumMan.glb`
- Exact source URL: `https://github.com/KhronosGroup/glTF-Sample-Assets/blob/f0920f5b32d172a30efe3f9257e965918831e6ea/Models/CesiumMan/glTF-Binary/CesiumMan.glb`
- Publisher/attribution: Cesium, 2017 (model); Cesium logo marked 2015
- Per-model license: CC BY 4.0 for model files, with Cesium logo/trademark explicitly excluded; see that commit's `Models/CesiumMan/LICENSE.md` and `metadata.json`.
- File size: 438,044 bytes
- SHA-256: `b7001eaeea8254bd44773bcd247e78696d94169388fbb2a1800fc69434e777d9`
- Format/content independently inspected: GLB 2.0; one skinned mesh; POSITION, NORMAL, TEXCOORD_0, JOINTS_0, WEIGHTS_0; one skin with 19 joints and inverse bind matrices; one animation; one material; no morph targets.
- Khronos glTF Validator `2.0.0-dev.3.10`: 0 errors, 1 warning (`NODE_SKINNED_MESH_NON_ROOT`, node 2).

This is a test-only input. Do not publish the binary or imply the Cesium logo itself is licensed under CC BY. The fixture is not required for ordinary application startup, unit tests, or build. `npm run test:e2e` acquires it before running the Playwright suite; `npm run test:real-character` runs the separate Node/core acceptance. The acquisition script pins the commit and verifies both byte length and digest before writing `tests/fixtures/downloads/CesiumMan.glb`. The fixture and export are never uploaded by the application or committed.

The model has no morph targets. Morph-target handling remains covered by the separate original procedural test fixture; this acceptance test does not claim third-party morph-target compatibility. It also has a single mesh, so multiple-skinned-mesh coverage remains an adversarial synthetic test, not a claim about this model.
