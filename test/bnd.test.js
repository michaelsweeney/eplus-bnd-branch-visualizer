import test from 'node:test';
import assert from 'node:assert/strict';

import { parseBnd } from '../src/parsebnd.js';
import { buildGraph } from '../src/buildgraph.js';
import { computeSystemLayout } from '../src/layoutbnd.js';

const fixture = `
! Node,Number,Node Name,Fluid Type,References
Node,1,Plant Supply Inlet,Water,1
Node,2,Plant Supply Outlet,Water,2
Node,3,Coil Water Inlet,Water,2
Node,4,Coil Water Outlet,Water,2
Node,5,AHU Inlet,Air,1
Node,6,AHU Outlet,Air,2
Node,7,Zone Supply,Air,2
Node,8,Zone Return,Air,2
! Branch List,Number,Branch List Name,Loop Name,Loop Type
Branch List,1,Plant Supply Branches,Heating Loop,Plant
! Branch,Number,Branch Name,Loop Name,Loop Type,Inlet Node Name,Outlet Node Name
Branch,1,Plant Supply Branch,Heating Loop,Plant,Plant Supply Inlet,Plant Supply Outlet
Branch,2,Air Branch,Main Air Loop,Air,AHU Inlet,AHU Outlet
! Plant Loop,Loop Name,Loop Side,Loop Side Inlet Node Name,Loop Side Outlet Node Name,Branch List Name,Connector List Name
Plant Loop,Heating Loop,Supply,Plant Supply Inlet,Plant Supply Outlet,Plant Supply Branches,Plant Connectors
! AirLoopHVAC,AirLoop Name,Controller List,Availability Manager List,Design Supply Air Flow Rate,Branch List Name,Connector List Name,Outdoor Air Used
AirLoopHVAC,Main Air Loop,,,,,Yes
! Component Set,Number,Parent Object Type,Parent Object Name,Component Object Type,Component Object Name,Inlet Node Name,Outlet Node Name,Description
Component Set,1,BRANCH,Plant Supply Branch,Pump:VariableSpeed,HW Pump,Plant Supply Inlet,Coil Water Inlet,
Component Set,2,BRANCH,Plant Supply Branch,Coil:Heating:Water,Heating Coil,Coil Water Inlet,Coil Water Outlet,
Component Set,3,BRANCH,Air Branch,Fan:VariableVolume,Supply Fan,AHU Inlet,AHU Outlet,
Component Set,4,BRANCH,Air Branch,Coil:Heating:Water,Heating Coil,AHU Outlet,Zone Supply,
! Controlled Zone,Zone Name,Zone Equipment List Name,Zone Equipment List Index,Zone Node Name
Controlled Zone,Office Zone,Office Zone Equipment,1,Office Zone Node
! Controlled Zone Inlet,Number,Zone Name,Supply Air Inlet Node Name
Controlled Zone Inlet,1,Office Zone,Zone Supply
! Controlled Zone Return,Number,Zone Name,Return Air Node Name
Controlled Zone Return,1,Office Zone,Zone Return
! Zone Equipment List,Number,Zone Equipment List Name,Zone Name
Zone Equipment List,1,Office Zone Equipment,Office Zone
! Parent Node Connection,Node Name,Object Type,Object Name,Connection Type,Fluid Stream,Is Parent
Parent Node Connection,Zone Supply,ZONE,Office Zone,Inlet,1,Yes
Parent Node Connection,Zone Return,ZONE,Office Zone,Outlet,1,Yes
`;

test('parseBnd reads core BND records', () => {
  const model = parseBnd(fixture);

  assert.equal(model.nodes['Zone Supply'].fluidType, 'Air');
  assert.equal(model.componentSets.length, 4);
  assert.equal(model.loops[0].name, 'Heating Loop');
  assert.equal(model.controlledZones[0].name, 'Office Zone');
});

test('buildGraph connects components through shared EnergyPlus nodes', () => {
  const graph = buildGraph(parseBnd(fixture));
  const edgeLabels = graph.elements.filter(e => e.data.source).map(e => e.data.label);

  assert.ok(graph.vertices['Fan:VariableVolume|Supply Fan']);
  assert.ok(graph.vertices['ZONE|Office Zone']);
  assert.ok(edgeLabels.includes('Coil Water Inlet'));
  assert.ok(edgeLabels.includes('Zone Supply'));
});

test('computeSystemLayout returns deterministic positions for leaf vertices', () => {
  const model = parseBnd(fixture);
  const graph = buildGraph(model);
  const first = computeSystemLayout(model, graph);
  const second = computeSystemLayout(model, graph);

  assert.deepEqual(first.positions, second.positions);
  assert.equal(first.colOf['ZONE|Office Zone'], 3);
  assert.equal(first.bandOf['Fan:VariableVolume|Supply Fan'], 'Main Air Loop');
});
