import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { RigSafeSculptTarget, vertexCompatibilityKeys } from '../src/core/rigSafeSculpt';
import { requiresSplitSeamGuard } from '../src/app/sculptTool';

function splitGeometry(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  // Two triangles share the same spatial edge but have independent render vertices.
  // Their planes are perpendicular; the shared edge is UV-seamed, hard-normal split,
  // and assigned to different materials. This is an adversarial smooth-brush fixture.
  g.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0,  1, 0, 0,  0, 1, 0,
    0, 0, 0,  1, 0, 0,  0, 0, 1
  ], 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute([
    0, 0, 1,  0, 0, 1,  0, 0, 1,
    0, 1, 0,  0, 1, 0,  0, 1, 0
  ], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([
    0, 0,  1, 0,  0, 1,
    0.25, 0.25,  0.75, 0.25,  1, 1
  ], 2));
  g.setIndex([0, 1, 2, 3, 4, 5]);
  g.addGroup(0, 3, 0);
  g.addGroup(3, 3, 1);
  return g;
}

describe('protected-attribute compatibility and split-surface regression fixture', () => {
  it('does not weld coincident render vertices when UVs, normals, or material groups differ', () => {
    const g = splitGeometry();
    const keys = vertexCompatibilityKeys(g);
    expect(keys[0]).not.toBe(keys[3]);
    expect(keys[1]).not.toBe(keys[4]);
    const target = new RigSafeSculptTarget(new THREE.Mesh(g, [new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial()]));
    expect(target.mesh.renderToUniq[0]).not.toBe(target.mesh.renderToUniq[3]);
    expect(target.mesh.renderToUniq[1]).not.toBe(target.mesh.renderToUniq[4]);
    target.dispose();
  });

  it('isolates UV, normal, material, joint-index, weight, and morph compatibility dimensions', () => {
    const matching = () => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0], 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1], 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute([0.5, 0.5, 0.5, 0.5], 2));
      return g;
    };
    const uv = matching();
    uv.getAttribute('uv').setXY(1, 0.25, 0.75);
    expect(vertexCompatibilityKeys(uv)[0]).not.toBe(vertexCompatibilityKeys(uv)[1]);

    const normal = matching();
    normal.getAttribute('normal').setXYZ(1, 0, 1, 0);
    expect(vertexCompatibilityKeys(normal)[0]).not.toBe(vertexCompatibilityKeys(normal)[1]);

    const material = new THREE.BufferGeometry();
    material.setAttribute('position', new THREE.Float32BufferAttribute([
      0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0
    ], 3));
    material.setAttribute('normal', new THREE.Float32BufferAttribute(Array.from({ length: 18 }, (_, i) => i % 3 === 2 ? 1 : 0), 3));
    material.setAttribute('uv', new THREE.Float32BufferAttribute(Array.from({ length: 12 }, () => 0.5), 2));
    material.setIndex([0, 1, 2, 3, 4, 5]);
    material.addGroup(0, 3, 0);
    material.addGroup(3, 3, 1);
    expect(vertexCompatibilityKeys(material)[0]).not.toBe(vertexCompatibilityKeys(material)[3]);

    const joints = matching();
    joints.setAttribute('skinIndex', new THREE.Uint16BufferAttribute([0, 0, 0, 0, 1, 0, 0, 0], 4));
    expect(vertexCompatibilityKeys(joints)[0]).not.toBe(vertexCompatibilityKeys(joints)[1]);

    const weights = matching();
    weights.setAttribute('skinWeight', new THREE.Float32BufferAttribute([1, 0, 0, 0, 0.5, 0.5, 0, 0], 4));
    expect(vertexCompatibilityKeys(weights)[0]).not.toBe(vertexCompatibilityKeys(weights)[1]);

    const morph = matching();
    morph.morphAttributes.position = [new THREE.Float32BufferAttribute([0, 0, 0, 0.01, 0, 0], 3)];
    expect(vertexCompatibilityKeys(morph)[0]).not.toBe(vertexCompatibilityKeys(morph)[1]);
  });

  it('routes only reproduced split-seam failure modes through the safety gate', () => {
    expect(requiresSplitSeamGuard('smooth')).toBe(true);
    expect(requiresSplitSeamGuard('inflate')).toBe(true);
    for (const tool of ['draw', 'clay', 'crease', 'grab', 'flatten', 'pinch', 'mask'] as const) {
      expect(requiresSplitSeamGuard(tool)).toBe(false);
    }
  });

  it.each(['smooth', 'inflate'] as const)('blocks the measured split-edge %s footprint before changing geometry', tool => {
    const target = new RigSafeSculptTarget(new THREE.Mesh(splitGeometry(), [new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial()]));
    const pos = target.geometry.getAttribute('position');
    const before = Array.from(pos.array as Float32Array);
    // The historical Smooth case opened a 0.2960245861-unit gap; the same fixture
    // also measures a 0.090422-unit gap for Inflate. The app blocks both footprints.
    expect(requiresSplitSeamGuard(tool)).toBe(true);
    expect(target.isGeometryStrokeSafeAt([0.5, 0, 0], 1.4, { x: false, y: false, z: false })).toBe(false);
    expect(Array.from(pos.array as Float32Array)).toEqual(before);
    expect(pos.count).toBe(6);
    expect(target.geometry.getAttribute('uv').getX(0)).not.toBe(target.geometry.getAttribute('uv').getX(3));
    target.dispose();
  });
});
