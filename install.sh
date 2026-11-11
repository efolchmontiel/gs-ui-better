#!/usr/bin/env bash
# gs-ui-better installer — Linux, macOS and Omarchy.
# Copies the extensions into the Pi agent home and substitutes the one import that
# must point at the installed gentle-pi package.
set -euo pipefail

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"

# 1. Agent home: the same order Pi and Gentle Shell use.
if [ -n "${GENTLE_PI_AGENT_HOME:-}" ]; then
  AGENT_HOME="$GENTLE_PI_AGENT_HOME"
elif [ -n "${PI_CODING_AGENT_DIR:-}" ]; then
  AGENT_HOME="$PI_CODING_AGENT_DIR"
elif [ -d "$HOME/.gentle-shell/agent" ]; then
  AGENT_HOME="$HOME/.gentle-shell/agent"
else
  AGENT_HOME="$HOME/.pi/agent"
fi

# 2. gentle-pi's card helpers: the file that carries the placeholder import.
CARD_LIB="${GS_UI_BETTER_SHELL_CARD:-}"
if [ -z "$CARD_LIB" ] && [ -f "$HOME/.gentle-shell/current/node_modules/gentle-pi/lib/shell-card.ts" ]; then
  CARD_LIB="$HOME/.gentle-shell/current/node_modules/gentle-pi/lib/shell-card.ts"
fi
if [ -z "$CARD_LIB" ]; then
  CARD_LIB="$(ls -1d "$HOME"/.gentle-shell/versions/*/node_modules/gentle-pi/lib/shell-card.ts 2>/dev/null | tail -1 || true)"
fi
if [ -z "$CARD_LIB" ] && [ -f "$AGENT_HOME/npm/node_modules/gentle-pi/lib/shell-card.ts" ]; then
  CARD_LIB="$AGENT_HOME/npm/node_modules/gentle-pi/lib/shell-card.ts"
fi

echo "gs-ui-better"
echo "  agent home : $AGENT_HOME"
echo "  card lib   : ${CARD_LIB:-NOT FOUND}"

if [ ! -d "$AGENT_HOME" ]; then
  echo "error: agent home does not exist: $AGENT_HOME" >&2
  echo "       open Gentle Shell once, or set GENTLE_PI_AGENT_HOME" >&2
  exit 1
fi

EXT_DIR="$AGENT_HOME/extensions"
ASSET_DIR="$AGENT_HOME/assets/gentleman-greeting"

if [ "$DRY_RUN" = "1" ]; then
  echo "  dry run    : nothing will be written"
fi

run() { [ "$DRY_RUN" = "1" ] && echo "    would: $*" || "$@"; }

mkdir -p "$EXT_DIR" "$ASSET_DIR"

# 3. Extensions. Every file but bash-one-line is copied verbatim.
for file in gentleman-greeting.ts herdr-agent-state.ts; do
  target="$EXT_DIR/$file"
  if [ -f "$target" ]; then run cp "$target" "$target.bak-$STAMP"; fi
  run cp "$SRC_DIR/extensions/$file" "$target"
  echo "  installed  : extensions/$file"
done

TARGET="$EXT_DIR/bash-one-line.ts"
if [ -f "$TARGET" ]; then run cp "$TARGET" "$TARGET.bak-$STAMP"; fi
if [ -z "$CARD_LIB" ]; then
  echo "  skipped    : extensions/bash-one-line.ts (shell-card.ts not found; Pi keeps its native cards)"
  echo "               set GS_UI_BETTER_SHELL_CARD=/path/to/gentle-pi/lib/shell-card.ts and rerun"
else
  if [ "$DRY_RUN" = "1" ]; then
    echo "    would: write extensions/bash-one-line.ts with the resolved import"
  else
    sed "s|__GS_UI_BETTER_SHELL_CARD__|$CARD_LIB|g" "$SRC_DIR/extensions/bash-one-line.ts" > "$TARGET"
  fi
  echo "  installed  : extensions/bash-one-line.ts"
fi

# 4. Greeting assets, read from the same relative path at runtime.
for asset in "$SRC_DIR"/assets/gentleman-greeting/*; do
  run cp "$asset" "$ASSET_DIR/"
done
echo "  installed  : assets/gentleman-greeting/ ($(ls -1 "$SRC_DIR"/assets/gentleman-greeting | wc -l | tr -d ' ') files)"

cat <<'DONE'

Done. Restart Gentle Shell (or run /reload) to load the extensions.
Backups of replaced files were written next to them with a .bak-<timestamp> suffix.
DONE
