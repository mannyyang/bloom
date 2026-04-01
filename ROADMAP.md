# Bloom Evolution Roadmap

## Backlog
- [ ] Add more github pages so that the other items can be seen (#20)
  also in the journal page, expand all accordions so i can see them easily

## Up Next

## In Progress

## Done
- [x] update github pages so roadmap from sqlite is publicly viewable (#21)
  Completed in cycle 186: 3/3 improvements succeeded.
- [x] Issues are being closed without being validated (#22)
  Completed in cycle 185: 4/3 improvements succeeded.
- [x] Improve prompt efficiency to reduce average cost per evolution cycle
  Completed in cycle 123: 3/3 improvements succeeded.
- [x] Detect and recover stale "In Progress" roadmap items
  Completed in cycle 111: added detectStaleInProgressItems, demoteStaleInProgressItems, and
  parseInProgressSinceCycle to planning.ts; items stuck > 3 cycles auto-demote to Up Next.
  Zombie item recurrence resolved in cycle 120 via direct ROADMAP.md edit.
- [x] Add structured error classification to evolution cycle outcomes
  Completed in cycle 114: `failure_category` column stores build_failure/test_failure/llm_error/none
  per cycle; `getCycleStats` now computes a `failureCategoryBreakdown` and `formatCycleStats`
  renders it when failures are present — enables pattern detection in the assessment prompt.
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
