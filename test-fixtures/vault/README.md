# Test Vault

This vault is **not** a real knowledge base. It's a fixture used by the
`obsidian-claude-code-mcp` plugin's integration tests. Contents under
`basics/`, `links/`, `nested/`, and `edges/` are reset by
`scripts/setup-test-vault.sh` whenever fixtures change.

The `__scratch__/` folder is the only place tests are allowed to write
freely — everything else is treated as pinned reference data.

If you opened this vault by mistake, the source-of-truth lives in:
`<plugin repo>/test-fixtures/vault/`
