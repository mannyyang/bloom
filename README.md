# Bloom

A self-evolving coding agent built with the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript). Bloom autonomously reads its own source code, identifies improvements, implements them, and commits passing changes.

Inspired by [yoyo-evolve](https://github.com/yologdev/yoyo-evolve).

## How It Works

Every 8 hours (via GitHub Actions), Bloom runs an evolution cycle:

1. **Assessment** - Reads its own code, community issues, and journal to identify improvements
2. **Evolution** - Implements 1-3 improvements, testing each before committing
3. **Journal** - Documents what was attempted, what succeeded, and what was learned
4. **Push** - Pushes passing changes to main

## Safety

- **Immutable constitution** (`IDENTITY.md`) - Defines purpose and boundaries, protected by hooks
- **Test-gated commits** - Only changes that pass `pnpm build && pnpm test` are committed
- **Append-only journal** - `JOURNAL.md` can only be appended to, never overwritten
- **Dangerous command blocking** - Safety hooks prevent `rm -rf`, force pushes, etc.
- **Budget limits** - Max 50 turns and $5 per evolution cycle

## Community Input

Open an issue with the `agent-input` label to suggest improvements. Issues are prioritized by reaction count.

## Development

```bash
pnpm install
pnpm build
pnpm test
```

## Manual Evolution

```bash
export ANTHROPIC_API_KEY=your-key
pnpm run evolve
```

## Setup for GitHub Actions

Add `ANTHROPIC_API_KEY` as a repository secret. The workflow runs automatically every 8 hours.
