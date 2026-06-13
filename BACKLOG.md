# Backlog

Feature queue for the prototype, roughly ordered. Items marked (Mike,
2026-06-12) came from the first UX prototyping session.

## Queued

- **Multi-selection + search box** (Mike, 2026-06-12): text search over
  components/zones/nodes with type-ahead; multi-select (ctrl-click and
  search-driven) feeding the same highlight/inspector pipeline.
- **Select by loop / by object type** (Mike, 2026-06-12): one-click
  selection of e.g. all chillers, all hot-water loops, all CW piping.
  Loop kind + object class are explicit in the .bnd; loop *function*
  (HW/CHW/CW) reuses the playback-driven classifier behind the System
  palette.
- **Flow particles / stronger motion**: marching dashes are in; a canvas
  overlay synced to cy's viewport transform could draw per-edge particle
  advection (speed ∝ velocity) without changing render engines. Only if
  dashes prove insufficient.
- **Playback JSON size**: 94 MB for Large Office hourly. Options:
  Float32 binary sidecar, per-series delta encoding, or on-demand node
  series fetch. Matters once sharing/deploying.
- **HVACTopology SQL source** (E+ 24.2+): alternative topology source
  behind the parser seam — future-proofing, parked.
- **@timestep/core promotion**: parser/graph/layout graduate into core
  once the demo shape settles (PROMPT.md step 3).

## Done (this session)

- **Public demo deployed**: https://eplus-bnd-viz.pages.dev (Cloudflare
  Pages project `eplus-bnd-viz`, wrangler-deployed from `npm run
  build:demo` output — decimated playback: offices 3-hourly, hospital
  4-hourly, values rounded to 3 decimals). Repo stays private at
  github.com/michaelsweeney/eplus-bnd-branch-visualizer. Redeploy:
  `npm run build:demo && npx wrangler pages deploy dist --project-name
  eplus-bnd-viz`. BYO-model docs in README.
- UI declutter pass: theme/units/colorscale into a topbar ⚙ popover;
  collapse/expand-all moved from the graph toolbar into a right-click
  context menu (per-object group/hide/select + background view actions).
- Per-unit show/hide checkbox column in the systems tree (next to the
  expand/group column), with tri-state section toggles.
- Loop boundary rectangles in the system-flow layout (one labeled box
  per loop, supply+demand sides together, membership by layout band).
- Single 3-state detail control per tree row (● detail / ◐ grouped /
  ○ hidden) replacing the group toggle + show/hide checkbox; metric-aware
  legend (System palette key / temp ramp / flow bar by active metric).
- Interactivity: hover-preview glow (tree rows + inspector refs) and
  clickable System-legend swatches that select a whole loop family.
- Module split (partial): 3D zone view → src/zones3d.js, selection chart
  → src/chart.js, via live ES-module bindings (app.js stays state owner).
  app.js 2366 → 1857 lines. The remaining core (graph build/layout,
  selection, tree, inspector, playback) is intentionally left as the
  orchestrator — it's tightly coupled (selection drives all five views),
  so further splitting would create cyclic modules, not cleaner ones. A
  leaf palette/format util module is the one clean extraction left if an
  even leaner app.js is wanted later.

- Unit collapse/expand (AHU / plant side / distribution / zone equip)
  with double-click + ⊟/⊞ all; stateless display rebuild.
- Component icon glyphs by object class; unit-type glyphs.
- Unit overview layout (max-collapsed plant→AHU→dist→zones columns).
- Capacity-sized edges (width = node peak flow over the run) with
  live utilization opacity.
- Directional flow motion: marching dashes on flowing edges while
  playing.
- System palette default (air amber / HW red / CHW blue / CW green),
  loop function classified from operating temps, not names.
- Dark + light engineering themes (8-bit theme built then retired
  2026-06-12 per Mike).
- Systems tree with jump-to navigation; plant loop sides merged into
  one unit per loop.
- Mini chart overlay: selection sparklines with live time marker.
- SI / IP display unit toggle (°C↔°F, kg/s↔lb/min).
- Panel splitters (graph/3D, inspector) + per-panel collapse.
- Hospital demo dataset + dataset selector.
- State-sharing hash params: dataset/theme/layout/collapse/t/play/sel.
