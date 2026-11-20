# Publishing skills

A skill is a directory with a `SKILL.md` file at its root.

```text
my-skill/
├── SKILL.md
├── references/
│   └── checklist.md
└── scripts/
    └── helper.js
```

## SKILL.md

```yaml
---
name: my-skill
description: What this skill does and when an agent should use it.
version: 1.0.0
categories: [productivity, docs]
author: your-handle
---

# My Skill

Instructions the agent should follow.
```

Required:

- `name` — the skill slug. Must not contain `--`, path separators, or reserved
  characters.
- `description` — one or two sentences. This is what users see in the marketplace.

Optional:

- `version` — used when scanning manually installed skills.
- `categories` — comma-separated or YAML list.
- `author` — handle shown in the marketplace.

## Packaging rules

The publisher walks the skill directory and excludes:

- `.git/`, `node_modules/`, `__pycache__/`, `.skillstore/`
- `.DS_Store`, `Thumbs.db`
- `.env`, `.npmrc`, `.netrc`, `id_rsa*`, `id_ed25519*`, `credentials*`
- `*.pem`, `*.key`, `*.p12`, `*.pfx`
- symbolic links

Add a `.skillignore` file to exclude more paths:

```text
drafts/
*.log
```

## Version strategies

| Strategy | Behavior |
|----------|----------|
| Auto-increment | The registry creates the next patch version |
| Manual | You provide a semver version |
| Force overwrite | Replaces the same version with new content |

Downgrades are rejected by default. The reference server accepts
`--allow-downgrade` for intentional rollbacks.

## From VS Code

Run **SkillStore: Publish Skill to Registry**:

1. Choose the skill folder.
2. Pick a version strategy.
3. Optionally enter categories.
4. Wait for the upload and refresh the marketplace.

## From the CLI

```bash
node local-registry/publish.js path/to/my-skill \
  --namespace global \
  --version 1.0.0 \
  --dir .skillstore-registry
```

Useful flags:

| Flag | Description |
|------|-------------|
| `--namespace` | Namespace, default `global` |
| `--version` | Semver version, default `1.0.0` |
| `--force` | Overwrite an existing version |
| `--allow-downgrade` | Allow a lower version |
| `--dir` | Registry data directory |

## From the HTTP API

See [REGISTRY_API.md](REGISTRY_API.md#publish) for the multipart contract.

## Hosting a registry

The reference server is intentionally small:

- Data is a single `index.json` plus one zip per version.
- It can run behind a reverse proxy.
- Writes can be protected with `--token`.
- For a read-only public registry, publish offline and serve the resulting files
  with any static host that supports the API paths (or a small adapter).
