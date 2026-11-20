# Releasing SkillStore

## One-time repository setup

Before publishing to the VS Code Marketplace, add the repository metadata to
`package.json`:

```json
{
  "repository": {
    "type": "git",
    "url": "https://github.com/<owner>/skillstore.git"
  },
  "homepage": "https://github.com/<owner>/skillstore#readme",
  "bugs": {
    "url": "https://github.com/<owner>/skillstore/issues"
  }
}
```

Then replace the `OWNER/REPO` placeholders in the CI badge (if you add one) and
in any links that point to the repository.

The `package` script keeps `--allow-missing-repository` so local packaging works
before the repository exists. You can remove that flag once the metadata is set.

## Versioning

SkillStore follows [Semantic Versioning](https://semver.org/):

- **Patch** — bug fixes, documentation, and internal changes.
- **Minor** — new features that are backward compatible.
- **Major** — breaking changes to settings, the registry contract, or the install
  layout.

## Release checklist

1. Update the version in `package.json`.
2. Update `CHANGELOG.md`:
   - Move `Unreleased` items under the new version.
   - Add the release date.
3. Run the full verification:

   ```bash
   npm ci
   npm run verify
   ```

4. Build the VSIX:

   ```bash
   npm run package
   ```

5. Install the VSIX locally and smoke-test:
   - Card marketplace loads.
   - Search, install, upgrade, and uninstall work.
   - Settings save and reload.
   - Publish to the local registry works.
   - English and Chinese UI both render.

6. Commit, tag, and push:

   ```bash
   git add -A
   git commit -m "chore: release v0.1.1"
   git tag v0.1.1
   git push origin main --tags
   ```

7. The `Release` workflow builds the VSIX and attaches it to the GitHub release.

8. Publish to the VS Code Marketplace (optional):

   ```bash
   npx @vscode/vsce publish
   ```

   This requires a `VSCE_PAT` personal access token with Marketplace publish
   permissions.

## GitHub release workflow

`.github/workflows/release.yml` runs on tags matching `v*`:

- Installs dependencies with `npm ci`.
- Runs `npm run verify`.
- Builds the VSIX.
- Creates a GitHub release and uploads the VSIX.

If you configure the `VSCE_PAT` secret, the workflow also publishes to the VS
Code Marketplace.

## Screenshots

English screenshots live in `media/screenshots/en/` and are used by
`README.md`. Chinese screenshots live in `media/screenshots/` and are used by
`README.zh-CN.md`. When the UI changes:

1. Open the card marketplace, a skill detail, settings, and the registry Web UI.
2. Capture the same four views in both languages.
3. Keep the filenames (`market.png`, `detail.png`, `settings.png`,
   `registry.png`).
4. Update both `README.md` and `README.zh-CN.md` if the captions change.

## Changelog style

Follow [Keep a Changelog](https://keepachangelog.com/):

```markdown
## [0.1.1] - 2026-01-15

### Added
- ...

### Changed
- ...

### Fixed
- ...
```
