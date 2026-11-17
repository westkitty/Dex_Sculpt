import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'tests/fixtures/downloads/CesiumMan.glb');
const commit = 'f0920f5b32d172a30efe3f9257e965918831e6ea';
const repoPath = 'Models/CesiumMan/glTF-Binary/CesiumMan.glb';
const url = `https://api.github.com/repos/KhronosGroup/glTF-Sample-Assets/contents/${repoPath}?ref=${commit}`;
const expectedBytes = 438044;
const expectedSha256 = 'b7001eaeea8254bd44773bcd247e78696d94169388fbb2a1800fc69434e777d9';

// curl uses the host trust store here (Node's bundled CA bundle can differ in managed sandboxes).
const jsonText = execFileSync('curl', [
  '--fail', '--silent', '--show-error', '--location',
  '--header', 'Accept: application/vnd.github+json',
  '--header', 'User-Agent: DEX-SCULPT-test-fixture-acquisition',
  url
], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
const item = JSON.parse(jsonText);
if (item.encoding !== 'base64' || typeof item.content !== 'string') throw new Error('GitHub API response did not include base64 file content');
const bytes = Buffer.from(item.content.replace(/\s/g, ''), 'base64');
const sha256 = createHash('sha256').update(bytes).digest('hex');
if (bytes.byteLength !== expectedBytes || sha256 !== expectedSha256) {
  throw new Error(`Fixture integrity mismatch: bytes=${bytes.byteLength}, sha256=${sha256}`);
}
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, bytes);
console.log(`Acquired ${repoPath} at ${commit}: ${bytes.byteLength} bytes, SHA-256 ${sha256}`);
console.log(`Per-model license/provenance: tests/fixtures/README.md (test-only; do not redistribute Cesium logo).`);
