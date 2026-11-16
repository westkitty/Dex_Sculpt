import type { SparseSculptDelta } from '../core/rigSafeSculpt';
import type { Dna } from './dnaLayers';

export interface MaterialOverride {
  colorHex?: string;
  roughness?: number;
  metalness?: number;
  emissiveHex?: string;
}

export interface RecipeAttachment {
  id: string;
  name: string;
  mode: 'bone-attached' | 'static-prop' | 'skinned-compatible';
  targetBone: string;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  proceduralId?: string;
  fileName?: string;
  sha256?: string;
  requiresLocalFile?: boolean;
}

export interface CharacterRecipeV1 {
  schemaVersion: 'dexsculpt.recipe.v1';
  editorVersion: string;
  projectId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  source: {
    kind: 'procedural-sample' | 'local-glb';
    assetId: string | null;
    displayName: string;
    fileName: string;
    sha256: string;
    skeletonFamily: string;
    licenseId: string;
    attribution?: string;
    provenanceUrl?: string;
    /** Honest flag: true when a local GLB file is needed to reconstruct the full mesh */
    requiresSourceRelink: boolean;
  };
  sculptDeltas: SparseSculptDelta[];
  morphWeights: Record<string, number>;
  materialOverrides: Record<string, MaterialOverride>;
  attachments: RecipeAttachment[];
}

/**
 * V2 project recipe: the authoritative Character DNA document (variants, sculpt
 * layers, morph/material overrides, accessory configuration) plus source identity.
 * `sculptDeltas` is retained as a derived V1-compat view of the ACTIVE variant so
 * older tooling can still read the visible edits; `dna` is authoritative.
 */
export interface CharacterRecipeV2 {
  schemaVersion: 'dexsculpt.recipe.v2';
  editorVersion: string;
  projectId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  source: CharacterRecipeV1['source'];
  /** Authoritative Character DNA state: all named variants with layers/overrides. */
  dna: Dna;
  /** Derived flat view of the active variant (V1 interop). */
  sculptDeltas: SparseSculptDelta[];
  activeVariantId: string;
}

export type ProjectRecipe = CharacterRecipeV1 | CharacterRecipeV2;

export function isRecipeV2(r: ProjectRecipe): r is CharacterRecipeV2 {
  return r.schemaVersion === 'dexsculpt.recipe.v2';
}

export function validateCharacterRecipe(raw: unknown): ProjectRecipe {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Recipe JSON must be an object');
  }
  const r = raw as Partial<CharacterRecipeV1> & Partial<CharacterRecipeV2>;
  if (r.schemaVersion === 'dexsculpt.recipe.v2') {
    return validateRecipeV2(r);
  }
  if (r.schemaVersion !== 'dexsculpt.recipe.v1') {
    throw new Error(`Unsupported recipe schemaVersion: ${String(r.schemaVersion)}`);
  }
  if (!r.projectId || !r.source || typeof r.source.sha256 !== 'string') {
    throw new Error('Recipe missing required projectId or source metadata');
  }
  if (!Array.isArray(r.sculptDeltas)) {
    throw new Error('Recipe missing sculptDeltas array');
  }
  return {
    schemaVersion: 'dexsculpt.recipe.v1',
    editorVersion: r.editorVersion ?? '0.1.0',
    projectId: r.projectId,
    title: r.title ?? r.source.displayName ?? 'Untitled Character',
    createdAt: r.createdAt ?? new Date().toISOString(),
    updatedAt: r.updatedAt ?? new Date().toISOString(),
    source: {
      kind: r.source.kind ?? 'local-glb',
      assetId: r.source.assetId ?? null,
      displayName: r.source.displayName ?? 'Character',
      fileName: r.source.fileName ?? 'character.glb',
      sha256: r.source.sha256,
      skeletonFamily: r.source.skeletonFamily ?? 'unknown',
      licenseId: r.source.licenseId ?? 'UNSPECIFIED',
      attribution: r.source.attribution,
      provenanceUrl: r.source.provenanceUrl,
      requiresSourceRelink: r.source.kind !== 'procedural-sample'
    },
    sculptDeltas: r.sculptDeltas,
    morphWeights: r.morphWeights ?? {},
    materialOverrides: r.materialOverrides ?? {},
    attachments: Array.isArray(r.attachments) ? r.attachments : []
  };
}

function validateRecipeV2(r: Partial<CharacterRecipeV2>): CharacterRecipeV2 {
  if (!r.projectId || !r.source || typeof r.source.sha256 !== 'string') {
    throw new Error('Recipe missing required projectId or source metadata');
  }
  const source = r.source;
  const sha256: string = source.sha256;
  const dna = r.dna;
  if (!dna || dna.schema !== 'dexsculpt.dna.v2') {
    throw new Error('V2 recipe missing Character DNA document');
  }
  // Structural + composition validation is completed against concrete source meshes
  // at load time (session.installRecipe); here we reject obviously malformed docs.
  if (!Array.isArray(dna.variants) || dna.variants.length === 0) {
    throw new Error('V2 recipe DNA has no variants');
  }
  if (typeof r.activeVariantId !== 'string' || !dna.variants.some((v) => v.id === dna.activeId) || !dna.variants.some((v) => v.id === r.activeVariantId)) {
    throw new Error('V2 recipe active variant identity is missing');
  }
  if (!Array.isArray(r.sculptDeltas)) {
    throw new Error('Recipe missing sculptDeltas array');
  }
  return {
    schemaVersion: 'dexsculpt.recipe.v2',
    editorVersion: r.editorVersion ?? '0.2.0',
    projectId: r.projectId,
    title: r.title ?? source.displayName ?? 'Untitled Character',
    createdAt: r.createdAt ?? new Date().toISOString(),
    updatedAt: r.updatedAt ?? new Date().toISOString(),
    source: {
      kind: source.kind ?? 'local-glb',
      assetId: source.assetId ?? null,
      displayName: source.displayName ?? 'Character',
      fileName: source.fileName ?? 'character.glb',
      sha256,
      skeletonFamily: source.skeletonFamily ?? 'unknown',
      licenseId: source.licenseId ?? 'UNSPECIFIED',
      attribution: source.attribution,
      provenanceUrl: source.provenanceUrl,
      requiresSourceRelink: source.kind !== 'procedural-sample'
    },
    dna,
    sculptDeltas: r.sculptDeltas,
    activeVariantId: r.activeVariantId
  };
}
