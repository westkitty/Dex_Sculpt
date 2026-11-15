/**
 * Bundled example assets.
 *
 * They are generated from code at load time and serialised to GLB, then imported
 * through the exact same pipeline as a user's file. Nothing third-party is
 * redistributed with this repository.
 */
import { buildFoundryBust, buildFoundryHumanoid, buildFoundryVisor, FIXTURE_SKELETON_FAMILY } from './humanoid';
import { sceneToGLB } from '../character/exporter';

export type ExampleKind = 'rigged' | 'static' | 'prop';

export interface ExampleAsset {
  id: string;
  name: string;
  subtitle: string;
  kind: ExampleKind;
  summary: string;
  capabilities: { rig: boolean; morphs: boolean; animation: boolean; uv: boolean };
  badges: string[];
  skeletonFamily?: string;
  license: string;
  build(): Promise<ArrayBuffer>;
}

export const EXAMPLE_ASSETS: ExampleAsset[] = [
  {
    id: 'foundry-humanoid',
    name: 'Foundry Humanoid',
    subtitle: 'Procedural rig-safe fixture',
    kind: 'rigged',
    summary:
      'A generated humanoid built for the rig-preservation proof: 20 bones, four-influence skin weights, inverse bind matrices, UV seams, three morph targets and three animation clips.',
    capabilities: { rig: true, morphs: true, animation: true, uv: true },
    badges: ['Generated', 'Skinned', '3 clips', '3 morphs'],
    skeletonFamily: FIXTURE_SKELETON_FAMILY,
    license: 'Original procedural work — CC0-1.0 (DEX//SCULPT)',
    build: async () => {
      const fixture = buildFoundryHumanoid();
      const bytes = await sceneToGLB(fixture.root, fixture.clips);
      return bytes;
    },
  },
  {
    id: 'foundry-bust',
    name: 'Foundry Static Bust',
    subtitle: 'Unrigged sculpt target',
    kind: 'static',
    summary:
      'A single unrigged mesh with UVs and no skeleton, morph targets or clips. Sculpting works; appearance, rig and animation panels explain exactly why they are unavailable.',
    capabilities: { rig: false, morphs: false, animation: false, uv: true },
    badges: ['Generated', 'Static mesh'],
    license: 'Original procedural work — CC0-1.0 (DEX//SCULPT)',
    build: async () => {
      const bust = buildFoundryBust();
      return sceneToGLB(bust.root, []);
    },
  },
  {
    id: 'foundry-visor',
    name: 'Foundry Visor',
    subtitle: 'Rigid accessory prop',
    kind: 'prop',
    summary:
      'An original rigid prop used to demonstrate the accessory workflow: import it, attach it to a bone, move it, then export it with the character.',
    capabilities: { rig: false, morphs: false, animation: false, uv: false },
    badges: ['Generated', 'Attachment'],
    license: 'Original procedural work — CC0-1.0 (DEX//SCULPT)',
    build: async () => {
      const visor = buildFoundryVisor();
      return sceneToGLB(visor, []);
    },
  },
];

export function getExample(id: string): ExampleAsset | undefined {
  return EXAMPLE_ASSETS.find((e) => e.id === id);
}
