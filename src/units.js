// Derives collapsible "unit" membership for graph vertices from explicit
// .bnd structure only:
//
//   AHU            = components on an air loop's branches (E+ has no AHU
//                    object; the air loop supply side IS the unit)
//   plant side     = components on a plant/condenser loop side's branches
//   distribution   = supply/return air path components per air loop
//   zone equipment = components on a zone's equipment list
//
// Containment (Component Set parentage) wins over branch membership: a
// reheat coil inside an air terminal belongs to the terminal's unit, and
// its hot-water demand branch is left as wiring (a boundary edge after
// collapse). Zones themselves are never unit members.
function assignUnits(model, graph) {
  const vertices = graph.vertices;
  const units = {};
  const unitOf = {};
  const ensureUnit = (id, type, label) =>
    units[id] || (units[id] = { id, type, label, members: [] });

  const branchInfo = {}; // branch name -> {loopName, loopType}
  for (const b of model.branches) branchInfo[b.name] = b;

  const airPathLoop = {}; // vertex id -> air loop name
  for (const p of model.airPaths)
    for (const c of p.components) airPathLoop[`${c.type}|${c.name}`] = p.airLoop;

  const zoneOf = {}; // vertex id -> zone name
  for (const l of model.zoneEquipLists)
    for (const c of l.components) zoneOf[`${c.type}|${c.name}`] = l.zone;

  const connSide = {}; // vertex id -> {loopName, loopSide}
  for (const c of model.connectors)
    connSide[`CONNECTOR:${c.type.toUpperCase()}|${c.name}`] = c;

  // id is loop+side only: branch records say "Condenser Demand" where
  // connector records say kind=Condenser side=Demand — same unit
  const loopUnit = (loopName, loopType) => {
    if (loopType === 'Air') return ensureUnit(`unit|AHU|${loopName}`, 'ahu', loopName);
    const side = (loopType.split(' ')[1] || 'loop').toLowerCase();
    return ensureUnit(
      `unit|SIDE|${loopName}|${side}`,
      'plant',
      `${loopName} · ${side}`
    );
  };

  const baseUnit = v => {
    if (v.type === 'ZONE') return null;
    if (airPathLoop[v.id]) {
      const loop = airPathLoop[v.id];
      return ensureUnit(`unit|DIST|${loop}`, 'dist', `${loop} · distribution`);
    }
    if (v.branch && branchInfo[v.branch]) {
      const { loopName, loopType } = branchInfo[v.branch];
      return loopUnit(loopName, loopType);
    }
    if (connSide[v.id]) {
      const { loopName, loopSide } = connSide[v.id];
      const kind = graph.loopKind[loopName];
      if (kind === 'Air') return ensureUnit(`unit|DIST|${loopName}`, 'dist', `${loopName} · distribution`);
      if (kind) return loopUnit(loopName, `${kind} ${loopSide}`);
    }
    if (zoneOf[v.id]) {
      const zone = zoneOf[v.id];
      return ensureUnit(`unit|ZEQ|${zone}`, 'zoneeq', `${zone} · equipment`);
    }
    return null;
  };

  // containment-first: walk to the outermost container vertex, take its
  // unit; an unattributable container keeps its children unitless too,
  // so a unit never splits a containment family
  const resolve = v => {
    let cur = v;
    const seen = new Set();
    while (cur.group && vertices[cur.group] && !seen.has(cur.group)) {
      seen.add(cur.group);
      cur = vertices[cur.group];
    }
    return baseUnit(cur);
  };

  for (const v of Object.values(vertices)) {
    const unit = resolve(v);
    if (!unit) continue;
    unitOf[v.id] = unit.id;
    unit.members.push(v.id);
  }
  return { units, unitOf };
}

if (typeof module !== 'undefined') module.exports = { assignUnits };
