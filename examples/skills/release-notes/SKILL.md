---
name: release-notes
description: Draft release notes from merged pull requests, with highlights, upgrade notes, and a full change list.
version: 1.0.0
categories: [documentation, release]
author: skillstore
---

# Release Notes

Use this skill before tagging a release.

## Instructions

1. Collect merged pull requests since the previous tag.
2. Pick the three to five changes that matter most to users.
3. Write a short highlight for each one, then a complete change list.
4. Add upgrade notes for breaking changes, migrations, or new requirements.

## Output format

```markdown
# v1.4.0

## Highlights
- **Feature name** — one sentence about the user benefit.

## Upgrade notes
- ...

## Changes
- Added ...
- Fixed ...
```

## Rules

- Lead with user impact, not implementation details.
- Link to issues or pull requests when available.
- Call out breaking changes at the top, never bury them.
