// Selection chart pane: sparklines of the selected object's series (zone
// temp + inlets / edge temp+flow / unit & loop-family heaviest-flow nodes),
// drawn into an offscreen cache, with a hover crosshair + tooltip and the
// transport scrubber aligned to the plot's x-axis. Reads app state via
// live ES module bindings.
import {
  $, esc, playback, selection, graph, units, playbackStats, currentTheme,
  selectedTimeIndex, zoneSeriesFor, graphZoneVertexByName, loopFamilyEdges, setTimeIndex
} from './app.js';
import { flowUnit, tempUnit, dispTemp, dispFlow } from './palette.js';

const MINI_COLORS = ['#e0a33b', '#4f9dd9', '#52b788', '#d96a6a'];
let miniSeries = [];
let miniCache = null;
let miniPlot = null; // plot-rect padding so the marker tracks the axes
let miniGeom = null; // full plot geometry (device px) for hover + scrubber align
let hoverIndex = null; // chart hover sample index (null = not hovering)

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
  } else if (selection.kind === 'unit' || selection.kind === 'loopFamily') {
    const names = new Set();
    if (selection.kind === 'unit') {
      const u = units && units.units[selection.unitId];
      for (const id of (u ? u.members : [])) {
        const v = graph.vertices[id];
        for (const p of (v ? v.pairs : [])) {
          if (p.inlet) names.add(p.inlet);
          if (p.outlet) names.add(p.outlet);
        }
      }
    } else {
      const edges = loopFamilyEdges(selection.familyKey);
      if (edges) edges.forEach(e => {
        const n = String(e.data('label') || '').split(' ⇒ ')[0];
        if (n) names.add(n);
      });
    }
    // heaviest-flow nodes are the main supply/return runs
    const peaks = (playbackStats && playbackStats.nodePeaks) || new Map();
    const ranked = [...names]
      .filter(n => playback.nodes && playback.nodes[n])
      .sort((a, b) => (peaks.get(b) || 0) - (peaks.get(a) || 0));
    for (const n of ranked.slice(0, 4)) addNode(n);
  }
  return out.slice(0, 4);
}

export function updateMiniChart() {
  miniSeries = computeMiniSeries();
  $('miniChartTitle').textContent =
    selection && miniSeries.length ? selection.title || selection.zoneName || '' : '';
  $('miniLegend').innerHTML = miniSeries
    .map((s, i) => `<span><i style="background:${MINI_COLORS[i]}"></i>${esc(s.label)}</span>`)
    .join('');
  const empty = miniSeries.length === 0;
  $('chartEmpty').style.display = empty ? 'flex' : 'none';
  $('miniChartCanvas').style.visibility = empty ? 'hidden' : 'visible';
  if (empty) {
    miniCache = null; miniGeom = null; hoverIndex = null;
    $('chartTip').hidden = true;
    alignScrubber();
    return;
  }
  renderMiniCache();
  drawMiniChart();
  alignScrubber();
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
  miniGeom = { dpr, padL, padR, padT, padB, plotW, plotH, w, h, ranges };

  const ink = currentTheme === 'light' ? '#97a3b4' : '#4d5a6e';
  const inkStrong = currentTheme === 'light' ? '#5d6b7e' : '#7c8aa0';
  ctx.strokeStyle = ink;
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.5;
  ctx.strokeRect(padL, padT, plotW, plotH);
  ctx.globalAlpha = 1;

  ctx.font = `${9 * dpr}px 'JetBrains Mono', monospace`;
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

export function drawMiniChart() {
  if (!miniCache || !miniSeries.length) return;
  const canvas = $('miniChartCanvas');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(miniCache, 0, 0);
  const n = ((playback && playback.times) || []).length;
  if (n < 2) return;
  const plot = miniPlot || { l: 0, r: 0 };
  const xAt = idx => plot.l + (idx / (n - 1)) * (canvas.width - plot.l - plot.r);

  // playback time marker (amber)
  const px = xAt(selectedTimeIndex);
  ctx.strokeStyle = currentTheme === 'light' ? '#d97c00' : '#ffc66b';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(px, 0);
  ctx.lineTo(px, canvas.height);
  ctx.stroke();

  // hover crosshair + value dots on each series
  if (hoverIndex != null && miniGeom) {
    const g = miniGeom;
    const hx = xAt(hoverIndex);
    ctx.strokeStyle = currentTheme === 'light' ? '#5d6b7e' : '#aebdd3';
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.moveTo(hx, g.padT);
    ctx.lineTo(hx, g.padT + g.plotH);
    ctx.stroke();
    ctx.globalAlpha = 1;
    miniSeries.forEach((sr, i) => {
      const r = g.ranges[sr.kind];
      const v = sr.values[hoverIndex];
      if (!r || !Number.isFinite(v)) return;
      const y = g.padT + g.plotH - ((v - r.min) / (r.max - r.min)) * g.plotH;
      ctx.fillStyle = MINI_COLORS[i];
      ctx.beginPath();
      ctx.arc(hx, y, 2.6 * g.dpr, 0, Math.PI * 2);
      ctx.fill();
    });
  }
}

// hover tooltip: vertical list of datetime + each series value at the
// hovered x. Pointer-events stay off the tip so it never steals the hover.
const seriesShortLabel = sr => String(sr.label).split(' · ')[0];

// clamp=true pins x to the plot ends (for scrubbing past the edges); when
// false, off-plot x returns null so hover doesn't show outside the axes
function chartIndexFromEvent(ev, clamp = false) {
  if (!miniGeom || !miniSeries.length) return null;
  const rect = $('miniChartCanvas').getBoundingClientRect();
  const plotL = miniGeom.padL / miniGeom.dpr;
  const plotR = rect.width - miniGeom.padR / miniGeom.dpr;
  const x = ev.clientX - rect.left;
  if (!clamp && (x < plotL - 3 || x > plotR + 3)) return null;
  const n = ((playback && playback.times) || []).length;
  if (n < 2) return null;
  const frac = Math.max(0, Math.min(1, (x - plotL) / (plotR - plotL)));
  return Math.round(frac * (n - 1));
}

// click/brush the chart to set the playback time (moves the marker + scrubber
// and refreshes the branch readouts). Dragging scrubs continuously.
let scrubbing = false;
function onChartDown(ev) {
  const idx = chartIndexFromEvent(ev, true);
  if (idx == null) return;
  scrubbing = true;
  setTimeIndex(idx);
  ev.preventDefault();
}
function onScrubMove(ev) {
  if (!scrubbing) return;
  const idx = chartIndexFromEvent(ev, true);
  if (idx != null) setTimeIndex(idx);
}
function endScrub() { scrubbing = false; }

function onChartHover(ev) {
  const idx = chartIndexFromEvent(ev);
  const tip = $('chartTip');
  if (idx == null) { hoverIndex = null; tip.hidden = true; drawMiniChart(); return; }
  hoverIndex = idx;
  const t = playback.times[idx];
  let html = `<div class="tipDate">${esc(t ? t.label : '')}</div>`;
  miniSeries.forEach((sr, i) => {
    const v = sr.values[idx];
    const conv = sr.kind === 'flow' ? dispFlow : dispTemp;
    const unit = sr.kind === 'flow' ? flowUnit() : tempUnit();
    const txt = Number.isFinite(v) ? `${conv(v).toFixed(sr.kind === 'flow' ? 2 : 1)} ${unit}` : '—';
    html += `<div class="tipRow"><i style="background:${MINI_COLORS[i]}"></i>${esc(seriesShortLabel(sr))}<b>${esc(txt)}</b></div>`;
  });
  tip.innerHTML = html;
  tip.hidden = false;
  const body = $('chartBody').getBoundingClientRect();
  const tr = tip.getBoundingClientRect();
  let lx = ev.clientX - body.left + 14;
  let ly = ev.clientY - body.top + 12;
  if (lx + tr.width > body.width) lx = ev.clientX - body.left - tr.width - 14;
  if (ly + tr.height > body.height) ly = body.height - tr.height - 4;
  tip.style.left = `${Math.max(2, lx)}px`;
  tip.style.top = `${Math.max(2, ly)}px`;
  drawMiniChart();
}

// Keep the transport scrubber the same width as the chart's plot area so
// the slider thumb sits directly under the chart's time marker. Falls back
// to spanning between the readout and speed selector when no chart is up.
export function alignScrubber() {
  const wrap = $('scrubWrap');
  if (!wrap) return;
  const tRect = $('transport').getBoundingClientRect();
  const minLeft = $('readout').getBoundingClientRect().right - tRect.left + 16;
  const minRight = tRect.right - $('playSpeed').getBoundingClientRect().left + 16;
  let left = minLeft, right = minRight;
  const chartOn = miniSeries.length && miniGeom && !$('chartPane').classList.contains('closed');
  if (chartOn) {
    const cRect = $('miniChartCanvas').getBoundingClientRect();
    const pl = cRect.left + miniGeom.padL / miniGeom.dpr;
    const pr = cRect.left + cRect.width - miniGeom.padR / miniGeom.dpr;
    left = Math.max(minLeft, pl - tRect.left);
    right = Math.max(minRight, tRect.right - pr);
  }
  wrap.style.left = `${left}px`;
  wrap.style.right = `${right}px`;
}

// chart pane event wiring (called once from app.js): hover crosshair on the
// canvas + re-render when the pane resizes
export function initCharting() {
  const canvas = $('miniChartCanvas');
  canvas.addEventListener('mousemove', onChartHover);
  canvas.addEventListener('mousedown', onChartDown);
  canvas.style.cursor = 'crosshair';
  // scrub continues while dragging anywhere, and ends on release
  window.addEventListener('mousemove', onScrubMove);
  window.addEventListener('mouseup', endScrub);
  canvas.addEventListener('mouseleave', () => {
    hoverIndex = null; $('chartTip').hidden = true; drawMiniChart();
  });
  new ResizeObserver(() => {
    if (miniSeries.length && !$('chartPane').classList.contains('closed')) {
      renderMiniCache();
      drawMiniChart();
    }
    alignScrubber();
  }).observe($('chartPane'));
}
