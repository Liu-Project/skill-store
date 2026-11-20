# Changelog

This project follows [Keep a Changelog](https://keepachangelog.com/1.1.0/) and
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.1] - 2026-11-20

### Added

- **Bilingual UI** — English and Chinese runtime messages, manifest strings via
  `package.nls*.json`, and automatic language detection from VS Code.
- **Agent directory presets** — one-click presets for `~/.zeroagent/skills`,
  `~/.claude/skills`, and `~/.codex/skills`, plus a native folder picker.
- **Registry connectivity check** — the settings panel can probe a registry and
  show its skill count.
- **Skill folder and manifest actions** — open the installed folder, open
  `SKILL.md`, and copy the skill coordinate from the tree context menu.
- **New settings** — `skillstore.openMarketOnStartup`,
  `skillstore.autoUpdateIntervalMinutes`, and `skillstore.showStatusBar`.
- **Getting-started walkthrough** — four guided steps inside VS Code.
- **One-command demo** — `npm run demo` starts a local registry and publishes
  three example skills from `examples/skills/`.
- **Documentation** — English and Chinese READMEs, architecture, registry API,
  publishing, releasing, contributing, security, and code of conduct.
- **Community automation** — CI matrix (Node 20/22) with VSIX artifact, release
  workflow, CodeQL, and Dependabot.

### Changed

- The extension is now positioned as a general Agent Skills marketplace rather
  than an enterprise-only registry client.
- The card marketplace no longer opens automatically on startup by default; use
  `skillstore.openMarketOnStartup` to opt in.
- The auto-update interval is configurable instead of a fixed 20 minutes.
- Core modules (`installer`, `publish`, `httpClient`, `skillstoreClient`, `util`)
  no longer depend on the VS Code API.
- Error messages in core modules are English and platform-independent.
- The manifest now uses the `AI` category and Agent Skills keywords.
- The Chinese marketplace label is now “技能广场” (formerly “技能商店”).
- The reference registry server, CLI publisher, and browser UI are now English.

### Fixed

- **Semver comparison** now follows prerelease precedence
  (`1.0.0-beta < 1.0.0`, `beta.2 < beta.10`).
- **YAML flow-style categories** such as `[docs, git]` now parse without
  brackets in the extension, CLI publisher, and registry extractor.
- **Skill detail booleans** are injected as real booleans instead of truthy
  strings, so an uninstalled skill shows “Install skill” rather than
  “Overwrite install”.
- **Relative download URLs** without a leading slash now resolve against the
  registry root instead of producing an invalid URL.
- **Installed tree node IDs** include the namespace, so same-named skills from
  different namespaces no longer collide.
- **Search fallback** only falls back to the legacy endpoint on 404/5xx instead
  of retrying after every network error.
- **Card version display** no longer renders `vlatest` when a skill has no
  version.
- **Publish slug** uses `path.basename` so publishing works on Windows.
- **Installed skill detail** now includes the version list.
- **Status bar** respects `skillstore.showStatusBar`.
- **Default registry display** is localized.

### Security

- Installer path validation now also validates the namespace in
  `installDirFor`.
- Zip entry count and uncompressed size limits remain enforced.
- Publishing continues to exclude secrets, keys, `node_modules`, and symlinks.

## [0.1.0] - 2026-11-18

### Added

- Marketplace sidebar grouped by category, with full-text search, install state,
  and upgrade hints.
- Card marketplace panel with gradient avatars, version badges, category tags,
  download/star counts, sorting, skeleton loading, and empty states.
- Skill detail panel with hero header, stats, version selection,
  install/upgrade/downgrade, and an auto-update toggle.
- Settings panel with multi-registry management and install directory
  configuration.
- Local registry server: REST API, CLI publisher, and browser UI.
- `.skillstore/metadata.json` install metadata, safe install/uninstall, and
  auto-update polling.
- Project tooling: `.gitignore`, `.gitattributes`, `.editorconfig`,
  `.vscodeignore`, VS Code debug configuration, and GitHub Actions CI.
- README with banner, badges, feature cards, architecture diagram, screenshots,
  and FAQ.

### Fixed

- Corrected the `local-registry` relative path in integration tests.
- Reused detail-panel message listeners to avoid duplicate install commands.
