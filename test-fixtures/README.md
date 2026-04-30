# Test Vault Fixtures

This directory holds the canonical content for the integration test vault.
`scripts/setup-test-vault.sh` syncs `vault/` into a real Obsidian vault on disk
so the plugin's tools can be exercised against live MetadataCache, file
watching, and Obsidian's actual API surface.

## Structure & guarantees

The fixture vault is **deliberate** — each subtree has known properties that
integration tests can assert against. Do not change file contents casually;
several tests will pin to specific text.

### `basics/`
Sanity-check files for the file-manipulation tools.
- `plain.md` — no frontmatter, no links, no tags. The simplest possible note.
- `with-frontmatter.md` — full YAML frontmatter (title, tags array, dates,
  nested values). For testing `get_frontmatter` once it exists.
- `with-tags.md` — inline `#tag` syntax: `#alpha`, `#beta`, `#project/april`
  (a nested tag).

### `links/`
Controlled link topology for backlink/outgoing-link tests.

```
hub.md → leaf-a.md
hub.md → leaf-b.md
hub.md → leaf-c.md
leaf-b.md → hub.md      (mutual)
leaf-c.md → leaf-a.md   (chain)
```

Resulting backlink expectations:
- `leaf-a.md` ← hub, leaf-c
- `leaf-b.md` ← hub
- `leaf-c.md` ← hub
- `hub.md` ← leaf-b

### `nested/deep/three/levels.md`
A single file three folders deep. Tests directory traversal and the
"`view` of a directory should show subfolders too" fix.

### `edges/`
Pathological cases.
- `file with spaces.md` — whitespace in filename
- `unicode-ファイル.md` — non-ASCII filename
- `empty.md` — zero bytes

### `__scratch__/`
Where the stress harness writes during runs. **Always treated as ephemeral**
— `setup-test-vault.sh` wipes its contents on every reset. Tests are free to
create, edit, and destroy here.

## Updating fixtures

If you add a new fixture file:
1. Drop it under the appropriate subtree
2. Update this README's link/tag inventory if it changes the topology
3. Re-run `scripts/setup-test-vault.sh` to push to the live vault

If you change link topology, also update the backlink expectations table
above and any tests that assert on specific results.
