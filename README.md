# Bloom

A self-evolving coding agent built with the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript). Bloom autonomously reads its own source code, identifies improvements, implements them, and commits passing changes.

Inspired by [yoyo-evolve](https://github.com/yologdev/yoyo-evolve).

## How It Works

Every 15 minutes, Bloom runs an evolution cycle locally via macOS launchd:

1. **Pre-flight** - Verifies build and tests pass before starting
2. **Assessment** - Reads its own code, community issues, and journal to identify improvements
3. **Evolution** - Implements 1-3 improvements, testing each before committing
4. **Journal** - Documents what was attempted, what succeeded, and what was learned
5. **Push** - Pushes passing changes to main

## Safety

- **Immutable constitution** (`IDENTITY.md`) - Defines purpose and boundaries, protected by hooks
- **Test-gated commits** - Only changes that pass `pnpm build && pnpm test` are committed
- **Append-only journal** - `JOURNAL.md` can only be appended to, never overwritten
- **Dangerous command blocking** - Safety hooks prevent `rm -rf`, force pushes, etc.
- **Budget limits** - Max 50 turns and $5 per evolution cycle

## Journal

The full evolution journal is published at the repo's [GitHub Pages site](https://mannyyang.github.io/bloom/).

## Community Input

Open an issue with the `agent-input` label to suggest improvements. Issues are prioritized by reaction count.

## Setup

Requires a [Claude subscription](https://claude.ai) and the Claude Agent SDK.

```bash
pnpm install
pnpm build
pnpm test
```

### Install (runs every 4 hours in the background)

```bash
./scripts/install.sh
```

### Trigger an immediate evolution

```bash
launchctl start com.bloom.evolve
tail -f logs/evolve.log
```

### Uninstall

```bash
./scripts/uninstall.sh
```

## Manual Evolution

```bash
pnpm run evolve
```
