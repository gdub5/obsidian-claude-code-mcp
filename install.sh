#!/bin/bash
#
# Install script for the Obsidian Claude Code MCP plugin.
# Copies the three built artifacts (main.js, manifest.json, styles.css)
# into an Obsidian plugin directory.
#
# Usage:
#   ./install.sh                              # use the default target below
#   ./install.sh /path/to/plugin/folder       # explicit target plugin folder
#   ./install.sh --vault /path/to/vault       # vault root; appends .obsidian/plugins/<id>
#   OBSIDIAN_PLUGIN_PATH=/path ./install.sh   # env var alternative
#
# Precedence: CLI arg > OBSIDIAN_PLUGIN_PATH env var > DEFAULT_TARGET below.
#
# The plugin folder name is read from manifest.json so it stays in sync
# automatically if the plugin id ever changes.

set -euo pipefail

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
NC='\033[0m'

# Default — override by passing a path as the first arg, or by exporting
# OBSIDIAN_PLUGIN_PATH. Edit this only if you want a different out-of-the-box
# install location for yourself.
DEFAULT_TARGET="$HOME/kb/Personal/.obsidian/plugins/claude-code-mcp"

REQUIRED_FILES=("main.js" "manifest.json" "styles.css")

usage() {
    cat <<EOF
Usage: $(basename "$0") [TARGET]
       $(basename "$0") --vault VAULT_PATH

Copy the built plugin (main.js, manifest.json, styles.css) into an Obsidian
plugin directory.

Arguments:
  TARGET                 Full path to the plugin folder
                         (e.g. /path/to/Vault/.obsidian/plugins/claude-code-mcp)
  --vault VAULT_PATH     Vault root; the script appends
                         .obsidian/plugins/<plugin-id-from-manifest>

Environment:
  OBSIDIAN_PLUGIN_PATH   Used when no CLI arg is given.

If neither is provided, falls back to:
  $DEFAULT_TARGET
EOF
}

# Resolve manifest plugin id (used when the user passes --vault).
get_plugin_id() {
    if [ ! -f manifest.json ]; then
        echo "manifest.json not found in $(pwd)" >&2
        return 1
    fi
    # Tiny portable JSON peek — no jq dependency.
    sed -n 's/.*"id":[[:space:]]*"\([^"]*\)".*/\1/p' manifest.json | head -n1
}

# Argument parsing
TARGET=""
case "${1:-}" in
    -h|--help)
        usage
        exit 0
        ;;
    --vault)
        if [ -z "${2:-}" ]; then
            echo -e "${RED}Error: --vault requires a path argument.${NC}" >&2
            usage
            exit 1
        fi
        PLUGIN_ID="$(get_plugin_id)"
        if [ -z "$PLUGIN_ID" ]; then
            echo -e "${RED}Error: could not read plugin id from manifest.json${NC}" >&2
            exit 1
        fi
        TARGET="$2/.obsidian/plugins/$PLUGIN_ID"
        ;;
    "")
        TARGET="${OBSIDIAN_PLUGIN_PATH:-$DEFAULT_TARGET}"
        ;;
    *)
        TARGET="$1"
        ;;
esac

# Sanity check: every artifact must already be built.
echo "Checking for built artifacts..."
MISSING=0
for file in "${REQUIRED_FILES[@]}"; do
    if [ ! -f "$file" ]; then
        echo -e "${RED}  ✗ $file not found${NC}"
        MISSING=1
    fi
done
if [ "$MISSING" -ne 0 ]; then
    echo -e "${RED}Missing build artifacts. Run 'bun run build' first.${NC}" >&2
    exit 1
fi

# Warn if the target doesn't look like an Obsidian plugin directory. We don't
# block — sometimes you're installing into a fresh path that doesn't exist
# yet — but a heads-up catches typos like pointing at a vault root.
if [[ "$TARGET" != *".obsidian/plugins/"* ]]; then
    echo -e "${YELLOW}Warning: target doesn't contain '.obsidian/plugins/' — double-check the path.${NC}"
    echo -e "${YELLOW}  Target: $TARGET${NC}"
fi

echo "Installing to: $TARGET"
mkdir -p "$TARGET"

for file in "${REQUIRED_FILES[@]}"; do
    if cp "$file" "$TARGET/"; then
        echo -e "${GREEN}  ✓ $file${NC}"
    else
        echo -e "${RED}  ✗ failed to copy $file${NC}" >&2
        exit 1
    fi
done

echo -e "${GREEN}Plugin installed.${NC}"
echo "Reload Obsidian or toggle the plugin off/on under Community Plugins for the new build to take effect."
