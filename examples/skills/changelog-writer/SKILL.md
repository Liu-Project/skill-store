---
name: changelog-writer
description: Turn a range of git commits into a clean, user-facing changelog grouped by Added, Changed, Fixed, and Removed.
version: 1.0.0
categories: [documentation, git]
author: skillstore
---

# Changelog Writer

Use this skill when you need to summarize a release or a batch of commits.

## Instructions

1. Ask for the commit range (for example `v1.2.0..HEAD`) if it is not provided.
2. Run `git log --no-merges --pretty=format:'%h %s' <range>`.
3. Group commits into **Added**, **Changed**, **Fixed**, and **Removed**.
4. Rewrite each entry from the user's perspective. Avoid internal ticket numbers
   unless they add context.
5. Keep the result short. One line per user-visible change.

## Output format

```markdown
## [1.3.0] - 2026-01-15

### Added
- ...

### Fixed
- ...
```

## Rules

- Do not invent changes that are not in the commit history.
- Collapse duplicate or purely internal refactors into a single line.
- Use the repository's existing changelog style when one is present.
