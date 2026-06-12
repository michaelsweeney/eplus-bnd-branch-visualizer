import cytoscape from 'cytoscape';
import cytoscapeFcose from 'cytoscape-fcose';
import * as THREE from 'three';
import { parseBnd } from './parsebnd.js';
import { buildGraph } from './buildgraph.js';
import { computeSystemLayout, assignLoopLanes } from './layoutbnd.js';
import { parseEpjsonGeometry } from './parsegeometry.js';
import { assignUnits } from './units.js';
import './app.css';

cytoscape.use(cytoscapeFcose);


let cy = null;
let model = null;
let graph = null;
let geometry = null;
let epjsonRaw = null;
let threeView = null;
let playback = null;
let playbackStats = null;
let playbackZonesUpper = null; // UPPER(zone) -> { key, series } (SQL uppercases keys)
let playTimer = null;
let dashRaf = null;
let selectedTimeIndex = 0;
let currentMetric = 'system';
let loopFunctionColors = null; // loopName -> hex, from classifyLoops()
let currentTheme = 'pro';
let units = null;             // { units, unitOf } from assignUnits
let collapsedSet = new Set(); // unit ids currently collapsed
// one selection drives every view: {kind:'zone'|'vertex'|'edge', ...}
let selection = null;

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const upper = s => String(s ?? '').toUpperCase();

/* ── loading ─────────────────────────────────────────────────── */

// #sel=<zone name> applies once the graph is up (used by demo links + smoke tests)
function maybeApplyHashSelection() {
  if (maybeApplyHashSelection.done || !cy) return;
  const zoneName = new URLSearchParams(location.hash.replace(/^#/, '')).get('sel');
  if (!zoneName) { maybeApplyHashSelection.done = true; return; }
  maybeApplyHashSelection.done = true;
  selectZone(zoneName);
}

function loadText(name, text) {
  model = parseBnd(text);
  graph = buildGraph(model);
  units = assignUnits(model, graph);
  collapsedSet = defaultCollapsedSet();
  for (const el of graph.elements)
    if (!el.data.source) el.data.origParent = el.data.parent || null;
  if (graph.elements.length === 0) {
    $('graphEmpty').textContent = `${name}: no HVAC topology in this .bnd`;
    if (cy) { cy.destroy(); cy = null; }
    clearSelection();
    return;
  }
  $('graphEmpty').style.display = 'none';

  const loops = [...new Set(
    graph.elements.filter(e => e.data.isGroup && e.data.id.startsWith('loop|')).map(e => e.data.label)
  )].sort();
  $('loopFilter').innerHTML = '<option value="">all loops</option>' +
    loops.map(l => `<option>${esc(l)}</option>`).join('');

  classifyLoops();
  createCy(buildDisplayElements());
  applyLayout();
  updateDatasetChip(name);
  applyPlaybackToGraph();
  renderSystemsTree();
  maybeApplyHashSelection();
}

function createCy(elements) {
  if (cy) cy.destroy();
  cy = cytoscape({
    container: $('cy'),
    elements,
    wheelSensitivity: 0.2,
    style: buildCyStyle(currentTheme),
    layout: { name: 'preset' }
  });
  cy.on('tap', 'node', e => onGraphNodeTap(e.target));
  cy.on('tap', 'edge', e => onGraphEdgeTap(e.target));
  cy.on('tap', e => { if (e.target === cy) clearSelection(); });
  cy.on('dbltap', 'node', e => onGraphNodeDblTap(e.target));
}

/* ── component icons ─────────────────────────────────────────── */
// Type-prefix -> schematic glyph. Pure object-class rendering, no
// inference; unknown prefixes keep the plain block.
const ICON_SHAPES = {
  fan: '<circle cx="12" cy="12" r="9"/><path d="M12 12 Q16 6 20 10 M12 12 Q10 19 5 16 M12 12 Q6 8 9 4"/>',
  coil: '<rect x="3" y="5" width="18" height="14"/><path d="M9 5 7 19 M15 5 13 19 M21 5 19 19"/>',
  pump: '<circle cx="12" cy="12" r="9"/><path d="M9 7l8 5-8 5z"/>',
  chiller: '<rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="8.5" cy="12" r="2.8"/><circle cx="15.5" cy="12" r="2.8"/>',
  boiler: '<rect x="5" y="4" width="14" height="16" rx="2"/><path d="M12 8c2.5 3.5-2.5 3.5 0 7"/>',
  tower: '<path d="M7 20 L8.5 9 H15.5 L17 20 Z"/><circle cx="12" cy="6" r="2.6"/>',
  terminal: '<rect x="3" y="7" width="18" height="10"/><path d="M7 16l5-8"/>',
  humidifier: '<path d="M12 4c4 5 6 7.5 6 10.5a6 6 0 1 1-12 0C6 11.5 8 9 12 4z"/>',
  oa: '<rect x="3" y="5" width="18" height="14"/><path d="M6 9h12M6 12h12M6 15h12"/>',
  hx: '<rect x="3" y="5" width="18" height="14"/><path d="M7 9l10 6M7 15l10-6"/>',
  plenum: '<rect x="3" y="9" width="18" height="6"/><path d="M7 9V5M12 9V5M17 9V5"/>',
  pipe: '<path d="M3 12h18M7 9v6M17 9v6"/>',
  unitary: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="12" r="3"/><path d="M15 8l4 8M19 8l-4 8"/>',
  tank: '<rect x="6" y="4" width="12" height="16" rx="4"/><path d="M9 9h6"/>',
  ahu: '<rect x="2" y="5" width="20" height="14" rx="1"/><circle cx="8" cy="12" r="3.4"/><path d="M14 6.5 12.5 17.5 M18 6.5 16.5 17.5"/>',
  plant: '<rect x="2" y="5" width="20" height="14" rx="1"/><circle cx="7.5" cy="12" r="3"/><path d="M13 9c2 2.5-2 2.5 0 5M17.5 9c2 2.5-2 2.5 0 5"/>',
  dist: '<path d="M3 12h6m0 0 8-6m-8 6 8 0m-8 0 8 6M17 4v4M17 10v4M17 16v4"/>',
  zoneeq: '<rect x="3" y="8" width="13" height="9"/><path d="M16 12h5M6 17v3h8v-3"/>'
};
function iconUri(kind, stroke) {
  const body = ICON_SHAPES[kind];
  if (!body) return null;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">` +
    `<g fill="none" stroke="${stroke}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${body}</g></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
const ICON_RULES = [
  ['FAN', 'fan'], ['COIL:COOLING', 'coil'], ['COIL:HEATING', 'coil'], ['COIL', 'coil'],
  ['PUMP', 'pump'], ['CHILLER', 'chiller'], ['BOILER', 'boiler'], ['COOLINGTOWER', 'tower'],
  ['FLUIDCOOLER', 'tower'], ['AIRTERMINAL', 'terminal'], ['ZONEHVAC:AIRDISTRIBUTIONUNIT', 'terminal'],
  ['HUMIDIFIER', 'humidifier'], ['AIRLOOPHVAC:OUTDOORAIRSYSTEM', 'oa'], ['OUTDOORAIR:MIXER', 'oa'],
  ['HEATEXCHANGER', 'hx'], ['AIRLOOPHVAC:RETURNPLENUM', 'plenum'], ['AIRLOOPHVAC:SUPPLYPLENUM', 'plenum'],
  ['PIPE', 'pipe'], ['AIRLOOPHVAC:UNITARY', 'unitary'], ['WATERHEATER', 'tank'],
  ['ZONEHVAC', 'zoneeq']
];

function buildCyStyle(theme) {
  const mario = theme === 'mario';
  const stroke = mario ? '#173568' : '#aebdd3';
  const c = mario ? {
    nodeBg: '#fff5d8', nodeBorder: '#173568', label: '#173568',
    zoneBg: '#fbd000', zoneBorder: '#7c2d05', zoneLabel: '#5c2d05',
    groupBorder: '#2a4a9e', groupLabel: '#1a2a6a',
    edge: '#888', air: '#e8eef8', water: '#43b047', crossover: '#e52521',
    sel: '#e52521', linked: '#fbd000',
    font: "'Press Start 2P', monospace", fontSize: 5.5
  } : {
    nodeBg: '#1a2230', nodeBorder: '#4d6076', label: '#7c8aa0',
    zoneBg: '#5a4a2e', zoneBorder: '#8a6a35', zoneLabel: '#a99263',
    groupBorder: '#2b3546', groupLabel: '#56647c',
    edge: '#39455a', air: '#3a7a5c', water: '#3d6390', crossover: '#7c4a4a',
    sel: '#ffc66b', linked: '#ffc66b',
    font: 'IBM Plex Mono, monospace', fontSize: 9
  };
  const style = [
    { selector: 'node', style: {
        label: 'data(label)', 'font-size': c.fontSize, width: 26, height: 26,
        'font-family': c.font, shape: 'round-rectangle',
        'text-valign': 'bottom', 'text-margin-y': 3, 'text-wrap': 'wrap', 'text-max-width': 110,
        color: c.label, 'background-color': c.nodeBg,
        'border-width': 1, 'border-color': c.nodeBorder,
        'background-fit': 'contain', 'background-clip': 'none'
    }}
  ];
  for (const [prefix, kind] of ICON_RULES) {
    style.push({ selector: `node[type ^= "${prefix}"]`, style: { 'background-image': iconUri(kind, stroke) } });
  }
  style.push(
    { selector: 'node[?isZone]', style: {
        shape: 'round-rectangle', 'background-color': c.zoneBg, 'border-color': c.zoneBorder,
        'border-width': mario ? 2 : 1, width: 34, height: 24, color: c.zoneLabel,
        'background-image': null
    }},
    { selector: 'node[type^="CONNECTOR"], node[type^="AIRLOOPHVAC:ZONESPLITTER"], node[type^="AIRLOOPHVAC:ZONEMIXER"]', style: {
        shape: 'diamond', width: 18, height: 18
    }},
    { selector: 'node[?isUnit]', style: {
        width: 52, height: 40, 'border-width': 2,
        label: el => `${el.data('label')}  [${el.data('memberCount')}]`,
        'font-weight': 'bold'
    }},
    { selector: 'node[unitType="ahu"]', style: { 'background-image': iconUri('ahu', stroke) } },
    { selector: 'node[unitType="plant"]', style: { 'background-image': iconUri('plant', stroke) } },
    { selector: 'node[unitType="dist"]', style: { 'background-image': iconUri('dist', stroke) } },
    { selector: 'node[unitType="zoneeq"]', style: { 'background-image': iconUri('zoneeq', stroke) } },
    { selector: ':parent', style: {
        'background-color': '#ffffff', 'background-opacity': mario ? 0.12 : 0.02,
        'border-color': c.groupBorder, 'border-width': 1, 'background-image': null,
        label: 'data(label)', 'font-size': c.fontSize + 1, 'font-weight': 'bold',
        'font-family': c.font,
        'text-valign': 'top', 'text-margin-y': -4, color: c.groupLabel
    }},
    { selector: 'edge', style: {
        width: 1.4, 'line-color': c.edge,
        'target-arrow-shape': 'none', 'curve-style': 'bezier',
        opacity: 0.75, 'line-cap': mario ? 'round' : 'butt'
    }},
    { selector: 'edge[fluid="Air"]', style: { 'line-color': c.air } },
    { selector: 'edge[fluid="Water"]', style: { 'line-color': c.water } },
    { selector: 'edge[kind="crossover"]', style: { 'line-style': 'dashed', 'line-color': c.crossover } },
    { selector: '.faded', style: { opacity: 0.08, 'text-opacity': 0.08 } },
    { selector: '.linked', style: {
        'underlay-color': c.linked, 'underlay-opacity': mario ? 0.4 : 0.18, 'underlay-padding': 5, 'z-index': 8
    }},
    { selector: 'node.linked', style: { 'border-color': c.linked } },
    { selector: '.sel', style: {
        'underlay-color': c.sel, 'underlay-opacity': mario ? 0.55 : 0.34, 'underlay-padding': 7, 'z-index': 9
    }},
    { selector: 'node.sel', style: { 'border-width': 2, 'border-color': c.sel } },
    { selector: 'edge.sel', style: { 'line-color': c.sel, opacity: 1 } },
    { selector: ':selected', style: { 'overlay-opacity': 0 } }
  );
  return style;
}

/* ── unit collapse / expand ──────────────────────────────────── */
// Stateless display rebuild: graph.elements is the ground truth; collapsed
// units are substituted by proxy nodes and boundary edges re-routed to
// them (deduped per node name). Avoids incremental remove/restore
// ordering bugs entirely.
function buildDisplayElements() {
  if (!units || collapsedSet.size === 0) return structuredClone(graph.elements);
  const proxyOf = id => {
    const u = units.unitOf[id];
    return u && collapsedSet.has(u) ? u : null;
  };
  const els = [];
  const keptNodeIds = new Set();
  const addedProxies = new Set();
  for (const el of graph.elements) {
    if (el.data.source || el.data.isGroup) continue;
    const proxy = proxyOf(el.data.id);
    if (!proxy) {
      keptNodeIds.add(el.data.id);
      els.push(structuredClone(el));
    } else if (!addedProxies.has(proxy)) {
      addedProxies.add(proxy);
      const u = units.units[proxy];
      els.push({ data: { id: u.id, label: u.label, isUnit: true, unitType: u.type, memberCount: u.members.length } });
    }
  }
  // groups: keep only those still referenced by a kept node (directly or
  // through a kept container chain); orphan parents are nulled
  const presentIds = new Set([...keptNodeIds, ...addedProxies]);
  for (const el of els) {
    if (el.data.parent && !presentIds.has(el.data.parent)) {
      const groupEl = graph.elements.find(g => g.data.id === el.data.parent && g.data.isGroup);
      if (groupEl) {
        if (![...els].some(x => x.data.id === groupEl.data.id)) els.push(structuredClone(groupEl));
        presentIds.add(groupEl.data.id);
      } else {
        el.data.parent = null;
      }
    }
  }
  const seenEdges = new Set();
  for (const el of graph.elements) {
    if (!el.data.source) continue;
    const s = proxyOf(el.data.source) || el.data.source;
    const t = proxyOf(el.data.target) || el.data.target;
    if (s === t || !presentIds.has(s) || !presentIds.has(t)) continue;
    const key = `${s}|${t}|${el.data.label}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    els.push({ data: { ...el.data, id: `d${seenEdges.size}`, source: s, target: t } });
  }
  return els;
}

function setCollapsed(nextSet) {
  if (!cy || !units) return;
  collapsedSet = nextSet;
  clearSelection();
  createCy(buildDisplayElements());
  applyLayout();
  applyPlaybackToGraph();
  renderSystemsTree();
}

// Default: zone equipment + distribution collapsed (repetitive per-zone
// noise), AHUs and plant sides expanded.
function defaultCollapsedSet() {
  return new Set(
    Object.values(units.units)
      .filter(u => u.type === 'zoneeq' || u.type === 'dist')
      .map(u => u.id)
  );
}

/* ── systems tree panel ──────────────────────────────────────── */
const SYS_SECTIONS = [['ahu', 'AIR LOOPS'], ['plant', 'PLANT'], ['dist', 'DISTRIBUTION'], ['zoneeq', 'ZONE EQUIPMENT']];
const sysSectionOpen = { ahu: true, plant: true, dist: true, zoneeq: false };

function renderSystemsTree() {
  const root = $('systemsTree');
  if (!units || !Object.keys(units.units).length) {
    root.innerHTML = '<span class="empty">no units</span>';
    return;
  }
  let html = '';
  for (const [type, title] of SYS_SECTIONS) {
    const list = Object.values(units.units)
      .filter(u => u.type === type)
      .sort((a, b) => a.label.localeCompare(b.label));
    if (!list.length) continue;
    const open = sysSectionOpen[type];
    html += `<div class="sysSection">
      <div class="sysHead">
        <button class="sysCaret" data-type="${type}">${open ? '▾' : '▸'}</button>
        <input type="checkbox" class="sysAll" data-type="${type}">
        <span class="sysTitle">${title}</span>
        <span class="sysCount">${list.length}</span>
      </div>
      <div class="sysList" data-type="${type}" style="display:${open ? 'block' : 'none'}">` +
      list.map(u => `
        <div class="sysRow${selection && selection.kind === 'unit' && selection.unitId === u.id ? ' selected' : ''}" data-unit="${esc(u.id)}">
          <input type="checkbox" class="sysBox" data-unit="${esc(u.id)}" ${collapsedSet.has(u.id) ? '' : 'checked'}>
          <span class="sysLabel" data-unit="${esc(u.id)}" title="${esc(u.label)} — click to select">${esc(u.label)}</span>
          <span class="sysCount">${u.members.length}</span>
        </div>`).join('') +
      '</div></div>';
  }
  root.innerHTML = html;

  for (const box of root.querySelectorAll('.sysBox')) {
    box.addEventListener('change', () => {
      const next = new Set(collapsedSet);
      if (box.checked) next.delete(box.dataset.unit);
      else next.add(box.dataset.unit);
      setCollapsed(next);
    });
  }
  for (const all of root.querySelectorAll('.sysAll')) {
    const type = all.dataset.type;
    const ids = Object.values(units.units).filter(u => u.type === type).map(u => u.id);
    const expanded = ids.filter(id => !collapsedSet.has(id)).length;
    all.checked = expanded === ids.length;
    all.indeterminate = expanded > 0 && expanded < ids.length;
    all.addEventListener('change', () => {
      const next = new Set(collapsedSet);
      for (const id of ids) {
        if (all.checked) next.delete(id);
        else next.add(id);
      }
      setCollapsed(next);
    });
  }
  for (const caret of root.querySelectorAll('.sysCaret')) {
    caret.addEventListener('click', () => {
      const type = caret.dataset.type;
      sysSectionOpen[type] = !sysSectionOpen[type];
      const list = root.querySelector(`.sysList[data-type="${type}"]`);
      list.style.display = sysSectionOpen[type] ? 'block' : 'none';
      caret.textContent = sysSectionOpen[type] ? '▾' : '▸';
    });
  }
  for (const label of root.querySelectorAll('.sysLabel')) {
    label.addEventListener('click', () => selectUnit(label.dataset.unit));
  }
}

function onGraphNodeDblTap(n) {
  const d = n.data();
  if (d.isUnit) {
    const next = new Set(collapsedSet);
    next.delete(d.id);
    setCollapsed(next);
  } else {
    const unitId = units && units.unitOf[d.id];
    if (!unitId) return;
    const next = new Set(collapsedSet);
    next.add(unitId);
    setCollapsed(next);
  }
}

function loadGeometry(name, text) {
  let epjson;
  try {
    epjson = JSON.parse(text);
  } catch (error) {
    $('zone3dEmpty').textContent = `${name}: could not parse epJSON (${error.message})`;
    geometry = null;
    return;
  }
  epjsonRaw = epjson;
  geometry = parseEpjsonGeometry(epjson);
  $('zone3dEmpty').style.display = 'none';
  renderZones3d();
  updateDatasetChip();
  maybeApplyHashSelection();
}

function loadPlayback(name, text) {
  try {
    playback = JSON.parse(text);
  } catch (error) {
    $('readoutValue').textContent = `bad playback JSON: ${error.message}`;
    playback = null;
    return;
  }
  const zones = Object.keys(playback.zones || {}).sort();
  playbackZonesUpper = new Map(zones.map(z => [upper(z), { key: z, series: playback.zones[z] }]));
  playbackStats = computePlaybackStats(playback);
  classifyLoops();
  selectedTimeIndex = 0;
  setPlaying(false);
  $('timeSlider').max = Math.max(0, (playback.times || []).length - 1);
  $('timeSlider').value = '0';
  buildMonthRuler();
  updateLegend();
  updateDatasetChip();
  updateTime();
}

function updateDatasetChip(bndName) {
  if (bndName) updateDatasetChip.bnd = bndName;
  const bits = [];
  if (updateDatasetChip.bnd) bits.push(`<b>${esc(updateDatasetChip.bnd.replace(/\.bnd$/i, ''))}</b>`);
  if (geometry) bits.push(`${geometry.zones.length} zones`);
  if (playback) bits.push(`${Object.keys(playback.nodes || {}).length} node series`);
  $('datasetChip').innerHTML = bits.length ? bits.join(' · ') : 'no dataset';
}

/* ── playback stats / scales ─────────────────────────────────── */

// Node temp scale uses clipped percentiles: stagnant-node artifacts (e.g.
// coil water outlets at zero flow reporting >1000 C) would otherwise flatten
// the whole heatmap. Ramp functions clamp, so outliers just saturate.
function computePlaybackStats(pb) {
  const stats = { tempMin: null, tempMax: null, flowMax: null, zoneMin: null, zoneMax: null };
  const nodeTemps = [];
  for (const node of Object.values(pb.nodes || {})) {
    if (node.temperature) {
      const values = node.temperature.values || [];
      const stride = Math.max(1, Math.ceil(values.length / 2000));
      for (let i = 0; i < values.length; i += stride) {
        if (Number.isFinite(values[i])) nodeTemps.push(values[i]);
      }
    }
    for (const v of (node.massFlow && node.massFlow.values) || []) {
      if (Number.isFinite(v) && (stats.flowMax == null || v > stats.flowMax)) stats.flowMax = v;
    }
  }
  // per-node peak flow over the run — the capacity proxy that sizes edges
  stats.nodePeaks = new Map();
  for (const [name, node] of Object.entries(pb.nodes || {})) {
    let peak = null;
    for (const v of (node.massFlow && node.massFlow.values) || []) {
      if (Number.isFinite(v) && (peak == null || v > peak)) peak = v;
    }
    if (peak != null) stats.nodePeaks.set(name, peak);
  }
  nodeTemps.sort((a, b) => a - b);
  if (nodeTemps.length) {
    const q = p => nodeTemps[Math.round(p * (nodeTemps.length - 1))];
    stats.tempMin = q(0.005);
    stats.tempMax = q(0.995);
  }
  for (const zone of Object.values(pb.zones || {})) {
    for (const v of (zone.temperature && zone.temperature.values) || []) {
      if (!Number.isFinite(v)) continue;
      if (stats.zoneMin == null || v < stats.zoneMin) stats.zoneMin = v;
      if (stats.zoneMax == null || v > stats.zoneMax) stats.zoneMax = v;
    }
  }
  return stats;
}

function zoneSeriesFor(zoneName) {
  const entry = playbackZonesUpper && playbackZonesUpper.get(upper(zoneName));
  return entry ? entry.series : null;
}

// "System" palette: loop function, not raw fluid. Air = amber; condenser
// water = green (explicit loop kind); plant water loops split hot (red)
// vs chilled (blue) by their operating regime in the playback data — the
// 90th-percentile node temperature on the loop — instead of guessing
// from loop names. Without playback, plant loops stay violet (unknown).
const SYSTEM_PALETTE = {
  air: '#d9a23b', chw: '#5b9bd9', hw: '#d65b4a', cw: '#46b380', other: '#8a7fb8'
};
function classifyLoops() {
  loopFunctionColors = {};
  if (!graph) return;
  const tempsByLoop = {};
  if (playback && playback.nodes) {
    for (const v of Object.values(graph.vertices)) {
      if (!v.group || !v.group.startsWith('loop|')) continue;
      const loop = v.group.slice(5);
      for (const p of v.pairs) {
        for (const nodeName of [p.inlet, p.outlet]) {
          const node = nodeName && playback.nodes[nodeName];
          if (!node || !node.temperature) continue;
          const arr = tempsByLoop[loop] || (tempsByLoop[loop] = []);
          const values = node.temperature.values;
          const stride = Math.max(1, Math.ceil(values.length / 200));
          for (let i = 0; i < values.length; i += stride)
            if (Number.isFinite(values[i])) arr.push(values[i]);
        }
      }
    }
  }
  for (const [loop, kind] of Object.entries(graph.loopKind || {})) {
    if (kind === 'Air') { loopFunctionColors[loop] = SYSTEM_PALETTE.air; continue; }
    if (kind === 'Condenser') { loopFunctionColors[loop] = SYSTEM_PALETTE.cw; continue; }
    const temps = tempsByLoop[loop];
    if (!temps || temps.length < 10) { loopFunctionColors[loop] = SYSTEM_PALETTE.other; continue; }
    temps.sort((a, b) => a - b);
    const p90 = temps[Math.round(0.9 * (temps.length - 1))];
    loopFunctionColors[loop] = p90 >= 35 ? SYSTEM_PALETTE.hw
      : p90 <= 18 ? SYSTEM_PALETTE.chw
      : SYSTEM_PALETTE.cw;
  }
}

function loopNameForGraphId(id) {
  const v = graph && graph.vertices[id];
  if (v && v.group && v.group.startsWith('loop|')) return v.group.slice(5);
  if (String(id).startsWith('unit|')) {
    const parts = id.split('|');
    if (parts[1] !== 'ZEQ') return parts[2];
  }
  return null;
}

function systemColorForEdge(edge) {
  if (edge.data('fluid') === 'Air') return SYSTEM_PALETTE.air;
  const loop = loopNameForGraphId(edge.data('source')) || loopNameForGraphId(edge.data('target'));
  return (loopFunctionColors && loopFunctionColors[loop]) || SYSTEM_PALETTE.other;
}

// user-adjustable scale domains (null = auto from playback stats) + ramp
const scale = { tempMin: null, tempMax: null, flowMax: null, ramp: 'thermal' };
const RAMPS = {
  thermal: ['#2747c9', '#2fa3c9', '#3fae62', '#c9b53a', '#e0492f'],
  coolwarm: ['#3b4cc0', '#9abbff', '#f1ede9', '#f4987a', '#b40426'],
  viridis: ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'],
  inferno: ['#0d0887', '#6a00a8', '#bc3754', '#f98e09', '#fcffa4']
};
function effectiveScale() {
  const s = playbackStats || {};
  return {
    tempMin: scale.tempMin ?? s.tempMin,
    tempMax: scale.tempMax ?? s.tempMax,
    flowMax: scale.flowMax ?? s.flowMax
  };
}
function rampColor(t) {
  const stops = RAMPS[scale.ramp] || RAMPS.thermal;
  const x = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  const a = stops[i].match(/\w\w/g).map(h => parseInt(h, 16));
  const b = stops[i + 1].match(/\w\w/g).map(h => parseInt(h, 16));
  const mix = a.map((v, k) => Math.round(v + (b[k] - v) * f));
  return `#${mix.map(v => v.toString(16).padStart(2, '0')).join('')}`;
}

function colorForTemperature(value, min, max) {
  if (!Number.isFinite(value) || min == null || max == null) return '#56647c';
  const t = max === min ? 0.5 : (value - min) / (max - min);
  return rampColor(t);
}

function colorForFlow(value, max) {
  if (!Number.isFinite(value) || !max) return '#39455a';
  const t = Math.max(0, Math.min(1, Math.sqrt(value / max)));
  return hslToHex(0.52, 0.8, 0.16 + t * 0.42);
}

function hslToHex(h, s, l) {
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const toHex = x => Math.round(x * 255).toString(16).padStart(2, '0');
  return `#${toHex(hue2rgb(p, q, h + 1 / 3))}${toHex(hue2rgb(p, q, h))}${toHex(hue2rgb(p, q, h - 1 / 3))}`;
}

function updateLegend() {
  $('legendTempBar').style.background =
    `linear-gradient(to right, ${(RAMPS[scale.ramp] || RAMPS.thermal).join(',')})`;
  const eff = effectiveScale();
  const set = (id, v) => { if (document.activeElement !== $(id)) $(id).value = v == null ? '' : String(Math.round(v * 10) / 10); };
  set('scaleTempMin', eff.tempMin);
  set('scaleTempMax', eff.tempMax);
  set('scaleFlowMax', eff.flowMax);
}

for (const [id, key] of [['scaleTempMin', 'tempMin'], ['scaleTempMax', 'tempMax'], ['scaleFlowMax', 'flowMax']]) {
  $(id).addEventListener('change', () => {
    const v = parseFloat($(id).value);
    scale[key] = Number.isFinite(v) ? v : null; // blank resets to auto
    updateLegend();
    if (playback) updateTime();
  });
}
$('rampPick').addEventListener('change', () => {
  scale.ramp = $('rampPick').value;
  updateLegend();
  if (playback) updateTime();
});

/* ── time / playback ─────────────────────────────────────────── */

function updateTime() {
  if (!playback) return;
  selectedTimeIndex = Number($('timeSlider').value) || 0;
  const max = Number($('timeSlider').max) || 1;
  $('timeSlider').style.setProperty('--progress', `${(selectedTimeIndex / max) * 100}%`);
  const time = playback.times && playback.times[selectedTimeIndex];
  if (time) {
    const [d, hm] = time.label.split(' ');
    $('readoutDate').textContent = `${d} · ${hm}`;
    $('readoutValue').textContent = readoutValueText();
  }
  applyPlaybackToGraph();
  updateZoneHighlights();
}

function readoutValueText() {
  if (!selection) {
    return currentMetric === 'system' ? 'system view'
      : currentMetric === 'temperature' ? 'node temperature' : 'node mass flow';
  }
  if (selection.kind === 'zone') {
    const series = zoneSeriesFor(selection.zoneName);
    const v = series && series.temperature && series.temperature.values[selectedTimeIndex];
    return Number.isFinite(v) ? `${selection.zoneName}  ${v.toFixed(1)} °C` : selection.zoneName;
  }
  if (selection.kind === 'edge' && playback.nodes) {
    const node = playback.nodes[selection.nodeName];
    const slot = currentMetric === 'temperature' ? 'temperature' : 'massFlow';
    const v = node && node[slot] && node[slot].values[selectedTimeIndex];
    const unit = slot === 'temperature' ? '°C' : 'kg/s';
    return Number.isFinite(v) ? `${selection.nodeName}  ${v.toFixed(1)} ${unit}` : selection.nodeName;
  }
  return selection.title || '';
}

function buildMonthRuler() {
  const ruler = $('monthRuler');
  ruler.innerHTML = '';
  const times = (playback && playback.times) || [];
  if (times.length < 2) return;
  const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  let lastMonth = null;
  for (let i = 0; i < times.length; i++) {
    const m = times[i].month;
    if (m !== lastMonth) {
      lastMonth = m;
      const span = document.createElement('span');
      span.textContent = MONTHS[(m - 1) % 12] || m;
      span.style.left = `${(i / (times.length - 1)) * 100}%`;
      ruler.appendChild(span);
    }
  }
}

function setPlaying(on) {
  if (playTimer) { clearInterval(playTimer); playTimer = null; }
  if (on && playback && (playback.times || []).length > 1) {
    playTimer = setInterval(stepTime, 1000 / Number($('playSpeed').value));
  }
  if (playTimer && !dashRaf) dashRaf = requestAnimationFrame(animateDashes);
  if (!playTimer) stopDashes();
  $('playBtn').textContent = playTimer ? '⏸' : '▶';
}

function stepTime() {
  const slider = $('timeSlider');
  slider.value = String((Number(slider.value) + 1) % (Number(slider.max) + 1));
  updateTime();
}

/* ── graph styling from playback ─────────────────────────────── */

// Edge WIDTH = capacity (the node's peak flow over the whole run), edge
// OPACITY = utilization right now (current/peak — idle systems go faint),
// edge COLOR = selected metric ramp (or fluid identity in 8-bit mode:
// pipes are pipes, ducts are ducts). Zone fills = zone mean air temp.
// All ramps are whole-run scales so color motion means the data changed.
function applyPlaybackToGraph() {
  if (!cy || !playback || !playback.nodes) return;
  const s = playbackStats || {};
  const eff = effectiveScale();
  const mario = currentTheme === 'mario';
  cy.batch(() => {
    cy.edges().forEach(edge => {
      const nodeName = String(edge.data('label') || '').split(' ⇒ ')[0];
      const node = playback.nodes[nodeName];
      const temp = node && node.temperature && node.temperature.values[selectedTimeIndex];
      const flow = node && node.massFlow && node.massFlow.values[selectedTimeIndex];
      const peak = s.nodePeaks ? s.nodePeaks.get(nodeName) : null;
      if (Number.isFinite(temp) || Number.isFinite(flow)) {
        const width = peak > 0 && eff.flowMax > 0
          ? 1.4 + Math.sqrt(Math.min(1, peak / eff.flowMax)) * (mario ? 9 : 7)
          : 2;
        const util = peak > 0 && Number.isFinite(flow) ? Math.min(1, flow / peak) : null;
        const opacity = util == null ? 0.85 : 0.22 + 0.73 * Math.sqrt(util);
        let color;
        if (mario) {
          color = edge.data('fluid') === 'Water' ? '#43b047'
            : edge.data('fluid') === 'Air' ? '#e8eef8' : '#9a6a30';
        } else if (currentMetric === 'system') {
          color = systemColorForEdge(edge);
        } else {
          color = currentMetric === 'temperature'
            ? (Number.isFinite(temp) ? colorForTemperature(temp, eff.tempMin, eff.tempMax) : '#56647c')
            : colorForFlow(flow, eff.flowMax);
        }
        edge.style({ width, 'line-color': color, opacity });
        edge.toggleClass('flowing', util != null && util > 0.02);
      } else {
        edge.style({ width: '', 'line-color': '', opacity: '' });
        edge.removeClass('flowing');
      }
    });
    cy.nodes('[?isZone]').forEach(zoneBox => {
      const zoneName = String(zoneBox.data('id') || '').split('|')[1] || zoneBox.data('label');
      const series = zoneSeriesFor(zoneName);
      const temp = series && series.temperature && series.temperature.values[selectedTimeIndex];
      if (Number.isFinite(temp)) {
        zoneBox.style({ 'background-color': colorForTemperature(temp, s.zoneMin, s.zoneMax) });
      } else {
        zoneBox.style({ 'background-color': '' });
      }
    });
  });
}

// Directional flow motion: marching dashes on edges with live flow, only
// while playing. One batched style write per frame — cytoscape redraws
// the canvas regardless, so this is the cheap way to show direction.
function animateDashes(ts) {
  if (!cy || !playTimer) { stopDashes(); return; }
  const offset = -((ts / 35) % 48);
  cy.batch(() => {
    cy.edges('.flowing').style({ 'line-style': 'dashed', 'line-dash-pattern': [7, 5], 'line-dash-offset': offset });
  });
  dashRaf = requestAnimationFrame(animateDashes);
}

function stopDashes() {
  if (dashRaf) { cancelAnimationFrame(dashRaf); dashRaf = null; }
  if (cy) cy.edges('.flowing').style({ 'line-style': 'solid' });
}

/* ── selection model ─────────────────────────────────────────── */
// One selection drives both views + inspector:
//   zone   → zone box .sel, its edges/neighbors .linked, 3D zone lit, epJSON info
//   vertex → vertex .sel, connected edges+vertices .linked, its zone (if any) too
//   edge   → edge .sel, endpoints .linked

function clearSelection() {
  selection = null;
  if (cy) cy.elements().removeClass('sel linked');
  updateZoneHighlights();
  $('inspectorBody').innerHTML =
    '<span class="empty">Nothing selected.</span>' +
    '<ul class="hintList">' +
    '<li>click a component or zone in the graph</li>' +
    '<li>click a zone surface in 3D</li>' +
    '<li>drag to orbit · scroll to zoom</li>' +
    '<li>space = play / pause</li></ul>';
  if (playback) updateTime();
}

function graphZoneVertexByName(zoneName) {
  if (!graph) return null;
  const id = Object.keys(graph.vertices).find(
    k => k.startsWith('ZONE|') && upper(k.slice(5)) === upper(zoneName)
  );
  return id ? { id, v: graph.vertices[id] } : null;
}

function geometryZoneByName(zoneName) {
  return geometry && geometry.zones.find(z => upper(z.name) === upper(zoneName));
}

function epjsonZoneByName(zoneName) {
  if (!epjsonRaw || !epjsonRaw.Zone) return null;
  const key = Object.keys(epjsonRaw.Zone).find(k => upper(k) === upper(zoneName));
  return key ? { key, obj: epjsonRaw.Zone[key] } : null;
}

function selectZone(zoneName) {
  const zv = graphZoneVertexByName(zoneName);
  selection = { kind: 'zone', zoneName: zv ? zv.v.name : zoneName };
  if (cy) {
    cy.elements().removeClass('sel linked');
    if (zv) {
      const box = cy.getElementById(zv.id);
      if (box.nonempty()) {
        box.addClass('sel');
        const edges = box.connectedEdges();
        edges.addClass('linked');
        edges.connectedNodes().difference(box).addClass('linked');
      }
    }
  }
  updateZoneHighlights();
  renderZoneInspector(selection.zoneName, zv);
  if (playback) updateTime();
}

function selectVertex(vertexId) {
  const v = graph && graph.vertices[vertexId];
  if (!v) return clearSelection();
  if (v.type === 'ZONE') return selectZone(v.name);
  selection = { kind: 'vertex', vertexId, title: v.name, zoneName: v.zone || null };
  if (cy) {
    cy.elements().removeClass('sel linked');
    const node = cy.getElementById(vertexId);
    if (node.nonempty()) {
      node.addClass('sel');
      const edges = node.connectedEdges();
      edges.addClass('linked');
      edges.connectedNodes().difference(node).addClass('linked');
    }
    if (v.zone) {
      const zv = graphZoneVertexByName(v.zone);
      if (zv) cy.getElementById(zv.id).addClass('linked');
    }
  }
  updateZoneHighlights(); // lights v.zone in 3D via selection.zoneName
  renderVertexInspector(v);
  if (playback) updateTime();
}

function selectEdge(edge) {
  const d = edge.data();
  const names = String(d.label || '').split(' ⇒ ');
  selection = { kind: 'edge', nodeName: names[0], title: names.join(' ⇒ '), zoneName: null };
  cy.elements().removeClass('sel linked');
  edge.addClass('sel');
  edge.connectedNodes().addClass('linked');
  updateZoneHighlights();
  renderEdgeInspector(d, names);
  if (playback) updateTime();
}

function onGraphNodeTap(n) {
  const d = n.data();
  if (d.isGroup) { clearSelection(); return; }
  if (d.isUnit) { selectUnit(d.id); return; }
  selectVertex(d.id);
}

function selectUnit(unitId) {
  const u = units && units.units[unitId];
  if (!u) return clearSelection();
  selection = { kind: 'unit', unitId, title: u.label, zoneName: u.type === 'zoneeq' ? u.label.split(' · ')[0] : null };
  cy.elements().removeClass('sel linked');
  const node = cy.getElementById(unitId);
  if (node.nonempty()) {
    // collapsed: the proxy is the selection
    node.addClass('sel');
    const edges = node.connectedEdges();
    edges.addClass('linked');
    edges.connectedNodes().difference(node).addClass('linked');
  } else {
    // expanded: highlight the member family in place
    let members = cy.collection();
    for (const id of u.members) members = members.union(cy.getElementById(id));
    members.addClass('sel');
    members.connectedEdges().addClass('linked');
  }
  updateZoneHighlights();
  renderUnitInspector(u);
  renderSystemsTree();
  if (playback) updateTime();
}

function renderUnitInspector(u) {
  const TYPE_LABEL = { ahu: 'AIR HANDLER (AIR LOOP)', plant: 'PLANT LOOP SIDE', dist: 'AIR DISTRIBUTION', zoneeq: 'ZONE EQUIPMENT' };
  let html = `<h2>${esc(u.label)}</h2><span class="kindChip">${TYPE_LABEL[u.type] || 'UNIT'}</span>`;
  html += kv([['members', u.members.length], ['collapsed', collapsedSet.has(u.id) ? 'yes — double-click to expand' : 'no']]);
  html += '<h3>members</h3>';
  html += u.members.map(id => {
    const v = graph.vertices[id];
    return `<div class="conn"><span class="ct">${esc(v ? v.type : '')}</span><br><span class="obj">${esc(v ? v.name : id)}</span></div>`;
  }).join('');
  $('inspectorBody').innerHTML = html;
}

function onGraphEdgeTap(e) {
  selectEdge(e);
}

/* ── inspector rendering ─────────────────────────────────────── */

function kv(rows) {
  return `<table>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`).join('')}</table>`;
}

function nodeInfoRow(name) {
  const info = model && model.nodes[name];
  if (!info) return esc(name);
  return `${esc(name)} <span style="color:var(--ink-faint)">(${esc(info.fluidType)}` +
    (info.suspicious ? ', <span class="suspicious">suspicious</span>' : '') + ')</span>';
}

function connectionsHtml(nodeNames) {
  const out = [];
  for (const n of nodeNames) {
    for (const c of (graph && graph.connectionsByNode[n]) || []) {
      out.push(`<div class="conn"><span class="ct">${esc(c.connectionType)}</span> @ ${esc(n)}<br>` +
        `<span class="obj">${esc(c.objectType)} — ${esc(c.objectName)}</span></div>`);
    }
  }
  return out.length ? out.join('') : '<span class="empty">none</span>';
}

function renderZoneInspector(zoneName, zv) {
  let html = `<h2>${esc(zoneName)}</h2><span class="kindChip">ZONE</span>`;

  const ep = epjsonZoneByName(zoneName);
  if (ep) {
    const rows = Object.entries(ep.obj)
      .filter(([, value]) => typeof value !== 'object')
      .map(([key, value]) => [key.replace(/_/g, ' '), esc(value)]);
    html += `<h3>epJSON · Zone</h3>${kv(rows.length ? rows : [['(no scalar fields)', '']])}`;
  }
  const gz = geometryZoneByName(zoneName);
  if (gz) {
    html += `<h3>geometry</h3>${kv([
      ['surfaces', gz.surfaces.length],
      ['multiplier', esc(gz.multiplier)],
      ['bounds', esc(formatBounds(gz.bounds))]
    ])}`;
  }
  if (!ep && !gz) html += '<h3>geometry</h3><span class="empty">no epJSON zone loaded</span>';

  if (zv) {
    const nodeNames = [...new Set(zv.v.pairs.flatMap(p => [p.inlet, p.outlet]).filter(Boolean))];
    if (zv.v.zoneNode) nodeNames.push(zv.v.zoneNode);
    html += '<h3>HVAC nodes</h3><table>';
    if (zv.v.zoneNode) html += `<tr><td>zone air</td><td>${nodeInfoRow(zv.v.zoneNode)}</td></tr>`;
    for (const p of zv.v.pairs) {
      html += `<tr><td>in</td><td>${p.inlet ? nodeInfoRow(p.inlet) : '—'}</td></tr>` +
              `<tr><td>out</td><td>${p.outlet ? nodeInfoRow(p.outlet) : '—'}</td></tr>`;
    }
    html += '</table><h3>objects touching these nodes</h3>' + connectionsHtml(nodeNames);
  } else {
    html += '<h3>HVAC nodes</h3><span class="empty">no matching zone in .bnd graph</span>';
  }
  $('inspectorBody').innerHTML = html;
}

function renderVertexInspector(v) {
  const nodeNames = [...new Set(v.pairs.flatMap(p => [p.inlet, p.outlet]).filter(Boolean))];
  if (v.zoneNode) nodeNames.push(v.zoneNode);
  let html = `<h2>${esc(v.name)}</h2><span class="kindChip">${esc(v.type)}</span>`;
  const rows = [];
  if (v.branch) rows.push(['branch', esc(v.branch)]);
  if (v.group) rows.push(['loop', esc(v.group.replace('loop|', ''))]);
  if (v.zone) rows.push(['serves zone', esc(v.zone)]);
  if (rows.length) html += kv(rows);
  html += '<h3>node pairs</h3><table>';
  for (const p of v.pairs) {
    html += `<tr><td>in</td><td>${p.inlet ? nodeInfoRow(p.inlet) : '—'}</td></tr>` +
            `<tr><td>out</td><td>${p.outlet ? nodeInfoRow(p.outlet) : '—'}</td></tr>`;
  }
  html += '</table><h3>objects touching these nodes</h3>' + connectionsHtml(nodeNames);
  $('inspectorBody').innerHTML = html;
}

function renderEdgeInspector(d, names) {
  let html = `<h2>${names.map(esc).join('<br>⇓<br>')}</h2>` +
    `<span class="kindChip">${d.kind === 'crossover' ? 'IMPLICIT LOOP INTERFACE' : 'FLUID NODE'}</span>`;
  html += kv([
    ['from', esc(String(d.source).split('|')[1])],
    ['to', esc(String(d.target).split('|')[1])],
    ['fluid', esc(d.fluid || '—')]
  ]);
  html += '<h3>objects touching this node</h3>' + connectionsHtml(names);
  $('inspectorBody').innerHTML = html;
}

function formatBounds(bounds) {
  const f = n => Number(n).toFixed(1);
  return `x ${f(bounds.min.x)}..${f(bounds.max.x)}  y ${f(bounds.min.y)}..${f(bounds.max.y)}  z ${f(bounds.min.z)}..${f(bounds.max.z)}`;
}

/* ── layout ──────────────────────────────────────────────────── */

// Corridor lanes in taxi modes: each water loop turns at its own distance
// and attaches a few px off node center, so CHW/CW/HW runs sharing a
// corridor draw as parallel lines. Inline styles; organic mode clears them.
function applyEdgeLanes() {
  if (!cy || !graph) return;
  const { lanes, count } = assignLoopLanes(graph.loopKind || {});
  if (!count) return;
  const center = (count - 1) / 2;
  cy.batch(() => {
    cy.edges().forEach(edge => {
      if (edge.data('fluid') === 'Air') return;
      const loop = loopNameForGraphId(edge.data('source')) || loopNameForGraphId(edge.data('target'));
      const lane = lanes[loop];
      if (lane == null) return;
      const dy = Math.max(-8, Math.min(8, Math.round((lane - center) * 4)));
      edge.style({
        'taxi-turn': 34 + lane * 10,
        'source-endpoint': `0 ${dy}`,
        'target-endpoint': `0 ${dy}`
      });
    });
  });
}

function clearEdgeLanes() {
  if (cy) cy.edges().removeStyle('taxi-turn source-endpoint target-endpoint');
}

function applyLayout() {
  if (!cy) return;
  const mode = $('layoutMode').value;
  if (mode === 'units') {
    // max-collapsed system diagram: plant → AHU → distribution → zone
    // equipment → zones, one column each
    const COLS = { plant: 0, ahu: 1, dist: 2, zoneeq: 3 };
    const buckets = new Map(); // col -> [node]
    cy.nodes().forEach(n => {
      const d = n.data();
      let col;
      if (d.isUnit) col = COLS[d.unitType] ?? 0;
      else if (d.isZone) col = 4;
      else if (d.isGroup) return;
      else col = 5; // unitless stragglers
      (buckets.get(col) || buckets.set(col, []).get(col)).push(n);
    });
    cy.batch(() => {
      cy.nodes(':child').move({ parent: null });
      cy.nodes('[?isGroup]').style('display', 'none');
      for (const [col, nodes] of buckets) {
        nodes.sort((a, b) => String(a.data('label')).localeCompare(String(b.data('label'))));
        nodes.forEach((n, i) => n.position({ x: col * 260, y: i * 64 }));
      }
    });
    cy.style()
      .selector('edge').style({ 'curve-style': 'taxi', 'taxi-direction': 'rightward',
                                'taxi-turn': 40, 'taxi-turn-min-distance': 12 })
      .update();
    applyEdgeLanes();
    cy.fit(undefined, 40);
  } else if (mode === 'system') {
    // bands/columns already encode the grouping, so compounds are
    // redundant boxes that span bands — flatten them for this mode
    const sys = computeSystemLayout(model, graph);
    const posFor = id => {
      if (sys.positions[id]) return sys.positions[id];
      const u = units && units.units[id]; // collapsed proxy -> member centroid
      if (u) {
        let sx = 0, sy = 0, n = 0;
        for (const m of u.members) {
          const p = sys.positions[m];
          if (p) { sx += p.x; sy += p.y; n++; }
        }
        if (n) return { x: sx / n, y: sy / n };
      }
      return undefined;
    };
    cy.batch(() => {
      cy.nodes(':child').move({ parent: null });
      cy.nodes('[?isGroup], [?isContainer]').style('display', 'none');
    });
    cy.style()
      .selector('edge').style({ 'curve-style': 'taxi', 'taxi-direction': 'rightward',
                                'taxi-turn': 40, 'taxi-turn-min-distance': 12 })
      .update();
    cy.layout({ name: 'preset', positions: n => posFor(n.id()),
                animate: false, fit: true, padding: 30 }).run();
    applyEdgeLanes();
  } else {
    clearEdgeLanes();
    cy.batch(() => {
      cy.nodes('[?isGroup], [?isContainer]').style('display', 'element');
      cy.nodes().forEach(n => {
        const p = n.data('origParent');
        if (p && n.data('parent') !== p && cy.getElementById(p).nonempty()) n.move({ parent: p });
      });
    });
    cy.style().selector('edge').style({ 'curve-style': 'bezier' }).update();
    cy.layout({ name: 'fcose', quality: 'proof', animate: false, nodeSeparation: 90,
                idealEdgeLength: 70, nestingFactor: 0.7, packComponents: true }).run();
  }
  applyFilter();
  applyPlaybackToGraph();
}

function applyFilter() {
  if (!cy) return;
  const loop = $('loopFilter').value;
  const zones = true;
  cy.elements().removeClass('faded');
  let visible = cy.elements();
  if (loop) {
    const group = cy.getElementById('loop|' + loop);
    const inLoop = group.union(group.descendants());
    const wired = inLoop.connectedEdges().connectedNodes().union(inLoop.connectedEdges());
    visible = inLoop.union(wired).union(wired.ancestors());
  }
  cy.elements().difference(visible.union(visible.connectedEdges().filter(e =>
    visible.contains(e.source()) && visible.contains(e.target())
  ))).addClass('faded');
}

/* ── 3D zones ────────────────────────────────────────────────── */

function renderZones3d() {
  if (!geometry || !geometry.zones.length) {
    $('zone3dEmpty').style.display = 'flex';
    $('zone3dEmpty').textContent = 'No BuildingSurface:Detailed zone geometry found.';
    return;
  }
  if (typeof THREE === 'undefined') {
    $('zone3dEmpty').style.display = 'flex';
    $('zone3dEmpty').textContent = 'Three.js did not load; check network access.';
    return;
  }
  $('zone3dEmpty').style.display = 'none';
  if (!threeView) {
    try {
      initThree();
    } catch (error) {
      $('zone3dEmpty').style.display = 'flex';
      $('zone3dEmpty').textContent = `3D view unavailable — WebGL context failed (${error.message}).`;
      return;
    }
  }
  threeView.zoneGroup.clear();

  const center = boundsCenter(geometry.bounds);
  for (const zone of geometry.zones) {
    const color = colorForZoneStatic(zone.name);
    for (const surface of zone.surfaces) {
      const mesh = meshForSurface(surface, center, color);
      mesh.userData.zoneName = zone.name;
      mesh.userData.baseColor = color;
      threeView.zoneGroup.add(mesh);
      threeView.zoneGroup.add(edgeLinesForSurface(surface, center));
    }
  }
  fitThreeCamera();
  updateZoneHighlights();
}

function initThree() {
  const root = $('zone3d');
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(currentTheme === 'mario' ? 0x5c94fc : 0x0e1219);
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100000);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  root.appendChild(renderer.domElement);
  const zoneGroup = new THREE.Group();
  scene.add(zoneGroup);
  scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x20242c, 1.5));
  const light = new THREE.DirectionalLight(0xffffff, 1.1);
  light.position.set(80, 120, 80);
  scene.add(light);
  threeView = {
    scene, camera, renderer, zoneGroup,
    raycaster: new THREE.Raycaster(),
    pointer: new THREE.Vector2(),
    dragging: false, last: null, moved: false
  };
  root.addEventListener('pointerdown', onThreePointerDown);
  root.addEventListener('pointermove', onThreePointerMove);
  root.addEventListener('pointerup', onThreePointerUp);
  root.addEventListener('pointerleave', onThreePointerUp);
  root.addEventListener('wheel', onThreeWheel, { passive: false });
  window.addEventListener('resize', resizeThree);
  resizeThree();
}

function meshForSurface(surface, center, color) {
  const positions = surface.vertices.map(v => toThreeVector(v, center));
  const indices = [];
  for (let i = 1; i < positions.length - 1; i++) indices.push(0, i, i + 1);
  const geo = new THREE.BufferGeometry();
  geo.setFromPoints(positions);
  geo.setIndex(indices);
  geo.computeVertexNormals();
  const material = new THREE.MeshLambertMaterial({
    color, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false
  });
  return new THREE.Mesh(geo, material);
}

function edgeLinesForSurface(surface, center) {
  const points = surface.vertices.map(v => toThreeVector(v, center));
  points.push(points[0]);
  const geo = new THREE.BufferGeometry().setFromPoints(points);
  const material = new THREE.LineBasicMaterial({ color: 0x46546b, transparent: true, opacity: 0.7 });
  return new THREE.Line(geo, material);
}

function toThreeVector(v, center) {
  return new THREE.Vector3(v.x - center.x, v.z - center.z, -(v.y - center.y));
}

function boundsCenter(bounds) {
  return {
    x: (bounds.min.x + bounds.max.x) / 2,
    y: (bounds.min.y + bounds.max.y) / 2,
    z: (bounds.min.z + bounds.max.z) / 2
  };
}

function fitThreeCamera() {
  if (!threeView || !geometry) return;
  const dx = geometry.bounds.max.x - geometry.bounds.min.x;
  const dy = geometry.bounds.max.y - geometry.bounds.min.y;
  const dz = geometry.bounds.max.z - geometry.bounds.min.z;
  const span = Math.max(dx, dy, dz, 1);
  threeView.zoneGroup.rotation.set(0, 0, 0);
  threeView.camera.position.set(span * 0.95, span * 0.65, span * 0.95);
  threeView.camera.near = Math.max(span / 1000, 0.01);
  threeView.camera.far = span * 10;
  threeView.camera.lookAt(0, 0, 0);
  threeView.camera.updateProjectionMatrix();
  renderThree();
}

function resizeThree() {
  if (!threeView) return;
  const root = $('zone3d');
  const width = Math.max(root.clientWidth, 1);
  const height = Math.max(root.clientHeight, 1);
  threeView.renderer.setSize(width, height, false);
  threeView.camera.aspect = width / height;
  threeView.camera.updateProjectionMatrix();
  renderThree();
}

function renderThree() {
  if (threeView) threeView.renderer.render(threeView.scene, threeView.camera);
}

// Selected zone glows amber; others heatmap by zone temp (dimmed when a
// selection exists) or fall back to the static palette.
function updateZoneHighlights() {
  if (!threeView) return;
  const s = playbackStats || {};
  const selectedZone = selection && selection.zoneName ? upper(selection.zoneName) : null;
  for (const child of threeView.zoneGroup.children) {
    if (!child.material || !child.userData.zoneName) continue;
    const isSel = selectedZone && upper(child.userData.zoneName) === selectedZone;
    if (isSel) {
      child.material.color.set('#ffc66b');
      child.material.opacity = 0.85;
      continue;
    }
    const series = zoneSeriesFor(child.userData.zoneName);
    const temp = series && series.temperature && series.temperature.values[selectedTimeIndex];
    if (Number.isFinite(temp)) {
      child.material.color.set(colorForTemperature(temp, s.zoneMin, s.zoneMax));
      child.material.opacity = selectedZone ? 0.18 : 0.55;
    } else {
      child.material.color.setHex(child.userData.baseColor);
      child.material.opacity = selectedZone ? 0.14 : 0.4;
    }
  }
  renderThree();
}

function colorForZoneStatic(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  const color = new THREE.Color();
  color.setHSL(hue / 360, 0.3, 0.45);
  return color.getHex();
}

function onThreePointerDown(event) {
  if (!threeView) return;
  threeView.dragging = true;
  threeView.last = { x: event.clientX, y: event.clientY };
  threeView.moved = false;
}

function onThreePointerMove(event) {
  if (!threeView || !threeView.dragging || !threeView.last) return;
  const dx = event.clientX - threeView.last.x;
  const dy = event.clientY - threeView.last.y;
  if (Math.abs(dx) + Math.abs(dy) > 2) threeView.moved = true;
  threeView.zoneGroup.rotation.y += dx * 0.006;
  threeView.zoneGroup.rotation.x += dy * 0.006;
  threeView.last = { x: event.clientX, y: event.clientY };
  renderThree();
}

function onThreePointerUp(event) {
  if (!threeView) return;
  const moved = threeView.moved;
  threeView.dragging = false;
  if (!moved) pickThreeZone(event);
}

function onThreeWheel(event) {
  if (!threeView) return;
  event.preventDefault();
  const factor = event.deltaY > 0 ? 1.12 : 0.88;
  threeView.camera.position.multiplyScalar(factor);
  renderThree();
}

function pickThreeZone(event) {
  const rect = $('zone3d').getBoundingClientRect();
  threeView.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  threeView.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  threeView.raycaster.setFromCamera(threeView.pointer, threeView.camera);
  const hits = threeView.raycaster.intersectObjects(threeView.zoneGroup.children, false)
    .filter(hit => hit.object.userData.zoneName);
  if (hits.length) selectZone(hits[0].object.userData.zoneName);
  else clearSelection();
}

/* ── wiring ──────────────────────────────────────────────────── */

window.addEventListener('dragover', e => { e.preventDefault(); });
window.addEventListener('drop', e => {
  e.preventDefault();
  for (const f of e.dataTransfer.files) loadFile(f);
});

function loadFile(f) {
  if (!f) return;
  toast(`reading ${f.name}…`);
  f.text().then(t => {
    if (/\.bnd$/i.test(f.name)) loadText(f.name, t);
    else if (/\.epjson$/i.test(f.name) || looksLikeEpjson(t)) loadGeometry(f.name, t);
    else if (/\.json$/i.test(f.name) || looksLikePlayback(t)) loadPlayback(f.name, t);
    else toast(`${f.name}: expected .bnd, epJSON, or playback JSON`);
  });
}

function looksLikeEpjson(text) {
  return text.trim().startsWith('{') && text.includes('"BuildingSurface:Detailed"');
}

function looksLikePlayback(text) {
  return text.trim().startsWith('{') && text.includes('"nodes"') && text.includes('"times"');
}

let toastTimer = null;
function toast(message) {
  const el = $('dropToast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
}

$('loopFilter').addEventListener('change', applyFilter);
$('layoutMode').addEventListener('change', () => {
  if ($('layoutMode').value === 'units' && units) {
    setCollapsed(new Set(Object.keys(units.units))); // setCollapsed re-runs layout
  } else {
    applyLayout();
  }
});
$('collapseAll').addEventListener('click', () => { if (units) setCollapsed(new Set(Object.keys(units.units))); });
$('expandAll').addEventListener('click', () => {
  if ($('layoutMode').value === 'units') $('layoutMode').value = 'system';
  setCollapsed(new Set());
});
$('fit').addEventListener('click', () => { if (cy) cy.fit(undefined, 30); });
$('resetCam').addEventListener('click', fitThreeCamera);

for (const btn of document.querySelectorAll('#themeToggle button')) {
  btn.addEventListener('click', () => {
    currentTheme = btn.dataset.theme;
    for (const b of document.querySelectorAll('#themeToggle button')) b.classList.toggle('on', b === btn);
    document.body.classList.toggle('mario', currentTheme === 'mario');
    if (cy) { cy.style(buildCyStyle(currentTheme)); applyPlaybackToGraph(); }
    if (threeView) {
      threeView.scene.background = new THREE.Color(currentTheme === 'mario' ? 0x5c94fc : 0x0e1219);
      updateZoneHighlights();
    }
  });
}
$('timeSlider').addEventListener('input', updateTime);
$('playBtn').addEventListener('click', () => setPlaying(!playTimer));
$('playSpeed').addEventListener('change', () => { if (playTimer) setPlaying(true); });

for (const btn of document.querySelectorAll('#metric button')) {
  btn.addEventListener('click', () => {
    currentMetric = btn.dataset.metric;
    for (const b of document.querySelectorAll('#metric button')) b.classList.toggle('on', b === btn);
    if (playback) updateTime();
  });
}

window.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.code === 'Space') { e.preventDefault(); setPlaying(!playTimer); }
  if (e.code === 'ArrowRight') { e.preventDefault(); stepTime(); }
  if (e.code === 'ArrowLeft') {
    e.preventDefault();
    const slider = $('timeSlider');
    slider.value = String(Math.max(0, Number(slider.value) - 1));
    updateTime();
  }
});

window.addEventListener('resize', () => { resizeThree(); });

/* panel grabbers + per-panel collapse */
function viewsResized() {
  if (cy) cy.resize();
  resizeThree();
}

function wireSplitter(splitter, onDrag) {
  splitter.addEventListener('pointerdown', e => {
    e.preventDefault();
    splitter.classList.add('dragging');
    splitter.setPointerCapture(e.pointerId);
    const move = ev => { onDrag(ev.clientX); viewsResized(); };
    const up = () => {
      splitter.classList.remove('dragging');
      splitter.removeEventListener('pointermove', move);
      splitter.removeEventListener('pointerup', up);
      viewsResized();
    };
    splitter.addEventListener('pointermove', move);
    splitter.addEventListener('pointerup', up);
  });
}

wireSplitter($('splitSystems'), x => {
  const rect = $('workspace').getBoundingClientRect();
  const width = Math.min(420, Math.max(170, x - rect.left));
  $('systems').style.width = `${width}px`;
});

wireSplitter($('splitPanes'), x => {
  const rect = $('panes').getBoundingClientRect();
  const frac = Math.min(0.85, Math.max(0.15, (x - rect.left) / rect.width));
  $('graphPane').style.flex = `${frac} 1 0`;
  $('zonePane').style.flex = `${1 - frac} 1 0`;
});

wireSplitter($('splitInspector'), x => {
  const rect = $('workspace').getBoundingClientRect();
  const width = Math.min(560, Math.max(220, rect.right - x));
  $('inspector').style.width = `${width}px`;
});

for (const btn of document.querySelectorAll('.paneToggle')) {
  btn.addEventListener('click', () => {
    const pane = $(btn.dataset.target);
    const closed = pane.classList.toggle('closed');
    btn.textContent = closed ? '⊞' : '—';
    viewsResized();
  });
}

clearSelection();

/* ── demo datasets & auto-load ───────────────────────────────── */
// Over http(s) a demo set loads by default (prototyping). Hash params:
// #dataset=hospital, #bnd=/#geometry=/#data= (explicit URLs win),
// #t= / #play=1, #sel=<zone>, #theme=mario, #layout=units|organic|system,
// #collapse=all.
const hashParams = new URLSearchParams(location.hash.replace(/^#/, ''));
const isHttp = /^https?:$/.test(location.protocol);
const DEMOS = {
  'large-office': { bnd: 'demo-data/large-office.bnd', geometry: 'demo-data/large-office.epJSON', data: 'demo-data/large-office.playback.json' },
  'hospital': { bnd: 'demo-data/hospital.bnd', geometry: 'demo-data/hospital.epJSON', data: 'demo-data/hospital.playback.json' },
  'small-office': { bnd: 'demo-data/small-office.bnd', geometry: 'demo-data/small-office.epJSON', data: 'demo-data/small-office.playback.json' }
};

function loadFromUrls(srcs, opts = {}) {
  for (const [key, load] of [['bnd', loadText], ['geometry', loadGeometry], ['data', loadPlayback]]) {
    const url = srcs[key];
    if (!url) continue;
    if (key === 'data') $('readoutValue').textContent = 'loading playback…';
    fetch(url)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); })
      .then(t => {
        load(decodeURIComponent(url.split('/').pop() || url), t);
        if (key === 'bnd' && opts.collapse && units) {
          setCollapsed(new Set(Object.keys(units.units)));
        }
        if (key === 'data') {
          const timeIdx = Number(opts.t);
          if (Number.isFinite(timeIdx) && timeIdx > 0) {
            $('timeSlider').value = String(timeIdx);
            updateTime();
          }
          if (opts.play) setPlaying(true);
        }
      })
      .catch(error => {
        if (key === 'data') $('readoutValue').textContent = `${url}: ${error.message}`;
        else toast(`${key}=${url}: ${error.message}`);
      });
  }
}

$('datasetPick').addEventListener('change', () => {
  setPlaying(false);
  loadFromUrls(DEMOS[$('datasetPick').value] || {});
});

const startTheme = hashParams.get('theme');
if (startTheme === 'mario') document.querySelector('#themeToggle button[data-theme="mario"]').click();
const startLayout = hashParams.get('layout');
if (startLayout && [...$('layoutMode').options].some(o => o.value === startLayout)) {
  $('layoutMode').value = startLayout;
}

if (isHttp) {
  const datasetKey = DEMOS[hashParams.get('dataset')] ? hashParams.get('dataset') : 'large-office';
  $('datasetPick').value = datasetKey;
  const srcs = { ...DEMOS[datasetKey] };
  for (const key of ['bnd', 'geometry', 'data'])
    if (hashParams.get(key)) srcs[key] = hashParams.get(key);
  loadFromUrls(srcs, {
    t: hashParams.get('t'),
    play: hashParams.get('play'),
    collapse: hashParams.get('collapse') === 'all' || $('layoutMode').value === 'units'
  });
} else {
  for (const key of ['bnd', 'geometry', 'data'])
    if (hashParams.get(key)) loadFromUrls({ [key]: hashParams.get(key) });
}
