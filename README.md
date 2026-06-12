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

The topology prototype has been copied into this repo for local testing:

- Open `index.html` directly, or serve the directory with a local static
  server and drop an EnergyPlus `.bnd` file onto the page.
- Drop an epJSON model, or use the Geometry file picker, to render
  `BuildingSurface:Detailed` zone surfaces in the 3D zones view. Clicking
  a graph zone or 3D surface links the selection when zone names match.
- Export a prepped `eplusout.sql` to playback JSON and drop it into the
  Data picker to chart node temperature or mass flow. Clicking a topology
  edge selects the matching node series when present.
- With playback loaded, the time slider and ▶ autoplay drive all views
  off one time index: topology edges color by node temperature and width
  by √mass-flow, graph zone boxes and 3D zone surfaces heatmap by zone
  mean air temperature, and the chart marker tracks. Color scales are
  global to the run (node temps percentile-clipped — stagnant coil
  outlet nodes report physically absurd temperatures at zero flow) and
  shown in the legend. Clicking a zone in either view charts its zone
  temperature series; topology↔3D selection linking stays by zone name.
- Run `npm test` to exercise the parser, graph builder, deterministic
  layout, epJSON geometry reader, and epJSON prep helper with Node's
  built-in test runner.
- Run `npm run collect:samples` to regenerate the optional `samples.js`
  dropdown from local EnergyPlus output folders. Missing sample sources
  are skipped.
- When served over http(s), hash params auto-load files and select the
  view — shareable demo links and the hook for headless smoke tests:
  `index.html#bnd=<url>&geometry=<url>&data=<url>&view=<topology|zones|chart|split>&t=<timestep>&play=1`.
  (`#sample=N` still works for embedded samples on `file://`.)

## End-to-end demo (validated 2026-06-12)

The full chain — IDF in, three synchronized views out — against a real
EnergyPlus 22.1 install:

```sh
node scripts/prep-epjson.mjs model.idf \
  --out demo-data/model.prepped.epJSON \
  --preset nodes-hourly \
  --run --weather path/to/weather.epw \
  --output-dir demo-data/run

node scripts/export-playback.mjs demo-data/run/eplusout.sql \
  --out demo-data/model.playback.json

python3 -m http.server 8741
# open http://127.0.0.1:8741/index.html#bnd=demo-data/run/eplusout.bnd&geometry=demo-data/model.prepped.epJSON&data=demo-data/model.playback.json&view=split
```

The small-office ASHRAE 901 STD2022 Seattle prototype produced 86 node
series × 8760 hourly timesteps; all four views (topology with playback
edge styling, 3D zones, chart, split) render. `demo-data/` is gitignored
scratch space for this workflow.

The showcase set is the Large Office STD2022 New York prototype (VAV
with reheat + chiller/boiler/tower plant): 357 node series + 23 zone
series × 8760 h (94 MB playback JSON; the exporter batches its SQL reads
to survive this scale). Winter vs summer timesteps show visibly
different zone heatmaps and reheat-loop activity:

```text
#...&view=split&t=400     January evening
#...&view=split&t=4263    late-June afternoon
#...&view=split&play=1    autoplay from t=0
```

Headless screenshots need software WebGL enabled for the 3D view:

```sh
google-chrome --headless --no-sandbox --enable-unsafe-swiftshader \
  --screenshot=/tmp/shot.png --window-size=1400,900 --virtual-time-budget=8000 \
  'http://127.0.0.1:8741/index.html#bnd=...&view=zones'
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
- `index.html` — drag-drop viewer (cytoscape, file://-friendly): sample
  dropdown, system-flow + organic layouts, taxi polyline edges colored by
  fluid, click drill-down to every object touching a node (setpoint
  managers, controllers), loop filter, 3D zone geometry, node series chart,
  `#sample=N` auto-load.
- `collect-samples.mjs` — embeds local .bnd files into a gitignored
  `samples.js` for the file:// demo.

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
