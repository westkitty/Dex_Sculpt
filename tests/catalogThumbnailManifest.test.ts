import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(process.cwd());
const gallery = readFileSync(join(root, 'gallery.html'), 'utf8');
const manifest = JSON.parse(readFileSync(join(root, 'src/data/modelThumbnailManifest.json'), 'utf8')) as {
  schema_version: string;
  catalog_record_count: number;
  public_thumbnail_count: number;
  previews: Record<string, { filename: string; source_glb_sha256: string; source_id: string; license_id: string }>;
};
const catalog = JSON.parse(readFileSync(join(root, 'src/data/humanoidCatalog.json'), 'utf8')) as {
  records: Array<{ asset_id: string; source_id: string; processed_glb_sha256: string; license_id: string }>;
};

describe('public model thumbnail identity and distribution boundary', () => {
  it('contains one verified source render per matched catalogue identity', () => {
    const byId = new Map(catalog.records.map(r => [r.asset_id, r]));
    const records = Object.entries(manifest.previews);
    expect(manifest.schema_version).toBe('dexsculpt.public-thumbnail-manifest.v1');
    expect(manifest.catalog_record_count).toBe(786);
    expect(records).toHaveLength(manifest.public_thumbnail_count);
    expect(records).toHaveLength(139);
    const filenames = new Set<string>();
    for (const [id, preview] of records) {
      const record = byId.get(id);
      expect(record, id).toBeDefined();
      expect(preview.source_id).toBe(record?.source_id);
      expect(preview.license_id).toBe(record?.license_id);
      expect(preview.source_glb_sha256).toBe(record?.processed_glb_sha256);
      expect(preview.filename).toMatch(/^[a-z0-9_-]+__[a-z0-9_-]+__posZ\.png$/i);
      expect(preview.filename.startsWith(record!.source_id + '__')).toBe(true);
      expect(filenames.has(preview.filename), 'no render reused for multiple models').toBe(false);
      filenames.add(preview.filename);
      const path = join(root, 'public/model-thumbnails', preview.filename);
      expect(existsSync(path), `render for ${id} exists`).toBe(true);
      const metadata = statSync(path);
      expect(metadata.size).toBeGreaterThan(2000);
      expect(metadata.size).toBeLessThan(1_000_000);
      expect(readFileSync(path).subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))).toBe(true);
    }
  });

  it('uses relative public thumbnails while excluding private archive IDs and all GLBs', () => {
    expect(gallery).toContain("from './src/data/modelThumbnailManifest.json'");
    expect(gallery).toContain("'./model-thumbnails/'");
    expect(gallery).not.toContain('1ss0Rqd0gDboU-ZCTbW4q-GDCgh0OEOQa');
    const manifestBytes = readFileSync(join(root, 'src/data/modelThumbnailManifest.json'), 'utf8');
    expect(manifestBytes).not.toMatch(/drive\.google\.com|\/Users\/|sediment:\/\/|private_locator|file\/d\//);
    expect(Object.values(manifest.previews).every(v => !v.filename.toLowerCase().endsWith('.glb'))).toBe(true);
  });
});
