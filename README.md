# eplus-bnd-branch-visualizer

EnergyPlus node/system analysis tool: HVAC topology from the `.bnd`
(Branch Node Details) report, 3D zone geometry from epJSON, and timeseries
playback from `eplusout.sql` — three synchronized views with the long-term
goal of an auto-play temporal slider visualizing thermal flow through
system nodes.

Spun out of [timestep](https://github.com/michaelsweeney/timestep)
2026-06-11. **Status: working prototype**, with a public hosted demo at
**https://eplus-bnd-viz.pages.dev** (the GitHub repo is private; the
Cloudflare Pages site is public independently). Copied here from
timestep's `explorations/bnd-viz/`; see `PROMPT.md` for the original
kickoff brief and `BACKLOG.md` for what's queued.

## Local prototype

A Vite app (`npm run dev`, default http://localhost:5173/) — vanilla ES
modules, no framework; cytoscape/three come from npm. `index.html` is
markup only. The runtime is `src/app.js` (loading, graph build/style/
layout, the selection model, systems tree, inspector, playback) plus
cohesive view modules it drives via live ES-module bindings —
`src/zones3d.js` (Three.js 3D zones), `src/chart.js` (selection chart
pane), `src/palette.js` (value→color ramps + SI/IP display units) — over
the `parsebnd`/`buildgraph`/`layoutbnd`/`units` libraries shared with the
node test suite. Styles in `src/app.css`. `npm run build` emits `dist/`.
Demo datasets live in gitignored `public/demo-data/` and auto-load in
dev (dataset selector: Large Office VAV / Hospital / Small Office).

Opens in **Temperature** metric, **IP** units, with a 40–120 °F scale by
default.

- **Panels**: a systems tree (unit hierarchy in sections; one 3-state
  **detail control** per row — ● full detail / ◐ grouped to one box / ○
  hidden — at unit, section, and "all systems" scope; zone equipment +
  distribution group by default), the system graph (Cytoscape; system-
  flow / organic / unit-overview layouts, loop filter, right-click
  context menu for group/hide/select), 3D zones (Three.js, with a
  non-selected-zone opacity slider), an inspector sidebar with a **zone
  picker** to jump to any zone, and a collapsible bottom **chart pane**
  (sparklines of the selection with a hover crosshair + tooltip) above
  the transport bar (play/pause, speed, annual scrub aligned to the chart
  x-axis; space / ←→ keyboard control). All panels resize and collapse;
  theme / SI-IP units / colorscale live in the topbar ⚙ popover. The
  system-flow layout draws each loop as a labeled boundary rectangle
  around its band (a plant loop's supply + demand share one box), by
  layout band so a dual-membership component (an air-loop coil on a CHW
  demand branch) lands in one box only.
- **Metric toggle** (System | Temperature | Flow): System colors by loop
  function (air amber, HW red, CHW blue, CW green — plant loops
  classified by operating temps, not names); Temperature/Flow use ramps.
  The legend shows only the active metric's key (the System palette
  swatches, or the temp ramp / flow bar with editable domains). Edge
  width = capacity (node peak flow over the run), opacity = live
  utilization; with a selection + a time set, each linked edge labels its
  node with the current value. Zone boxes and 3D surfaces heatmap by zone
  mean air temperature (node temps percentile-clipped — stagnant coil
  outlet nodes report physically absurd temperatures at zero flow).
- **Linked selection** drives every view at once. Click a zone (graph,
  3D, or the inspector picker) → it highlights in all panes, lights its
  connected HVAC nodes/edges, and shows its epJSON + geometry + node
  connections in the inspector. Click a component → its connected objects
  and served zone light up; click an edge → the fluid node. Inspector
  references are clickable, and hovering a tree row / inspector reference
  previews its graph elements. Clicking a System-legend swatch selects a
  whole loop family (all HW, all CHW, …).
- **Drag-drop** any `.bnd`, epJSON, or playback JSON to replace the
  loaded set.
- Run `npm test` for the parser/graph/layout/units/prep/export suites.
- Hash params: `#dataset=<key>` or `#bnd=/#geometry=/#data=<url>` pick
  the data; `#t=<index>`, `#play=1`, `#sel=<zone name>`,
  `#theme=light`, `#layout=system|organic|units`, `#collapse=all`
  restore a shareable app state.

## Hosted demo build

`npm run build:demo` produces a deployable `dist/`: the app bundle plus
decimated copies of the demo datasets (3-hourly for the offices,
4-hourly for the hospital, values rounded to 3 decimals — 90–214 MB
playback JSONs become 3–18 MB, under Cloudflare Pages' 25 MB file cap).
Deploy with `npx wrangler pages deploy dist --project-name <name>`.
The plain `npm run build` keeps full-resolution data for local use.

## Bring your own model

Drag any of these onto the running app — each layer degrades
gracefully:

- **`.bnd` alone** → the full topology graph. Every EnergyPlus run
  writes `eplusout.bnd`; any version, no preparation.
- **+ epJSON** → 3D zone geometry (`ConvertInputFormat --epJSON` turns
  an IDF into one).
- **+ playback JSON** → the temporal layer. This is the only part that
  needs the model prepared before the run: two output variables and
  SQLite output —

  ```text
  Output:Variable, *, System Node Temperature, Hourly;
  Output:Variable, *, System Node Mass Flow Rate, Hourly;
  Output:SQLite, SimpleAndTabular;
  ```

  `npm run prep` injects these for you (and `--run` executes a
  version-matched EnergyPlus); `npm run export:playback` then converts
  `eplusout.sql` into the playback JSON. Oversized result? Shrink it
  with `node scripts/decimate-playback.mjs`.

## End-to-end demo (validated 2026-06-12)

The full chain — IDF in, three synchronized views out — against a real
EnergyPlus 22.1 install:

```sh
node scripts/prep-epjson.mjs model.idf \
  --out public/demo-data/model.prepped.epJSON \
  --preset nodes-hourly \
  --run --weather path/to/weather.epw \
  --output-dir public/demo-data/run

node scripts/export-playback.mjs public/demo-data/run/eplusout.sql \
  --out public/demo-data/model.playback.json

npm run dev
# open http://localhost:5173/#bnd=demo-data/run/eplusout.bnd&geometry=demo-data/model.prepped.epJSON&data=demo-data/model.playback.json
```

The small-office ASHRAE 901 STD2022 Seattle prototype produced 86 node
series × 8760 hourly timesteps. `public/demo-data/` is gitignored
scratch space for this workflow (files under `public/` are served at
the site root, so fetch URLs stay `demo-data/...`).

The showcase set is the Large Office STD2022 New York prototype (VAV
with reheat + chiller/boiler/tower plant): 357 node series + 23 zone
series × 8760 h (94 MB playback JSON; the exporter batches its SQL reads
to survive this scale). Winter vs summer timesteps show visibly
different zone heatmaps and reheat-loop activity:

```text
#t=400              January evening
#t=4263             late-June afternoon
#play=1             autoplay from t=0
#dataset=hospital   701 nodes + 55 zones
```

Headless screenshots need software WebGL enabled for the 3D view:

```sh
google-chrome --headless --no-sandbox --enable-unsafe-swiftshader \
  --screenshot=/tmp/shot.png --window-size=1400,900 --virtual-time-budget=15000 \
  'http://localhost:5173/#t=4263'
```

Without WebGL the 3D view degrades to an explanatory message instead of
a blank canvas.

Prep an epJSON model for node-level playback data:

```sh
npm run prep -- path/to/model.epJSON --out path/to/model.prepped.epJSON
```

The prep helper injects `System Node Temperature`, `System Node Mass Flow
Rate`, and `Output:SQLite, SimpleAndTabular`. Add `--run --weather
path/to/weather.epw` to run the version-matched EnergyPlus executable
from `~/programs/energyplus/<version>/`. IDF input is accepted too; the
helper detects the `Version` object, runs version-matched
`ConvertInputFormat --epJSON`, then patches the converted epJSON. Use
`--version <version>` when the input version cannot be inferred.

Export node-level playback data from EnergyPlus SQLite:

```sh
npm run export:playback -- path/to/eplusout.sql --out path/to/playback.json
```

The export looks for `System Node Temperature` and `System Node Mass Flow
Rate` in `ReportDataDictionary`. If the SQL was not generated from a
prepped model, the export still writes time metadata and reports that no
matching node series were found.

## What exists today

- `parsebnd.js` — full parser for the self-documenting .bnd record types
  (every record has a `! <Type>,<field>,...` header; trim + split-on-comma
  is safe since IDF names can't contain commas).
- `buildgraph.js` — components as vertices, EnergyPlus fluid nodes as
  edges; loops as compound groups; per-endpoint container suppression
  (partially-decomposed parents like air terminals keep uncovered
  endpoints without duplicating child edges); node-connection backfill for
  components with no structured node rows (return plenums, ERV secondary
  streams).
- `layoutbnd.js` — deterministic "system flow" schematic: columns
  left→right are plant supply → AHU/airside → distribution → zones →
  return path; one horizontal band per system; topological rank within
  each cell; stacks wrap at 14. Classification prefers branch membership,
  falls back to node fluid type (reheat coils draw airside, air-cooled
  chillers stay waterside). Band inference walks Air edges only.
- `src/app.js` + `index.html` — the explorer app and its core (see
  "Local prototype" above); click drill-down reaches every object
  touching a node (setpoint managers, controllers).
- `src/zones3d.js` / `src/chart.js` / `src/palette.js` — extracted view
  modules: the Three.js zone view, the selection chart pane, and the
  color/SI-IP utility layer. They read shared app state through live ES
  bindings, so app.js stays the single state owner.
- `src/units.js` — collapsible unit membership (AHU / plant side /
  distribution / zone equipment) from explicit .bnd structure,
  containment-first.
- `collect-samples.mjs` — embeds local .bnd files into a gitignored
  `samples.js` (legacy of the file:// demo; the app now fetches
  `public/demo-data/` instead).

Validated against 8 models (22.1 + 25.2; office/hotel/hospital/apartment
archetypes): zero orphaned flow vertices, full loop closure.

## Is .bnd safe to build on? (researched 2026-06-11)

Yes. The writer (`BranchNodeConnections.cc`, `ReportLoopConnections`) has
substantive commits through June 2026; the record format is byte-stable
across 22.1→25.2 (59 record types, zero diff); the official docs state the
file exists "to support software which draws a schematic diagram of the
HVAC system." The half-remembered "unmaintained" claim refers to the
legacy Fortran HVAC-Diagram tool (its Python replacement has been a
stalled draft since 2021). Strategic hedge: the `HVACTopology` tabular
report (E+ 24.2+, lands in eplusout.sql) is the future machine-readable
topology source — keep the parser behind a seam so a SQL-backed source
can swap in for ≥24.2 models.

## Planned shape (agreed 2026-06-11)

- **Input bundle**: epJSON model + outputs (.sql / .eso / .bnd).
- **Prep helper as the gate**: inject `System Node Temperature` +
  `System Node Mass Flow Rate` (tiered presets: nodes / nodes+surfaces /
  everything), force `Output:SQLite, SimpleAndTabular`, optionally run the
  version-matched engine. IDF auto-converts via `ConvertInputFormat`.
  "Ran through prep" is a documented requirement, not a runtime failure;
  topology-only degraded mode when node data is absent.
- **Three synchronized views off one Time index**: topology graph (edge
  color/width = temp/flow), 3D zones (three.js; epJSON
  `BuildingSurface:Detailed` vertices, mind `GlobalGeometryRules`
  relative→world transforms), and a conventional chart. Click a zone in 3D
  ↔ highlight in graph ↔ chart its node. The topology and 3D zone views
  now exist locally; charting/playback remains greenfield.
- **Architecture**: consume `@timestep/core` (parsing, SQLite engine,
  ESO conversion) — first external consumer, not a fork. The bnd
  parser/graph/layout graduate from timestep explorations into core with
  tests.
- Absorbs timestep ISSUE#20 (color-surfaces-by-data user ask).
