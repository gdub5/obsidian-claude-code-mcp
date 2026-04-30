---
title: Note With Frontmatter
tags:
  - yaml-tag-one
  - yaml-tag-two
date: 2026-04-30
status: draft
nested:
  level: 1
  child:
    name: deeper
    value: 42
---

# Note With Frontmatter

The interesting part of this file is the YAML block above. It exercises:

- string values (`title`, `status`)
- a tags array (Obsidian merges these with inline `#tags` in MetadataCache)
- ISO date (`date`) — Obsidian parses these into Date objects in some APIs
- nested object (`nested.child.name`) — at least two levels deep

Body content is minimal.
