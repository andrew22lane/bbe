#!/usr/bin/env node
// Prove two build outputs are byte-for-byte the same.
//
// Usage: node tools/verify-byte-identity.mjs <dirA> <dirB>
//
// Walks both trees, sha256s every file, and reports. Exits 1 on any content
// difference, any file present in one tree and not the other, or any file-count
// mismatch. Exits 0 only when both trees hold the same files with the same bytes.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const [,, dirA, dirB] = process.argv;
if (!dirA || !dirB) {
  console.error('usage: node tools/verify-byte-identity.mjs <dirA> <dirB>');
  process.exit(1);
}
for (const d of [dirA, dirB]) {
  if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) {
    console.error(`FAIL: not a directory: ${d}`);
    process.exit(1);
  }
}

function walk(root, rel = '', out = new Map()) {
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walk(root, r, out);
    else if (e.isFile()) out.set(r, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, r))).digest('hex'));
  }
  return out;
}

const a = walk(dirA);
const b = walk(dirB);
const all = [...new Set([...a.keys(), ...b.keys()])].sort();

const onlyA = [], onlyB = [], differ = [];
for (const f of all) {
  if (!b.has(f)) onlyA.push(f);
  else if (!a.has(f)) onlyB.push(f);
  else if (a.get(f) !== b.get(f)) differ.push(f);
}

const htmlA = [...a.keys()].filter(f => f.endsWith('.html')).length;
const htmlB = [...b.keys()].filter(f => f.endsWith('.html')).length;
const same = all.length - onlyA.length - onlyB.length - differ.length;

console.log(`${dirA}: ${a.size} files (${htmlA} html)`);
console.log(`${dirB}: ${b.size} files (${htmlB} html)`);
console.log(`${same}/${all.length} identical`);

for (const f of differ) console.log(`DIFFER      ${f}  ${a.get(f).slice(0,12)} vs ${b.get(f).slice(0,12)}`);
for (const f of onlyA)  console.log(`ONLY IN A   ${f}`);
for (const f of onlyB)  console.log(`ONLY IN B   ${f}`);

if (a.size !== b.size) console.log(`COUNT MISMATCH  ${a.size} vs ${b.size}`);

const bad = differ.length || onlyA.length || onlyB.length || a.size !== b.size;
console.log(bad ? 'RESULT: NOT IDENTICAL' : 'RESULT: IDENTICAL');
process.exit(bad ? 1 : 0);
