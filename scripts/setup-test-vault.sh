#!/bin/bash
#
# Sync test-fixtures/vault/ into the live test vault on disk.
#
# - Wipes everything outside __scratch__/ and .obsidian/
# - Re-copies all fixture content
# - Empties __scratch__/ (its purpose is to be transient)
#
# Does NOT touch:
#   - .obsidian/  (plugin install + Obsidian's own state)
#   - any path matching the EXCLUDES pattern below
#
# Usage:
#   ./scripts/setup-test-vault.sh                          # use default path
#   ./scripts/setup-test-vault.sh /path/to/test/vault      # explicit path
#   TEST_VAULT_PATH=/path ./scripts/setup-test-vault.sh    # env var
#
# Precedence: CLI arg > TEST_VAULT_PATH env > DEFAULT_VAULT below.

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'

DEFAULT_VAULT="/Users/gwalker/Documents/Obsidian/mcptestvault"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FIXTURES_DIR="$REPO_ROOT/test-fixtures/vault"

# Resolve target
TARGET="${1:-${TEST_VAULT_PATH:-$DEFAULT_VAULT}}"

if [ ! -d "$FIXTURES_DIR" ]; then
    echo -e "${RED}Fixtures directory not found at $FIXTURES_DIR${NC}" >&2
    exit 1
fi

if [ ! -d "$TARGET" ]; then
    echo -e "${RED}Target vault directory does not exist: $TARGET${NC}" >&2
    echo "Create the vault in Obsidian first (File → Open vault → Create new), then re-run." >&2
    exit 1
fi

# Refuse to nuke a vault we don't recognize as a test vault. Heuristic:
# the vault must either be effectively empty (only .obsidian/ + macOS junk)
# or already contain our README marker.
MARKER="$TARGET/README.md"
SAFE_TO_WIPE=0
if [ -f "$MARKER" ] && grep -q "fixture used by the .obsidian-claude-code-mcp" "$MARKER" 2>/dev/null; then
    SAFE_TO_WIPE=1
else
    # Strip out tolerated noise (.obsidian, .DS_Store, .trash) and check
    # whether anything remains.
    REAL_CONTENT=$(ls -A "$TARGET" 2>/dev/null | grep -v -E '^(\.obsidian|\.DS_Store|\.trash)$' || true)
    if [ -z "$REAL_CONTENT" ]; then
        SAFE_TO_WIPE=1
    fi
fi

if [ "$SAFE_TO_WIPE" -eq 0 ]; then
    echo -e "${RED}Refusing to wipe $TARGET${NC}" >&2
    echo "  This directory has content but is not marked as a test vault." >&2
    echo "  Either point at an empty/known-test directory, or add the test-vault" >&2
    echo "  marker by copying $FIXTURES_DIR/README.md to $TARGET/README.md." >&2
    exit 1
fi

echo "Syncing fixtures → $TARGET"

# Wipe everything except .obsidian (plugin install lives there).
# Use find with explicit safety: prune .obsidian, delete everything else.
find "$TARGET" -mindepth 1 -maxdepth 1 \
    ! -name ".obsidian" \
    -exec rm -rf {} +

# Copy fixtures over (preserve structure, including the empty __scratch__/).
# Trailing slash on source means "contents of", not "the directory itself".
cp -R "$FIXTURES_DIR/." "$TARGET/"

# Ensure __scratch__/ is empty (the .gitkeep is harmless but pointless in the
# live vault).
rm -f "$TARGET/__scratch__/.gitkeep" 2>/dev/null || true

# Counts for sanity
FILE_COUNT=$(find "$TARGET" -type f ! -path "$TARGET/.obsidian/*" | wc -l | tr -d ' ')
DIR_COUNT=$(find "$TARGET" -type d ! -path "$TARGET/.obsidian*" | wc -l | tr -d ' ')

echo -e "${GREEN}✓ Synced.${NC} $FILE_COUNT files across $DIR_COUNT directories."
echo
echo -e "${YELLOW}Note:${NC} Obsidian caches the vault in memory. Reload the vault (Cmd-R / Ctrl-R"
echo "      in the test vault window) so MetadataCache picks up the new files."
