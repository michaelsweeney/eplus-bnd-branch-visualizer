// Shrinks a playback JSON for web hosting: keep every Nth timestep and
// round values to a fixed number of decimals. The annual scrub story
// survives decimation (a year at 3-hourly is still a year); rounding
// mostly buys JSON bytes — full-precision floats serialize at 15+
// digits. Internals stay aligned: times and every series are sliced
// with the same stride.
//
// usage: node scripts/decimate-playback.mjs in.playback.json \
//          --out out.playback.json [--every 3] [--round 3]
import fs from 'node:fs';
import path from 'node:path';

export function decimatePlayback(playback, { every = 3, round = 3 } = {}) {
  const stride = Math.max(1, Math.floor(every));
  const keep = arr => arr.filter((_, i) => i % stride === 0);
  const roundVal = v =>
    typeof v === 'number' && Number.isFinite(v) ? Number(v.toFixed(round)) : v;

  const out = {
    metadata: {
      ...(playback.metadata || {}),
      timeCount: keep(playback.times || []).length,
      decimation: {
        every: stride,
        round,
        originalTimeCount: (playback.times || []).length
      }
    },
    times: keep(playback.times || []),
    nodes: {},
    zones: {}
  };
  for (const bucket of ['nodes', 'zones']) {
    for (const [key, slots] of Object.entries(playback[bucket] || {})) {
      out[bucket][key] = {};
      for (const [slot, series] of Object.entries(slots)) {
        out[bucket][key][slot] = {
          ...series,
          values: keep(series.values || []).map(roundVal)
        };
      }
    }
  }
  return out;
}

function parseArgs(argv) {
  const args = { every: 3, round: 3 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i];
    else if (a === '--every') args.every = Number(argv[++i]);
    else if (a === '--round') args.round = Number(argv[++i]);
    else if (!args.input) args.input = a;
    else throw new Error(`Unexpected argument: ${a}`);
  }
  if (!args.input) {
    console.error(
      'Usage: node scripts/decimate-playback.mjs <in.playback.json> --out <out.json> [--every 3] [--round 3]'
    );
    process.exit(1);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = path.resolve(args.input);
  const out = path.resolve(args.out || input.replace(/\.json$/i, '') + `.x${args.every}.json`);
  const playback = JSON.parse(fs.readFileSync(input, 'utf8'));
  const slim = decimatePlayback(playback, { every: args.every, round: args.round });
  fs.writeFileSync(out, `${JSON.stringify(slim)}\n`);
  const mb = b => (b / 1024 / 1024).toFixed(1);
  console.log(
    `wrote ${out} (${slim.metadata.timeCount}/${slim.metadata.decimation.originalTimeCount} timesteps, ` +
      `${mb(fs.statSync(input).size)} MB -> ${mb(fs.statSync(out).size)} MB)`
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  main();
}
