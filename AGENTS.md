# AGENTS.md

Guidance for coding agents (Codex, Claude Code) working in this repository.

## What this is

**eplus-bnd-branch-visualizer** — a browser-only EnergyPlus HVAC visualizer. No
backend; static Vite + vanilla ES modules. It parses an EnergyPlus `.bnd`
(branch/node) file plus epJSON geometry and renders:

- a **Cytoscape** branch/loop graph (the "system graph" / HVAC view),
- a **Three.js** 3D zone view (zone surfaces, temperature heatmap),
- a **playback timeline** + annual line chart driven by 8760-hour series.

The three surfaces are **coordinated views of one shared selection** — selecting
a zone/node/edge in any one drives highlighting, isolate-dimming, 3D, chart, and
the inspector together.

## Architecture

- `src/app.js` (~2100 lines) — orchestrator: state, selection model, isolate
  scoping, Cytoscape setup, pane/splitter wiring, inspector rendering. Exports
  live ES-module bindings consumed by the view modules.
- `src/zones3d.js` — Three.js 3D zone view; imports live state from app.js.
- `src/chart.js` — annual line chart + scrub-to-set-time.
- `src/palette.js` — color scales (temperature heatmap, static zone colors).
- `src/parsebnd.js` / `src/parsegeometry.js` / `src/buildgraph.js` /
  `src/layoutbnd.js` / `src/units.js` — parsing + graph/unit construction.
- `index.html` / `src/app.css` — single-page shell + all styling.

### Layout (relevant to UI work)

`#workspace` is a flex row: `#systems` (tree, left, collapsible) | `#panes`
(center column: `#panesRow` = `#graphPane` + `#zonePane` side-by-side, with
`#chartPane` below) | `#inspector` (right, collapsible). All panes already
support: collapse-to-30px-strip (`.paneToggle` → `.closed`) and drag-resize via
splitters (`wireSplitter`).

## Conventions

- Vanilla ES modules, no framework. Keep it dependency-light.
- Typography split: `--sans` (IBM Plex Sans) for UI chrome, `--mono`
  (JetBrains Mono) for EnergyPlus identifiers + data values.
- Dark engineering-tool aesthetic is the settled baseline.
- Handoffs from Claude Code live under `.claude/handoffs/YYYY-MM-DD-<slug>.md`,
  each self-contained.
