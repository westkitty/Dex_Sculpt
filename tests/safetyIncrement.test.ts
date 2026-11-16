import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { RigSafeSculptTarget } from '../src/core/rigSafeSculpt';
import { CharacterSession } from '../src/app/characterSession';
import type { StudioViewport } from '../src/app/viewport';
import type { CharacterRecipeV1 } from '../src/core/recipe';

function seam(kind: 'uv'|'normal'|'skinIndex'|'skinWeight'|'morph'|'material'|'same'): RigSafeSculptTarget {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([0,0,0, 1,0,0, 0,1,0, 0,0,0, -1,0,0, 0,-1,0],3));
  const uv = new Float32Array(12); const normals = new Float32Array(18); const joints = new Uint16Array(24); const weights = new Float32Array(24); const morph = new Float32Array(18);
  for (let i=0;i<6;i++) { normals[i*3+2]=1; weights[i*4]=1; }
  if (kind==='uv') uv[6]=1;
  if (kind==='normal') {normals[11]=0; normals[10]=1;}
  if (kind==='skinIndex') joints[12]=1;
  if (kind==='skinWeight') {weights[12]=.5; weights[13]=.5;}
  if (kind==='morph') morph[9]=.5;
  g.setAttribute('normal',new THREE.BufferAttribute(normals,3)); g.setAttribute('uv',new THREE.BufferAttribute(uv,2));
  g.setAttribute('skinIndex',new THREE.BufferAttribute(joints,4)); g.setAttribute('skinWeight',new THREE.BufferAttribute(weights,4));
  g.morphAttributes.position=[new THREE.BufferAttribute(morph,3)]; g.morphTargetsRelative=true;
  if(kind==='material') {g.addGroup(0,3,0);g.addGroup(3,3,1);}
  return new RigSafeSculptTarget(new THREE.Mesh(g));
}
describe('portable safety integration', () => {
  it.each(['uv','normal','skinIndex','skinWeight','morph','material'] as const)('separates coincident vertices with different %s', kind => {
    const t=seam(kind); expect(t.mesh.renderToUniq[0]).not.toBe(t.mesh.renderToUniq[3]);
    const first=t.mesh.renderToUniq[0]; t.mesh.pos[first*3]+=0.5; t.applyChangedVertices([first]);
    const p=t.geometry.getAttribute('position'); expect(p.getX(0)).toBe(.5); expect(p.getX(3)).toBe(0); t.dispose();
  });
  it('still welds attribute-compatible coincident vertices', () => {const t=seam('same'); expect(t.mesh.renderToUniq[0]).toBe(t.mesh.renderToUniq[3]); t.dispose();});
  it('rejects malformed deltas before touching geometry', () => {const t=seam('same'); const before=Array.from(t.geometry.getAttribute('position').array); expect(() => t.applySparseDeltas({meshName:'x',vertexCount:6,indices:[0],deltas:[NaN,0,0]})).toThrow(); expect(Array.from(t.geometry.getAttribute('position').array)).toEqual(before); t.dispose();});
  it('rejects a wrong relink before unloading the current character', async () => {
    const s=new CharacterSession({} as StudioViewport); const original=new THREE.Group(); s.root=original; s.sourceSha256='old';
    s.pendingRecipeAwaitingRelink={source:{sha256:'a'.repeat(64)}} as CharacterRecipeV1;
    await expect(s.relinkSourceForPendingRecipe('wrong.glb',new Uint8Array([1,2,3]).buffer)).rejects.toThrow(/SHA-256 differs/);
    expect(s.root).toBe(original); expect(s.sourceSha256).toBe('old'); expect(s.pendingRecipeAwaitingRelink).not.toBeNull();
  });
});
