# eplus-bnd-branch-visualizer

An EnergyPlus HVAC system explorer. It reads the topology straight out of a
run's `eplusout.bnd` (Branch Node Details) report, pulls 3D zone geometry
from the epJSON model, and animates node temperatures and flows from
`eplusout.sql` — three synchronized views over one timeline, so you can
watch thermal conditions move through the system as the year plays.

Live demo: **https://eplus-bnd-viz.pages.dev** · landing page:
**https://michaelsweeney.github.io/eplus-bnd-branch-visualizer/**

## What it does

- **System graph** (Cytoscape) — components as nodes, EnergyPlus fluid
  nodes as edges. A deterministic "system flow" layout reads left→right:
  plant supply → AHU/airside → distribution → zones → return, one labeled
  loop boundary per system. Also offers a unit-overview and an organic
  layout.
- **3D zones** (Three.js) — `BuildingSurface:Detailed` geometry from the
  epJSON, surfaces heatmapped by zone mean air temperature.
- **Chart pane** — sparklines of the current selection with a hover
  crosshair and tooltip.
- **One linked selection** drives every view. Click a zone (in the graph,
  in 3D, or from the inspector's zone picker) and it lights up everywhere,
  highlights its connected HVAC nodes, and shows its epJSON, geometry, and
  node connections in the inspector. Click a component, an edge, or a
  System-legend swatch to select its connected objects, its fluid node, or
  a whole loop family.
- **Transport** — play/pause, speed, and an annual scrub aligned to the
  chart x-axis (space and ←/→ also drive it). Edge color/width tracks
  temperature or flow; the metric toggle switches between System (colored
  by loop function), Temperature, and Flow.
- **Systems tree** — a per-row detail control (● full detail / ◐ grouped to
  one box / ○ hidden) at unit, section, and all-systems scope, to dial the
  graph from overview to fully expanded.

## Run it locally

A Vite app with no framework — vanilla ES modules; Cytoscape and Three come
from npm.

```sh
npm install
npm run dev        # http://localhost:5173/
npm test           # parser / graph / layout / units / prep / export suites
npm run build      # full-resolution dist/
```

Demo datasets live in gitignored `public/demo-data/` and auto-load in dev
(dataset selector: Large Office VAV / Hospital / Small Office). The app
opens in Temperature, IP units, with a 40–120 °F scale; theme, SI/IP, and
colorscale are in the topbar ⚙ popover.

Shareable app state rides in the URL hash: `#dataset=<key>` or
`#bnd=/#geometry=/#data=<url>` pick the data; `#t=<index>`, `#play=1`,
`#sel=<zone>`, `#theme=light`, `#layout=system|organic|units`, and
`#collapse=all` restore view state.

## Bring your own model

Drag any of these onto the running app — each layer degrades gracefully:

- **`.bnd` alone** → the full topology graph. Every EnergyPlus run writes
  `eplusout.bnd`, any version, no preparation.
- **+ epJSON** → 3D zone geometry. `ConvertInputFormat --epJSON` turns an
  IDF into one.
- **+ playback JSON** → the temporal layer. This is the only part that
  needs the model prepared before the run — two output variables and
  SQLite output:

  ```text
  Output:Variable, *, System Node Temperature, Hourly;
  Output:Variable, *, System Node Mass Flow Rate, Hourly;
  Output:SQLite, SimpleAndTabular;
  ```

The CLI helpers handle that prep and export:

```sh
# inject the node outputs + SQLite (accepts IDF or epJSON);
# add --run --weather <file.epw> to run the version-matched engine
npm run prep -- path/to/model.epJSON --out path/to/model.prepped.epJSON

# convert eplusout.sql into the playback JSON the app loads
npm run export:playback -- path/to/eplusout.sql --out path/to/playback.json

# shrink an oversized playback JSON
node scripts/decimate-playback.mjs
```

`--run` looks for the executable under `~/programs/energyplus/<version>/`,
matching the model's `Version` object (override with `--version`). If the
SQL came from an un-prepped model, export still writes time metadata and
notes that no node series were found, so topology and 3D still work.

## Hosted build

`npm run build:demo` produces a deployable `dist/` — the app bundle plus
decimated copies of the demo datasets (3-hourly offices, 4-hourly
hospital, values rounded to 3 decimals) so the playback JSONs land under
Cloudflare Pages' 25 MB file cap. Deploy with:

```sh
npx wrangler pages deploy dist --project-name <name>
```

Headless 3D screenshots need software WebGL:

```sh
google-chrome --headless --no-sandbox --enable-unsafe-swiftshader \
  --screenshot=/tmp/shot.png --window-size=1400,900 \
  --virtual-time-budget=15000 'http://localhost:5173/#t=4263'
```

Without WebGL the 3D view shows an explanatory message instead of a blank
canvas.

## Inside

- **`parsebnd.js`** — parser for the self-documenting `.bnd` record types
  (every record carries a `! <Type>,<field>,...` header; the format is
  byte-stable across EnergyPlus 22.1→25.2, 59 record types). The `.bnd`
  exists, per the EnergyPlus docs, "to support software which draws a
  schematic diagram of the HVAC system."
- **`buildgraph.js`** — components → vertices, fluid nodes → edges, loops
  → compound groups; per-endpoint container suppression and node-connection
  backfill for components with no structured node rows (return plenums, ERV
  secondary streams).
- **`layoutbnd.js`** — the deterministic system-flow schematic: columns
  plant→airside→distribution→zones→return, one band per system,
  topological rank within each cell. Classification prefers branch
  membership, falls back to node fluid type.
- **`src/app.js`** — the app and its state owner: loading, graph
  build/style/layout, the selection model, systems tree, inspector, and
  playback. `index.html` is markup only.
- **`src/zones3d.js` / `src/chart.js` / `src/palette.js`** — the Three.js
  zone view, the chart pane, and the color-ramp / SI-IP utility layer. They
  read app state through live ES bindings, so `app.js` stays the single
  state owner.
- **`src/units.js`** — unit membership (AHU / plant side / distribution /
  zone equipment) from explicit `.bnd` structure.

Topology has a swap seam for the `HVACTopology` tabular report (E+ 24.2+,
written into `eplusout.sql`) as a future SQL-backed source.

Validated against 8 models (22.1 + 25.2; office / hotel / hospital /
apartment archetypes): zero orphaned flow vertices, full loop closure.
