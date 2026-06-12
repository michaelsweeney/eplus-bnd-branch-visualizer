const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('prep-epjson injects node outputs and sqlite output', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bnd-prep-'));
  const input = path.join(dir, 'model.epJSON');
  const output = path.join(dir, 'model.prepped.epJSON');
  fs.writeFileSync(
    input,
    JSON.stringify({
      Version: {
        Version_1: {
          version_identifier: '25.2'
        }
      }
    })
  );

  const result = spawnSync(
    process.execPath,
    ['scripts/prep-epjson.mjs', input, '--out', output],
    { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' }
  );

  assert.equal(result.status, 0, result.stderr);
  const patched = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(
    patched['Output:SQLite'].BNDPrepOutputSQLite.option_type,
    'SimpleAndTabular'
  );
  const variables = Object.values(patched['Output:Variable']);
  assert.ok(variables.some(v => v.variable_name === 'System Node Temperature'));
  assert.ok(variables.some(v => v.variable_name === 'System Node Mass Flow Rate'));
});

test('prep-epjson converts IDF input before patching outputs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bnd-prep-idf-'));
  const input = path.join(dir, 'model.idf');
  const output = path.join(dir, 'model.prepped.epJSON');
  const root = path.join(dir, 'energyplus');
  const binDir = path.join(root, '25.2');
  const converter = path.join(binDir, 'ConvertInputFormat');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(input, 'Version, 25.2;\n');
  fs.writeFileSync(
    converter,
    `#!/bin/sh
idf="$2"
out="\${idf%.idf}.epJSON"
cat > "$out" <<'JSON'
{"Version":{"Version 1":{"version_identifier":"25.2"}}}
JSON
`
  );
  fs.chmodSync(converter, 0o755);

  const result = spawnSync(
    process.execPath,
    ['scripts/prep-epjson.mjs', input, '--out', output, '--energyplus-root', root],
    { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' }
  );

  assert.equal(result.status, 0, result.stderr);
  const patched = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.ok(patched['Output:Variable']);
  assert.equal(
    patched['Output:SQLite'].BNDPrepOutputSQLite.option_type,
    'SimpleAndTabular'
  );
});
