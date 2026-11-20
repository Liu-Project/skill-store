## Share a skill with your team

A skill is just a folder with a `SKILL.md` file:

```text
my-skill/
├── SKILL.md
└── references/
    └── checklist.md
```

`SKILL.md` starts with YAML frontmatter:

```yaml
---
name: my-skill
description: What this skill does and when to use it.
version: 1.0.0
categories: [productivity]
---
```

Run **SkillStore: Publish Skill to Registry**, choose the folder, and pick a version strategy. Sensitive files such as `.env`, private keys, and `node_modules` are excluded automatically.
