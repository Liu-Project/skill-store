# Contributing to SkillStore

Thanks for taking the time to contribute. This guide covers the development
workflow, coding conventions, and what to expect from a pull request.

## Code of Conduct

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to contribute

- Report bugs with the bug report template.
- Request features with the feature request template.
- Improve documentation, examples, or error messages.
- Add tests for edge cases.
- Implement a requested feature.
- Share a registry implementation or a skill collection.

## Development setup

Requirements:

- Node.js `^20.19.0` or `>=22.12.0`
- VS Code `^1.85.0`

```bash
git clone <your-fork-url>
cd skillstore
npm install
npm run watch
```

Press `F5` in VS Code to launch the Extension Development Host.

## Project layout

| Path | What lives there |
|------|------------------|
| `src/extension.ts` | Activation, commands, views, timers |
| `src/config.ts` | Registry and settings access |
| `src/i18n.ts` | Runtime English/Chinese messages |
| `src/util.ts` | Semver, URL normalization, paths |
| `src/httpClient.ts` | HTTP client |
| `src/skillstoreClient.ts` | Registry API client |
| `src/installer.ts` | Install/uninstall/scan safety |
| `src/publish.ts` | Packaging and upload |
| `src/skillTree.ts` | Sidebar tree providers |
| `src/marketPanel.ts` | Card marketplace webview |
| `src/webview.ts` | Skill detail webview |
| `src/settingsPanel.ts` | Settings webview |
| `local-registry/` | Reference registry server |
| `test/unit/` | Unit tests |
| `test/integration/` | Registry end-to-end tests |
| `examples/skills/` | Example skills |

## Coding guidelines

- TypeScript strict mode is enabled. Keep it that way.
- Keep `installer.ts`, `publish.ts`, `httpClient.ts`, `skillstoreClient.ts`, and
  `util.ts` free of `vscode` imports. They are platform-independent and easier to
  test.
- Add user-facing strings to `src/i18n.ts` (English and Chinese).
- Add manifest strings to `package.nls.json` and `package.nls.zh-cn.json`.
- Escape untrusted values in webviews.
- Do not log secrets or file contents.
- Prefer small, focused functions over large command handlers.
- Do not add comments that restate the code.

## Testing

```bash
npm run lint       # type-check
npm run test:unit
npm run test:integration
npm run verify     # both
```

Guidelines:

- Every bug fix should include a regression test.
- Installer and publisher changes need tests for unsafe paths and failure modes.
- Registry API changes need an integration test.
- Keep tests deterministic; do not depend on the network.

## Commit and pull request

1. Create a topic branch.
2. Keep commits focused. Conventional prefixes are welcome:
   `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`.
3. Update `CHANGELOG.md` for user-visible changes.
4. Run `npm run verify`.
5. Open a pull request and fill in the template.

A maintainer will review for correctness, safety, tests, and consistency. Small,
well-tested pull requests are merged fastest.

## Adding a feature

1. Open an issue describing the workflow and the expected behavior.
2. Decide whether the change belongs in the extension, the registry, or both.
3. Add the smallest implementation that solves the problem.
4. Add tests and documentation.
5. If the feature changes the registry contract, update
   [docs/REGISTRY_API.md](docs/REGISTRY_API.md).

## Adding a registry adapter

The client only needs `search`, `resolve`, `download`, and `publish`. If you are
targeting a different backend, implement those methods in a small adapter around
`SkillStoreClient` rather than branching inside the UI.

## Release process

See [docs/RELEASING.md](docs/RELEASING.md).
