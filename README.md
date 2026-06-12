# eplus-bnd-branch-visualizer

EnergyPlus node/system analysis tool: HVAC topology from the `.bnd`
(Branch Node Details) report, 3D zone geometry from epJSON, and timeseries
playback from `eplusout.sql` — three synchronized views with the long-term
goal of an auto-play temporal slider visualizing thermal flow through
system nodes.

Spun out of [timestep](https://github.com/michaelsweeney/timestep)
2026-06-11. **Status: local prototype.** The topology prototype has been
copied here from timestep's `explorations/bnd-viz/` so it can be tested
locally while the longer-term packaging and `@timestep/core` split are
worked out. See `PROMPT.md` for the original agent kickoff brief.

## Local prototype

A Vite app (`npm run dev`, default http://localhost:5173/) — vanilla ES
modules, no framework; cytoscape/three come from npm. `index.html` is
markup only; runtime lives in `src/app.js` + `src/app.css` with the
parser/graph/layout/units libraries as plain modules shared with the
node test suite. `npm run build` emits `dist/`. Demo datasets live in
gitignored `public/demo-data/` and auto-load in dev (dataset selector:
Large Office VAV / Hospital / Small Office).

- **Panels**: systems tree (collapsible unit hierarchy with checkboxes —
  checked = expanded; zone equipment + distribution collapse by
  default), system graph (Cytoscape; system-flow / organic / unit
  overview layouts, loop filter, double-click collapses/expands units),
  3D zones (Three.js), inspector sidebar, and a bottom transport bar
  (play/pause, speed, annual scrub with month ruler; space / ←→
  keyboard control). All panels resize via grabbers and collapse.
- **Metric toggle** (System | Temperature | Flow): System colors by loop
  function (air amber, HW red, CHW blue, CW green — plant loops
  classified by operating temps, not names); Temperature/Flow use ramps.
  Edge width = capacity (node peak flow over the run), opacity = live
  utilization. Zone boxes and 3D surfaces heatmap by zone mean air
  temperature. Scale domains and the colorscale are editable in the
  legend (blank input = auto; node temps percentile-clipped — stagnant
  coil outlet nodes report physically absurd temperatures at zero flow).
- **Linked selection**: clicking a zone in either pane selects it in
  both, highlights its connected HVAC nodes/edges amber, and shows its
  epJSON object + geometry + node connections in the inspector.
  Clicking a component highlights its connected objects and its served
  zone (if any) in both panes; clicking an edge shows the fluid node.
- **Drag-drop** any `.bnd`, epJSON, or playback JSON to replace the
  loaded set.
- Run `npm test` for the parser/graph/layout/units/prep/export suites.
- Hash params: `#dataset=<key>` or `#bnd=/#geometry=/#data=<url>` pick
  the data; `#t=<index>`, `#play=1`, `#sel=<zone name>`,
  `#theme=mario`, `#layout=system|organic|units`, `#collapse=all`
  restore a shareable app state.

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
- `src/app.js` + `index.html` — the explorer app (see "Local prototype"
  above); click drill-down reaches every object touching a node
  (setpoint managers, controllers).
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
