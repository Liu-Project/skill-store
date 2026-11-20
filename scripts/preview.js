#!/usr/bin/env node
/**
 * Render the extension webviews to standalone HTML files for screenshots.
 *
 * Usage:
 *   npm run compile
 *   node scripts/preview.js [en|zh-cn] [outDir]
 *
 * The generated files use a VS Code dark theme approximation and stub the
 * webview host API, so they can be opened in a browser or captured with
 * Playwright.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const language = process.argv[2] || 'en';
const outDir = path.resolve(
  process.argv[3] || path.join(os.tmpdir(), 'skillstore-preview')
);

const vscode = {
  env: { language },
  workspace: {
    getConfiguration: () => ({
      get: (_key, fallback) => fallback,
      inspect: () => undefined,
      update: async () => {},
    }),
  },
  window: {},
  commands: { executeCommand: async () => undefined },
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') {
    return vscode;
  }
  return originalLoad.apply(this, arguments);
};

const { renderMarketHtml } = require(path.join(ROOT, 'dist', 'marketPanel'));
const { renderDetailHtml } = require(path.join(ROOT, 'dist', 'webview'));
const { renderSettingsHtml } = require(path.join(ROOT, 'dist', 'settingsPanel'));

const panel = { webview: { cspSource: 'vscode-resource:' } };

const THEME = `
<style>
  :root {
    --vscode-font-family: -apple-system, "Segoe UI", "PingFang SC", sans-serif;
    --vscode-foreground: #cccccc;
    --vscode-descriptionForeground: #9d9d9d;
    --vscode-editor-background: #1e1e1e;
    --vscode-editorWidget-background: #252526;
    --vscode-panel-border: #3c3c3c;
    --vscode-input-background: #3c3c3c;
    --vscode-input-foreground: #cccccc;
    --vscode-input-border: #3c3c3c;
    --vscode-focusBorder: #007fd4;
    --vscode-button-background: #0e639c;
    --vscode-button-foreground: #ffffff;
    --vscode-button-hoverBackground: #1177b0;
    --vscode-button-secondaryBackground: #3a3d41;
    --vscode-button-secondaryForeground: #ffffff;
    --vscode-button-secondaryHoverBackground: #45494e;
    --vscode-dropdown-background: #3c3c3c;
    --vscode-dropdown-foreground: #cccccc;
    --vscode-dropdown-border: #3c3c3c;
    --vscode-badge-background: #4d4d4d;
    --vscode-textLink-foreground: #3794fc;
    --vscode-toolbar-hoverBackground: rgba(90, 93, 94, .31);
    --vscode-charts-green: #89d185;
    --vscode-charts-yellow: #cca700;
    --vscode-errorForeground: #f48771;
    --vscode-editor-font-family: "SF Mono", Consolas, monospace;
  }
  html, body { background: #1e1e1e; }
</style>`;

function shim(extra) {
  return `<script>
  (function () {
    const host = {
      postMessage: function (msg) {
        ${extra || ''}
      }
    };
    window.acquireVsCodeApi = function () { return host; };
  })();
  </script>`;
}

function withHost(html, extra, onLoad) {
  const themed = html
    .replace(/script-src[^;]*;/, "script-src 'unsafe-inline';")
    .replace('</head>', `${THEME}</head>`);
  const out = themed.replace('<script nonce=', `${shim(extra)}<script nonce=`);
  return onLoad
    ? out.replace('</body>', `<script>${onLoad}</script></body>`)
    : out;
}

const now = Date.now();
const iso = (minutesAgo) =>
  new Date(now - minutesAgo * 60 * 1000).toISOString();

const marketSkills = [
  {
    slug: 'changelog-writer',
    namespace: 'global',
    name: 'changelog-writer',
    description:
      'Turn a range of git commits into a clean, user-facing changelog grouped by Added, Changed, Fixed, and Removed.',
    version: '1.0.0',
    categories: ['documentation', 'git'],
    author: 'skillstore',
    downloads: 1280,
    stars: 96,
    updatedAt: iso(35),
    status: 'install',
  },
  {
    slug: 'code-review-checklist',
    namespace: 'global',
    name: 'code-review-checklist',
    description:
      'Review a pull request or diff against a practical checklist covering correctness, security, tests, and maintainability.',
    version: '1.0.0',
    categories: ['code-review', 'quality'],
    author: 'skillstore',
    downloads: 842,
    stars: 71,
    updatedAt: iso(180),
    status: 'installed',
    installedVersion: '1.0.0',
  },
  {
    slug: 'release-notes',
    namespace: 'global',
    name: 'release-notes',
    description:
      'Draft release notes from merged pull requests, with highlights, upgrade notes, and a full change list.',
    version: '1.1.0',
    categories: ['documentation', 'release'],
    author: 'skillstore',
    downloads: 615,
    stars: 58,
    updatedAt: iso(60 * 24 * 2),
    status: 'upgrade',
    installedVersion: '1.0.0',
  },
  {
    slug: 'pdf-toolkit',
    namespace: 'global',
    name: 'pdf-toolkit',
    description:
      'Extract text, split, merge, and rotate PDF files with a small set of safe scripts.',
    version: '2.3.1',
    categories: ['documents', 'pdf'],
    author: 'alice',
    downloads: 3210,
    stars: 240,
    updatedAt: iso(60 * 24 * 6),
    status: 'install',
  },
  {
    slug: 'meeting-notes',
    namespace: 'global',
    name: 'meeting-notes',
    description:
      'Turn a transcript into decisions, action items, and a short summary with owners and due dates.',
    version: '0.8.0',
    categories: ['productivity', 'writing'],
    author: 'team-ops',
    downloads: 488,
    stars: 33,
    updatedAt: iso(60 * 24 * 12),
    status: 'install',
  },
  {
    slug: 'zero-zmail',
    namespace: 'global',
    name: 'zero-zmail',
    description:
      'Send a quick email to yourself with a single prompt. Useful for saving notes and links.',
    version: '1.0.0',
    categories: ['productivity'],
    author: 'skillstore',
    downloads: 156,
    stars: 12,
    updatedAt: iso(60 * 24 * 20),
    status: 'overwrite',
    installedVersion: 'unknown',
  },
];

const marketInit = `
        if (msg.type === 'init' || msg.type === 'search') {
          setTimeout(function () {
            window.dispatchEvent(new MessageEvent('message', {
              data: {
                type: 'data',
                requestId: msg.requestId,
                categories: ['documentation', 'git', 'code-review', 'quality', 'release', 'documents', 'pdf', 'productivity', 'writing'],
                skills: ${JSON.stringify(marketSkills)}
              }
            }));
          }, 30);
        }`;

const detailPayload = {
  summary: {
    slug: 'changelog-writer',
    name: 'changelog-writer',
    description:
      'Turn a range of git commits into a clean, user-facing changelog grouped by Added, Changed, Fixed, and Removed. Works with any repository that follows a conventional commit style.',
    version: '1.0.0',
    categories: ['documentation', 'git'],
    author: { handle: 'skillstore', displayName: 'skillstore' },
    downloadCount: 1280,
    starCount: 96,
    updatedAt: iso(35),
  },
  namespace: 'global',
  installed: false,
  registry: 'http://127.0.0.1:3030',
  versions: ['1.0.0'],
  autoUpdateIntervalMinutes: 20,
};

const settingsData = {
  sources: [
    { id: 'local', name: 'Local registry', url: 'http://127.0.0.1:3030' },
    { id: 'team', name: 'Team registry', url: 'https://skills.example.com' },
  ],
  activeId: 'local',
  installDir: '~/.zeroagent/skills',
  presets: [
    { id: 'zeroagent', label: 'ZeroAgent', dir: '~/.zeroagent/skills' },
    { id: 'claude', label: 'Claude Code', dir: '~/.claude/skills' },
    { id: 'codex', label: 'Codex', dir: '~/.codex/skills' },
  ],
};

const settingsInit = `
        setTimeout(function () {
          window.dispatchEvent(new MessageEvent('message', {
            data: { type: 'init', data: ${JSON.stringify(settingsData)} }
          }));
        }, 30);`;

fs.mkdirSync(outDir, { recursive: true });

const files = [
  ['market', withHost(renderMarketHtml(panel), marketInit)],
  ['detail', withHost(renderDetailHtml(panel, detailPayload))],
  ['settings', withHost(renderSettingsHtml(panel), '', settingsInit)],
];

for (const [name, html] of files) {
  const file = path.join(outDir, `${name}-${language}.html`);
  fs.writeFileSync(file, html, 'utf8');
  console.log(file);
}
