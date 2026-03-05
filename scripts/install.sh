#!/bin/bash
set -e

PLIST_NAME="com.bloom.evolve.plist"
PLIST_SRC="$(cd "$(dirname "$0")/.." && pwd)/$PLIST_NAME"
PLIST_DST="$HOME/Library/LaunchAgents/$PLIST_NAME"

if [ ! -f "$PLIST_SRC" ]; then
  echo "Error: $PLIST_SRC not found"
  exit 1
fi

# Install dependencies
echo "Installing dependencies..."
pnpm install

# Verify build + tests
echo "Running build and tests..."
pnpm build && pnpm test

# Create logs directory
mkdir -p "$(dirname "$PLIST_SRC")/logs"

# Copy and load the launchd plist
cp "$PLIST_SRC" "$PLIST_DST"
launchctl load "$PLIST_DST"

echo ""
echo "Bloom installed and scheduled (every 8 hours)."
echo "  Logs: $(dirname "$PLIST_SRC")/logs/evolve.log"
echo "  Run now: launchctl start $PLIST_NAME"
echo "  Uninstall: ./scripts/uninstall.sh"
