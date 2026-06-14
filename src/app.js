import cytoscape from 'cytoscape';
import cytoscapeFcose from 'cytoscape-fcose';
import { parseBnd } from './parsebnd.js';
import { buildGraph } from './buildgraph.js';
import { computeSystemLayout, assignLoopLanes } from './layoutbnd.js';
import { parseEpjsonGeometry } from './parsegeometry.js';
import { assignUnits } from './units.js';
import { renderZones3d, fitThreeCamera, resizeThree, updateZoneHighlights, applyTheme3d } from './zones3d.js';
import { updateMiniChart, drawMiniChart, alignScrubber, initCharting } from './chart.js';
import {
  SYSTEM_PALETTE, RAMPS, scale, colorForTemperature, colorForFlow,
  tempUnit, flowUnit, dispTemp, siTemp, dispFlow, siFlow, setDisplayUnits
} from './palette.js';
import './app.css';

cytoscape.use(cytoscapeFcose);

// shared state + helpers the view modules (zones3d, chart) read via live
// bindings; app.js stays the owner and only it reassigns them
export {
  $, esc, upper, geometry, graph, units, playback, currentTheme, playbackStats,
  selection, zoneOpacity, hiddenZones, selectedTimeIndex, zoneSeriesFor,
  selectZone, clearSelection, graphZoneVertexByName, loopFamilyEdges
};

let cy = null;
let model = null;
let graph = null;
let geometry = null;
let epjsonRaw = null;
let playback = null;
let playbackStats = null;
let playbackZonesUpper = null; // UPPER(zone) -> { key, series } (SQL uppercases keys)
let playTimer = null;
let dashRaf = null;
let selectedTimeIndex = 0;
let currentMetric = 'temperature';
let loopFunctionColors = null; // loopName -> hex, from classifyLoops()
let currentTheme = 'dark';
let zoneOpacity = 0.18;        // opacity of non-selected 3D zones (slider)
let hiddenZones = new Set();   // UPPER(zone) names hidden from graph + 3D
let units = null;             // { units, unitOf } from assignUnits
let collapsedSet = new Set(); // unit ids currently collapsed
let hiddenSet = new Set();    // unit ids currently not displayed at all
let focusReveal = new Set();  // graph vertex ids force-shown for the focused
                              // zone (its immediate neighbors), overriding
                              // grouping/hiding so a zone's connections show
let graphLocked = true;       // nodes ungrabbable by default → click-drag pans
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
  clearSelection(); // drop any prior dataset's selection + stale inspector
  model = parseBnd(text);
  graph = buildGraph(model);
  units = assignUnits(model, graph);
  // the 'units' overview needs every unit grouped; seed it that way at load
  // so applyLayout's fallback guard doesn't trip on the default expanded set
  collapsedSet = $('layoutMode').value === 'units'
    ? new Set(Object.keys(units.units))
    : defaultCollapsedSet();
  hiddenSet = new Set();
  hiddenZones = new Set();
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
  populateZonePicker();
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
  // tapping empty graph space leaves the selection alone (deselect by
  // clicking empty 3D space, the context menu, or the zone picker) —
  // losing a selection to a stray background click is annoying
  cy.on('dbltap', 'node', e => onGraphNodeDblTap(e.target));
  cy.on('cxttap', e => onGraphContextMenu(e));
  cy.autoungrabify(graphLocked); // locked: drag pans instead of moving nodes
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
    sel: '#d97c00', linked: '#d97c00', preview: '#2f74b5',
    parentBg: '#000000', parentOpacity: 0.03,
    font: 'IBM Plex Mono, monospace', fontSize: 9
  } : {
    nodeBg: '#1a2230', nodeBorder: '#4d6076', label: '#7c8aa0',
    zoneBg: '#5a4a2e', zoneBorder: '#8a6a35', zoneLabel: '#a99263',
    groupBorder: '#2b3546', groupLabel: '#56647c',
    edge: '#39455a', air: '#3a7a5c', water: '#3d6390', crossover: '#7c4a4a',
    sel: '#ffc66b', linked: '#ffc66b', preview: '#9ad0ff',
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
        opacity: 0.75,
        // node-state readout (temp/flow at current time) — only sel/linked
        // edges carry a non-empty stateLabel (set in applyPlaybackToGraph)
        label: 'data(stateLabel)', 'font-size': 8, 'font-family': c.font,
        color: c.label, 'text-background-color': c.nodeBg,
        'text-background-opacity': 0.92, 'text-background-padding': 2,
        'text-background-shape': 'roundrectangle', 'edge-text-rotation': 'none',
        'text-events': 'no'
    }},
    { selector: 'edge[fluid="Air"]', style: { 'line-color': c.air } },
    { selector: 'edge[fluid="Water"]', style: { 'line-color': c.water } },
    { selector: 'edge[kind="crossover"]', style: { 'line-style': 'dashed', 'line-color': c.crossover } },
    { selector: 'edge.sel, edge.linked', style: {
        color: c.sel, 'font-weight': 'bold', 'text-background-opacity': 0.96, 'z-index': 20
    }},
    { selector: '.faded', style: { opacity: 0.08, 'text-opacity': 0.08 } },
    { selector: '.preview', style: {
        'underlay-color': c.preview, 'underlay-opacity': 0.20, 'underlay-padding': 4, 'z-index': 7
    }},
    { selector: 'node.preview', style: { 'border-color': c.preview } },
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
  // a focus-revealed node is always shown individually (never hidden, never
  // collapsed into its unit's proxy) so the focused zone's connection lands
  // on the real component, not a grouped box
  const isHidden = id => { const u = unitIdOf(id); return !!(u && hiddenSet.has(u) && !focusReveal.has(id)); };
  const proxyOf = id => {
    if (focusReveal.has(id)) return null;
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
  focusReveal = new Set(); // grouping changed under us; drop any focus reveal
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
const sysSectionOpen = { ahu: true, plant: true, dist: true, zoneeq: false, zones: false };

// zones get a simpler active/inactive filter (no "grouped" state). Inactive
// = hidden from the branch graph, but only faded to translucent in 3D.
const ZONE_SEG = [['shown', '●'], ['hidden', '○']];
function zoneSegHtml(active, dataAttr) {
  return '<span class="detailSeg">' + ZONE_SEG.map(([s, g]) =>
    `<button class="dseg z-${s}${active === s ? ' on' : ''}" data-zstate="${s}"${dataAttr} ` +
    `title="${s === 'shown' ? 'active (shown in graph, solid in 3D)' : 'inactive (hidden in graph, translucent in 3D)'}">${g}</button>`
  ).join('') + '</span>';
}
function zoneNameOfNode(n) {
  return String(n.data('id') || '').split('|')[1] || n.data('label');
}
// apply hiddenZones to the graph (zone boxes + their edges) and 3D, without
// a full rebuild so the current selection survives
function applyZoneVisibility() {
  if (cy) {
    const zones = cy.nodes('[?isZone]');
    cy.batch(() => {
      zones.forEach(n => n.style('display', hiddenZones.has(upper(zoneNameOfNode(n))) ? 'none' : 'element'));
      zones.connectedEdges().forEach(e => {
        const off = e.source().style('display') === 'none' || e.target().style('display') === 'none';
        e.style('display', off ? 'none' : 'element');
      });
    });
  }
  updateZoneHighlights();
}
function setHiddenZones(next, fit) {
  hiddenZones = next;
  applyZoneVisibility();
  renderSystemsTree();
  if (fit) { // zoom extents when something was turned off
    if (cy) cy.fit(cy.elements(':visible'), 30);
    fitThreeCamera();
  }
}

// One per-row "detail level" control instead of two booleans: a unit is
// shown in full DETAIL (every component), GROUPED (collapsed to one box),
// or HIDDEN. These are a single ordinal axis — how much do I want to see —
// so a 3-segment control reads far clearer than a group toggle + a
// show/hide checkbox (whose hidden+expanded combo was meaningless).
const DETAIL_SEG = [['detail', '●'], ['grouped', '◐'], ['hidden', '○']];

function unitDetail(id) {
  if (hiddenSet.has(id)) return 'hidden';
  if (collapsedSet.has(id)) return 'grouped';
  return 'detail';
}
// aggregate state for a section / the master row (null = mixed)
function aggDetail(ids) {
  const set = new Set(ids.map(unitDetail));
  return set.size === 1 ? [...set][0] : null;
}
function detailSegHtml(active, dataAttr) {
  return '<span class="detailSeg">' + DETAIL_SEG.map(([s, g]) =>
    `<button class="dseg s-${s}${active === s ? ' on' : ''}" data-state="${s}"${dataAttr} ` +
    `title="${s === 'detail' ? 'show in full detail' : s === 'grouped' ? 'collapse to one box' : 'hide'}">${g}</button>`
  ).join('') + '</span>';
}
// set the detail level for a set of units in one rebuild
function applyDetail(ids, state) {
  const c = new Set(collapsedSet);
  const h = new Set(hiddenSet);
  for (const id of ids) {
    if (state === 'hidden') h.add(id);
    else if (state === 'grouped') { h.delete(id); c.add(id); }
    else { h.delete(id); c.delete(id); }
  }
  collapsedSet = c;
  hiddenSet = h;
  rebuildDisplay();
}

function renderSystemsTree() {
  const root = $('systemsTree');
  if (!units || !Object.keys(units.units).length) {
    root.innerHTML = '<span class="empty">no units</span>';
    return;
  }
  const allIds = Object.keys(units.units);
  let html = `<div class="sysHead sysMaster">
    <span class="sysCaretPad"></span>
    ${detailSegHtml(aggDetail(allIds), ' data-all="1"')}
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
        ${detailSegHtml(aggDetail(list.map(u => u.id)), ` data-type="${type}"`)}
        <span class="sysTitle">${title}</span>
        <span class="sysCount">${list.length}</span>
      </div>
      <div class="sysList" data-type="${type}" style="display:${open ? 'block' : 'none'}">` +
      list.map(u => `
        <div class="sysRow${selectedUnitIdForTree() === u.id ? ' selected' : ''}${hiddenSet.has(u.id) ? ' off' : ''}" data-unit="${esc(u.id)}">
          ${detailSegHtml(unitDetail(u.id), ` data-unit="${esc(u.id)}"`)}
          <span class="sysLabel" data-unit="${esc(u.id)}" title="${esc(u.label)} — click to select">${esc(u.label)}</span>
          <span class="sysCount">${u.members.length}</span>
        </div>`).join('') +
      '</div></div>';
  }
  // ZONES section: a show/hide filter over every zone (graph box + 3D)
  const zoneNames = allZoneNames();
  if (zoneNames.length) {
    const zOpen = sysSectionOpen.zones;
    const shownN = zoneNames.filter(z => !hiddenZones.has(upper(z))).length;
    const aggZ = shownN === zoneNames.length ? 'shown' : shownN === 0 ? 'hidden' : 'mixed';
    html += `<div class="sysSection">
      <div class="sysHead">
        <button class="sysCaret" data-type="zones">${zOpen ? '▾' : '▸'}</button>
        ${zoneSegHtml(aggZ, ' data-zoneall="1"')}
        <span class="sysTitle">ZONES</span>
        <span class="sysCount">${zoneNames.length}</span>
      </div>
      <div class="sysList" data-type="zones" style="display:${zOpen ? 'block' : 'none'}">` +
      zoneNames.map(z => {
        const off = hiddenZones.has(upper(z));
        const sel = selection && selection.kind === 'zone' && upper(selection.zoneName) === upper(z);
        return `<div class="sysRow${sel ? ' selected' : ''}${off ? ' off' : ''}" data-zone="${esc(z)}">
          <button class="zfocus${sel ? ' on' : ''}" data-zfocus="${esc(z)}" title="${sel ? 'focused — click to clear' : 'focus this zone (reveal its connections)'}">${sel ? '◉' : '◎'}</button>
          ${zoneSegHtml(off ? 'hidden' : 'shown', ` data-zone="${esc(z)}"`)}
          <span class="zoneLabel" data-zone="${esc(z)}" title="${esc(z)} — click to focus">${esc(z)}</span>
        </div>`;
      }).join('') +
      '</div></div>';
  }
  root.innerHTML = html;

  // one detail-level control per row (unit / section / master); a segment
  // click sets every unit in scope to that level
  for (const seg of root.querySelectorAll('.dseg[data-state]')) {
    seg.addEventListener('click', () => {
      const state = seg.dataset.state;
      let ids;
      if (seg.dataset.unit) ids = [seg.dataset.unit];
      else if (seg.dataset.type) ids = Object.values(units.units).filter(u => u.type === seg.dataset.type).map(u => u.id);
      else ids = Object.keys(units.units);
      applyDetail(ids, state); // applyLayout drops 'units' overview if anything expands
    });
  }
  // zone on/off toggles (per zone, or the section "all")
  for (const seg of root.querySelectorAll('.dseg[data-zstate]')) {
    seg.addEventListener('click', () => {
      const hide = seg.dataset.zstate === 'hidden';
      const names = seg.dataset.zone ? [seg.dataset.zone] : zoneNames;
      const next = new Set(hiddenZones);
      let turnedOff = false;
      for (const n of names) {
        if (hide) { if (!next.has(upper(n))) turnedOff = true; next.add(upper(n)); }
        else next.delete(upper(n));
      }
      setHiddenZones(next, turnedOff);
    });
  }
  for (const lbl of root.querySelectorAll('.zoneLabel')) {
    lbl.addEventListener('click', () => selectZone(lbl.dataset.zone));
  }
  // explicit focus toggle: focus the zone, or clear if it's already focused
  for (const b of root.querySelectorAll('.zfocus')) {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const z = b.dataset.zfocus;
      const isSel = selection && selection.kind === 'zone' && upper(selection.zoneName) === upper(z);
      if (isSel) clearSelection(); else selectZone(z);
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
  // hover a row → preview its elements in the graph
  for (const rowEl of root.querySelectorAll('.sysRow')) {
    rowEl.addEventListener('mouseenter', () => previewEles(
      rowEl.dataset.zone ? refEles('zone', rowEl.dataset.zone) : unitEles(rowEl.dataset.unit)));
    rowEl.addEventListener('mouseleave', clearPreview);
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
  populateZonePicker();
  if (units) renderSystemsTree(); // refresh the ZONES section with geometry-only zones
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
  // loop classification just changed; refresh a stale loop-family selection
  // (e.g. an 'Other' family picked before playback that now classifies)
  if (selection && selection.kind === 'loopFamily') {
    const fe = loopFamilyEdges(selection.familyKey);
    if (fe && fe.nonempty()) selectLoopFamily(selection.familyKey);
    else clearSelection();
  }
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

function effectiveScale() {
  const s = playbackStats || {};
  return {
    tempMin: scale.tempMin ?? s.tempMin,
    tempMax: scale.tempMax ?? s.tempMax,
    flowMax: scale.flowMax ?? s.flowMax
  };
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
  updateLegendForMetric();
}

// Legend shows only what the active metric uses: the System palette key
// (what the colors mean) for System, the temp ramp + scale for
// Temperature, the flow bar + scale for Flow. Avoids showing temp/flow
// scale inputs that don't apply to the current coloring.
function updateLegendForMetric() {
  const m = currentMetric;
  $('legendSystem').style.display = m === 'system' ? 'flex' : 'none';
  $('legendTemp').style.display = m === 'temperature' ? 'flex' : 'none';
  $('legendFlow').style.display = m === 'massFlow' ? 'flex' : 'none';
  if (m === 'system') {
    const keys = [['air', 'Air'], ['hw', 'HW'], ['chw', 'CHW'], ['cw', 'CW']];
    // only show "Other" when some loop is actually unclassified (violet)
    const hasOther = loopFunctionColors &&
      Object.values(loopFunctionColors).some(c => c === SYSTEM_PALETTE.other);
    if (hasOther) keys.push(['other', 'Other']);
    $('legendSystem').innerHTML = keys
      .map(([k, lbl]) => `<span class="sysKey" data-family="${k}" title="${lbl} — click to select"><i style="background:${SYSTEM_PALETTE[k]}"></i>${lbl}</span>`)
      .join('');
  }
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
    const [d, hm] = String(time.label || '').split(' ');
    $('readoutDate').textContent = hm ? `${d} · ${hm}` : (d || '—');
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
      setEdgeStateLabel(edge, temp, flow);
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

// Node-state readout: when a selection is active and a time is set, each
// selected/linked edge labels its fluid node with the current value (the
// active metric; system mode shows temperature). Non-selected edges keep
// an empty label so the graph stays clean.
function setEdgeStateLabel(edge, temp, flow) {
  let next = '';
  // skip for whole-family selections — labeling every edge would swamp the graph
  if (selection && selection.kind !== 'loopFamily' && (edge.hasClass('sel') || edge.hasClass('linked'))) {
    const useFlow = currentMetric === 'massFlow';
    const val = useFlow ? flow : temp;
    if (Number.isFinite(val)) {
      next = useFlow
        ? `${dispFlow(val).toFixed(2)} ${flowUnit()}`
        : `${dispTemp(val).toFixed(1)} ${tempUnit()}`;
    }
  }
  if ((edge.data('stateLabel') || '') !== next) edge.data('stateLabel', next);
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
  resetFocusReveal(); // re-collapse any neighbors a focused zone had revealed
  if (cy) cy.elements().removeClass('sel linked preview');
  syncZonePicker(null);
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

// graph vertex ids of the zone's immediate neighbors that are currently
// grouped or hidden — the ones a reveal must pull out. Neighbors already
// shown individually are skipped, so the common (ungrouped) view needs no
// rebuild on focus.
function revealCandidates(zoneName) {
  const out = new Set();
  if (!units || !graph || !zoneName) return out;
  const zv = graphZoneVertexByName(zoneName);
  if (!zv) return out;
  for (const el of graph.elements) {
    if (!el.data.source) continue;
    let other = null;
    if (el.data.source === zv.id) other = el.data.target;
    else if (el.data.target === zv.id) other = el.data.source;
    if (!other) continue;
    const u = units.unitOf[other];
    if (u && (hiddenSet.has(u) || collapsedSet.has(u))) out.add(other);
  }
  return out;
}

// rebuild the cy display from the current grouping + reveal sets, preserving
// the active selection (unlike rebuildDisplay, which clears it)
function rebuildDisplayKeepSelection() {
  if (!cy || !units) return;
  createCy(buildDisplayElements());
  applyLayout();
  applyPlaybackToGraph();
}

// drop a focus reveal and re-collapse the neighbors (used when selecting
// anything that isn't a zone). Returns whether a rebuild was needed.
function resetFocusReveal() {
  if (!focusReveal.size) return false;
  focusReveal = new Set();
  rebuildDisplayKeepSelection();
  return true;
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

// zone picker (inspector head): jump to any zone without hunting for it
// in the graph or 3D. Sourced from both the .bnd graph zones and the
// epJSON geometry zones, so it works with either loaded.
function allZoneNames() {
  // dedupe case-insensitively (SQL/.bnd uppercase vs epJSON mixed case);
  // prefer the .bnd graph name so the picker matches the inspector heading
  const byUpper = new Map();
  if (geometry) for (const z of geometry.zones) byUpper.set(upper(z.name), z.name);
  if (graph) for (const k of Object.keys(graph.vertices))
    if (k.startsWith('ZONE|')) { const n = graph.vertices[k].name; byUpper.set(upper(n), n); }
  return [...byUpper.values()].sort((a, b) => a.localeCompare(b));
}
function populateZonePicker() {
  const sel = $('zonePick');
  if (!sel) return;
  const cur = sel.value;
  const names = allZoneNames();
  sel.innerHTML = '<option value="">zone…</option>' +
    names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
  if (cur && names.includes(cur)) sel.value = cur;
}
function syncZonePicker(zoneName) {
  const sel = $('zonePick');
  if (!sel) return;
  const v = zoneName || '';
  sel.value = [...sel.options].some(o => o.value === v) ? v : '';
}

function selectZone(zoneName) {
  const zv = graphZoneVertexByName(zoneName);
  selection = { kind: 'zone', zoneName: zv ? zv.v.name : zoneName };
  syncZonePicker(selection.zoneName);
  // focusing an inactive zone reactivates it — show it on the graph again so
  // the focus (and its revealed connections) actually have something to land on
  if (hiddenZones.has(upper(selection.zoneName))) {
    const next = new Set(hiddenZones);
    next.delete(upper(selection.zoneName));
    hiddenZones = next;
    applyZoneVisibility();
  }
  // focus reveals the zone's immediate neighborhood: the edges touching it and
  // the node at each far end, even when that node is grouped or hidden. Rebuild
  // only when the reveal set actually changes what's displayed.
  const hadReveal = focusReveal.size > 0;
  focusReveal = revealCandidates(selection.zoneName);
  if (cy && units && (focusReveal.size > 0 || hadReveal)) rebuildDisplayKeepSelection();
  if (cy) {
    cy.elements().removeClass('sel linked preview');
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
    cy.elements().removeClass('sel linked preview');
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
  cy.elements().removeClass('sel linked preview');
  edge.addClass('sel');
  edge.connectedNodes().addClass('linked');
  updateZoneHighlights();
  renderEdgeInspector(d, names);
  renderSystemsTree();
  updateMiniChart();
  if (playback) updateTime();
}

/* ── loop-family selection (from the System legend swatches) ──── */
const FAMILY_LABEL = { air: 'Air loops', hw: 'Hot water', chw: 'Chilled water', cw: 'Condenser water', other: 'Other loops' };
function loopFamilyEdges(familyKey) {
  if (!cy) return null;
  const color = SYSTEM_PALETTE[familyKey];
  return cy.edges().filter(e => systemColorForEdge(e) === color);
}
function selectLoopFamily(key) {
  if (!cy) return;
  const edges = loopFamilyEdges(key);
  if (!edges || !edges.nonempty()) return;
  selection = { kind: 'loopFamily', familyKey: key, title: FAMILY_LABEL[key] || key, zoneName: null };
  cy.elements().removeClass('sel linked preview');
  edges.addClass('sel');
  edges.connectedNodes().addClass('linked');
  updateZoneHighlights();
  renderFamilyInspector(key, edges);
  renderSystemsTree();
  updateMiniChart();
  if (playback) updateTime();
}
function renderFamilyInspector(key, edges) {
  const loops = new Set();
  edges.forEach(e => {
    const l = loopNameForGraphId(e.data('source')) || loopNameForGraphId(e.data('target'));
    if (l) loops.add(l);
  });
  const col = SYSTEM_PALETTE[key];
  let html = `<h2>${esc(FAMILY_LABEL[key] || key)}</h2>` +
    `<span class="kindChip" style="color:${col};border-color:${col}">SYSTEM FAMILY</span>`;
  html += kv([['fluid nodes', edges.length], ['loops', loops.size]]);
  if (loops.size) {
    html += '<h3>loops</h3>' + [...loops].sort()
      .map(l => `<div class="conn"><span class="obj">${esc(l)}</span></div>`).join('');
  }
  $('inspectorBody').innerHTML = html;
}

/* ── preview highlight (transient, hover-driven) ─────────────── */
// A soft blue glow shown while hovering a tree row / inspector ref /
// legend swatch — previews what a click would select, without touching
// the actual selection. Pure feedback, so no new controls to learn.
function previewEles(eles) {
  if (!cy) return;
  cy.elements().removeClass('preview');
  if (eles && eles.nonempty && eles.nonempty()) eles.addClass('preview');
}
function clearPreview() { if (cy) cy.elements().removeClass('preview'); }

// the cy elements a unit occupies: its proxy when grouped, else its
// member nodes — plus their edges
function unitEles(unitId) {
  if (!cy) return null;
  const u = units && units.units[unitId];
  if (!u) return cy.collection();
  const proxy = cy.getElementById(unitId);
  if (proxy.nonempty()) return proxy.union(proxy.connectedEdges());
  let col = cy.collection();
  for (const id of u.members) col = col.union(cy.getElementById(id));
  return col.union(col.connectedEdges());
}

// the cy elements an inspector ref points at (mirrors the click handler)
function refEles(kind, val) {
  if (!cy) return null;
  if (kind === 'vertex') {
    const n = cy.getElementById(val);
    if (n.nonempty()) return n.union(n.connectedEdges());
    const uid = units && units.unitOf[val];
    return uid ? unitEles(uid) : cy.collection();
  }
  if (kind === 'unit') return unitEles(val);
  if (kind === 'zone') {
    const zv = graphZoneVertexByName(val);
    if (!zv) return cy.collection();
    const box = cy.getElementById(zv.id);
    return box.union(box.connectedEdges());
  }
  if (kind === 'node') {
    return cy.edges().filter(e => String(e.data('label') || '').split(' ⇒ ')[0] === val);
  }
  return cy.collection();
}

// Select a fluid node by name (from an inspector ref). Prefer its visible
// edge; if the node is hidden inside a collapsed unit, fall back to the
// component that owns it so the click still lands somewhere coherent.
function selectEdgeByNode(nodeName) {
  if (cy) {
    const edge = cy.edges().filter(e =>
      String(e.data('label') || '').split(' ⇒ ')[0] === nodeName)[0];
    if (edge && edge.nonempty()) { selectEdge(edge); return; }
  }
  const owner = graph && Object.values(graph.vertices).find(v =>
    v.pairs.some(p => p.inlet === nodeName || p.outlet === nodeName));
  if (owner) { selectVertex(owner.id); return; }
  // last resort: node-only selection so the chart still tracks it
  selection = { kind: 'edge', nodeName, title: nodeName, zoneName: null };
  if (cy) cy.elements().removeClass('sel linked preview');
  updateZoneHighlights();
  renderSystemsTree();
  updateMiniChart();
  if (playback) updateTime();
}


function onGraphNodeTap(n) {
  const d = n.data();
  if (d.isGroup) { clearSelection(); return; }
  if (d.isUnit) { selectUnit(d.id); return; }
  selectVertex(d.id);
}

function selectUnit(unitId, opts = {}) {
  const u = units && units.units[unitId];
  if (!u || !cy) return clearSelection();
  selection = { kind: 'unit', unitId, title: u.label, zoneName: u.type === 'zoneeq' ? u.label.split(' · ')[0] : null };
  cy.elements().removeClass('sel linked preview');
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
    const inner = `<span class="ct">${esc(v ? v.type : '')}</span><br><span class="obj">${esc(v ? v.name : id)}</span>`;
    return connBlock(id, inner);
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

// Inspector reference links: every object/node/zone named in the sidebar
// becomes a clickable ref that drives the shared selection (graph + 3D +
// chart + inspector), via the delegated handler on #inspectorBody.
// `inner` is already-safe HTML; `value` is escaped into the attribute.
function ref(kind, value, inner) {
  return `<span class="ref" data-rk="${kind}" data-rv="${esc(value)}">${inner}</span>`;
}
// a graph id that may be a real vertex or a collapsed unit proxy
function idRef(id, inner) {
  if (graph && graph.vertices[id]) return ref('vertex', id, inner);
  if (units && units.units[id]) return ref('unit', id, inner);
  return inner;
}
// a .conn card, made clickable only when the named object is selectable
function connBlock(vid, inner) {
  const selectable = graph && graph.vertices[vid];
  return `<div class="conn${selectable ? ' ref' : ''}"` +
    (selectable ? ` data-rk="vertex" data-rv="${esc(vid)}"` : '') + `>${inner}</div>`;
}

function nodeInfoRow(name) {
  const info = model && model.nodes[name];
  const inner = info
    ? `${esc(name)} <span style="color:var(--ink-faint)">(${esc(info.fluidType)}` +
      (info.suspicious ? ', <span class="suspicious">suspicious</span>' : '') + ')</span>'
    : esc(name);
  return ref('node', name, inner);
}

function connectionsHtml(nodeNames) {
  const out = [];
  for (const n of nodeNames) {
    for (const c of (graph && graph.connectionsByNode[n]) || []) {
      const vid = `${c.objectType}|${c.objectName}`;
      const inner = `<span class="ct">${esc(c.connectionType)}</span> @ ${esc(n)}<br>` +
        `<span class="obj">${esc(c.objectType)} — ${esc(c.objectName)}</span>`;
      out.push(connBlock(vid, inner));
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
  if (v.zone) rows.push(['serves zone', ref('zone', v.zone, esc(v.zone))]);
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
    ['from', idRef(d.source, esc(String(d.source).split('|')[1] ?? d.source))],
    ['to', idRef(d.target, esc(String(d.target).split('|')[1] ?? d.target))],
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
  // the 'units' overview only has proxies for grouped units; if anything
  // got expanded (via the detail control, double-tap, or context menu)
  // it has no proxy and would land as a stray column — fall back to system
  if ($('layoutMode').value === 'units' && units &&
      Object.values(units.units).some(u => unitDetail(u.id) === 'detail')) {
    $('layoutMode').value = 'system';
  }
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
  if (hiddenZones.size) applyZoneVisibility(); // reapply after the rebuild
}

function applyFilter() {
  if (!cy) return;
  const loop = $('loopFilter').value;
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
$('lockToggle').addEventListener('click', () => {
  graphLocked = !graphLocked;
  if (cy) cy.autoungrabify(graphLocked);
  const btn = $('lockToggle');
  btn.classList.toggle('on', graphLocked);
  btn.textContent = graphLocked ? '🔒 locked' : '🔓 unlocked';
  btn.title = graphLocked
    ? 'nodes locked — click-drag pans. Unlock to rearrange nodes.'
    : 'nodes unlocked — drag to rearrange. Lock to pan by dragging.';
});
$('resetCam').addEventListener('click', fitThreeCamera);
$('zoneOpacity').addEventListener('input', () => {
  zoneOpacity = Number($('zoneOpacity').value) / 100;
  updateZoneHighlights();
});
$('zonePick').addEventListener('change', () => {
  const v = $('zonePick').value;
  if (v) selectZone(v); else clearSelection();
});

initCharting(); // chart pane hover + resize wiring (owned by chart.js)

/* inspector reference links: click any named object/node/zone to select
   it across all views (graph + 3D + chart + inspector) */
$('inspectorBody').addEventListener('click', e => {
  const el = e.target.closest('.ref');
  if (!el || !graph) return;
  const kind = el.dataset.rk;
  const val = el.dataset.rv;
  if (kind === 'vertex') {
    if (!graph.vertices[val]) return;
    const node = cy && cy.getElementById(val);
    if (node && node.nonempty()) { selectVertex(val); return; }
    const uid = units && units.unitOf[val]; // hidden in a collapsed unit
    if (uid && cy && cy.getElementById(uid).nonempty()) selectUnit(uid, { jump: true });
    else selectVertex(val);
  } else if (kind === 'node') {
    selectEdgeByNode(val);
  } else if (kind === 'zone') {
    selectZone(val);
  } else if (kind === 'unit') {
    selectUnit(val, { jump: true });
  }
});
// hover an inspector ref → preview its target in the graph
$('inspectorBody').addEventListener('mouseover', e => {
  const el = e.target.closest('.ref');
  if (el) previewEles(refEles(el.dataset.rk, el.dataset.rv));
});
$('inspectorBody').addEventListener('mouseout', e => {
  if (e.target.closest('.ref')) clearPreview();
});

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
    setDisplayUnits(btn.dataset.units);
    for (const b of document.querySelectorAll('#unitToggle button')) b.classList.toggle('on', b === btn);
    updateLegend();
    updateMiniChart();
    if (playback) updateTime();
  });
}

for (const btn of document.querySelectorAll('#themeToggle button')) {
  btn.addEventListener('click', () => {
    currentTheme = btn.dataset.theme;
    for (const b of document.querySelectorAll('#themeToggle button')) b.classList.toggle('on', b === btn);
    document.body.classList.toggle('light', currentTheme === 'light');
    if (cy) { cy.style(buildCyStyle(currentTheme)); applyPlaybackToGraph(); }
    applyTheme3d();
  });
}
$('timeSlider').addEventListener('input', updateTime);
$('playBtn').addEventListener('click', () => setPlaying(!playTimer));
$('playSpeed').addEventListener('change', () => { if (playTimer) setPlaying(true); });

for (const btn of document.querySelectorAll('#metric button')) {
  btn.addEventListener('click', () => {
    currentMetric = btn.dataset.metric;
    for (const b of document.querySelectorAll('#metric button')) b.classList.toggle('on', b === btn);
    updateLegendForMetric();
    if (playback) updateTime();
  });
}

// System legend swatches: hover previews the loop family, click selects it
$('legendSystem').addEventListener('mouseover', e => {
  const k = e.target.closest('.sysKey');
  if (k && k.dataset.family) previewEles(loopFamilyEdges(k.dataset.family));
});
$('legendSystem').addEventListener('mouseout', e => {
  if (e.target.closest('.sysKey')) clearPreview();
});
$('legendSystem').addEventListener('click', e => {
  const k = e.target.closest('.sysKey');
  if (k && k.dataset.family) selectLoopFamily(k.dataset.family);
});

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

window.addEventListener('resize', () => { resizeThree(); alignScrubber(); });

/* panel grabbers + per-panel collapse */
function viewsResized() {
  if (cy) cy.resize();
  resizeThree();
  alignScrubber();
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
    // re-fit the graph so its content fills the resized pane (collapsing
    // the 3D / a side panel widens the graph; without this the diagram
    // stays bunched in its old footprint)
    if (cy) cy.fit(cy.elements(':visible'), 30);
  });
}

clearSelection();
updateLegendForMetric(); // match the default (System) metric before any data loads

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
