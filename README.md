<p align="center">
  <img src="assets/bloom-logo.png" alt="Bloom" width="200">
</p>

# Bloom

A self-evolving coding agent built with the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript). Bloom autonomously reads its own source code, identifies improvements, implements them, and commits passing changes.

Inspired by [yoyo-evolve](https://github.com/yologdev/yoyo-evolve).

## Goal

Bloom is a proof-of-concept demonstrating that an AI agent can **safely and transparently evolve its own source code**. Every change must pass the build and test suite before it is committed, every decision is logged in a public journal, and an immutable constitution (`IDENTITY.md`) defines hard boundaries that the agent cannot override. The project is guided by community input — anyone can open an issue to suggest what Bloom should improve next.

## How It Works

Every 4 hours, Bloom runs an evolution cycle via GitHub Actions:

1. **Pre-flight** - Verifies build and tests pass before starting
2. **Memory & Planning** - Loads accumulated learnings, strategic context, and the project roadmap
3. **Assessment** - Reads its own code, community issues, memory, and roadmap to identify improvements
4. **Evolution** - Implements 1-3 improvements, testing each before committing
5. **Build verification** - Verifies build still passes after evolution; reverts if broken
6. **Learning extraction** - Stores categorized learnings and updates strategic context
7. **Roadmap update** - Updates the GitHub Project board with cycle results
8. **Push** - Pushes passing changes to main

The workflow retries up to 3 times with backoff on failure.

## Features

### Memory

Bloom accumulates knowledge across evolution cycles via two mechanisms:

- **Structured learnings** — Categorized insights (pattern, anti-pattern, domain, tool-usage) stored in SQLite with relevance decay. Newer learnings naturally rank higher than older ones. Injected into each assessment prompt so Bloom builds on past experience.
- **Strategic context** — A persistent narrative summary of focus areas, trajectory, and ongoing goals. Updated each cycle so Bloom maintains awareness of its multi-cycle direction.

### Planning via GitHub Projects

Bloom manages its own **kanban-style roadmap** using a GitHub Projects v2 board ("Bloom Evolution Roadmap"):

- **Hybrid planning** — Bloom proposes its own improvement goals and incorporates community issues, with reactions influencing priority
- **Automated status tracking** — Items flow from Backlog → Up Next → In Progress → Done as Bloom works through cycles
- **Priority algorithm** — "Up Next" items are picked first (sorted by reactions), then "Backlog" items

### Persistence

All state is stored in `bloom.db` (SQLite with WAL mode):

| Table | Purpose |
|-------|---------|
| `cycles` | One row per evolution cycle with outcome metrics (passed count, total count, durations) |
| `journal_entries` | Structured journal data (attempted, succeeded, failed, learnings, strategic_context) |
| `phase_usage` | Token counts, costs, and duration per phase |
| `issue_actions` | Tracks which issues were acknowledged or closed |
| `learnings` | Categorized knowledge with relevance scores |
| `strategic_context` | High-level narrative summaries per cycle |

## Safety

- **Immutable constitution** (`IDENTITY.md`) - Defines purpose and boundaries, protected by hooks
- **Test-gated commits** - Only changes that pass `pnpm build && pnpm test` are committed
- **Post-evolution verification** - Build is verified after the agent runs; broken builds are reverted
- **Append-only journal** - `JOURNAL.md` can only be appended to, never overwritten
- **Dangerous command blocking** - Safety hooks prevent `rm -rf`, force pushes, etc.
- **Budget limits** - Max 50 turns and $5 per evolution cycle
- **Best-effort externals** - GitHub API failures (issues, projects) never block evolution

## Journal

The full evolution journal is published at the repo's [GitHub Pages site](https://mannyyang.github.io/bloom/).

## Community Input

Open an issue with the `agent-input` label to suggest improvements. Issues are prioritized by reaction count. Bloom acknowledges each issue with a comment and can auto-close issues when commits reference them.

## Architecture

```
src/
├── index.ts        # Main orchestrator (5 phases)
├── evolve.ts       # Assessment & evolution prompt building
├── memory.ts       # Learning extraction, storage, and prompt formatting
├── planning.ts     # GitHub Projects v2 integration via GraphQL
├── db.ts           # SQLite persistence (bloom.db)
├── issues.ts       # GitHub issues integration
├── github-app.ts   # GitHub App JWT auth + REST/GraphQL API client
├── safety.ts       # Pre-tool-use hooks & dangerous command blocking
├── lifecycle.ts    # Git operations, build verification, safety tags
├── outcomes.ts     # Cycle metrics tracking (passed + total test counts)
└── usage.ts        # Token/cost/cache usage tracking
```

## GitHub Actions

Evolution runs automatically on a 4-hour cron schedule. You can also trigger it manually from the **Actions** tab → **Bloom Evolution** → **Run workflow**.

### Required Secrets

| Secret | Description |
|--------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key for Claude |
| `BLOOM_APP_PRIVATE_KEY` | GitHub App private key (PEM) for issue management and project board |

`GITHUB_TOKEN` is provided automatically by GitHub Actions.

### GitHub App Permissions

The GitHub App (used for issue and project management) needs:
- **Issues**: Read and write
- **Projects**: Read and write

## Local Development

```bash
pnpm install
pnpm build
pnpm test
```

### Manual Evolution

```bash
ANTHROPIC_API_KEY=sk-... pnpm run evolve
```
