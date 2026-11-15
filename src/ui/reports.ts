/** Export verification report + project/recipe helpers used by dialogs. */
import { el, checkRow, section } from './dom';
import { formatBytes, formatDuration } from '../core/util';
import type { Studio, ExportArtifact } from '../app/studio';

function statusOf(ok: boolean): 'ok' | 'fail' {
  return ok ? 'ok' : 'fail';
}

function stat(label: string, value: string, kind: 'ok' | 'fail' | 'plain' = 'plain'): HTMLElement {
  return el('div', { class: `report-stat${kind === 'ok' ? ' report-stat--ok' : kind === 'fail' ? ' report-stat--fail' : ''}` }, [
    el('span', { class: 'field__label', text: label }),
    el('strong', { text: value }),
  ]);
}

export function renderExportReport(studio: Studio, artifact: ExportArtifact): Node[] {
  const report = artifact.report;
  const reimport = artifact.reimport;
  const nodes: Node[] = [];

  nodes.push(
    el('div', { class: `banner banner--${statusOf(report.ok && reimport.ok)}` }, [
      el('strong', { text: report.ok && reimport.ok ? 'Export verified' : 'Validation failed — download blocked' }),
      el('span', {
        text: `${artifact.fileName} · ${formatBytes(artifact.bytes.byteLength)} · structural ${report.checks.filter((c) => c.status === 'pass').length}/${report.checks.length} passed · re-import ${reimport.checks.filter((c) => c.status === 'pass').length}/${reimport.checks.length} passed`,
      }),
    ]),
  );

  const facts = report.facts;
  nodes.push(
    el('div', { class: 'grid-3' }, [
      stat('Skins', `${facts.skinCount}`, facts.skinCount > 0 ? 'ok' : 'fail'),
      stat('Skinned meshes', `${facts.skinnedMeshCount}`),
      stat('Max position error', `${(reimport.maxPositionError * 1000).toFixed(3)} mm`),
      stat('Clips', `${facts.animationCount}`),
      stat('Morph targets', `${facts.morphTargets}`),
      stat('Materials', `${facts.materialCount}`),
      stat('Edited vertices', `${facts.changedVertexCount}`),
      stat('Max edit', `${(facts.maxSkinPositionDelta * 1000).toFixed(2)} mm`),
      stat('Accessors', `${facts.accessorCount}`),
    ]),
  );

  nodes.push(
    section(
      'Structural checks',
      report.checks.map((check) => checkRow(check.status, check.label, check.detail)),
      'Parsed from the exported GLB bytes by an independent validator that never touches the editor scene.',
    ),
  );

  nodes.push(
    section(
      'Re-import checks',
      reimport.checks.map((check) => checkRow(check.status, check.label, check.detail)),
      'The exported file was parsed by a fresh GLTFLoader, rebuilt into a new skeleton and compared against the editor state.',
    ),
  );

  if (reimport.probes.length) {
    const list = el('div', { class: 'list' });
    for (const probe of reimport.probes) {
      list.append(
        el('div', { class: 'list-item' }, [
          el('span', { text: `${probe.mesh} · vertex ${probe.vertex}` }),
          el('span', { class: 'list-item__mono', text: `${probe.moved >= 0.0005 ? '✓' : '✕'} ${(probe.moved * 1000).toFixed(1)} mm` }),
        ]),
      );
    }
    nodes.push(section('Skinned deformation probes', [list], 'Each probe vertex is moved only by skinning weights while a clip plays. A dead probe means the skin was lost.'));
  }

  if (reimport.morphProbe) {
    const probe = reimport.morphProbe;
    nodes.push(
      section('Morph target probe', [
        el('div', { class: 'list' }, [
          el('div', { class: 'list-item' }, [
            el('span', { text: `Target “${probe.target}”` }),
            el('span', { class: 'list-item__mono', text: `${probe.movedVertices} verts · max ${(probe.maxMove * 1000).toFixed(1)} mm` }),
          ]),
        ]),
      ]),
    );
  }

  if (reimport.clip) {
    nodes.push(
      section('Clip playback', [
        el('div', { class: 'list' }, [
          el('div', { class: 'list-item' }, [
            el('span', { text: reimport.clip.name }),
            el('span', { class: 'list-item__mono', text: `${formatDuration(reimport.clip.duration)} · sampled at ${reimport.clip.time.toFixed(2)}s` }),
          ]),
        ]),
      ]),
    );
  }

  const summary = el('p', { class: 'report-summary' });
  summary.textContent = studio.lastExport
    ? `Validated ${new Date(artifact.createdAt).toLocaleTimeString()} · max position error ${(reimport.maxPositionError * 1000).toFixed(3)} mm vs the editor`
    : '';
  nodes.push(summary);
  return nodes;
}
