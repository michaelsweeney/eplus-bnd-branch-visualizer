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
- **Light mode** (Mike, 2026-06-12): theme system already supports
  multiple cy stylesheets + CSS var sets (pro/mario); add a light
  engineering theme as a third option.
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
- 8-bit theme (pipes green, ducts silver, Press Start 2P).
- Panel splitters (graph/3D, inspector) + per-panel collapse.
- Hospital demo dataset + dataset selector.
- State-sharing hash params: dataset/theme/layout/collapse/t/play/sel.
