---
name: code-review-checklist
description: Review a pull request or diff against a practical checklist covering correctness, security, tests, and maintainability.
version: 1.0.0
categories: [code-review, quality]
author: skillstore
---

# Code Review Checklist

Use this skill when reviewing a diff, a pull request, or a single file.

## Instructions

1. Read the diff and the surrounding code before commenting.
2. Check each item below and mark it **pass**, **concern**, or **blocker**.
3. Quote the relevant file and line for every concern.
4. Suggest a concrete fix. Avoid vague advice.

## Checklist

### Correctness
- Does the change handle empty, null, and error cases?
- Are version and path comparisons correct?
- Is state updated consistently on failure?

### Security
- Is user input validated before it reaches the filesystem or a shell?
- Are secrets, tokens, and private keys excluded from logs and packages?
- Are archive extraction paths checked for traversal?

### Tests
- Is the new behavior covered by a test that would fail without the change?
- Do tests assert behavior rather than implementation details?

### Maintainability
- Is the change in the right module?
- Are names consistent with the surrounding code?
- Is duplicated logic worth extracting, or is it accidental duplication?

## Output format

```markdown
## Review summary
- Blockers: N
- Concerns: N

## Findings
### [blocker] path/to/file.ts:42
Why it matters...
Suggested fix...
```
