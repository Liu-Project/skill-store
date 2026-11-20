import * as vscode from 'vscode';
import {
  RegistrySource,
  getSources,
  saveSources,
  setActiveSource,
  genId,
} from './config';
import { SkillStoreClient } from './skillstoreClient';
import { DEFAULT_INSTALL_DIR } from './util';
import { MessageKey, currentLanguage, messages, t } from './i18n';

interface SettingsData {
  sources: RegistrySource[];
  activeId: string;
  installDir: string;
  presets: Array<{ id: string; label: string; dir: string }>;
}

const PRESETS: Array<{ id: string; labelKey: MessageKey; dir: string }> = [
  {
    id: 'zeroagent',
    labelKey: 'settings.preset.zeroagent',
    dir: '~/.zeroagent/skills',
  },
  {
    id: 'claude',
    labelKey: 'settings.preset.claude',
    dir: '~/.claude/skills',
  },
  {
    id: 'codex',
    labelKey: 'settings.preset.codex',
    dir: '~/.codex/skills',
  },
];

export function openSettingsPanel(
  _context: vscode.ExtensionContext,
  onChanged: () => void
): void {
  const panel = vscode.window.createWebviewPanel(
    'skillstore.settings',
    t('settings.title'),
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [],
    }
  );

  panel.webview.html = renderSettingsHtml(panel);
  sendInit(panel);

  const messageDisposable = panel.webview.onDidReceiveMessage(async (msg) => {
    try {
      switch (msg.type) {
        case 'addSource': {
          const url = String(msg.url || '').trim();
          const name = String(msg.name || '').trim() || url;
          if (!url) {
            return;
          }
          const sources = [...getSources(), { id: genId(url), name, url }];
          await saveSources(sources);
          await setActiveSource(sources[sources.length - 1].id);
          onChanged();
          sendInit(panel);
          break;
        }
        case 'removeSource': {
          const sources = getSources();
          const target = sources.find((s) => s.id === msg.id);
          if (!target) {
            return;
          }
          const removeLabel = t('settings.deleteConfirmButton');
          const confirmed = await vscode.window.showWarningMessage(
            t('settings.deleteConfirm', {
              name: target.name,
              url: target.url,
            }),
            { modal: true },
            removeLabel
          );
          if (confirmed !== removeLabel) {
            return;
          }
          const rest = sources.filter((s) => s.id !== msg.id);
          await saveSources(rest);
          onChanged();
          sendInit(panel);
          break;
        }
        case 'updateSource': {
          const id = String(msg.id || '');
          const url = String(msg.url || '').trim();
          const name = String(msg.name || '').trim() || url;
          if (!id || !url) {
            return;
          }
          const sources = getSources().map((s) =>
            s.id === id ? { ...s, name, url } : s
          );
          await saveSources(sources);
          onChanged();
          sendInit(panel);
          break;
        }
        case 'activateSource': {
          await setActiveSource(String(msg.id));
          onChanged();
          sendInit(panel);
          break;
        }
        case 'updateInstallDir': {
          const dir = String(msg.path || '').trim();
          if (dir) {
            await vscode.workspace
              .getConfiguration('skillstore')
              .update('installDir', dir, vscode.ConfigurationTarget.Global);
            onChanged();
          }
          sendInit(panel);
          break;
        }
        case 'pickInstallDir': {
          const picked = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: t('settings.saveDir'),
            title: t('settings.folderDialogTitle'),
          });
          if (picked && picked.length > 0) {
            await vscode.workspace
              .getConfiguration('skillstore')
              .update(
                'installDir',
                picked[0].fsPath,
                vscode.ConfigurationTarget.Global
              );
            onChanged();
          }
          sendInit(panel);
          break;
        }
        case 'checkRegistry': {
          const id = String(msg.id || '');
          const url = String(msg.url || '');
          if (!url) {
            return;
          }
          try {
            const health = await new SkillStoreClient(url).health();
            panel.webview.postMessage({
              type: 'reachability',
              id,
              ok: true,
              count: health.count,
            });
          } catch {
            panel.webview.postMessage({
              type: 'reachability',
              id,
              ok: false,
            });
          }
          break;
        }
      }
    } catch (err) {
      vscode.window.showErrorMessage(
        t('settings.saveFailed', {
          error: err instanceof Error ? err.message : String(err),
        })
      );
      sendInit(panel);
    }
  });
  panel.onDidDispose(() => messageDisposable.dispose());
}

function sendInit(panel: vscode.WebviewPanel): void {
  const cfg = vscode.workspace.getConfiguration('skillstore');
  const data: SettingsData = {
    sources: getSources(),
    activeId: cfg.get<string>('activeRegistry', '') || '',
    installDir:
      cfg.get<string>('installDir', DEFAULT_INSTALL_DIR) || DEFAULT_INSTALL_DIR,
    presets: PRESETS.map((preset) => ({
      id: preset.id,
      label: t(preset.labelKey),
      dir: preset.dir,
    })),
  };
  panel.webview.postMessage({ type: 'init', data });
}

export function renderSettingsHtml(
  panel: Pick<vscode.WebviewPanel, 'webview'>
): string {
  const nonce = getNonce();
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
  .page { max-width: 900px; margin: 0 auto; padding: 22px 24px 48px; }
  .page-head { display: flex; align-items: center; gap: 14px; margin-bottom: 22px; }
  .logo {
    width: 44px;
    height: 44px;
    border-radius: 12px;
    background: linear-gradient(135deg, #2b6ff0, #8b5cff);
    display: flex;
    align-items: center;
    justify-content: center;
    color: #fff;
    font-size: 20px;
    font-weight: 700;
    flex-shrink: 0;
    box-shadow: 0 4px 14px rgba(43, 111, 240, .35);
  }
  .logo svg { width: 26px; height: 26px; display: block; }
  .page-head h1 { font-size: 19px; margin: 0; }
  .page-head p { font-size: 12px; margin: 3px 0 0; color: var(--vscode-descriptionForeground); }
  .section { margin-bottom: 24px; }
  .section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 10px;
  }
  .section-head h2 { font-size: 13px; margin: 0; letter-spacing: .3px; }
  .count {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 999px;
    padding: 1px 8px;
  }
  .src-list { display: flex; flex-direction: column; gap: 8px; margin-bottom: 10px; }
  .src-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 14px;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 12px;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    transition: border-color .15s ease, box-shadow .15s ease;
  }
  .src-row:hover { border-color: var(--vscode-focusBorder); }
  .src-row.active {
    border-color: var(--vscode-focusBorder);
    box-shadow: inset 3px 0 0 var(--vscode-focusBorder);
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
    background: var(--vscode-descriptionForeground);
    opacity: .45;
  }
  .src-row.active .dot {
    background: var(--vscode-charts-green, #2da44e);
    opacity: 1;
    box-shadow: 0 0 0 3px rgba(45, 164, 78, .18);
  }
  .src-info { flex: 1; min-width: 0; }
  .src-title { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .src-name {
    font-size: 13px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .badge {
    flex-shrink: 0;
    font-size: 10px;
    font-weight: 600;
    line-height: 16px;
    border-radius: 999px;
    padding: 1px 8px;
    color: var(--vscode-charts-green, #2da44e);
    background: rgba(45, 164, 78, .14);
    border: 1px solid rgba(45, 164, 78, .35);
  }
  .src-url {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    margin-top: 3px;
    word-break: break-all;
    font-family: var(--vscode-editor-font-family, monospace);
  }
  .reach {
    display: none;
    margin-top: 4px;
    font-size: 11px;
  }
  .reach.show { display: block; }
  .reach.ok { color: var(--vscode-charts-green, #2da44e); }
  .reach.fail { color: var(--vscode-errorForeground, #f48771); }
  .src-actions { display: flex; gap: 6px; flex-shrink: 0; flex-wrap: wrap; }
  .form-card {
    padding: 16px;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 12px;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
  }
  .form-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 12px;
    flex-wrap: wrap;
  }
  .form-title { font-size: 13px; font-weight: 700; }
  .fields { display: flex; gap: 10px; flex-wrap: wrap; }
  .field { display: flex; flex-direction: column; gap: 5px; flex: 1; min-width: 180px; }
  .field.grow { flex: 2; }
  .field span { font-size: 11px; color: var(--vscode-descriptionForeground); }
  input {
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    border-radius: 8px;
    padding: 7px 10px;
    font-size: 13px;
    transition: border-color .15s ease, box-shadow .15s ease;
  }
  input:focus {
    outline: none;
    border-color: var(--vscode-focusBorder);
    box-shadow: 0 0 0 1px var(--vscode-focusBorder);
  }
  .actions { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
  .presets { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
  button {
    background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
    color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
    border: none;
    border-radius: 8px;
    padding: 6px 14px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: background .15s ease, opacity .15s ease;
  }
  button:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground)); }
  button:disabled { opacity: .55; cursor: default; }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  button.ghost {
    background: transparent;
    color: var(--vscode-foreground);
    border: 1px solid var(--vscode-panel-border);
  }
  button.ghost:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.15)); }
  button.danger { background: transparent; color: var(--vscode-errorForeground, #f48771); border: 1px solid rgba(244, 135, 113, .35); }
  button.danger:hover { background: rgba(244, 135, 113, .14); }
  .hint { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 8px; line-height: 1.6; }
  .empty {
    padding: 22px;
    text-align: center;
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
    border: 1px dashed var(--vscode-panel-border);
    border-radius: 12px;
  }
  @media (max-width: 560px) {
    .page { padding: 16px 14px 36px; }
    .src-row { align-items: flex-start; flex-wrap: wrap; }
    .src-actions { width: 100%; padding-left: 20px; }
    .field { min-width: 100%; }
  }
</style>
</head>
<body>
  <div class="page">
    <div class="page-head">
      <div class="logo" aria-hidden="true">
        <svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M7 11h18l1.3 14.2A2.3 2.3 0 0 1 24 27.6H8a2.3 2.3 0 0 1-2.3-2.4L7 11z" fill="rgba(255,255,255,.14)" stroke="#fff" stroke-width="1.7" stroke-linejoin="round"/>
          <path d="M11.5 11V8.8a4.5 4.5 0 0 1 9 0V11" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/>
          <path d="M16 14.2l1.25 3.05L20.3 18.5l-3.05 1.25L16 22.8l-1.25-3.05L11.7 18.5l3.05-1.25L16 14.2z" fill="#fff"/>
        </svg>
      </div>
      <div>
        <h1>${t('settings.title')}</h1>
        <p>${t('settings.subtitle')}</p>
      </div>
    </div>

    <section class="section">
      <div class="section-head">
        <h2>${t('settings.registries')}</h2>
        <span class="count" id="srcCount">0</span>
      </div>
      <div id="srcList" class="src-list"></div>
      <div class="form-card">
        <div class="form-head">
          <span class="form-title" id="formTitle">${t('settings.addTitle')}</span>
          <span class="hint" style="margin-top:0">${t('settings.url')} *</span>
        </div>
        <div class="fields">
          <label class="field">
            <span>${t('settings.name')}</span>
            <input id="newName" placeholder="${t('settings.namePlaceholder')}"/>
          </label>
          <label class="field grow">
            <span>${t('settings.url')}</span>
            <input id="newUrl" placeholder="${t('settings.urlPlaceholder')}"/>
          </label>
        </div>
        <div class="actions">
          <button class="primary" id="addBtn">${t('settings.addButton')}</button>
          <button class="ghost" id="cancelBtn" hidden>${t('settings.cancelEdit')}</button>
        </div>
      </div>
      <div class="hint">${t('settings.hint')}</div>
    </section>

    <section class="section">
      <div class="section-head">
        <h2>${t('settings.installDir')}</h2>
      </div>
      <div class="form-card">
        <div class="fields">
          <label class="field grow">
            <span>${t('settings.installDir')}</span>
            <input id="installDir" placeholder="${t('settings.installDirPlaceholder')}"/>
          </label>
        </div>
        <div class="actions">
          <button class="primary" id="saveDirBtn">${t('settings.saveDir')}</button>
          <button class="ghost" id="browseBtn">${t('settings.chooseFolder')}</button>
        </div>
        <div class="presets" id="presets"></div>
        <div class="hint">${t('settings.installDirHint')}</div>
      </div>
    </section>
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
  const srcList = document.getElementById('srcList');
  const srcCount = document.getElementById('srcCount');
  const newName = document.getElementById('newName');
  const newUrl = document.getElementById('newUrl');
  const addBtn = document.getElementById('addBtn');
  const cancelBtn = document.getElementById('cancelBtn');
  const formTitle = document.getElementById('formTitle');
  const installDir = document.getElementById('installDir');
  const saveDirBtn = document.getElementById('saveDirBtn');
  const browseBtn = document.getElementById('browseBtn');
  const presetsEl = document.getElementById('presets');
  let editingId = null;
  let presetList = [];

  function startEdit(s) {
    editingId = s.id;
    newName.value = s.name;
    newUrl.value = s.url;
    addBtn.textContent = tr('settings.saveButton');
    formTitle.textContent = tr('settings.editTitle');
    cancelBtn.hidden = false;
    newName.focus();
  }

  function cancelEdit() {
    editingId = null;
    newName.value = '';
    newUrl.value = '';
    addBtn.textContent = tr('settings.addButton');
    formTitle.textContent = tr('settings.addTitle');
    cancelBtn.hidden = true;
  }

  function renderPresets(presets) {
    presetList = presets || [];
    presetsEl.innerHTML = '';
    for (const preset of presetList) {
      const btn = document.createElement('button');
      btn.className = 'ghost';
      btn.textContent = preset.label;
      btn.title = preset.dir;
      btn.addEventListener('click', function () {
        installDir.value = preset.dir;
        installDir.focus();
      });
      presetsEl.appendChild(btn);
    }
  }

  function render(data) {
    srcList.innerHTML = '';
    const sources = data.sources || [];
    srcCount.textContent = tr('settings.count', { count: sources.length });
    if (sources.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = tr('settings.empty');
      srcList.appendChild(empty);
    } else {
      for (const s of sources) {
        const active = s.id === data.activeId;
        const row = document.createElement('div');
        row.className = 'src-row' + (active ? ' active' : '');

        const dot = document.createElement('span');
        dot.className = 'dot';

        const info = document.createElement('div');
        info.className = 'src-info';
        const title = document.createElement('div');
        title.className = 'src-title';
        const name = document.createElement('span');
        name.className = 'src-name';
        name.textContent = s.name;
        title.appendChild(name);
        if (active) {
          const badge = document.createElement('span');
          badge.className = 'badge';
          badge.textContent = tr('settings.inUse');
          title.appendChild(badge);
        }
        const url = document.createElement('div');
        url.className = 'src-url';
        url.textContent = s.url;
        const reach = document.createElement('div');
        reach.className = 'reach';
        reach.dataset.id = s.id;
        info.appendChild(title);
        info.appendChild(url);
        info.appendChild(reach);

        const actions = document.createElement('div');
        actions.className = 'src-actions';

        const useBtn = document.createElement('button');
        useBtn.textContent = active ? tr('settings.inUse') : tr('settings.use');
        useBtn.disabled = active;
        useBtn.addEventListener('click', function () {
          vscode.postMessage({ type: 'activateSource', id: s.id });
        });

        const checkBtn = document.createElement('button');
        checkBtn.className = 'ghost';
        checkBtn.textContent = tr('settings.reachability.check');
        checkBtn.addEventListener('click', function () {
          reach.className = 'reach show';
          reach.textContent = tr('settings.reachability.checking');
          vscode.postMessage({ type: 'checkRegistry', id: s.id, url: s.url });
        });

        const editBtn = document.createElement('button');
        editBtn.className = 'ghost';
        editBtn.textContent = tr('settings.edit');
        editBtn.addEventListener('click', function () { startEdit(s); });

        const delBtn = document.createElement('button');
        delBtn.className = 'danger';
        delBtn.textContent = tr('settings.delete');
        delBtn.addEventListener('click', function () {
          vscode.postMessage({ type: 'removeSource', id: s.id });
        });

        actions.appendChild(useBtn);
        actions.appendChild(checkBtn);
        actions.appendChild(editBtn);
        actions.appendChild(delBtn);

        row.appendChild(dot);
        row.appendChild(info);
        row.appendChild(actions);
        srcList.appendChild(row);
      }
    }
    installDir.value = data.installDir || '';
    renderPresets(data.presets);
  }

  addBtn.addEventListener('click', function () {
    const url = newUrl.value.trim();
    const name = newName.value.trim();
    if (!url) { newUrl.focus(); return; }
    if (editingId) {
      vscode.postMessage({ type: 'updateSource', id: editingId, name: name, url: url });
    } else {
      vscode.postMessage({ type: 'addSource', name: name, url: url });
    }
    cancelEdit();
  });

  newUrl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') addBtn.click();
  });
  cancelBtn.addEventListener('click', cancelEdit);

  saveDirBtn.addEventListener('click', function () {
    const dir = installDir.value.trim();
    if (!dir) { installDir.focus(); return; }
    vscode.postMessage({ type: 'updateInstallDir', path: dir });
  });
  browseBtn.addEventListener('click', function () {
    vscode.postMessage({ type: 'pickInstallDir' });
  });

  window.addEventListener('message', function (e) {
    const msg = e.data || {};
    if (msg.type === 'init') {
      render(msg.data || {});
      cancelEdit();
    } else if (msg.type === 'reachability') {
      const nodes = srcList.querySelectorAll('.reach');
      for (const el of nodes) {
        if (el.dataset.id !== msg.id) continue;
        el.className = 'reach show ' + (msg.ok ? 'ok' : 'fail');
        el.textContent = msg.ok
          ? tr('settings.reachability.online', { count: msg.count })
          : tr('settings.reachability.offline');
        break;
      }
    }
  });
</script>
</body>
</html>`;
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
