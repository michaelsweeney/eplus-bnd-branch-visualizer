import test from 'node:test';
import assert from 'node:assert/strict';
import { decimatePlayback } from '../scripts/decimate-playback.mjs';

const playback = {
  metadata: { timeCount: 6, seriesCount: 2 },
  times: [0, 1, 2, 3, 4, 5].map(i => ({ timeIndex: i + 1, month: 1, label: `t${i}` })),
  nodes: {
    'NODE A': {
      temperature: { units: 'C', values: [1.123456, 2.987654, null, 4.5, 5.000001, 6.4999] },
      massFlow: { units: 'kg/s', values: [0.000123, 0.1, 0.2, 0.3, 0.4, 0.5] }
    }
  },
  zones: {
    'ZONE 1': { temperature: { units: 'C', values: [20.111111, 21, 22, 23, 24, 25] } }
  }
};

test('decimatePlayback keeps every Nth timestep across times and all series', () => {
  const out = decimatePlayback(playback, { every: 2, round: 3 });
  assert.equal(out.times.length, 3);
  assert.deepEqual(out.times.map(t => t.label), ['t0', 't2', 't4']);
  assert.deepEqual(out.nodes['NODE A'].temperature.values, [1.123, null, 5]);
  assert.deepEqual(out.nodes['NODE A'].massFlow.values, [0, 0.2, 0.4]);
  assert.deepEqual(out.zones['ZONE 1'].temperature.values, [20.111, 22, 24]);
  assert.equal(out.metadata.timeCount, 3);
  assert.deepEqual(out.metadata.decimation, { every: 2, round: 3, originalTimeCount: 6 });
});

test('decimatePlayback preserves series metadata and rounds without float junk', () => {
  const out = decimatePlayback(playback, { every: 1, round: 2 });
  assert.equal(out.nodes['NODE A'].temperature.units, 'C');
  assert.equal(out.times.length, 6);
  assert.equal(JSON.stringify(out.nodes['NODE A'].temperature.values), '[1.12,2.99,null,4.5,5,6.5]');
});
