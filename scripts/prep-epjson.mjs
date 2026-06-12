#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

const PRESETS = {
  nodes: [
    ['System Node Temperature', 'Timestep'],
    ['System Node Mass Flow Rate', 'Timestep']
  ],
  'nodes-hourly': [
    ['System Node Temperature', 'Hourly'],
    ['System Node Mass Flow Rate', 'Hourly']
  ],
  everything: [
    ['System Node Temperature', 'Timestep'],
    ['System Node Mass Flow Rate', 'Timestep'],
    ['Surface Inside Face Temperature', 'Timestep'],
    ['Zone Mean Air Temperature', 'Timestep']
  ]
};

function usage() {
  console.error(`Usage: node scripts/prep-epjson.mjs <model.epJSON|model.idf> [options]

Options:
  --out <file>             Output epJSON path (default: <input>.prepped.epJSON)
  --preset <name>          nodes | nodes-hourly | everything (default: nodes)
  --version <version>      EnergyPlus version override for IDF conversion/run
  --run                    Run EnergyPlus after writing the patched model
  --weather <file>         Weather file for --run
  --output-dir <dir>       Run output directory (default: sibling eplus-run/)
  --energyplus-root <dir>  Root containing versioned installs (default: ~/programs/energyplus)
`);
}

function parseArgs(argv) {
  const args = {
    input: null,
    preset: 'nodes',
    run: false,
    energyplusRoot: path.join(process.env.HOME || '', 'programs/energyplus')
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!args.input && !arg.startsWith('--')) {
      args.input = arg;
    } else if (arg === '--out') {
      args.out = argv[++i];
    } else if (arg === '--preset') {
      args.preset = argv[++i];
    } else if (arg === '--version') {
      args.version = argv[++i];
    } else if (arg === '--run') {
      args.run = true;
    } else if (arg === '--weather') {
      args.weather = argv[++i];
    } else if (arg === '--output-dir') {
      args.outputDir = argv[++i];
    } else if (arg === '--energyplus-root') {
      args.energyplusRoot = argv[++i];
    } else if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.input) throw new Error('Missing input epJSON file.');
  if (!PRESETS[args.preset]) throw new Error(`Unknown preset: ${args.preset}`);
  return args;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function isIdf(file) {
  return /\.idf$/i.test(file);
}

function defaultOutputPath(input) {
  if (isIdf(input)) return input.replace(/\.idf$/i, '') + '.prepped.epJSON';
  return input.replace(/\.epjson$/i, '') + '.prepped.epJSON';
}

function readInputModel(input, args) {
  if (!isIdf(input)) return { model: readJson(input), version: null };

  const version = args.version || detectIdfVersion(fs.readFileSync(input, 'utf8'));
  const converter = resolveEnergyPlusTool(args.energyplusRoot, version, 'ConvertInputFormat');
  const tempDir = fs.mkdtempSync(path.join(path.dirname(input), '.bnd-prep-convert-'));
  const tempIdf = path.join(tempDir, path.basename(input));
  fs.copyFileSync(input, tempIdf);
  const result = spawnSync(converter, ['--epJSON', tempIdf], {
    cwd: tempDir,
    stdio: 'inherit'
  });
  if (result.status !== 0) {
    throw new Error(`ConvertInputFormat failed with exit code ${result.status}`);
  }
  const epjson = tempIdf.replace(/\.idf$/i, '.epJSON');
  if (!fs.existsSync(epjson)) {
    throw new Error(`ConvertInputFormat did not create ${epjson}`);
  }
  return { model: readJson(epjson), version };
}

function detectIdfVersion(text) {
  const match = text.match(/^\s*Version\s*,\s*([^;,\n]+)/im);
  if (!match) throw new Error('Cannot detect EnergyPlus version from IDF Version object; pass --version.');
  const version = match[1].trim();
  const normalized = version.match(/\d+(?:\.\d+)?/);
  if (!normalized) throw new Error('Cannot parse EnergyPlus version from IDF Version object; pass --version.');
  return normalized[0];
}

function detectVersion(model) {
  const versionObj = model.Version && Object.values(model.Version)[0];
  const raw =
    versionObj?.version_identifier ||
    versionObj?.Version_Identifier ||
    versionObj?.versionIdentifier ||
    versionObj?.identifier;
  if (!raw) return null;
  const match = String(raw).match(/\d+(?:\.\d+)?/);
  return match ? match[0] : null;
}

function ensureOutputSqlite(model) {
  model['Output:SQLite'] = {
    BNDPrepOutputSQLite: {
      option_type: 'SimpleAndTabular'
    }
  };
}

function ensureOutputVariables(model, preset) {
  const current = model['Output:Variable'] || {};
  const next = { ...current };
  let i = 1;
  for (const [variableName, frequency] of PRESETS[preset]) {
    const exists = Object.values(next).some(
      row =>
        row &&
        row.variable_name === variableName &&
        (row.key_value === '*' || row.key_value == null) &&
        row.reporting_frequency === frequency
    );
    if (exists) continue;
    let key;
    do {
      key = `BND Prep ${String(i).padStart(2, '0')}`;
      i++;
    } while (next[key]);
    next[key] = {
      key_value: '*',
      variable_name: variableName,
      reporting_frequency: frequency
    };
  }
  model['Output:Variable'] = next;
}

function resolveEnergyPlus(root, version) {
  return resolveEnergyPlusTool(root, version, 'energyplus');
}

function resolveEnergyPlusTool(root, version, tool) {
  if (!version) throw new Error('Cannot detect EnergyPlus version from Version object.');
  const candidates = [
    path.join(root, version, tool),
    path.join(root, version, 'bin', tool),
    path.join(root, `EnergyPlus-${version}`, tool),
    path.join(root, `EnergyPlus-${version}`, 'bin', tool),
    path.join(root, version, tool === 'energyplus' ? 'EnergyPlus' : tool)
  ];
  const found = candidates.find(file => fs.existsSync(file));
  if (!found) {
    throw new Error(`Could not find ${tool} for EnergyPlus ${version} under ${root}`);
  }
  return found;
}

function runEnergyPlus({ executable, weather, outputDir, modelFile }) {
  if (!weather) throw new Error('--weather is required with --run');
  fs.mkdirSync(outputDir, { recursive: true });
  const result = spawnSync(
    executable,
    ['-w', weather, '-d', outputDir, modelFile],
    { stdio: 'inherit' }
  );
  if (result.status !== 0) {
    throw new Error(`EnergyPlus failed with exit code ${result.status}`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = path.resolve(args.input);
  const out = path.resolve(args.out || defaultOutputPath(input));
  const { model, version: inputVersion } = readInputModel(input, args);
  const version = args.version || inputVersion || detectVersion(model);

  ensureOutputSqlite(model);
  ensureOutputVariables(model, args.preset);
  fs.writeFileSync(out, `${JSON.stringify(model, null, 2)}\n`);
  console.log(`wrote ${out}`);

  if (args.run) {
    const executable = resolveEnergyPlus(args.energyplusRoot, version);
    runEnergyPlus({
      executable,
      weather: args.weather,
      outputDir: path.resolve(args.outputDir || path.join(path.dirname(out), 'eplus-run')),
      modelFile: out
    });
  }
}

try {
  main();
} catch (error) {
  console.error(error.message);
  usage();
  process.exit(1);
}
