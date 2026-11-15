import type { SparseSculptDelta } from '../core/rigSafeSculpt';

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

export function validateCharacterRecipe(raw: unknown): CharacterRecipeV1 {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Recipe JSON must be an object');
  }
  const r = raw as Partial<CharacterRecipeV1>;
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
