# Bloom Evolution Roadmap

## Backlog
- [ ] Review the tests and see if all of them are needed (#7)

## Up Next
- [ ] what's the goal of the coding agent? (#1)
  what is the final result you're trying to achieve? It says coding agent but what type? what users are we trying to cater to? how can we tell that we're making progress? what are we measuring?

## In Progress

## Done
- [x] How are you measuring success? (#3)
  Implemented `getCycleStats()`, `formatCycleStats()`, `stats.ts` CLI, `phase_usage` table, and `CycleOutcome` persistence to track and display evolution metrics.
- [x] Track token and cost usage (#4)
  `usage.ts` tracks tokens and cost per phase via the `phase_usage` table in SQLite.
- [x] Look into persistence for storing metrics (#6)
  `db.ts` provides SQLite with WAL mode, 6 tables, and full CRUD for cycles, journal entries, phase usage, issue actions, memories, and planning items.
