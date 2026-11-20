# Security policy

## Supported versions

| Version | Supported |
|---------|-----------|
| `0.1.x` | Yes |
| `< 0.1` | No |

## Reporting a vulnerability

Please do **not** open a public issue for security problems.

Use GitHub's private vulnerability reporting for this repository, or contact the
maintainers directly. Include:

- A description of the issue and its impact
- Steps to reproduce
- Affected version and platform
- Any proof-of-concept or logs (redact secrets)

You can expect an acknowledgement within a few days. We will coordinate a fix
and a disclosure date with you.

## Security model

SkillStore treats registries and skill packages as untrusted input.

### Install path

- Skill names and namespaces are validated before use in paths.
- Zip entries are rejected if they are absolute, contain `..`, or contain NUL
  bytes.
- Extraction is limited by file count and total uncompressed size.
- Installs are staged and swapped atomically.
- Uninstall only removes directories that contain
  `.skillstore/metadata.json`.
- Manually placed folders are never overwritten without explicit confirmation.

### Publish path

- `.env`, private keys, credentials, `.git`, `node_modules`, and `.skillstore`
  are excluded from packages.
- Symbolic links are skipped.
- The reference registry validates namespaces, versions, and package paths.

### Network

- The extension supports `http` and `https`. Use `https` for untrusted networks.
- The reference server binds to `127.0.0.1` by default.
- Write operations on the reference server can require a bearer token with
  `--token`.

### Out of scope

- The behavior of the agent that consumes installed skills.
- Skills that intentionally execute malicious instructions when loaded by an
  agent.
- Registries that serve content different from what their metadata claims.

## Dependencies

Dependabot is enabled for npm and GitHub Actions. Security-relevant updates are
prioritized.
