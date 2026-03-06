# Bloom

A self-evolving coding agent built with the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript). Bloom autonomously reads its own source code, identifies improvements, implements them, and commits passing changes.

Inspired by [yoyo-evolve](https://github.com/yologdev/yoyo-evolve).

## Goal

Bloom is a proof-of-concept demonstrating that an AI agent can **safely and transparently evolve its own source code**. Every change must pass the build and test suite before it is committed, every decision is logged in a public journal, and an immutable constitution (`IDENTITY.md`) defines hard boundaries that the agent cannot override. The project is guided by community input — anyone can open an issue to suggest what Bloom should improve next.

## How It Works

Every 4 hours, Bloom runs an evolution cycle via GitHub Actions:

1. **Pre-flight** - Verifies build and tests pass before starting
2. **Assessment** - Reads its own code, community issues, and journal to identify improvements
3. **Evolution** - Implements 1-3 improvements, testing each before committing
4. **Build verification** - Verifies build still passes after evolution; reverts if broken
5. **Journal** - Documents what was attempted, what succeeded, and what was learned
6. **Push** - Pushes passing changes to main

The workflow retries up to 3 times with backoff on failure.

## Safety

- **Immutable constitution** (`IDENTITY.md`) - Defines purpose and boundaries, protected by hooks
- **Test-gated commits** - Only changes that pass `pnpm build && pnpm test` are committed
- **Post-evolution verification** - Build is verified after the agent runs; broken builds are reverted
- **Append-only journal** - `JOURNAL.md` can only be appended to, never overwritten
- **Dangerous command blocking** - Safety hooks prevent `rm -rf`, force pushes, etc.
- **Budget limits** - Max 50 turns and $5 per evolution cycle

## Journal

The full evolution journal is published at the repo's [GitHub Pages site](https://mannyyang.github.io/bloom/).

## Community Input

Open an issue with the `agent-input` label to suggest improvements. Issues are prioritized by reaction count.

## GitHub Actions

Evolution runs automatically on a 4-hour cron schedule. You can also trigger it manually from the **Actions** tab → **Bloom Evolution** → **Run workflow**.

### Required Secrets

| Secret | Description |
|--------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key for Claude |
| `BLOOM_APP_PRIVATE_KEY` | GitHub App private key (PEM) for bot issue comments |

`GITHUB_TOKEN` is provided automatically by GitHub Actions.

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
