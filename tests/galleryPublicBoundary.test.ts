import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// npm/Vitest runs this test from the project root.
const project = resolve(process.cwd());
const gallery = readFileSync(resolve(project, 'gallery.html'), 'utf8');
const vite = readFileSync(resolve(project, 'vite.config.ts'), 'utf8');
const ignore = readFileSync(resolve(project, '.gitignore'), 'utf8');

describe('public model gallery boundary', () => {
  it('includes a separate Vite gallery entrypoint', () => {
    expect(gallery).toContain('Model Gallery');
    expect(gallery).toContain('Choose GLB files');
    expect(gallery).toContain('SHA-256');
    expect(vite).toContain("gallery: resolve(root, 'gallery.html')");
  });
  it('does not publish a private preview manifest', () => {
    expect(ignore).toMatch(/^gallery-drive-previews\.json$/m);
    expect(gallery).not.toMatch(/\/Users\/|[\w.-]+@gmail\.com/);
    expect(gallery).not.toMatch(/(?:1[A-Za-z0-9_-]{27,})/);
    expect(gallery).not.toContain('DEX_SCULPT_LIBRARY_ROOT');
  });
});
