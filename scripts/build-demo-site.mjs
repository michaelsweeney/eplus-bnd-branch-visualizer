// Builds the deployable demo site into dist/: the app bundle plus
// decimated demo datasets (full-resolution playback JSONs are 90-214 MB;
// hosting caps and load times want <25 MB per file).
//
// usage: node scripts/build-demo-site.mjs
// deploy: npx wrangler pages deploy dist --project-name <name>
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const src = path.join(root, 'public', 'demo-data');
const dst = path.join(root, 'dist', 'demo-data');

// per-dataset stride: a year of 3-hourly still scrubs like a year; the
// hospital needs 4-hourly to clear Cloudflare Pages' 25 MB file cap
const DATASETS = {
  'large-office': { every: 3 },
  'hospital': { every: 4 },
  'small-office': { every: 3 }
};

const run = (cmd, args, env = {}) => {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

run('npx', ['vite', 'build'], { SKIP_PUBLIC_COPY: '1' });
fs.mkdirSync(dst, { recursive: true });

for (const [name, { every }] of Object.entries(DATASETS)) {
  for (const ext of ['bnd', 'epJSON']) {
    const f = `${name}.${ext}`;
    if (fs.existsSync(path.join(src, f))) fs.copyFileSync(path.join(src, f), path.join(dst, f));
    else console.warn(`missing ${f} — dataset will load without it`);
  }
  const pb = path.join(src, `${name}.playback.json`);
  if (!fs.existsSync(pb)) { console.warn(`missing ${name}.playback.json — skipping playback`); continue; }
  run('node', [
    '--max-old-space-size=4096', 'scripts/decimate-playback.mjs', pb,
    '--every', String(every), '--round', '3',
    '--out', path.join(dst, `${name}.playback.json`)
  ]);
}

const mb = b => (b / 1024 / 1024).toFixed(1);
let total = 0;
for (const f of fs.readdirSync(dst)) total += fs.statSync(path.join(dst, f)).size;
console.log(`\ndist/demo-data total: ${mb(total)} MB`);
console.log('deploy with: npx wrangler pages deploy dist --project-name eplus-bnd-viz');
