# Agent kickoff brief — eplus-bnd-branch-visualizer

You are picking up a parked project. Read `README.md` in this repo first —
it holds the full concept, the .bnd maintenance research, and the agreed
architecture. This file tells you how to resume work.

## Context you need

- **Owner**: Mike Sweeney (`michaelsweeney` on GitHub). Senior building-
  energy engineer; don't explain EnergyPlus primitives. Conventions:
  prose-first replies, ISSUE#N / PR#N notation, commit freely / ask before
  pushing.
- **The prototype is not here yet.** Working code lives in the timestep
  repo: `~/repos/timestep-modernize/explorations/bnd-viz/` on branch
  `claude/eplus-test-matrix` (pushed to `michaelsweeney/timestep`). It is
  a working drag-drop .bnd visualizer — parser, graph builder,
  deterministic system-flow layout, cytoscape viewer.
- **Why parked**: timestep's v2.0 release milestone (its ISSUE#23–27) was
  prioritized 2026-06-11. Do not resume this project if that milestone is
  still open without checking with Mike first.
- **Vault state**: the feature note lives in Mike's Obsidian vault at
  `06_Features/eplus-bnd-branch-visualizer.md` — read and update its
  "Pick up here" section as you work.

## Resume sequence (in order)

1. **Verify timestep 2.0 shipped** (`gh release list -R
   michaelsweeney/timestep`). If not shipped, stop and ask Mike.
2. **Migrate the prototype**: move `explorations/bnd-viz/` from timestep
   into this repo (preserve the README content already merged into this
   repo's README; delete the exploration from timestep with a pointer
   commit). Keep `collect-samples.mjs` machine-local paths working —
   sample .bnd sources are listed in that script.
3. **Promote shared parsing into `@timestep/core`**: `parsebnd.js` (and
   possibly the graph model) belongs in
   `timestep/packages/core` with vitest tests, exported like the existing
   `eso-sqlite` subpath. This repo then consumes `@timestep/core` as a
   dependency — never fork its code. Check how core is published first
   (npm vs git dependency; publishing was deferred past timestep 2.0; the
   bare npm name `timestep` is taken, `@michaelsweeney/timestep-core` is
   the fallback).
4. **Build the prep helper next** — it gates everything else. epJSON in →
   inject node-level Output:Variables (tiered presets) + Output:SQLite →
   optionally run the engine. Engine installs live at
   `~/programs/energyplus/<version>/` (22.1–25.2, match the model's
   Version object); weather at `~/Documents/energyplus-files/eplus-weather/`;
   reference harness: timestep `scripts/eplus-matrix.mjs`.
5. **Then the three views** (topology / 3D zones / chart) per README
   "Planned shape". Topology view exists; 3D and playback are greenfield.

## Constraints and decisions already made

- .bnd parsing is safe (researched; see README) but keep the topology
  source behind a seam — `HVACTopology` SQL tables (24.2+) are the future
  alternative.
- Layout is a **single fixed rule set** (deterministic; same .bnd → same
  drawing). Mike explicitly wants suggestion-not-configuration. The rule
  set: plant supply → airside → distribution → zones → return, banded per
  system, fluid-colored taxi edges.
- Node-level timeseries are opt-in in E+; the tool must degrade to
  topology-only when absent, and the prep helper is the documented gate.
- Playback volume is fine: columnar typed arrays in core handled 22M rows.
- Test fixtures: `~/repos/timestep-modernize/test-matrix/` (16 runs,
  gitignored, regenerable via `yarn eplus-matrix`) and PNNL prototype
  outputs under `~/Documents/energyplus-files/prototype-testing/`.

## Known sharp edges (learned building the prototype)

- Component Sets only carry a component's *primary* node pair —
  multi-stream equipment (ERV exhaust side) and return plenums exist only
  in the Parent/Non-Parent Node Connection records. Always backfill.
- Containers partially decompose: an air terminal's only child may be its
  reheat coil. Suppress container edges per-endpoint, not per-component.
- Classification traps: a reheat coil's only branch is hot-water demand
  (it's airside); an air-cooled chiller touches an outdoor-air node (it's
  waterside). Branch membership first, fluid type as fallback; propagate
  bands along Air edges only.
- Hourly ESO data rows bind to the *full-hour* stamp (id 2), not the most
  recent sub-hourly stamp — if you touch core's ESO parser, mind the
  frequency state machine.
- `break` inside `for...of` closes a generator — core's line iterator was
  bitten by this once already.
