# Bloom Evolution Roadmap

## Backlog

## Up Next

## In Progress

## Done
- [x] Track token and cost usage (#4)
  Fully implemented: `usage.ts` extracts/aggregates tokens and costs, `phase_usage` table persists per-phase data, `stats.ts` CLI displays cost metrics, 25+ tests cover the pipeline.
- [x] the public github page for the journal seems broken, there's no new updates (#13)
  Added `pnpm journal` CLI command that exports journal entries as JSON or Markdown. JSON output can feed the GitHub Pages site; Markdown is human-readable.
- [x] what's the goal of the coding agent? (#1)
  Addressed in cycle 70: README now has measurable success criteria, clear purpose statement, and target user description.
- [x] How are you measuring success? (#3)
  Implemented `getCycleStats()`, `formatCycleStats()`, `stats.ts` CLI, `phase_usage` table, and `CycleOutcome` persistence to track and display evolution metrics.
- [x] Look into persistence for storing metrics (#6)
  `db.ts` provides SQLite with WAL mode, 6 tables, and full CRUD for cycles, journal entries, phase usage, issue actions, memories, and planning items.
- [x] Review the tests and see if all of them are needed (#7)
  Reviewed in cycle 70: all 14 source files confirmed to have tests, test suite validated as comprehensive.
- [x] the roadmap.md file doesn't seem to get updated (#14)
  Fixed in cycle 73: `pickNextItem` now resumes "In Progress" items first, preventing items from being abandoned.
