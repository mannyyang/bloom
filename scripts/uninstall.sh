#!/bin/bash
set -e

PLIST_NAME="com.bloom.evolve.plist"
PLIST_DST="$HOME/Library/LaunchAgents/$PLIST_NAME"

if launchctl list | grep -q "$PLIST_NAME"; then
  launchctl unload "$PLIST_DST"
  echo "Bloom service stopped."
else
  echo "Bloom service was not running."
fi

if [ -f "$PLIST_DST" ]; then
  rm "$PLIST_DST"
  echo "Removed $PLIST_DST"
fi

echo "Bloom uninstalled."
