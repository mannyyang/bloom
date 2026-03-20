# Bloom Evolution Roadmap

## Backlog
- [ ] Improve prompt efficiency to reduce average cost per evolution cycle
  Investigate token-heavy phases (assessment, implementation) and find opportunities to
  shrink prompts without losing quality. Target: reduce median cycle cost by ~20%.
  (Moved back from In Progress — no concrete code changes were made toward this goal.)

## Up Next
- [ ] Add structured error classification to evolution cycle outcomes
  Distinguish between build failures, test failures, LLM errors, and tool errors in the
  outcomes table. Enables pattern detection (e.g., "test failures dominate cycle losses").

## In Progress

## Done
- [x] Detect and recover stale "In Progress" roadmap items
  Completed in cycle 111: added detectStaleInProgressItems, demoteStaleInProgressItems, and
  parseInProgressSinceCycle to planning.ts; items stuck > 3 cycles auto-demote to Up Next.
- [x] Track assessment-to-improvement conversion rate
  Completed in cycle 110: added avgConversionRate to CycleStats — surfaces succeeded/attempted
  ratio in pnpm stats, with null when no attempts have been made.
- [x] Track token and cost usage (#4)
  Completed in cycle 75: 1/4 improvements succeeded.
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
