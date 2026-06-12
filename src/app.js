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
let currentTheme = 'dark';
let units = null;             // { units, unitOf } from assignUnits
let collapsedSet = new Set(); // unit ids currently collapsed
let hiddenSet = new Set();    // unit ids currently not displayed at all
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
  hiddenSet = new Set();
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
  cy.on('cxttap', e => onGraphContextMenu(e));
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
  const light = theme === 'light';
  const stroke = light ? '#45556c' : '#aebdd3';
  const c = light ? {
    nodeBg: '#ffffff', nodeBorder: '#9aa8bb', label: '#5d6b7e',
    zoneBg: '#f0cb6e', zoneBorder: '#b08628', zoneLabel: '#7a5d1d',
    groupBorder: '#d3dae3', groupLabel: '#8a97a8',
    edge: '#b6c0cd', air: '#3a9367', water: '#3d72c4', crossover: '#c05050',
    sel: '#d97c00', linked: '#d97c00',
    parentBg: '#000000', parentOpacity: 0.03,
    font: 'IBM Plex Mono, monospace', fontSize: 9
  } : {
    nodeBg: '#1a2230', nodeBorder: '#4d6076', label: '#7c8aa0',
    zoneBg: '#5a4a2e', zoneBorder: '#8a6a35', zoneLabel: '#a99263',
    groupBorder: '#2b3546', groupLabel: '#56647c',
    edge: '#39455a', air: '#3a7a5c', water: '#3d6390', crossover: '#7c4a4a',
    sel: '#ffc66b', linked: '#ffc66b',
    parentBg: '#ffffff', parentOpacity: 0.02,
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
        'border-width': 1, width: 34, height: 24, color: c.zoneLabel,
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
        'background-color': c.parentBg, 'background-opacity': c.parentOpacity,
        'border-color': c.groupBorder, 'border-width': 1, 'background-image': null,
        label: 'data(label)', 'font-size': c.fontSize + 1, 'font-weight': 'bold',
        'font-family': c.font,
        'text-valign': 'top', 'text-margin-y': -4, color: c.groupLabel
    }},
    { selector: 'edge', style: {
        width: 1.4, 'line-color': c.edge,
        'target-arrow-shape': 'none', 'curve-style': 'bezier',
        opacity: 0.75
    }},
    { selector: 'edge[fluid="Air"]', style: { 'line-color': c.air } },
    { selector: 'edge[fluid="Water"]', style: { 'line-color': c.water } },
    { selector: 'edge[kind="crossover"]', style: { 'line-style': 'dashed', 'line-color': c.crossover } },
    { selector: '.faded', style: { opacity: 0.08, 'text-opacity': 0.08 } },
    { selector: '.linked', style: {
        'underlay-color': c.linked, 'underlay-opacity': 0.18, 'underlay-padding': 5, 'z-index': 8
    }},
    { selector: 'node.linked', style: { 'border-color': c.linked } },
    { selector: '.sel', style: {
        'underlay-color': c.sel, 'underlay-opacity': 0.34, 'underlay-padding': 7, 'z-index': 9
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
  if (!units || (collapsedSet.size === 0 && hiddenSet.size === 0))
    return structuredClone(graph.elements);
  const unitIdOf = id => units.unitOf[id] || null;
  const isHidden = id => { const u = unitIdOf(id); return !!(u && hiddenSet.has(u)); };
  const proxyOf = id => {
    const u = unitIdOf(id);
    return u && !hiddenSet.has(u) && collapsedSet.has(u) ? u : null;
  };
  const els = [];
  const keptNodeIds = new Set();
  const addedProxies = new Set();
  for (const el of graph.elements) {
    if (el.data.source || el.data.isGroup) continue;
    if (isHidden(el.data.id)) continue;
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
    if (isHidden(el.data.source) || isHidden(el.data.target)) continue;
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

function rebuildDisplay() {
  if (!cy || !units) return;
  clearSelection();
  createCy(buildDisplayElements());
  applyLayout();
  applyPlaybackToGraph();
  renderSystemsTree();
}

function setCollapsed(nextSet) {
  collapsedSet = nextSet;
  rebuildDisplay();
}

function setHidden(nextSet) {
  hiddenSet = nextSet;
  rebuildDisplay();
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
  const allIds = Object.keys(units.units);
  let html = `<div class="sysHead sysMaster">
    <span class="sysCaretPad"></span>
    <input type="checkbox" class="sysAllG" title="expand / group everything">
    <input type="checkbox" class="sysAllVisG" title="show / hide everything">
    <span class="sysTitle">ALL SYSTEMS</span>
    <span class="sysCount">${allIds.length}</span>
  </div>`;
  for (const [type, title] of SYS_SECTIONS) {
    const list = Object.values(units.units)
      .filter(u => u.type === type)
      .sort((a, b) => a.label.localeCompare(b.label));
    if (!list.length) continue;
    const open = sysSectionOpen[type];
    html += `<div class="sysSection">
      <div class="sysHead">
        <button class="sysCaret" data-type="${type}">${open ? '▾' : '▸'}</button>
        <input type="checkbox" class="sysAll" data-type="${type}" title="expand / group all">
        <input type="checkbox" class="sysAllVis" data-type="${type}" title="show / hide all">
        <span class="sysTitle">${title}</span>
        <span class="sysCount">${list.length}</span>
      </div>
      <div class="sysList" data-type="${type}" style="display:${open ? 'block' : 'none'}">` +
      list.map(u => `
        <div class="sysRow${selectedUnitIdForTree() === u.id ? ' selected' : ''}${hiddenSet.has(u.id) ? ' off' : ''}" data-unit="${esc(u.id)}">
          <input type="checkbox" class="sysBox" data-unit="${esc(u.id)}" title="expanded / grouped" ${collapsedSet.has(u.id) ? '' : 'checked'}>
          <input type="checkbox" class="sysVis" data-unit="${esc(u.id)}" title="shown / hidden" ${hiddenSet.has(u.id) ? '' : 'checked'}>
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
  for (const box of root.querySelectorAll('.sysVis')) {
    box.addEventListener('change', () => {
      const next = new Set(hiddenSet);
      if (box.checked) next.delete(box.dataset.unit);
      else next.add(box.dataset.unit);
      setHidden(next);
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
  const masterG = root.querySelector('.sysAllG');
  const masterV = root.querySelector('.sysAllVisG');
  const expandedAll = allIds.filter(id => !collapsedSet.has(id)).length;
  masterG.checked = expandedAll === allIds.length;
  masterG.indeterminate = expandedAll > 0 && expandedAll < allIds.length;
  masterG.addEventListener('change', () => {
    if (masterG.checked && $('layoutMode').value === 'units') $('layoutMode').value = 'system';
    setCollapsed(masterG.checked ? new Set() : new Set(allIds));
  });
  const shownAll = allIds.filter(id => !hiddenSet.has(id)).length;
  masterV.checked = shownAll === allIds.length;
  masterV.indeterminate = shownAll > 0 && shownAll < allIds.length;
  masterV.addEventListener('change', () => {
    setHidden(masterV.checked ? new Set() : new Set(allIds));
  });
  for (const all of root.querySelectorAll('.sysAllVis')) {
    const type = all.dataset.type;
    const ids = Object.values(units.units).filter(u => u.type === type).map(u => u.id);
    const shown = ids.filter(id => !hiddenSet.has(id)).length;
    all.checked = shown === ids.length;
    all.indeterminate = shown > 0 && shown < ids.length;
    all.addEventListener('change', () => {
      const next = new Set(hiddenSet);
      for (const id of ids) {
        if (all.checked) next.delete(id);
        else next.add(id);
      }
      setHidden(next);
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
    label.addEventListener('click', () => selectUnit(label.dataset.unit, { jump: true }));
  }
  const selectedRow = root.querySelector('.sysRow.selected');
  if (selectedRow) selectedRow.scrollIntoView({ block: 'nearest' });
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
  updateMiniChart();
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

// display unit system: SI (°C, kg/s) or IP (°F, lb/min) — display-layer
// only, all internal state stays SI
let displayUnits = 'si';
const tempUnit = () => (displayUnits === 'ip' ? '°F' : '°C');
const flowUnit = () => (displayUnits === 'ip' ? 'lb/min' : 'kg/s');
const dispTemp = c => (displayUnits === 'ip' ? c * 9 / 5 + 32 : c);
const siTemp = t => (displayUnits === 'ip' ? (t - 32) * 5 / 9 : t);
const dispFlow = f => (displayUnits === 'ip' ? f * 132.277 : f);
const siFlow = f => (displayUnits === 'ip' ? f / 132.277 : f);

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
  set('scaleTempMin', eff.tempMin == null ? null : dispTemp(eff.tempMin));
  set('scaleTempMax', eff.tempMax == null ? null : dispTemp(eff.tempMax));
  set('scaleFlowMax', eff.flowMax == null ? null : dispFlow(eff.flowMax));
  $('legendTempUnitLbl').textContent = tempUnit();
  $('legendFlowUnitLbl').textContent = flowUnit();
}

for (const [id, key, toSi] of [
  ['scaleTempMin', 'tempMin', siTemp],
  ['scaleTempMax', 'tempMax', siTemp],
  ['scaleFlowMax', 'flowMax', siFlow]
]) {
  $(id).addEventListener('change', () => {
    const v = parseFloat($(id).value);
    scale[key] = Number.isFinite(v) ? toSi(v) : null; // blank resets to auto
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
  drawMiniChart();
}

function readoutValueText() {
  if (!selection) {
    return currentMetric === 'system' ? 'system view'
      : currentMetric === 'temperature' ? 'node temperature' : 'node mass flow';
  }
  if (selection.kind === 'zone') {
    const series = zoneSeriesFor(selection.zoneName);
    const v = series && series.temperature && series.temperature.values[selectedTimeIndex];
    return Number.isFinite(v) ? `${selection.zoneName}  ${dispTemp(v).toFixed(1)} ${tempUnit()}` : selection.zoneName;
  }
  if (selection.kind === 'edge' && playback.nodes) {
    const node = playback.nodes[selection.nodeName];
    const slot = currentMetric === 'temperature' ? 'temperature' : 'massFlow';
    const v = node && node[slot] && node[slot].values[selectedTimeIndex];
    const conv = slot === 'temperature' ? dispTemp : dispFlow;
    const unit = slot === 'temperature' ? tempUnit() : flowUnit();
    return Number.isFinite(v) ? `${selection.nodeName}  ${conv(v).toFixed(1)} ${unit}` : selection.nodeName;
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
  cy.batch(() => {
    cy.edges().forEach(edge => {
      const nodeName = String(edge.data('label') || '').split(' ⇒ ')[0];
      const node = playback.nodes[nodeName];
      const temp = node && node.temperature && node.temperature.values[selectedTimeIndex];
      const flow = node && node.massFlow && node.massFlow.values[selectedTimeIndex];
      const peak = s.nodePeaks ? s.nodePeaks.get(nodeName) : null;
      if (Number.isFinite(temp) || Number.isFinite(flow)) {
        const width = peak > 0 && eff.flowMax > 0
          ? 1.4 + Math.sqrt(Math.min(1, peak / eff.flowMax)) * 7
          : 2;
        const util = peak > 0 && Number.isFinite(flow) ? Math.min(1, flow / peak) : null;
        const opacity = util == null ? 0.85 : 0.22 + 0.73 * Math.sqrt(util);
        let color;
        if (currentMetric === 'system') {
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
    '<li>right-click for group / hide actions</li>' +
    '<li>click a zone surface in 3D</li>' +
    '<li>drag to orbit · scroll to zoom</li>' +
    '<li>space = play / pause</li>' +
    '<li>drop your own .bnd / epJSON / playback JSON to load a model</li></ul>';
  renderSystemsTree();
  updateMiniChart();
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
  renderSystemsTree();
  updateMiniChart();
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
  renderSystemsTree();
  updateMiniChart();
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
  renderSystemsTree();
  updateMiniChart();
  if (playback) updateTime();
}

/* ── mini chart: sparklines for the selection during playback ─── */
// Each related series normalizes to its own range (mixed units), drawn
// once into an offscreen cache; per-tick work is one blit + the time
// marker, so it stays cheap at 30 steps/s.
const MINI_COLORS = ['#e0a33b', '#4f9dd9', '#52b788', '#d96a6a'];
let miniSeries = [];
let miniCache = null;
let miniPlot = null; // plot-rect padding so the marker tracks the axes

function computeMiniSeries() {
  if (!playback || !selection) return [];
  const out = [];
  const addNode = (name, slot = 'temperature') => {
    const node = playback.nodes && playback.nodes[name];
    const series = node && node[slot];
    const key = `${name}|${slot}`;
    if (series && out.length < 4 && !out.some(s => s.key === key)) {
      out.push({
        key,
        kind: slot === 'massFlow' ? 'flow' : 'temp',
        label: `${name} · ${slot === 'massFlow' ? flowUnit() : tempUnit()}`,
        values: series.values
      });
    }
  };
  if (selection.kind === 'zone') {
    const series = zoneSeriesFor(selection.zoneName);
    if (series && series.temperature) {
      out.push({ key: `zone|${selection.zoneName}`, kind: 'temp', label: `${selection.zoneName} · zone ${tempUnit()}`, values: series.temperature.values });
    }
    const zv = graphZoneVertexByName(selection.zoneName);
    if (zv) for (const p of zv.v.pairs) if (p.inlet) addNode(p.inlet);
  } else if (selection.kind === 'edge') {
    addNode(selection.nodeName, 'temperature');
    addNode(selection.nodeName, 'massFlow');
  } else if (selection.kind === 'vertex') {
    const v = graph && graph.vertices[selection.vertexId];
    for (const p of (v ? v.pairs : [])) {
      if (p.inlet) addNode(p.inlet);
      if (p.outlet) addNode(p.outlet);
    }
  } else if (selection.kind === 'unit') {
    const u = units && units.units[selection.unitId];
    if (u) {
      const names = new Set();
      for (const id of u.members) {
        const v = graph.vertices[id];
        for (const p of (v ? v.pairs : [])) {
          if (p.inlet) names.add(p.inlet);
          if (p.outlet) names.add(p.outlet);
        }
      }
      // heaviest-flow nodes are the unit's main supply/return runs
      const peaks = (playbackStats && playbackStats.nodePeaks) || new Map();
      const ranked = [...names]
        .filter(n => playback.nodes && playback.nodes[n])
        .sort((a, b) => (peaks.get(b) || 0) - (peaks.get(a) || 0));
      for (const n of ranked.slice(0, 4)) addNode(n);
    }
  }
  return out.slice(0, 4);
}

function updateMiniChart() {
  miniSeries = computeMiniSeries();
  $('miniChartTitle').textContent =
    selection && miniSeries.length ? selection.title || selection.zoneName || '' : '';
  $('miniLegend').innerHTML = miniSeries
    .map((s, i) => `<span><i style="background:${MINI_COLORS[i]}"></i>${esc(s.label)}</span>`)
    .join('');
  const empty = miniSeries.length === 0;
  $('chartEmpty').style.display = empty ? 'flex' : 'none';
  $('miniChartCanvas').style.visibility = empty ? 'hidden' : 'visible';
  if (empty) { miniCache = null; return; }
  renderMiniCache();
  drawMiniChart();
}

function renderMiniCache() {
  const canvas = $('miniChartCanvas');
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.floor(rect.width * dpr));
  const h = Math.max(1, Math.floor(rect.height * dpr));
  canvas.width = w;
  canvas.height = h;
  miniCache = document.createElement('canvas');
  miniCache.width = w;
  miniCache.height = h;
  const ctx = miniCache.getContext('2d');

  // shared scale per unit kind: temps on the left axis, flows (0-based)
  // on the right axis — lines of the same kind are directly comparable
  const ranges = { temp: null, flow: null };
  for (const series of miniSeries) {
    let min = Infinity, max = -Infinity;
    for (const v of series.values) {
      if (!Number.isFinite(v)) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (!(max >= min)) continue;
    const r = ranges[series.kind] || { min, max };
    r.min = Math.min(r.min, min);
    r.max = Math.max(r.max, max);
    ranges[series.kind] = r;
  }
  if (ranges.flow) ranges.flow.min = Math.min(0, ranges.flow.min);
  for (const r of Object.values(ranges)) {
    if (r && !(r.max > r.min)) { r.min -= 1; r.max += 1; }
  }

  const hasTemp = !!ranges.temp;
  const hasFlow = !!ranges.flow;
  const padL = hasTemp ? 34 * dpr : 6 * dpr;
  const padR = hasFlow ? 34 * dpr : 6 * dpr;
  const padT = 4 * dpr;
  const padB = 4 * dpr;
  miniPlot = { l: padL, r: padR };
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  const ink = currentTheme === 'light' ? '#97a3b4' : '#4d5a6e';
  const inkStrong = currentTheme === 'light' ? '#5d6b7e' : '#7c8aa0';
  ctx.strokeStyle = ink;
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.5;
  ctx.strokeRect(padL, padT, plotW, plotH);
  ctx.globalAlpha = 1;

  ctx.font = `${9 * dpr}px 'IBM Plex Mono', monospace`;
  ctx.fillStyle = inkStrong;
  if (hasTemp) {
    ctx.textAlign = 'right';
    ctx.fillText(dispTemp(ranges.temp.max).toFixed(0), padL - 3 * dpr, padT + 8 * dpr);
    ctx.fillText(dispTemp(ranges.temp.min).toFixed(0), padL - 3 * dpr, h - padB);
  }
  if (hasFlow) {
    ctx.textAlign = 'left';
    ctx.fillText(dispFlow(ranges.flow.max).toFixed(ranges.flow.max < 10 ? 1 : 0), w - padR + 3 * dpr, padT + 8 * dpr);
    ctx.fillText(dispFlow(ranges.flow.min).toFixed(0), w - padR + 3 * dpr, h - padB);
  }

  miniSeries.forEach((series, i) => {
    const r = ranges[series.kind];
    if (!r) return;
    const n = series.values.length;
    const stride = Math.max(1, Math.floor(n / plotW)); // ~1 sample per px
    ctx.beginPath();
    let started = false;
    for (let j = 0; j < n; j += stride) {
      const v = series.values[j];
      if (!Number.isFinite(v)) continue;
      const x = padL + (j / (n - 1)) * plotW;
      const y = padT + plotH - ((v - r.min) / (r.max - r.min)) * plotH;
      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = MINI_COLORS[i];
    ctx.lineWidth = 1.2 * dpr;
    ctx.globalAlpha = 0.9;
    ctx.stroke();
  });
  ctx.globalAlpha = 1;
}

function drawMiniChart() {
  if (!miniCache || !miniSeries.length) return;
  const canvas = $('miniChartCanvas');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(miniCache, 0, 0);
  const n = ((playback && playback.times) || []).length;
  if (n > 1) {
    const plot = miniPlot || { l: 0, r: 0 };
    const x = plot.l + (selectedTimeIndex / (n - 1)) * (canvas.width - plot.l - plot.r);
    ctx.strokeStyle = currentTheme === 'light' ? '#d97c00' : '#ffc66b';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvas.height);
    ctx.stroke();
  }
}

function onGraphNodeTap(n) {
  const d = n.data();
  if (d.isGroup) { clearSelection(); return; }
  if (d.isUnit) { selectUnit(d.id); return; }
  selectVertex(d.id);
}

function selectUnit(unitId, opts = {}) {
  const u = units && units.units[unitId];
  if (!u) return clearSelection();
  selection = { kind: 'unit', unitId, title: u.label, zoneName: u.type === 'zoneeq' ? u.label.split(' · ')[0] : null };
  cy.elements().removeClass('sel linked');
  const node = cy.getElementById(unitId);
  let focus;
  if (node.nonempty()) {
    // collapsed: the proxy is the selection
    node.addClass('sel');
    const edges = node.connectedEdges();
    edges.addClass('linked');
    edges.connectedNodes().difference(node).addClass('linked');
    focus = node;
  } else {
    // expanded: highlight the member family in place
    let members = cy.collection();
    for (const id of u.members) members = members.union(cy.getElementById(id));
    members.addClass('sel');
    members.connectedEdges().addClass('linked');
    focus = members;
  }
  if (opts.jump && focus && focus.nonempty()) {
    cy.animate({ fit: { eles: focus.closedNeighborhood(), padding: 90 }, duration: 350, easing: 'ease-in-out' });
  }
  updateZoneHighlights();
  renderUnitInspector(u);
  renderSystemsTree();
  updateMiniChart();
  if (playback) updateTime();
}

// which tree row matches the selection (direct unit pick, or the unit
// that owns a selected component)
function selectedUnitIdForTree() {
  if (!selection || !units) return null;
  if (selection.kind === 'unit') return selection.unitId;
  if (selection.kind === 'vertex') return units.unitOf[selection.vertexId] || null;
  return null;
}

function renderUnitInspector(u) {
  const TYPE_LABEL = { ahu: 'AIR HANDLER (AIR LOOP)', plant: 'PLANT LOOP', dist: 'AIR DISTRIBUTION', zoneeq: 'ZONE EQUIPMENT' };
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

// Edge routing in taxi modes, two parts:
//   1. corridor lanes — each water loop turns at its own distance, so
//      CHW/CW/HW runs sharing a corridor draw as parallel lines;
//   2. ports — a node's in-edges spread along its left side and
//      out-edges along its right side (flow is left→right), ordered by
//      the other endpoint's y so runs don't cross, and the node grows
//      to fit its port count instead of funneling everything through
//      one center point.
// Inline styles; organic mode clears them.
const PORT_SPACING = 6;

function nodeBaseSize(node) {
  if (node.data('isUnit')) return { w: 52, h: 40 };
  if (node.data('isZone')) return { w: 34, h: 24 };
  const type = String(node.data('type') || '');
  if (type.startsWith('CONNECTOR') || type.startsWith('AIRLOOPHVAC:ZONESPLITTER') ||
      type.startsWith('AIRLOOPHVAC:ZONEMIXER')) return { w: 18, h: 18 };
  return { w: 26, h: 26 };
}

// Which loop compound a display node belongs in (system layout boxes).
// Follows the LAYOUT's band assignment, not the ground-truth group chain:
// dual-membership components (a cooling coil sits on both an air branch
// and a CHW demand branch) are drawn in one band, and the box must wrap
// where they are drawn or it stretches across other systems. Zones stay
// unboxed (building objects, not system internals); plant LOOP proxies
// stand for the whole loop and get no box either.
function displayLoopParent(n, bandOf) {
  const d = n.data();
  if (d.isZone) return null;
  if (d.isUnit) {
    const parts = String(d.id).split('|');
    if (parts[1] === 'AHU' || parts[1] === 'DIST') return `loop|${parts[2]}`;
    if (parts[1] !== 'ZEQ') return null;
    const u = units && units.units[d.id];
    for (const m of (u ? u.members : [])) {
      const b = bandOf[m];
      if (b && b !== 'misc' && graph.loopKind[b]) return `loop|${b}`;
    }
    return null;
  }
  const b = bandOf[d.id];
  return b && b !== 'misc' && graph.loopKind[b] ? `loop|${b}` : null;
}

function applyEdgeRouting() {
  if (!cy || !graph) return;
  const { lanes } = assignLoopLanes(graph.loopKind || {});
  cy.batch(() => {
    cy.edges().forEach(edge => {
      if (edge.data('fluid') === 'Air') return;
      const loop = loopNameForGraphId(edge.data('source')) || loopNameForGraphId(edge.data('target'));
      const lane = lanes[loop];
      if (lane != null) edge.style('taxi-turn', 34 + lane * 10);
    });
    cy.nodes().forEach(node => {
      if (node.data('isGroup')) return;
      const ins = [];
      const outs = [];
      node.connectedEdges().forEach(e => {
        if (e.data('target') === node.id()) ins.push(e);
        else if (e.data('source') === node.id()) outs.push(e);
      });
      const need = Math.max(ins.length, outs.length);
      const base = nodeBaseSize(node);
      const h = Math.max(base.h, need * PORT_SPACING + 8);
      if (h > base.h) node.style('height', h);
      const yOf = other => (other && other.nonempty() ? other.position('y') : 0);
      const byOtherY = key => (a, b) =>
        yOf(a[key]()) - yOf(b[key]()) || String(a.data('label')).localeCompare(String(b.data('label')));
      ins.sort(byOtherY('source'));
      outs.sort(byOtherY('target'));
      ins.forEach((e, i) =>
        e.style('target-endpoint', `${-base.w / 2}px ${Math.round((i - (ins.length - 1) / 2) * PORT_SPACING)}px`));
      outs.forEach((e, i) =>
        e.style('source-endpoint', `${base.w / 2}px ${Math.round((i - (outs.length - 1) / 2) * PORT_SPACING)}px`));
    });
  });
}

function clearEdgeRouting() {
  if (!cy) return;
  cy.edges().removeStyle('taxi-turn source-endpoint target-endpoint');
  cy.nodes().removeStyle('height');
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
    applyEdgeRouting();
    cy.fit(undefined, 40);
  } else if (mode === 'system') {
    // bands/columns already encode the grouping; container compounds are
    // flattened, but loop compounds stay visible as labeled boundary
    // rectangles around each system (one box per loop, both sides)
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
      cy.nodes('[?isGroup]').forEach(g =>
        g.style('display', g.id().startsWith('loop|') ? 'element' : 'none'));
      cy.nodes().not('[?isGroup]').forEach(n => {
        const want = displayLoopParent(n, sys.bandOf);
        const target = want && cy.getElementById(want).nonempty() ? want : null;
        if ((n.data('parent') || null) !== target) n.move({ parent: target });
      });
      cy.nodes('[?isContainer]').style('display', 'none');
    });
    cy.style()
      .selector('edge').style({ 'curve-style': 'taxi', 'taxi-direction': 'rightward',
                                'taxi-turn': 40, 'taxi-turn-min-distance': 12 })
      .update();
    cy.layout({ name: 'preset', positions: n => posFor(n.id()),
                animate: false, fit: true, padding: 30 }).run();
    applyEdgeRouting();
  } else {
    clearEdgeRouting();
    cy.batch(() => {
      cy.nodes('[?isGroup], [?isContainer]').style('display', 'element');
      cy.nodes().forEach(n => {
        if (n.data('isGroup')) return;
        const p = n.data('origParent') || null; // proxies have none — unparent
        if ((n.data('parent') || null) === p) return;
        if (!p || cy.getElementById(p).nonempty()) n.move({ parent: p });
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
  scene.background = new THREE.Color(currentTheme === 'light' ? 0xeef1f5 : 0x0e1219);
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
$('fit').addEventListener('click', () => { if (cy) cy.fit(undefined, 30); });
$('resetCam').addEventListener('click', fitThreeCamera);

/* ── graph context menu ──────────────────────────────────────── */
// Right-click actions: per-object collapse/expand/hide moved here from
// the toolbar so the chrome stays thin.
function openCtxMenu(x, y, entries) {
  const menu = $('ctxMenu');
  menu.innerHTML = '';
  for (const en of entries) {
    if (en === '—') { menu.appendChild(Object.assign(document.createElement('div'), { className: 'ctxSep' })); continue; }
    const div = document.createElement('div');
    if (en.head) {
      div.className = 'ctxHead';
      div.textContent = en.head;
    } else {
      div.className = 'ctxItem';
      div.textContent = en.label;
      div.addEventListener('click', () => { closeCtxMenu(); en.run(); });
    }
    menu.appendChild(div);
  }
  menu.classList.add('show');
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - r.width - 6)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - r.height - 6)}px`;
}
function closeCtxMenu() { $('ctxMenu').classList.remove('show'); }
window.addEventListener('pointerdown', e => { if (!$('ctxMenu').contains(e.target)) closeCtxMenu(); });
window.addEventListener('keydown', e => { if (e.code === 'Escape') closeCtxMenu(); });
$('cy').addEventListener('contextmenu', e => e.preventDefault());

function onGraphContextMenu(e) {
  const oe = e.originalEvent || {};
  const x = oe.clientX ?? 0;
  const y = oe.clientY ?? 0;
  const entries = [];
  const t = e.target;
  if (t === cy || (t.isNode && t.isNode() && t.data('isGroup'))) {
    entries.push(
      { head: 'view' },
      { label: 'fit view', run: () => cy && cy.fit(undefined, 30) },
      { label: 'expand all units', run: () => {
          if ($('layoutMode').value === 'units') $('layoutMode').value = 'system';
          setCollapsed(new Set());
        } },
      { label: 'group all units', run: () => { if (units) setCollapsed(new Set(Object.keys(units.units))); } },
      { label: 'show all units', run: () => setHidden(new Set()) },
      '—',
      { label: 'clear selection', run: clearSelection }
    );
  } else if (t.isNode && t.isNode()) {
    const d = t.data();
    if (d.isUnit) {
      entries.push(
        { head: d.label },
        { label: 'select', run: () => selectUnit(d.id) },
        { label: 'expand unit', run: () => { const n = new Set(collapsedSet); n.delete(d.id); setCollapsed(n); } },
        { label: 'hide unit', run: () => { const n = new Set(hiddenSet); n.add(d.id); setHidden(n); } }
      );
    } else {
      entries.push(
        { head: d.label },
        { label: 'select', run: () => selectVertex(d.id) }
      );
      const unitId = units && units.unitOf[d.id];
      if (unitId) {
        const u = units.units[unitId];
        entries.push(
          '—',
          { label: `group into ${u.label}`, run: () => { const n = new Set(collapsedSet); n.add(unitId); setCollapsed(n); } },
          { label: `hide ${u.label}`, run: () => { const n = new Set(hiddenSet); n.add(unitId); setHidden(n); } }
        );
      }
    }
  } else if (t.isEdge && t.isEdge()) {
    const name = String(t.data('label') || '').split(' ⇒ ')[0];
    entries.push(
      { head: name },
      { label: 'select', run: () => { const edge = cy.getElementById(t.id()); if (edge.nonempty()) selectEdge(edge); } }
    );
  }
  if (entries.length) openCtxMenu(x, y, entries);
}

/* ── settings popover (theme / units / colorscale) ───────────── */
$('settingsBtn').addEventListener('click', () => {
  $('settingsPanel').hidden = !$('settingsPanel').hidden;
});
window.addEventListener('pointerdown', e => {
  if (!$('settingsWrap').contains(e.target)) $('settingsPanel').hidden = true;
});

for (const btn of document.querySelectorAll('#unitToggle button')) {
  btn.addEventListener('click', () => {
    displayUnits = btn.dataset.units;
    for (const b of document.querySelectorAll('#unitToggle button')) b.classList.toggle('on', b === btn);
    updateLegend();
    updateMiniChart();
    if (playback) updateTime();
  });
}

// re-render the cached plot whenever the chart pane changes size (its
// own splitter, side-panel splitters, or collapse/expand)
new ResizeObserver(() => {
  if (miniSeries.length && !$('chartPane').classList.contains('closed')) {
    renderMiniCache();
    drawMiniChart();
  }
}).observe($('chartPane'));

for (const btn of document.querySelectorAll('#themeToggle button')) {
  btn.addEventListener('click', () => {
    currentTheme = btn.dataset.theme;
    for (const b of document.querySelectorAll('#themeToggle button')) b.classList.toggle('on', b === btn);
    document.body.classList.toggle('light', currentTheme === 'light');
    if (cy) { cy.style(buildCyStyle(currentTheme)); applyPlaybackToGraph(); }
    if (threeView) {
      threeView.scene.background = new THREE.Color(currentTheme === 'light' ? 0xeef1f5 : 0x0e1219);
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
    const move = ev => { onDrag(ev.clientX, ev.clientY); viewsResized(); };
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
  const rect = $('panesRow').getBoundingClientRect();
  const frac = Math.min(0.85, Math.max(0.15, (x - rect.left) / rect.width));
  $('graphPane').style.flex = `${frac} 1 0`;
  $('zonePane').style.flex = `${1 - frac} 1 0`;
});

wireSplitter($('splitChart'), (x, y) => {
  const rect = $('panes').getBoundingClientRect();
  const h = Math.min(rect.height * 0.6, Math.max(90, rect.bottom - y));
  $('chartPane').style.height = `${h}px`;
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
// #t= / #play=1, #sel=<zone>, #theme=light, #layout=units|organic|system,
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
if (startTheme === 'light') document.querySelector('#themeToggle button[data-theme="light"]').click();
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
