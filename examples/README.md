# Example skills

Each folder is a minimal Agent Skill. A skill is a directory with a `SKILL.md`
file at its root:

```text
my-skill/
├── SKILL.md
└── references/
    └── notes.md
```

`SKILL.md` starts with YAML frontmatter:

```yaml
---
name: my-skill
description: What this skill does and when an agent should use it.
version: 1.0.0
categories: [productivity]
author: your-handle
---
```

The body contains the instructions the agent should follow. Supporting files
can live next to `SKILL.md`; reference them by relative path.

## Try the examples

From the repository root:

```bash
npm run demo
```

This starts a local registry on `http://127.0.0.1:3030` and publishes every
skill in this folder. Open VS Code, run **SkillStore: Card View**, and install
one of the examples.

## Publish your own

```bash
node local-registry/publish.js path/to/your-skill --namespace global
```

Or use **SkillStore: Publish Skill to Registry** from the Command Palette.
