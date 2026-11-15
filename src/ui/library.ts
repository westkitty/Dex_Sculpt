/** Character library rail: bundled examples and the metadata-only catalog. */
import { el, clear } from './dom';
import { icons } from './icons';
import { filterAssets, assetSourceId, sourceOf, type CatalogAsset } from '../catalog/catalog';
import type { Studio } from '../app/studio';

const FILTERS: { id: Studio['state']['libraryFilter']; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'examples', label: 'Examples' },
  { id: 'metadata', label: 'Catalog' },
  { id: 'rigged', label: 'Rigged' },
  { id: 'animated', label: 'Animated' },
];

const TYPE_ICON: Record<string, string> = {
  character: icons.human,
  mannequin: icons.human,
  'static_posed_humanoid': icons.human,
  'specialized_skeletal_humanoid': icons.human,
  'partial_humanoid_fps_arms': icons.human,
  animation_pack: icons.play,
  accessory: icons.prop,
  'modular_part': icons.prop,
  'modular_outfit': icons.prop,
  'modular_hairstyle': icons.prop,
  'hairstyle_origin_0': icons.prop,
  'hairstyle_rigged_head': icons.prop,
  base_mesh: icons.cube,
};

export function renderLibrary(studio: Studio): void {
  const body = document.getElementById('libraryBody');
  const filters = document.getElementById('libraryFilters');
  const search = document.getElementById('librarySearch') as HTMLInputElement | null;
  if (!body || !filters) return;

  if (search && search.value !== studio.state.libraryQuery) search.value = studio.state.libraryQuery;

  clear(filters);
  for (const filter of FILTERS) {
    filters.append(
      el('button', {
        class: 'chip',
        text: filter.label,
        ariaPressed: studio.state.libraryFilter === filter.id,
        dataset: { filter: filter.id },
      }),
    );
  }

  clear(body);
  const filter = studio.state.libraryFilter;
  const query = studio.state.libraryQuery.trim();

  if (filter !== 'metadata') {
    body.append(el('div', { class: 'rail__group-label', text: 'Bundled examples · generated locally' }));
    const examples = studio.examples.filter((example) => {
      if (filter === 'rigged' && !example.capabilities.rig) return false;
      if (filter === 'animated' && !example.capabilities.animation) return false;
      if (!query) return true;
      return (
        example.name.toLowerCase().includes(query.toLowerCase()) ||
        example.summary.toLowerCase().includes(query.toLowerCase()) ||
        example.badges.some((b) => b.toLowerCase().includes(query.toLowerCase()))
      );
    });
    if (!examples.length) {
      body.append(el('div', { class: 'rail__empty', text: 'No bundled example matches that search.' }));
    }
    for (const example of examples) {
      const isCurrent =
        studio.character?.meta.fixtureId === example.id ||
        (studio.character?.meta.fileName ?? '').startsWith(example.id);
      body.append(
        el('button', {
          class: 'asset',
          ariaCurrent: isCurrent ? 'true' : undefined,
          title: example.summary,
          dataset: { action: 'example', id: example.id },
        }, [
          el('span', { class: 'asset__icon', html: example.kind === 'rigged' ? icons.human : example.kind === 'static' ? icons.cube : icons.prop }),
          el('span', { class: 'asset__body' }, [
            el('span', { class: 'asset__name', text: example.name }),
            el('span', { class: 'asset__sub' }, [
              el('span', { class: 'asset__meta', text: `${example.subtitle} · ${example.badges.join(' · ')}` }),
              el('span', { class: 'asset__badges' }, [
                el('span', { class: 'badge badge--accent', text: example.kind === 'rigged' ? 'Rigged' : example.kind }),
              ]),
            ]),
          ]),
        ]),
      );
    }
  }

  const catalog = studio.catalog;
  if (filter !== 'examples') {
    if (!catalog) {
      body.append(el('div', { class: 'rail__group-label', text: 'Humanoid catalog · metadata only' }));
      body.append(
        el('div', { class: 'rail__empty' }, [
          document.createTextNode(
            studio.catalogFailure ??
              'Catalog metadata is unavailable. You can still import any local GLB — DEX//SCULPT does not need the catalog to edit a character.',
          ),
        ]),
      );
      return;
    }
    let assets = filterAssets(catalog, query, 'all');
    if (filter === 'rigged') assets = assets.filter((asset) => (asset.joints ?? 0) > 0);
    if (filter === 'animated') assets = assets.filter((asset) => (asset.clips ?? 0) > 0);
    const limited = assets.slice(0, 80);
    body.append(
      el('div', { class: 'rail__group-label', text: `Humanoid catalog · ${assets.length.toLocaleString()} records` }),
    );
    if (!assets.length) {
      body.append(el('div', { class: 'rail__empty', text: 'No catalog record matches that search.' }));
    }
    for (const asset of limited) {
      body.append(renderCatalogRow(studio, asset));
    }
    if (assets.length > limited.length) {
      body.append(
        el('div', {
          class: 'rail__empty',
          text: `${(assets.length - limited.length).toLocaleString()} more records — refine the search to narrow the list.`,
        }),
      );
    }
  }
}

function renderCatalogRow(studio: Studio, asset: CatalogAsset): HTMLElement {
  const source = sourceOf(studio.catalog, assetSourceId(asset));
  const joints = asset.joints ? `${asset.joints}j` : 'no rig';
  const clips = asset.clips ? `${asset.clips} clips` : 'static';
  const meta = `${source?.name ?? 'unknown source'} · ${asset.type.replace(/_/g, ' ')} · ${joints} · ${clips}`;
  const isCurrent = studio.loadedCatalogAsset?.id === asset.id;
  return el('button', {
    class: 'asset',
    title: `${asset.id}\n${asset.family ?? 'no skeleton family'} · licence ${asset.license ?? 'unknown'}\nCatalog record only — relink a local file to edit it.`,
    ariaCurrent: isCurrent ? 'true' : undefined,
    dataset: { action: 'catalog', id: asset.id },
  }, [
    el('span', { class: 'asset__icon', html: TYPE_ICON[asset.type] ?? icons.file }),
    el('span', { class: 'asset__body' }, [
      el('span', { class: 'asset__name', text: asset.name }),
      el('span', { class: 'asset__sub' }, [
        el('span', { class: 'asset__meta', text: meta }),
        el('span', { class: 'asset__badges' }, [
          asset.clips ? el('span', { class: 'badge badge--info', text: 'anim' }) : null,
          el('span', { class: 'badge badge--warn', text: 'meta' }),
        ]),
      ]),
    ]),
  ]);
}
