import * as vscode from 'vscode';
import { SkillSummary } from './skillstoreClient';
import { currentLanguage, messages, t } from './i18n';

export interface DetailPayload {
  summary: SkillSummary;
  namespace: string;
  installed: boolean;
  installedVersion?: string;
  /** true=SkillStore 安装；false=手动放置/上传（不允许技能广场覆盖升级） */
  managed?: boolean;
  registry: string;
  versions?: string[];
  autoUpdate?: boolean;
  autoUpdateIntervalMinutes?: number;
}

const AUTO_UPDATE_KEY = 'skillstore.autoUpdate';

const detailPanels = new Map<string, vscode.WebviewPanel>();
const detailListeners = new Map<string, vscode.Disposable>();

export function openSkillDetail(
  context: vscode.ExtensionContext,
  payload: DetailPayload
): void {
  const { summary, namespace } = payload;
  const slug = summary.slug;
  const skillSlug = slug.includes('--')
    ? slug.slice(slug.indexOf('--') + 2)
    : slug;
  const key = `${namespace}/${skillSlug}`;

  const existing = detailPanels.get(key);
  if (existing) {
    existing.reveal();
    renderDetail(existing, context, payload, key);
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    'skillstore.detail',
    `${summary.name || skillSlug}`,
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      localResourceRoots: [],
    }
  );
  detailPanels.set(key, panel);
  panel.onDidDispose(() => {
    detailPanels.delete(key);
    detailListeners.get(key)?.dispose();
    detailListeners.delete(key);
  });
  renderDetail(panel, context, payload, key);
}

function renderDetail(
  panel: vscode.WebviewPanel,
  context: vscode.ExtensionContext,
  payload: DetailPayload,
  key: string
): void {
  const { summary, namespace } = payload;
  const skillSlug = key.includes('/') ? key.slice(key.indexOf('/') + 1) : key;
  const autoUpdateMap = context.globalState.get<Record<string, boolean>>(
    AUTO_UPDATE_KEY,
    {}
  );
  const autoUpdate = payload.autoUpdate ?? autoUpdateMap[key] !== false;
  panel.title = `${summary.name || skillSlug}`;
  panel.webview.html = renderDetailHtml(panel, { ...payload, autoUpdate });

  detailListeners.get(key)?.dispose();
  const listener = panel.webview.onDidReceiveMessage((message) => {
    if (message.type === 'install') {
      const target = {
        summary,
        namespace,
        version: message.version || undefined,
      } as { summary: SkillSummary; namespace: string; version?: string };
      const cmd = message.force
        ? 'skillstore.upgradeSkill'
        : 'skillstore.installSkill';
      vscode.commands
        .executeCommand(cmd, target)
        .then(
          (result) => {
            const r = result as
              | { ok?: boolean; cancelled?: boolean; error?: string; version?: string }
              | undefined;
            if (r && r.ok === false) {
              if (!r.cancelled) {
                panel.webview.postMessage({
                  type: 'installFailed',
                  message: r.error || t('common.unknown'),
                });
              }
              return;
            }
            panel.webview.postMessage({
              type: 'installed',
              version: r?.version || message.version || summary.version,
            });
          },
          (err) => {
            const messageText =
              err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(
              t('ext.install.failed.install', { error: messageText })
            );
            panel.webview.postMessage({
              type: 'installFailed',
              message: messageText,
            });
          }
        );
    } else if (message.type === 'setAutoUpdate') {
      const enabled = Boolean(message.enabled);
      const map = context.globalState.get<Record<string, boolean>>(
        AUTO_UPDATE_KEY,
        {}
      );
      map[key] = enabled;
      context.globalState.update(AUTO_UPDATE_KEY, map);
      panel.webview.postMessage({
        type: 'autoUpdateSaved',
        enabled,
      });
    } else if (message.type === 'openRegistry') {
      if (payload.registry) {
        void vscode.env.openExternal(vscode.Uri.parse(payload.registry));
      }
    }
  });
  detailListeners.set(key, listener);
}

export function renderDetailHtml(
  panel: Pick<vscode.WebviewPanel, 'webview'>,
  p: DetailPayload
): string {
  const s = p.summary;
  const esc = (v: unknown): string =>
    String(v ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  const newline = (v: unknown): string =>
    esc(v).replace(/\n/g, '<br/>');
  const author =
    s.author?.displayName || s.author?.handle || t('common.unknown');
  const nonce = getNonce();
  const versions = p.versions && p.versions.length > 0 ? p.versions : undefined;
  const currentVersion = s.version;
  const versionOptions = versions
    ? [
        `<option value="">${esc(t('detail.latestOption', { version: versions[0] }))}</option>`,
        ...versions.map(
          (v) =>
            `<option value="${esc(v)}"${v === currentVersion ? ' selected' : ''}>${esc(v)}</option>`
        ),
      ].join('')
    : '';
  const installedVersion = p.installedVersion || '';
  const managed = p.managed !== false;
  const latestVersion = versions && versions.length > 0 ? versions[0] : '';
  const slugKey = s.slug || '';
  const shortSlug = slugKey.includes('--')
    ? slugKey.slice(slugKey.indexOf('--') + 2)
    : slugKey;
  const hue = hueOf(slugKey);
  const hue2 = (hue + 42) % 360;
  const initial = esc(String(s.name || slugKey).slice(0, 1).toUpperCase());

  return `<!DOCTYPE html>
<html lang="${currentLanguage() === 'zh' ? 'zh-CN' : 'en'}">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';"/>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family);
    margin: 0;
    padding: 0;
    color: var(--vscode-foreground);
    background: transparent;
  }
  .page { max-width: 980px; margin: 0 auto; padding: 20px 24px 48px; }
  .hero {
    position: relative;
    display: flex;
    gap: 18px;
    align-items: flex-start;
    padding: 22px;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 16px;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    overflow: hidden;
  }
  .hero::before {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(120deg, hsla(var(--h), 80%, 60%, .14), transparent 55%);
    pointer-events: none;
  }
  .avatar {
    position: relative;
    width: 64px;
    height: 64px;
    border-radius: 18px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 28px;
    font-weight: 700;
    color: #fff;
    background: linear-gradient(135deg, hsl(var(--h), 72%, 58%), hsl(var(--h2), 72%, 46%));
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .2), 0 8px 20px rgba(0, 0, 0, .18);
  }
  .hero-main { position: relative; min-width: 0; flex: 1; }
  .chips { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
  .cat-badge {
    display: inline-block;
    font-size: 10px;
    line-height: 16px;
    padding: 2px 8px;
    border-radius: 999px;
    border: 1px solid var(--vscode-panel-border);
    color: var(--vscode-descriptionForeground);
  }
  .badge {
    display: inline-block;
    font-size: 10px;
    line-height: 16px;
    padding: 2px 8px;
    border-radius: 999px;
    font-weight: 600;
  }
  .installed-badge {
    color: var(--vscode-charts-green, #2da44e);
    background: rgba(45, 164, 78, .14);
    border: 1px solid rgba(45, 164, 78, .35);
  }
  h1 { font-size: 24px; line-height: 1.25; margin: 0 0 6px; word-break: break-word; }
  .coords {
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
    font-family: var(--vscode-editor-font-family, monospace);
    word-break: break-all;
  }
  .stats {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 12px;
    margin: 16px 0;
  }
  .stat {
    padding: 12px 14px;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 12px;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
  }
  .stat .k { font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 5px; }
  .stat .v { font-size: 16px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .stat .v.small { font-size: 12px; font-weight: 500; white-space: normal; line-height: 1.4; }
  .card {
    padding: 18px 20px;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 14px;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    margin-bottom: 14px;
  }
  .card h2 {
    font-size: 13px;
    font-weight: 700;
    letter-spacing: .3px;
    margin: 0 0 10px;
    color: var(--vscode-foreground);
  }
  .desc { line-height: 1.75; margin: 0; font-size: 13px; color: var(--vscode-foreground); }
  .meta-grid {
    display: grid;
    grid-template-columns: 96px minmax(0, 1fr);
    gap: 8px 16px;
    font-size: 12px;
  }
  .meta-grid .k { color: var(--vscode-descriptionForeground); }
  .meta-grid .v { word-break: break-all; }
  .action-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  .hint { font-size: 11px; color: var(--vscode-descriptionForeground); margin: 4px 0 0; line-height: 1.5; }
  .controls { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 12px; }
  select {
    background: var(--vscode-dropdown-background);
    color: var(--vscode-dropdown-foreground);
    border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border));
    border-radius: 8px;
    padding: 7px 10px;
    font-size: 12px;
    min-width: 160px;
  }
  button {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    border-radius: 8px;
    padding: 8px 20px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: background .15s ease, opacity .15s ease;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: .6; cursor: default; }
  .status { margin-top: 10px; font-size: 12px; color: var(--vscode-descriptionForeground); min-height: 18px; }
  .status.ok { color: var(--vscode-charts-green, #2da44e); }
  .auto-update {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 14px 16px;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 14px;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
  }
  .auto-update input {
    width: 16px;
    height: 16px;
    margin-top: 2px;
    accent-color: var(--vscode-focusBorder);
    cursor: pointer;
    flex-shrink: 0;
  }
  .auto-update label { font-size: 13px; font-weight: 600; cursor: pointer; }
  .auto-update .hint { margin-top: 3px; }
  .footer {
    margin-top: 18px;
    padding-top: 14px;
    border-top: 1px solid var(--vscode-panel-border);
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    display: flex;
    justify-content: space-between;
    gap: 10px;
    flex-wrap: wrap;
  }
  .registry-link { cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
  .registry-link:hover { color: var(--vscode-textLink-foreground, var(--vscode-foreground)); }
  @media (max-width: 640px) {
    .page { padding: 14px 14px 36px; }
    .hero { padding: 16px; }
    .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .meta-grid { grid-template-columns: 1fr; gap: 2px 0; }
    .meta-grid .k { margin-top: 6px; }
  }
</style>
</head>
<body>
  <div class="page" style="--h:${hue};--h2:${hue2}">
    <header class="hero">
      <div class="avatar">${initial}</div>
      <div class="hero-main">
        <div class="chips">
          ${(s.categories || []).map((c) => `<span class="cat-badge">${esc(c)}</span>`).join('')}
          ${p.installed ? `<span class="badge installed-badge">${esc(p.installedVersion ? t('detail.installedWithVersion', { version: p.installedVersion }) : t('detail.installed'))}${managed ? '' : ` · ${esc(t('detail.manual'))}`}</span>` : ''}
        </div>
        <h1>${esc(s.name || s.slug)}</h1>
        <div class="coords">@${esc(p.namespace)} / ${esc(shortSlug)}</div>
      </div>
    </header>

    <section class="stats">
      <div class="stat"><div class="k">${esc(t('detail.latestVersion'))}</div><div class="v">${s.version ? `v${esc(s.version)}` : esc(t('common.latest'))}</div></div>
      <div class="stat"><div class="k">${esc(t('detail.downloads'))}</div><div class="v">${esc(s.downloadCount ?? 0)}</div></div>
      <div class="stat"><div class="k">${esc(t('detail.stars'))}</div><div class="v">${esc(s.starCount ?? 0)}</div></div>
      <div class="stat"><div class="k">${esc(t('detail.updated'))}</div><div class="v small">${esc(formatDate(s.updatedAt))}</div></div>
    </section>

    <section class="card">
      <h2>${esc(t('detail.about'))}</h2>
      <p class="desc">${newline(s.description || t('common.noDescription'))}</p>
    </section>

    <section class="card">
      <h2>${esc(t('detail.details'))}</h2>
      <div class="meta-grid">
        <span class="k">${esc(t('detail.author'))}</span><span class="v">${esc(author)}</span>
        <span class="k">${esc(t('detail.namespace'))}</span><span class="v">${esc(p.namespace)}</span>
        <span class="k">${esc(t('detail.coordinate'))}</span><span class="v">${esc(s.slug)}</span>
        <span class="k">${esc(t('detail.registry'))}</span><span class="v">${esc(p.registry)}</span>
      </div>
    </section>

    <section class="card">
      <div class="action-head">
        <div>
          <h2 style="margin-bottom:2px">${esc(t('detail.installAndVersions'))}</h2>
          <p class="hint">${p.installed ? (managed ? esc(t('detail.hint.managed', { version: installedVersion })) : esc(t('detail.hint.manual'))) : esc(t('detail.hint.notInstalled'))}</p>
        </div>
      </div>
      <div class="controls">
        ${versionOptions ? `<select id="verSel" aria-label="${esc(t('detail.selectVersion'))}">${versionOptions}</select>` : ''}
        <button id="installBtn">${esc(p.installed ? t('detail.button.installed') : t('detail.button.install'))}</button>
      </div>
      <div id="status" class="status"></div>
    </section>

    ${p.installed && managed ? `<section class="auto-update">
      <input type="checkbox" id="autoUpdateChk" ${p.autoUpdate ? 'checked' : ''}/>
      <div>
        <label for="autoUpdateChk">${esc(t('detail.autoUpdate.label'))}</label>
        <div class="hint">${esc(t('detail.autoUpdate.hint', { minutes: p.autoUpdateIntervalMinutes ?? 20 }))}</div>
      </div>
    </section>` : ''}

    <div class="footer">
      <span>SkillStore · Agent Skills Registry</span>
      <span class="registry-link" id="registryLink" title="${esc(t('market.registry.title'))}">${esc(p.registry)}</span>
    </div>
  </div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const I18N = ${JSON.stringify(messages())};
  function tr(key, vars) {
    let text = I18N[key] || key;
    if (vars) {
      for (const name of Object.keys(vars)) {
        text = text.split('{' + name + '}').join(String(vars[name]));
      }
    }
    return text;
  }
  const btn = document.getElementById('installBtn');
  const status = document.getElementById('status');
  const verSel = document.getElementById('verSel');
  const autoUpdateChk = document.getElementById('autoUpdateChk');
  const installedVersion = ${jsonForScript(installedVersion)};
  const installed = ${jsonForScript(p.installed)};
  const installedManaged = ${jsonForScript(p.installed ? managed : true)};
  const latestVersion = ${jsonForScript(latestVersion)};

  function cmpVersion(a, b) {
    const pa = String(a).split('.').map(function (n) { return parseInt(n, 10) || 0; });
    const pb = String(b).split('.').map(function (n) { return parseInt(n, 10) || 0; });
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
      const x = pa[i] || 0;
      const y = pb[i] || 0;
      if (x !== y) return x - y;
    }
    return 0;
  }

  function selectedVersion() {
    return verSel ? (verSel.value || latestVersion) : latestVersion;
  }

  function updateButton() {
    const sel = selectedVersion();
    if (installed && !installedVersion) {
      btn.disabled = false;
      btn.textContent = tr('detail.button.overwrite');
      btn.dataset.force = '1';
      return;
    }
    if (!latestVersion) {
      btn.disabled = false;
      btn.textContent = installedVersion ? tr('detail.button.reinstall') : tr('detail.button.install');
      btn.dataset.force = installedVersion ? '1' : '';
      return;
    }
    if (!installedVersion) {
      btn.disabled = false;
      btn.textContent = tr('detail.button.install');
      btn.dataset.force = '';
      return;
    }
    if (sel === installedVersion) {
      btn.disabled = true;
      btn.textContent = tr('detail.button.installed');
      btn.dataset.force = '';
      return;
    }
    if (cmpVersion(sel, installedVersion) > 0) {
      btn.disabled = false;
      btn.textContent = tr('detail.button.upgradeTo', { version: sel });
      btn.dataset.force = '1';
      return;
    }
    if (!installedManaged) {
      btn.disabled = true;
      btn.textContent = tr('detail.button.manualInstalled');
      btn.dataset.force = '';
      return;
    }
    btn.disabled = false;
    btn.textContent = tr('detail.button.downgrade');
    btn.dataset.force = '1';
  }

  btn.addEventListener('click', function () {
    btn.disabled = true;
    status.classList.remove('ok');
    status.textContent = tr('detail.status.installing');
    vscode.postMessage({
      type: 'install',
      version: selectedVersion() || undefined,
      force: btn.dataset.force === '1'
    });
  });

  if (verSel) {
    verSel.addEventListener('change', updateButton);
  }
  if (autoUpdateChk) {
    autoUpdateChk.addEventListener('change', function () {
      vscode.postMessage({ type: 'setAutoUpdate', enabled: autoUpdateChk.checked });
    });
  }
  const registryLink = document.getElementById('registryLink');
  if (registryLink) {
    registryLink.addEventListener('click', function () {
      vscode.postMessage({ type: 'openRegistry' });
    });
  }

  updateButton();

  window.addEventListener('message', function (e) {
    const msg = e.data || {};
    if (msg.type === 'installed') {
      status.classList.add('ok');
      status.textContent = tr('detail.status.installed', { version: msg.version || '' });
      btn.disabled = true;
      btn.textContent = tr('detail.button.installed');
    } else if (msg.type === 'installFailed') {
      status.classList.remove('ok');
      status.textContent = tr('detail.status.failed', { error: msg.message || tr('common.unknown') });
      btn.disabled = false;
      updateButton();
    } else if (msg.type === 'autoUpdateSaved') {
      status.classList.add('ok');
      status.textContent = msg.enabled ? tr('detail.status.autoUpdateOn') : tr('detail.status.autoUpdateOff');
    }
  });
</script>
</body>
</html>`;
}

function hueOf(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = (h * 31 + text.charCodeAt(i)) % 360;
  }
  return h;
}

function jsonForScript(v: unknown): string {
  const json = JSON.stringify(v === undefined ? null : v) ?? 'null';
  return json
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

function formatDate(v: unknown): string {
  if (!v) {
    return t('detail.unknownDate');
  }
  const d = new Date(String(v));
  if (isNaN(d.getTime())) {
    return String(v);
  }
  return d.toLocaleString();
}

function getNonce(): string {
  let text = '';
  const chars =
    'ABCDEFGHIJKLMNPQRSTUVWXYZabcdefghijklmnpqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
