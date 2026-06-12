const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('export-playback creates node-aligned playback JSON from EnergyPlus SQL tables', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bnd-playback-'));
  const db = path.join(dir, 'eplusout.sql');
  const out = path.join(dir, 'playback.json');
  const schema = `
create table ReportDataDictionary (
  ReportDataDictionaryIndex integer primary key,
  IsMeter integer,
  Type text,
  IndexGroup text,
  TimestepType text,
  KeyValue text,
  Name text,
  ReportingFrequency text,
  ScheduleName text,
  Units text
);
create table Time (
  TimeIndex integer primary key,
  Year integer,
  Month integer,
  Day integer,
  Hour integer,
  Minute integer,
  Dst integer,
  Interval integer,
  IntervalType integer,
  SimulationDays integer,
  DayType text,
  EnvironmentPeriodIndex integer,
  WarmupFlag integer
);
create table ReportData (
  ReportDataIndex integer primary key,
  TimeIndex integer,
  ReportDataDictionaryIndex integer,
  Value real
);
insert into ReportDataDictionary values
  (10,0,'Variable','HVAC','Zone','Node A','System Node Temperature','Timestep','','C'),
  (11,0,'Variable','HVAC','Zone','Node A','System Node Mass Flow Rate','Timestep','','kg/s');
insert into Time values
  (1,2026,1,1,1,0,0,60,1,1,'Monday',1,0),
  (2,2026,1,1,2,0,0,60,1,1,'Monday',1,0);
insert into ReportData values
  (1,1,10,21.5),
  (2,2,10,22.0),
  (3,1,11,0.5),
  (4,2,11,0.7);
`;
  const setup = spawnSync('sqlite3', [db, schema], { encoding: 'utf8' });
  assert.equal(setup.status, 0, setup.stderr);

  const result = spawnSync(
    process.execPath,
    ['scripts/export-playback.mjs', db, '--out', out],
    { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' }
  );

  assert.equal(result.status, 0, result.stderr);
  const playback = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(playback.metadata.timeCount, 2);
  assert.equal(playback.metadata.seriesCount, 2);
  assert.deepEqual(playback.nodes['Node A'].temperature.values, [21.5, 22]);
  assert.deepEqual(playback.nodes['Node A'].massFlow.values, [0.5, 0.7]);
  assert.equal(playback.times[0].label, '2026-01-01 01:00');
});
