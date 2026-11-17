import { describe, it, expect } from 'vitest';
import { DnaHistory, meshPath, migrateRecipe, type Dna } from '../../src/core/dnaLayers';
import type { CharacterRecipeV1 } from '../../src/core/recipe';
const hash = 'a'.repeat(64);
const source = [{id: meshPath([0]), positions:[0,0,0, 0,0,0, 1,0,0]}, {id: meshPath([1]), positions:[0,0,0]}];
const initial = (): Dna => ({schema:'dexsculpt.dna.v2', sourceSha256:hash, activeId:'a', variants:[{id:'a',name:'Original',layers:[],morphWeights:{},materialOverrides:{},attachments:[],configuration:{}}]});
describe('portable DNA layers', () => {
 it('composes independent render vertex deltas, visibility, strength, history and JSON reload', () => {
  const h = new DnaHistory(source, initial(), hash);
  h.edit(d => d.variants[0].layers.push({id:'j',name:'Jaw',visible:true,strength:1,deltas:{'root/0':[1,0,0,0,0,0,0,0,0]}}));
  h.edit(d => d.variants[0].layers.push({id:'s',name:'Shoulders',visible:true,strength:1,deltas:{'root/0':[0,0,0,0,2,0,0,0,0]}}));
  h.edit(d => {d.variants[0].layers[0].visible = false});
  expect([...h.geometry()['root/0']].slice(0,6)).toEqual([0,0,0,0,2,0]);
  h.edit(d => {d.variants[0].layers[0].visible = true; d.variants[0].layers[0].strength = .5});
  expect(h.geometry()['root/0'][0]).toBe(.5); expect(h.undo()).toBe(true); expect(h.geometry()['root/0'][0]).toBe(0); expect(h.redo()).toBe(true);
  const loaded = new DnaHistory(source, JSON.parse(JSON.stringify(h.snapshot())), hash);
  expect([...loaded.geometry()['root/0']]).toEqual([...h.geometry()['root/0']]);
  expect(source[0].positions[0]).toBe(0);
 });
 it('isolates variants, supports comparison and rejects invalid transactions atomically', () => {
  const h = new DnaHistory(source, initial(), hash);
  h.edit(d => {const v = structuredClone(d.variants[0]); v.id='b'; v.name='Alternate'; v.layers.push({id:'l',name:'Edit',visible:true,strength:1,deltas:{'root/1':[0,1,0]}}); d.variants.push(v); d.activeId='b'});
  expect(h.geometry('a')['root/1'][1]).toBe(0); expect(h.geometry('b')['root/1'][1]).toBe(1);
  const before = h.snapshot(); expect(() => h.edit(d => { d.variants[1].layers[0].deltas['root/1']=[NaN,0,0] })).toThrow(); expect(h.snapshot()).toEqual(before);
  expect(() => new DnaHistory(source, before, 'b'.repeat(64))).toThrow();
 });
 it('rejects ambiguous duplicate-name V1 migration and migrates unambiguous sparse vertices', () => {
  const r = {schemaVersion:'dexsculpt.recipe.v1',editorVersion:'1',projectId:'p',createdAt:'',updatedAt:'',title:'Old',source:{kind:'local-glb',assetId:null,displayName:'Old',fileName:'old.glb',sha256:hash,skeletonFamily:'unknown',licenseId:'unknown',requiresSourceRelink:true},sculptDeltas:[{meshName:'body',vertexCount:1,indices:[0],deltas:[1,2,3]}],morphWeights:{},materialOverrides:{},attachments:[]} as CharacterRecipeV1;
  expect(() => migrateRecipe(r,[{id:'root/0',name:'body',vertexCount:1},{id:'root/1',name:'body',vertexCount:1}])).toThrow(/Ambiguous/);
  expect(migrateRecipe(r,[{id:'root/1',name:'body',vertexCount:1}]).variants[0].layers[0].deltas['root/1']).toEqual([1,2,3]);
 });
});
