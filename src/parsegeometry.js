// Minimal epJSON geometry reader for the 3D zone view.
//
// EnergyPlus epJSON appears in two vertex shapes depending on object:
//   vertices: [{ vertex_x_coordinate, ... }]
//   vertex_1_x_coordinate, vertex_1_y_coordinate, ...
//
// This parser normalizes both into world coordinates and groups building
// surfaces by zone. It intentionally stays renderer-neutral so it can be
// tested in Node and later moved behind a topology/geometry data boundary.

export function parseEpjsonGeometry(epjson) {
  const geometryRules = firstObject(epjson.GlobalGeometryRules) || {};
  const coordinateSystem = geometryRules.coordinate_system || 'Relative';
  const relative = String(coordinateSystem).toLowerCase() !== 'world';
  const zones = epjson.Zone || {};
  const surfaces = epjson['BuildingSurface:Detailed'] || {};
  const byZone = {};
  const allVertices = [];

  for (const [name, surface] of Object.entries(surfaces)) {
    const zoneName = surface.zone_name;
    if (!zoneName) continue;
    const rawVertices = readSurfaceVertices(surface);
    if (rawVertices.length < 3) continue;

    const zone = zones[zoneName] || {};
    const vertices = rawVertices.map(v =>
      relative ? applyZoneTransform(v, zone) : v
    );
    allVertices.push(...vertices);
    if (!byZone[zoneName]) {
      byZone[zoneName] = {
        name: zoneName,
        origin: vectorFromZone(zone),
        multiplier: numberOr(zone.multiplier, 1),
        surfaces: [],
        bounds: emptyBounds()
      };
    }
    const item = {
      name,
      type: surface.surface_type || '',
      construction: surface.construction_name || '',
      outsideBoundary: surface.outside_boundary_condition || '',
      vertices,
      bounds: boundsFor(vertices)
    };
    byZone[zoneName].surfaces.push(item);
    expandBounds(byZone[zoneName].bounds, item.bounds);
  }

  return {
    coordinateSystem,
    zones: Object.values(byZone).sort((a, b) => a.name.localeCompare(b.name)),
    bounds: boundsFor(allVertices)
  };
}

function firstObject(obj) {
  if (!obj) return null;
  return Object.values(obj)[0] || null;
}

function readSurfaceVertices(surface) {
  if (Array.isArray(surface.vertices)) {
    return surface.vertices
      .map(v => ({
        x: numberOr(v.vertex_x_coordinate, NaN),
        y: numberOr(v.vertex_y_coordinate, NaN),
        z: numberOr(v.vertex_z_coordinate, NaN)
      }))
      .filter(isFiniteVector);
  }

  const count = Number(surface.number_of_vertices) || 0;
  const vertices = [];
  for (let i = 1; i <= count; i++) {
    const v = {
      x: numberOr(surface[`vertex_${i}_x_coordinate`], NaN),
      y: numberOr(surface[`vertex_${i}_y_coordinate`], NaN),
      z: numberOr(surface[`vertex_${i}_z_coordinate`], NaN)
    };
    if (isFiniteVector(v)) vertices.push(v);
  }
  return vertices;
}

function applyZoneTransform(v, zone) {
  const origin = vectorFromZone(zone);
  const degrees = numberOr(zone.direction_of_relative_north, 0);
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return {
    x: origin.x + v.x * cos - v.y * sin,
    y: origin.y + v.x * sin + v.y * cos,
    z: origin.z + v.z
  };
}

function vectorFromZone(zone) {
  return {
    x: numberOr(zone.x_origin, 0),
    y: numberOr(zone.y_origin, 0),
    z: numberOr(zone.z_origin, 0)
  };
}

function numberOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function isFiniteVector(v) {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

function emptyBounds() {
  return {
    min: { x: Infinity, y: Infinity, z: Infinity },
    max: { x: -Infinity, y: -Infinity, z: -Infinity }
  };
}

function boundsFor(vertices) {
  const bounds = emptyBounds();
  for (const v of vertices) {
    bounds.min.x = Math.min(bounds.min.x, v.x);
    bounds.min.y = Math.min(bounds.min.y, v.y);
    bounds.min.z = Math.min(bounds.min.z, v.z);
    bounds.max.x = Math.max(bounds.max.x, v.x);
    bounds.max.y = Math.max(bounds.max.y, v.y);
    bounds.max.z = Math.max(bounds.max.z, v.z);
  }
  if (vertices.length === 0) {
    bounds.min = { x: 0, y: 0, z: 0 };
    bounds.max = { x: 0, y: 0, z: 0 };
  }
  return bounds;
}

function expandBounds(bounds, other) {
  bounds.min.x = Math.min(bounds.min.x, other.min.x);
  bounds.min.y = Math.min(bounds.min.y, other.min.y);
  bounds.min.z = Math.min(bounds.min.z, other.min.z);
  bounds.max.x = Math.max(bounds.max.x, other.max.x);
  bounds.max.y = Math.max(bounds.max.y, other.max.y);
  bounds.max.z = Math.max(bounds.max.z, other.max.z);
}

