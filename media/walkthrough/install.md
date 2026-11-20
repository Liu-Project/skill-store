## Install with one click

Pick a version and SkillStore downloads, verifies, and extracts the skill package into your skills directory.

- Installs are atomic: the new version is staged and swapped in only after a successful extraction.
- Existing folders are never overwritten silently.
- Manually placed `SKILL.md` folders are detected and can be adopted with an explicit confirmation.

Set `skillstore.installDir` to the directory your agent reads, for example `~/.claude/skills` or `~/.zeroagent/skills`.
