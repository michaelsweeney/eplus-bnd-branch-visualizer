const test = require('node:test');
const assert = require('node:assert/strict');
const { assignUnits } = require('../src/units');

// Minimal model/graph shapes: an air loop branch with a fan, a VAV
// terminal (zone equipment, containing a reheat coil that also sits on a
// plant demand branch), a plant supply pump, an air path splitter, and
// the zone itself.
function fixture() {
  const model = {
    branches: [
      { name: 'MAIN BRANCH', loopName: 'VAV_1', loopType: 'Air' },
      { name: 'REHEAT BRANCH', loopName: 'HEATSYS1', loopType: 'Plant Demand' },
      { name: 'PUMP BRANCH', loopName: 'HEATSYS1', loopType: 'Plant Supply' }
    ],
    airPaths: [
      { airLoop: 'VAV_1', components: [{ type: 'AIRLOOPHVAC:ZONESPLITTER', name: 'SPLITTER 1' }] }
    ],
    zoneEquipLists: [
      { zone: 'CORE_ZN', components: [{ type: 'ZONEHVAC:AIRDISTRIBUTIONUNIT', name: 'ADU 1' }] }
    ],
    connectors: [
      { type: 'Splitter', name: 'HW SPLIT', loopName: 'HEATSYS1', loopSide: 'Supply' }
    ]
  };
  const vertices = {
    'FAN:VARIABLEVOLUME|FAN 1': {
      id: 'FAN:VARIABLEVOLUME|FAN 1', type: 'FAN:VARIABLEVOLUME', name: 'FAN 1',
      group: 'loop|VAV_1', branch: 'MAIN BRANCH'
    },
    'ZONEHVAC:AIRDISTRIBUTIONUNIT|ADU 1': {
      id: 'ZONEHVAC:AIRDISTRIBUTIONUNIT|ADU 1', type: 'ZONEHVAC:AIRDISTRIBUTIONUNIT',
      name: 'ADU 1', group: 'zones', zone: 'CORE_ZN'
    },
    'AIRTERMINAL:SINGLEDUCT:VAV:REHEAT|TERMINAL 1': {
      id: 'AIRTERMINAL:SINGLEDUCT:VAV:REHEAT|TERMINAL 1',
      type: 'AIRTERMINAL:SINGLEDUCT:VAV:REHEAT', name: 'TERMINAL 1',
      group: 'ZONEHVAC:AIRDISTRIBUTIONUNIT|ADU 1'
    },
    // contained in the terminal but also on a plant demand branch:
    // containment must win
    'COIL:HEATING:WATER|REHEAT COIL 1': {
      id: 'COIL:HEATING:WATER|REHEAT COIL 1', type: 'COIL:HEATING:WATER',
      name: 'REHEAT COIL 1',
      group: 'AIRTERMINAL:SINGLEDUCT:VAV:REHEAT|TERMINAL 1', branch: 'REHEAT BRANCH'
    },
    'PUMP:VARIABLESPEED|HW PUMP': {
      id: 'PUMP:VARIABLESPEED|HW PUMP', type: 'PUMP:VARIABLESPEED', name: 'HW PUMP',
      group: 'loop|HEATSYS1', branch: 'PUMP BRANCH'
    },
    'AIRLOOPHVAC:ZONESPLITTER|SPLITTER 1': {
      id: 'AIRLOOPHVAC:ZONESPLITTER|SPLITTER 1', type: 'AIRLOOPHVAC:ZONESPLITTER',
      name: 'SPLITTER 1', group: 'loop|VAV_1'
    },
    'CONNECTOR:SPLITTER|HW SPLIT': {
      id: 'CONNECTOR:SPLITTER|HW SPLIT', type: 'CONNECTOR:SPLITTER', name: 'HW SPLIT',
      group: 'loop|HEATSYS1'
    },
    'ZONE|CORE_ZN': { id: 'ZONE|CORE_ZN', type: 'ZONE', name: 'CORE_ZN', group: 'zones' }
  };
  return { model, graph: { vertices, loopKind: { VAV_1: 'Air', HEATSYS1: 'Plant' } } };
}

test('assignUnits groups by air loop, plant side, air path, and zone equipment', () => {
  const { model, graph } = fixture();
  const { units, unitOf } = assignUnits(model, graph);

  assert.equal(unitOf['FAN:VARIABLEVOLUME|FAN 1'], 'unit|AHU|VAV_1');
  assert.equal(unitOf['PUMP:VARIABLESPEED|HW PUMP'], 'unit|SIDE|HEATSYS1|supply');
  assert.equal(unitOf['AIRLOOPHVAC:ZONESPLITTER|SPLITTER 1'], 'unit|DIST|VAV_1');
  // connector records say kind=Plant side=Supply; branch records say
  // "Plant Supply" — both must land in the SAME unit
  assert.equal(unitOf['CONNECTOR:SPLITTER|HW SPLIT'], 'unit|SIDE|HEATSYS1|supply');
  assert.equal(unitOf['ZONE|CORE_ZN'], undefined);
  assert.equal(units['unit|AHU|VAV_1'].type, 'ahu');
  assert.equal(units['unit|AHU|VAV_1'].members.length, 1);
});

test('assignUnits resolves containment over branch membership', () => {
  const { model, graph } = fixture();
  const { unitOf } = assignUnits(model, graph);

  // ADU is zone equipment; terminal and reheat coil are inside it, so the
  // whole family lands in the zone-equipment unit — the coil's plant
  // demand branch must NOT pull it into the plant loop
  assert.equal(unitOf['ZONEHVAC:AIRDISTRIBUTIONUNIT|ADU 1'], 'unit|ZEQ|CORE_ZN');
  assert.equal(unitOf['AIRTERMINAL:SINGLEDUCT:VAV:REHEAT|TERMINAL 1'], 'unit|ZEQ|CORE_ZN');
  assert.equal(unitOf['COIL:HEATING:WATER|REHEAT COIL 1'], 'unit|ZEQ|CORE_ZN');
});
