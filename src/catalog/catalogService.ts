import * as THREE from 'three';
import catalogDoc from '../data/humanoidCatalog.json';
import sourcesDoc from '../data/humanoidSources.json';
import compatDoc from '../data/humanoidCompatibility.json';

export interface CatalogRecord {
  asset_id: string;
  display_name: string;
  source_id: string;
  asset_type: string;
  category: string;
  style_tags: string[];
  license_id: string;
  skeleton_family: string | null;
  joint_count: number | null;
  triangle_count: number | null;
  dimensions_m: { x?: number; y?: number; z?: number } | null;
  animation_count: number | null;
  processed_glb_basename: string | null;
  processed_glb_bytes: number | null;
  processed_glb_sha256: string | null;
  qa_status: string;
  visual_approval: string;
}

export interface CatalogSource {
  id: string;
  name: string;
  kind: string;
  official_url: string;
  license: string;
  license_url: string;
  formats: string[];
  advertised_content: string;
}

export interface CatalogSearchFilters {
  query?: string;
  sourceId?: string;
  assetType?: string;
  skeletonFamily?: string;
  onlyAnimated?: boolean;
  licenseId?: string;
}

export interface CompatibilityAssessment {
  compatible: boolean;
  mode: 'exact-family' | 'rigid-socket' | 'retarget-required' | 'incompatible' | 'unknown';
  reason: string;
}

const records: CatalogRecord[] = (catalogDoc as { records: CatalogRecord[] }).records;
const sources: CatalogSource[] = (sourcesDoc as { sources: CatalogSource[] }).sources;
const byId = new Map(records.map((r) => [r.asset_id, r]));
const bySha = new Map(
  records.filter((r) => r.processed_glb_sha256).map((r) => [r.processed_glb_sha256!.toLowerCase(), r])
);
const sourceById = new Map(sources.map((s) => [s.id, s]));
const compat = compatDoc as unknown as {
  skeleton_families: Record<string, any>;
  incompatible_pairs_explicit?: Array<{ pair: string[]; reason: string }>;
  threejs_runtime_notes?: string[];
};

export function getCatalogSummary(): {
  totalRecords: number;
  sourceCount: number;
  familyCount: number;
  assetTypes: string[];
  licenses: string[];
  families: string[];
} {
  const assetTypes = Array.from(new Set(records.map((r) => r.asset_type))).sort();
  const licenses = Array.from(new Set(records.map((r) => r.license_id))).sort();
  const families = Array.from(
    new Set(records.map((r) => r.skeleton_family).filter((f): f is string => !!f))
  ).sort();
  return {
    totalRecords: records.length,
    sourceCount: sources.length,
    familyCount: families.length,
    assetTypes,
    licenses,
    families
  };
}

export function listCatalogSources(): CatalogSource[] {
  return [...sources];
}

export function getCatalogSource(sourceId: string): CatalogSource | null {
  return sourceById.get(sourceId) ?? null;
}

export function getCatalogRecord(assetId: string): CatalogRecord | null {
  return byId.get(assetId) ?? null;
}

export function findCatalogRecordBySha256(sha256: string): CatalogRecord | null {
  return bySha.get(sha256.toLowerCase()) ?? null;
}

export function searchCatalog(filters: CatalogSearchFilters = {}): CatalogRecord[] {
  const q = (filters.query ?? '').trim().toLowerCase();
  return records.filter((r) => {
    if (filters.sourceId && r.source_id !== filters.sourceId) return false;
    if (filters.assetType && r.asset_type !== filters.assetType) return false;
    if (filters.skeletonFamily && r.skeleton_family !== filters.skeletonFamily) return false;
    if (filters.licenseId && r.license_id !== filters.licenseId) return false;
    if (filters.onlyAnimated && !(typeof r.animation_count === 'number' && r.animation_count > 0)) return false;
    if (q) {
      const hay = `${r.asset_id} ${r.display_name} ${r.source_id} ${r.asset_type} ${r.category} ${r.skeleton_family ?? ''} ${(r.style_tags ?? []).join(' ')}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

export function getSkeletonFamilyInfo(familyId: string | null): Record<string, any> | null {
  if (!familyId) return null;
  return compat.skeleton_families?.[familyId] ?? null;
}

/** Heuristic skeleton family detection from Three.js bone names when no catalog ID is linked. */
export function detectSkeletonFamilyFromBones(boneNames: string[]): string {
  if (boneNames.length === 0) return 'none-static-pose';
  const norm = new Set(boneNames.map((n) => THREE.PropertyBinding.sanitizeNodeName(n)));
  const raw = new Set(boneNames);

  if (raw.has('Root') && raw.has('Pelvis') && raw.has('Chest') && raw.has('UpperArm_L') && boneNames.length === 20) {
    return 'dex-foundry-biped-20';
  }
  if (boneNames.some((b) => b.startsWith('Bip01'))) return 'rocketbox-bip01';
  if (norm.has('handslotl') || norm.has('handslotr')) return 'kaykit-rig-medium';
  if (raw.has('hips') && raw.has('spine') && raw.has('chest') && boneNames.length <= 25) return 'kaykit-rig-medium';
  if (raw.has('pelvis') && raw.has('spine_01') && raw.has('clavicle_l') && boneNames.length >= 60) {
    return 'quaternius-universal-65';
  }
  if (boneNames.some((b) => b.startsWith('mixamorig'))) return 'polygonalmind-vrm-humanoid';
  if (raw.has('Hips') && raw.has('LeftUpperArm') && raw.has('RightUpperArm')) return 'polygonalmind-vrm-humanoid';
  if (raw.has('DEF-spine') || raw.has('ORG-spine')) return 'gdquest-mannequin-45';
  return `custom-rig-${boneNames.length}`;
}

export function assessCatalogCompatibility(
  targetFamily: string | null,
  candidate: CatalogRecord
): CompatibilityAssessment {
  if (
    candidate.asset_type === 'accessory' ||
    candidate.asset_type === 'hairstyle_origin_0' ||
    candidate.asset_type === 'static_posed_humanoid'
  ) {
    return {
      compatible: true,
      mode: 'rigid-socket',
      reason: 'Static/rigid item can attach to a matching bone socket or character root.'
    };
  }

  if (!targetFamily || targetFamily === 'none-static-pose') {
    return {
      compatible: false,
      mode: 'incompatible',
      reason: 'Active character has no skeleton; skinned assets or clips require a rigged character.'
    };
  }

  const candFam = candidate.skeleton_family;
  if (!candFam) {
    return {
      compatible: true,
      mode: 'rigid-socket',
      reason: 'Asset has no skeleton family; usable as a rigid socket attachment.'
    };
  }

  if (candFam === targetFamily) {
    return {
      compatible: true,
      mode: 'exact-family',
      reason: `Exact skeleton family match (${candFam}). Direct clip/modular compatibility.`
    };
  }

  const explicitBad = (compat.incompatible_pairs_explicit ?? []).find(
    (p) =>
      Array.isArray(p.pair) &&
      ((p.pair[0] === targetFamily && p.pair[1] === candFam) ||
        (p.pair[0] === candFam && p.pair[1] === targetFamily))
  );
  if (explicitBad) {
    return {
      compatible: false,
      mode: 'incompatible',
      reason: explicitBad.reason
    };
  }

  return {
    compatible: false,
    mode: 'retarget-required',
    reason: `Skeleton mismatch (${candFam} vs ${targetFamily}). Do not bind directly without retargeting or rigid bone attachment.`
  };
}
