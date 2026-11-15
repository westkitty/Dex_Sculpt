#!/usr/bin/env node
/**
 * Build the public, sanitised catalog summary consumed by DEX//SCULPT.
 *
 * Input: a local clone of the humanoid library catalog branch
 *   git clone --branch feat/humanoid-asset-catalog-20261113 \
 *     https://github.com/westkitty/modern_3d_browser_game_toolkit
 *
 * Output: public/catalog/humanoid-summary.json
 *
 * ONLY metadata is emitted. Private Google Drive locators, archive paths, hashes
 * and any signed URL are stripped; model binaries are never copied into this
 * public repository. Run with:
 *   node tools/catalog/build-summary.mjs /path/to/modern_3d_browser_game_toolkit
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = process.argv[2];
if (!repo) {
  console.error('usage: node tools/catalog/build-summary.mjs <path-to-toolkit-checkout>');
  process.exit(1);
}
const base = join(repo, 'catalog', 'humanoids');
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const outDir = join(root, 'public', 'catalog');
mkdirSync(outDir, { recursive: true });

const catalog = JSON.parse(readFileSync(join(base, 'catalog.json'), 'utf8'));
const sources = JSON.parse(readFileSync(join(base, 'sources.json'), 'utf8'));
const matrix = JSON.parse(readFileSync(join(base, 'compatibility-matrix.json'), 'utf8'));
let commit = 'unknown';
try {
  commit = execSync('git rev-parse HEAD', { cwd: repo }).toString().trim();
} catch {
  /* a source archive without git history is fine */
}

const FORBIDDEN =
  /drive\.google|drive\.usercontent|docs\.google|private_locator|private storage|processed_glb_sha256|sha256sum|[?&]sign=|X-Goog-|Bearer |api_key/i;
const tokens = new Set([
  'private_locator',
  'processed_glb_sha256',
  'archive_path',
  'drive_folder',
  'drive_file_id',
  'signed_url',
]);

function sanitize(value) {
  if (typeof value === 'string') return FORBIDDEN.test(value) ? undefined : value;
  return value;
}

const sourceById = new Map(sources.sources.map((s) => [s.id, s]));
const bySource = new Map();
for (const rec of catalog.records) {
  const list = bySource.get(rec.source_id) ?? [];
  list.push({
    id: rec.asset_id,
    name: rec.display_name,
    type: rec.asset_type,
    family: rec.skeleton_family ?? null,
    joints: rec.joint_count ?? null,
    clips: rec.animation_count ?? null,
    triangles: rec.triangle_count ?? null,
    bytes: rec.processed_glb_bytes ?? null,
    license: rec.license_id ?? null,
    qa: rec.qa_status ?? null,
    tags: rec.style_tags ?? [],
  });
  bySource.set(rec.source_id, list);
}

const summarize = (list) => {
  const types = {};
  const families = {};
  for (const a of list) {
    types[a.type] = (types[a.type] ?? 0) + 1;
    if (a.family) families[a.family] = (families[a.family] ?? 0) + 1;
  }
  return { types, families };
};

const summarySources = [...bySource.entries()]
  .map(([id, assets]) => {
    const meta = sourceById.get(id) ?? {};
    const { types, families } = summarize(assets);
    const entry = {
      id,
      name: sanitize(meta.name) ?? id,
      kind: sanitize(meta.kind),
      license: meta.license ?? null,
      licenseUrl: sanitize(meta.license_url),
      officialUrl: sanitize(meta.official_url),
      access: sanitize(meta.access),
      notes: sanitize(meta.notes),
      assetCount: assets.length,
      assetTypes: types,
      skeletonFamilies: families,
      status: sanitize(meta.source_status) ?? null,
    };
    for (const key of Object.keys(entry)) {
      if (tokens.has(key) || entry[key] === undefined) delete entry[key];
    }
    return entry;
  })
  .sort((a, b) => b.assetCount - a.assetCount);

const families = Object.entries(matrix.skeleton_families ?? {}).map(([id, value]) => ({
  id,
  jointCountRange: value.joint_count_range ?? null,
  authoringConvention: sanitize(value.authoring_convention) ?? null,
  rootBone: value.root_bone ?? null,
  pelvisBone: value.pelvis_bone ?? null,
  memberSources: value.member_sources ?? null,
  embeddedAnimationClips: value.embedded_animation_clips ?? null,
  directClipSharing: sanitize(value.direct_clip_sharing) ?? null,
}));

const workflows = (matrix.retargeting_workflows ?? []).map((w) => ({
  id: w.id,
  sourceFamily: w.source_family,
  targetFamily: w.target_family,
  status: w.status,
  method: sanitize(w.method) ?? null,
}));

const incompatiblePairs = (matrix.incompatible_pairs_explicit ?? []).map((p) => ({
  pair: p.pair,
  reason: sanitize(p.reason) ?? null,
}));

const assets = [];
for (const [, list] of bySource) assets.push(...list);

const output = {
  schema: 'dexsculpt/humanoid-catalog-summary@1',
  generatedFrom: {
    repository: 'https://github.com/westkitty/modern_3d_browser_game_toolkit',
    branch: 'feat/humanoid-asset-catalog-20261113',
    commit,
    catalogGeneratedUtc: sanitize(catalog.generated_utc) ?? null,
    catalogSchema: catalog.schema_version ?? null,
  },
  notes: [
    'METADATA ONLY. DEX//SCULPT does not ship any library model binary; every record here is a reference that must be re-linked to a local file before it can be edited.',
    'Archive locators, content hashes and signed URLs are intentionally excluded from this public repository.',
    'Counts and QA statuses are copied from the upstream catalog; they describe upstream static/browser smoke checks, not DEX//SCULPT validation of those files.',
    'Rocketbox and KayKit/Quaternius assets carry their upstream licences (MIT / CC0-1.0). GDQuest mannequins are CC-BY-4.0 and require attribution.',
  ],
  totals: {
    assets: assets.length,
    sources: summarySources.length,
    rocketboxAssets: assets.filter((a) => a.id.startsWith('rocketbox/')).length,
    animatedAssets: assets.filter((a) => (a.clips ?? 0) > 0).length,
    families: families.length,
  },
  sources: summarySources,
  families,
  retargetingWorkflows: workflows,
  incompatiblePairs,
  assets,
};

const text = JSON.stringify(output, null, 0);
const leak = text.match(FORBIDDEN);
if (leak) {
  console.error(`Refusing to write: the summary still contains a forbidden token (${leak[0]}).`);
  process.exit(1);
}
writeFileSync(join(outDir, 'humanoid-summary.json'), text);
console.log(
  `wrote public/catalog/humanoid-summary.json (${(text.length / 1024).toFixed(0)} kB): ${assets.length} assets, ${summarySources.length} sources, ${families.length} families`,
);
