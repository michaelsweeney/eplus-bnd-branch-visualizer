import test from 'node:test';
import assert from 'node:assert/strict';

import { parseEpjsonGeometry } from '../src/parsegeometry.js';

test('parseEpjsonGeometry groups detailed surfaces by zone', () => {
  const geometry = parseEpjsonGeometry({
    GlobalGeometryRules: {
      Rules: { coordinate_system: 'Relative' }
    },
    Zone: {
      ZoneA: {
        x_origin: 10,
        y_origin: 20,
        z_origin: 3,
        direction_of_relative_north: 0
      }
    },
    'BuildingSurface:Detailed': {
      WallA: {
        zone_name: 'ZoneA',
        surface_type: 'Wall',
        vertices: [
          { vertex_x_coordinate: 0, vertex_y_coordinate: 0, vertex_z_coordinate: 0 },
          { vertex_x_coordinate: 1, vertex_y_coordinate: 0, vertex_z_coordinate: 0 },
          { vertex_x_coordinate: 1, vertex_y_coordinate: 0, vertex_z_coordinate: 2 },
          { vertex_x_coordinate: 0, vertex_y_coordinate: 0, vertex_z_coordinate: 2 }
        ]
      }
    }
  });

  assert.equal(geometry.zones.length, 1);
  assert.equal(geometry.zones[0].name, 'ZoneA');
  assert.equal(geometry.zones[0].surfaces[0].vertices[0].x, 10);
  assert.equal(geometry.zones[0].surfaces[0].vertices[0].y, 20);
  assert.equal(geometry.zones[0].surfaces[0].vertices[0].z, 3);
  assert.deepEqual(geometry.bounds.max, { x: 11, y: 20, z: 5 });
});

test('parseEpjsonGeometry reads numbered vertex fields and relative north', () => {
  const geometry = parseEpjsonGeometry({
    Zone: {
      Rotated: {
        x_origin: 0,
        y_origin: 0,
        z_origin: 0,
        direction_of_relative_north: 90
      }
    },
    'BuildingSurface:Detailed': {
      Floor: {
        zone_name: 'Rotated',
        surface_type: 'Floor',
        number_of_vertices: 3,
        vertex_1_x_coordinate: 1,
        vertex_1_y_coordinate: 0,
        vertex_1_z_coordinate: 0,
        vertex_2_x_coordinate: 1,
        vertex_2_y_coordinate: 1,
        vertex_2_z_coordinate: 0,
        vertex_3_x_coordinate: 0,
        vertex_3_y_coordinate: 1,
        vertex_3_z_coordinate: 0
      }
    }
  });

  const first = geometry.zones[0].surfaces[0].vertices[0];
  assert.ok(Math.abs(first.x) < 1e-12);
  assert.ok(Math.abs(first.y - 1) < 1e-12);
});
