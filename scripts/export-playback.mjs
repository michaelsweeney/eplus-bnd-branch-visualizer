#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

const VARIABLE_MAP = {
  'System Node Temperature': 'temperature',
  'System Node Mass Flow Rate': 'massFlow'
};

function usage() {
  console.error(`Usage: node scripts/export-playback.mjs <eplusout.sql> [options]

Options:
  --out <file>       Output JSON path (default: <sql>.playback.json)
  --frequency <name> Optional reporting frequency filter, e.g. Timestep or Hourly
`);
}

function parseArgs(argv) {
  const args = { input: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!args.input && !arg.startsWith('--')) {
      args.input = arg;
    } else if (arg === '--out') {
      args.out = argv[++i];
    } else if (arg === '--frequency') {
      args.frequency = argv[++i];
    } else if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.input) throw new Error('Missing eplusout.sql input.');
  return args;
}

function sqliteJson(db, sql) {
  const result = spawnSync('sqlite3', ['-json', db, sql], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 256
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.error?.message || `sqlite3 failed with exit code ${result.status}`);
  }
  return result.stdout.trim() ? JSON.parse(result.stdout) : [];
}

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function exportPlayback(sqlFile, options = {}) {
  const frequencyFilter = options.frequency
    ? ` and d.ReportingFrequency = ${sqlString(options.frequency)}`
    : '';
  const dict = sqliteJson(
    sqlFile,
    `select d.ReportDataDictionaryIndex as idx, d.KeyValue as keyValue, d.Name as name, ` +
      `d.ReportingFrequency as frequency, d.Units as units ` +
      `from ReportDataDictionary d ` +
      `where d.Name in ('System Node Temperature','System Node Mass Flow Rate')${frequencyFilter} ` +
      `order by d.KeyValue, d.Name, d.ReportDataDictionaryIndex`
  );

  const dictionaryIds = dict.map(row => row.idx);
  const times = sqliteJson(
    sqlFile,
    `select TimeIndex as timeIndex, Year as year, Month as month, Day as day, Hour as hour, ` +
      `Minute as minute, Interval as interval, SimulationDays as simulationDay, DayType as dayType, ` +
      `EnvironmentPeriodIndex as environmentPeriodIndex, WarmupFlag as warmupFlag ` +
      `from Time order by TimeIndex`
  );
  const timeIndex = new Map(times.map((row, i) => [row.timeIndex, i]));

  const output = {
    metadata: {
      source: path.resolve(sqlFile),
      exportedAt: new Date().toISOString(),
      variables: dict,
      timeCount: times.length,
      seriesCount: dict.length
    },
    times: times.map(row => ({
      ...row,
      label: timeLabel(row)
    })),
    nodes: {}
  };

  if (dictionaryIds.length === 0) return output;

  const rows = sqliteJson(
    sqlFile,
    `select r.TimeIndex as timeIndex, r.ReportDataDictionaryIndex as idx, r.Value as value ` +
      `from ReportData r where r.ReportDataDictionaryIndex in (${dictionaryIds.join(',')}) ` +
      `order by r.ReportDataDictionaryIndex, r.TimeIndex`
  );
  const dictById = new Map(dict.map(row => [row.idx, row]));
  for (const entry of dict) {
    const slot = VARIABLE_MAP[entry.name];
    if (!output.nodes[entry.keyValue]) output.nodes[entry.keyValue] = {};
    output.nodes[entry.keyValue][slot] = {
      units: entry.units || '',
      frequency: entry.frequency || '',
      values: Array(times.length).fill(null)
    };
  }

  for (const row of rows) {
    const entry = dictById.get(row.idx);
    if (!entry) continue;
    const slot = VARIABLE_MAP[entry.name];
    const offset = timeIndex.get(row.timeIndex);
    if (offset == null) continue;
    output.nodes[entry.keyValue][slot].values[offset] = row.value;
  }

  return output;
}

function timeLabel(row) {
  const year = row.year || '----';
  const month = String(row.month).padStart(2, '0');
  const day = String(row.day).padStart(2, '0');
  const hour = String(row.hour).padStart(2, '0');
  const minute = String(row.minute).padStart(2, '0');
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = path.resolve(args.input);
  const out = path.resolve(args.out || input.replace(/\.sql$/i, '') + '.playback.json');
  const playback = exportPlayback(input, { frequency: args.frequency });
  fs.writeFileSync(out, `${JSON.stringify(playback)}\n`);
  console.log(
    `wrote ${out} (${Object.keys(playback.nodes).length} nodes, ${playback.metadata.timeCount} timesteps)`
  );
  if (playback.metadata.seriesCount === 0) {
    console.warn('warning: no System Node Temperature or System Node Mass Flow Rate series found');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    usage();
    process.exit(1);
  }
}

export { exportPlayback };
