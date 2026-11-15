/**
 * Minimal, dependency-free GLB 2.0 / glTF 2.0 structural reader.
 *
 * This is deliberately *not* Three.js: it is the independent second opinion used
 * to validate exported files (chunk layout, accessor bounds, skins, morph
 * targets, animation channels, decoded JOINTS_0/WEIGHTS_0 values). A file that
 * this parser cannot read is broken regardless of what the exporter reported.
 */

export interface GlbAccessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  normalized?: boolean;
  count: number;
  type: string;
  min?: number[];
  max?: number[];
  name?: string;
  sparse?: unknown;
}

export interface GlbBufferView {
  buffer: number;
  byteOffset?: number;
  byteLength: number;
  byteStride?: number;
  target?: number;
}

export interface GlbPrimitive {
  attributes: Record<string, number>;
  indices?: number;
  material?: number;
  mode?: number;
  targets?: Record<string, number>[];
}

export interface GlbNode {
  name?: string;
  children?: number[];
  mesh?: number;
  skin?: number;
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
}

export interface GlbAnimation {
  name?: string;
  channels: { sampler: number; target: { node?: number; path: string } }[];
  samplers: { input: number; output: number; interpolation?: string }[];
}

export interface GlbJson {
  asset?: { version?: string; generator?: string };
  scene?: number;
  scenes?: { name?: string; nodes?: number[] }[];
  nodes?: GlbNode[];
  meshes?: { name?: string; primitives: GlbPrimitive[]; weights?: number[]; extras?: { targetNames?: string[] } }[];
  skins?: { name?: string; joints: number[]; inverseBindMatrices?: number; skeleton?: number }[];
  animations?: GlbAnimation[];
  materials?: { name?: string; pbrMetallicRoughness?: { baseColorFactor?: number[]; metallicFactor?: number; roughnessFactor?: number } }[];
  accessors?: GlbAccessor[];
  bufferViews?: GlbBufferView[];
  buffers?: { byteLength: number; uri?: string }[];
  extensionsUsed?: string[];
  extensionsRequired?: string[];
  [key: string]: unknown;
}

export interface ParsedGLB {
  json: GlbJson;
  bin: Uint8Array<ArrayBufferLike>;
  bytes: Uint8Array<ArrayBufferLike>;
  jsonChunkLength: number;
  binChunkLength: number;
}

export class GlbParseError extends Error {}

export function parseGLB(input: ArrayBuffer | Uint8Array): ParsedGLB {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < 20) throw new GlbParseError('File is too small to be a GLB');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint32(0, true);
  if (magic !== 0x46546c67) throw new GlbParseError('Missing glTF magic header (not a GLB file)');
  const version = view.getUint32(4, true);
  if (version !== 2) throw new GlbParseError(`Unsupported GLB version ${version}`);
  const declaredLength = view.getUint32(8, true);
  if (declaredLength !== bytes.byteLength) {
    throw new GlbParseError(`GLB length header ${declaredLength} does not match file size ${bytes.byteLength}`);
  }
  let offset = 12;
  let json: GlbJson | null = null;
  let bin: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  let jsonChunkLength = 0;
  let binChunkLength = 0;
  while (offset + 8 <= bytes.byteLength) {
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const end = start + chunkLength;
    if (end > bytes.byteLength) throw new GlbParseError('Chunk overruns the file');
    if (chunkType === 0x4e4f534a) {
      jsonChunkLength = chunkLength;
      const text = new TextDecoder().decode(bytes.subarray(start, end));
      try {
        json = JSON.parse(text) as GlbJson;
      } catch (error) {
        throw new GlbParseError(`JSON chunk is not valid JSON: ${(error as Error).message}`);
      }
    } else if (chunkType === 0x004e4942) {
      binChunkLength = chunkLength;
      bin = bytes.subarray(start, end);
    }
    offset = end + ((4 - (chunkLength % 4)) % 4);
  }
  if (!json) throw new GlbParseError('No JSON chunk found');
  if (!json.asset || (json.asset.version ?? '').slice(0, 1) !== '2') {
    throw new GlbParseError(`Unsupported glTF asset version ${json.asset?.version ?? '(missing)'}`);
  }
  if (!json.buffers?.length) throw new GlbParseError('No buffers declared');
  if (!bin.length && (json.buffers[0].byteLength ?? 0) > 0) throw new GlbParseError('Missing BIN chunk');
  if (json.buffers[0].byteLength > bin.length) {
    throw new GlbParseError(`Declared buffer byteLength ${json.buffers[0].byteLength} exceeds BIN chunk ${bin.length}`);
  }
  return { json, bin, bytes, jsonChunkLength, binChunkLength };
}

const COMPONENT_SIZE: Record<number, number> = {
  5120: 1,
  5121: 1,
  5122: 2,
  5123: 2,
  5125: 4,
  5126: 4,
};

const TYPE_COMPONENTS: Record<string, number> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
};

export interface DecodedAccessor {
  componentType: number;
  itemSize: number;
  count: number;
  /** raw numeric values, row-major, count * itemSize */
  values: Float64Array;
  normalized: boolean;
  min: number;
  max: number;
}

export function decodeAccessor(glb: ParsedGLB, accessorIndex: number): DecodedAccessor {
  const accessor = glb.json.accessors?.[accessorIndex];
  if (!accessor) throw new GlbParseError(`Accessor ${accessorIndex} does not exist`);
  const itemSize = TYPE_COMPONENTS[accessor.type];
  if (!itemSize) throw new GlbParseError(`Unknown accessor type ${accessor.type}`);
  const size = COMPONENT_SIZE[accessor.componentType];
  if (!size) throw new GlbParseError(`Unknown componentType ${accessor.componentType}`);
  if (accessor.sparse) throw new GlbParseError('Sparse accessors are not supported by this validator');
  const out = new Float64Array(accessor.count * itemSize);
  if (accessor.bufferView === undefined) {
    return {
      componentType: accessor.componentType,
      itemSize,
      count: accessor.count,
      values: out,
      normalized: !!accessor.normalized,
      min: accessor.min?.[0] ?? 0,
      max: accessor.max?.[0] ?? 0,
    };
  }
  const bufferView = glb.json.bufferViews?.[accessor.bufferView];
  if (!bufferView) throw new GlbParseError(`bufferView ${accessor.bufferView} does not exist`);
  if (bufferView.buffer !== 0) throw new GlbParseError('External buffers are not supported in a GLB validator');
  const base = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const stride = bufferView.byteStride ?? itemSize * size;
  const needed = base + stride * (accessor.count - 1) + itemSize * size;
  if (needed > glb.bin.length || base + bufferView.byteLength > glb.bin.length) {
    throw new GlbParseError(`Accessor ${accessorIndex} reads past the BIN chunk (${needed} > ${glb.bin.length})`);
  }
  const view = new DataView(glb.bin.buffer, glb.bin.byteOffset, glb.bin.byteLength);
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < accessor.count; i++) {
    const row = base + i * stride;
    for (let c = 0; c < itemSize; c++) {
      const at = row + c * size;
      let v: number;
      switch (accessor.componentType) {
        case 5120: v = view.getInt8(at); break;
        case 5121: v = view.getUint8(at); break;
        case 5122: v = view.getInt16(at, true); break;
        case 5123: v = view.getUint16(at, true); break;
        case 5125: v = view.getUint32(at, true); break;
        case 5126: v = view.getFloat32(at, true); break;
        default: throw new GlbParseError(`Unsupported componentType ${accessor.componentType}`);
      }
      out[i * itemSize + c] = v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  return {
    componentType: accessor.componentType,
    itemSize,
    count: accessor.count,
    values: out,
    normalized: !!accessor.normalized,
    min,
    max,
  };
}

/** Node parent map built from the children arrays. */
export function buildParentMap(json: GlbJson): Map<number, number | null> {
  const parents = new Map<number, number | null>();
  (json.nodes ?? []).forEach((_, i) => parents.set(i, null));
  (json.nodes ?? []).forEach((node, i) => {
    for (const child of node.children ?? []) parents.set(child, i);
  });
  return parents;
}

export function nodeName(json: GlbJson, index: number): string {
  return json.nodes?.[index]?.name ?? `node_${index}`;
}

/** All joints referenced by any skin, in skin order. */
export function skinJointNames(json: GlbJson): string[][] {
  return (json.skins ?? []).map((skin) => skin.joints.map((j) => nodeName(json, j)));
}

/** Bone hierarchy as childName -> parentName for every node that is a skin joint. */
export function jointHierarchy(json: GlbJson): { name: string; parent: string | null }[] {
  const parents = buildParentMap(json);
  const jointSet = new Set<number>();
  for (const skin of json.skins ?? []) for (const j of skin.joints) jointSet.add(j);
  const out: { name: string; parent: string | null }[] = [];
  for (const j of [...jointSet].sort((a, b) => a - b)) {
    const p = parents.get(j) ?? null;
    out.push({ name: nodeName(json, j), parent: p === null ? null : nodeName(json, p) });
  }
  return out;
}

/** Total node count, mesh nodes and skinned mesh nodes. */
export function glbFacts(json: GlbJson): {
  nodeCount: number;
  meshCount: number;
  skinnedMeshCount: number;
  skinCount: number;
  animationCount: number;
  materialCount: number;
  morphTargets: number;
  accessorCount: number;
} {
  let skinned = 0;
  for (const node of json.nodes ?? []) if (node.mesh !== undefined && node.skin !== undefined) skinned++;
  return {
    nodeCount: json.nodes?.length ?? 0,
    meshCount: json.meshes?.length ?? 0,
    skinnedMeshCount: skinned,
    skinCount: json.skins?.length ?? 0,
    animationCount: json.animations?.length ?? 0,
    materialCount: json.materials?.length ?? 0,
    morphTargets: (json.meshes ?? []).reduce((acc, m) => acc + (m.primitives[0]?.targets?.length ?? 0), 0),
    accessorCount: json.accessors?.length ?? 0,
  };
}
