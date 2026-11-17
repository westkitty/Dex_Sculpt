import fs from 'node:fs';
import { validateBytes } from 'gltf-validator';

const input = process.argv[2];
if (!input) throw new Error('Usage: node scripts/validate-real-character.mjs <file.glb>');
const bytes = fs.readFileSync(input);
const result = await validateBytes(new Uint8Array(bytes), { uri: input.split(/[\\/]/).at(-1) });
console.log(JSON.stringify({
  file: input,
  bytes: bytes.byteLength,
  numErrors: result.issues.numErrors,
  numWarnings: result.issues.numWarnings,
  numInfos: result.issues.numInfos,
  messages: result.issues.messages.map((m) => ({ code: m.code, message: m.message }))
}));
if (result.issues.numErrors > 0) process.exitCode = 1;
