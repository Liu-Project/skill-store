import * as vscode from 'vscode';
import { SkillStoreClient, SkillSummary } from './skillstoreClient';
import { getActiveSource, getConfig } from './config';
import { listInstalled } from './installer';
import { compareVersions, isComparableVersion } from './util';
import { currentLanguage, messages, t } from './i18n';

export type CardStatus = 'install' | 'installed' | 'upgrade' | 'overwrite';

interface CardSkill {
  slug: string;
  namespace: string;
  name: string;
  description: string;
  version: string;
  categories: string[];
  author: string;
  downloads: number;
  stars: number;
  updatedAt: string;
  status: CardStatus;
  installedVersion?: string;
}

interface CardRequest {
  type: string;
  query?: string;
  category?: string;
  limit?: number;
  slug?: string;
  namespace?: string;
  version?: string;
  force?: boolean;
  requestId?: number;
}

let panel: vscode.WebviewPanel | undefined;

export interface InstalledEntry {
  version: string;
  managed: boolean;
}

// 已安装技能缓存：避免每次 init/search 消息都同步扫盘（短 TTL，安装/卸载后最多 2s 内失效）
let installedCache: { at: number; map: Map<string, InstalledEntry> } | undefined;
const INSTALLED_CACHE_TTL_MS = 2000;

function getInstalledMap(): Map<string, InstalledEntry> {
  const now = Date.now();
  if (installedCache && now - installedCache.at < INSTALLED_CACHE_TTL_MS) {
    return installedCache.map;
  }
  const map = new Map<string, InstalledEntry>();
  for (const s of listInstalled(getConfig().installDir)) {
    map.set(`${s.namespace}/${s.slug}`, {
      version: s.version,
      managed: s.managed !== false,
    });
  }
  installedCache = { at: now, map };
  return map;
}

export function openMarketPanel(context: vscode.ExtensionContext): void {
  if (panel) {
    panel.reveal(vscode.ViewColumn.Active);
    panel.webview.postMessage({ type: 'refresh' });
    return;
  }

  panel = vscode.window.createWebviewPanel(
    'skillstore.market',
    t('market.panelTitle'),
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      localResourceRoots: [],
      retainContextWhenHidden: true,
    }
  );

  panel.webview.html = renderMarketHtml(panel);

  const sendState = async (msg: CardRequest): Promise<void> => {
    const src = getActiveSource();
    if (!src) {
      panel?.webview.postMessage({
        type: 'error',
        message: t('market.noSource'),
      });
      return;
    }
    try {
      const client = new SkillStoreClient(src.url);
      const installedMap = getInstalledMap();
      if (msg.type === 'init') {
        const [categories, search] = await Promise.all([
          client.getCategories(),
          client.search('', msg.limit || 100),
        ]);
        panel?.webview.postMessage({
          type: 'data',
          requestId: msg.requestId,
          categories: categories.map((c) => c.name),
          skills: (search.results ?? []).map((s) => toCard(s, installedMap)),
        });
        return;
      }
      if (msg.type === 'search') {
        const search = await client.search(
          msg.query || '',
          msg.limit || 100,
          msg.category || undefined
        );
        panel?.webview.postMessage({
          type: 'data',
          requestId: msg.requestId,
          skills: (search.results ?? []).map((s) => toCard(s, installedMap)),
        });
        return;
      }
    } catch (err) {
      panel?.webview.postMessage({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  panel.webview.onDidReceiveMessage((msg: CardRequest) => {
    if (msg.type === 'init' || msg.type === 'search') {
      void sendState(msg);
      return;
    }
    if (msg.type === 'openSettings') {
      void vscode.commands.executeCommand('skillstore.openSettings');
      return;
    }
    if (msg.type === 'openRegistry') {
      void vscode.commands.executeCommand('skillstore.openRegistry');
      return;
    }
    if (msg.type === 'publish') {
      Promise.resolve(
        vscode.commands.executeCommand('skillstore.publishSkill')
      ).then(
        () => panel?.webview.postMessage({ type: 'refresh' }),
        (err) => {
          panel?.webview.postMessage({
            type: 'error',
            message: t('market.publishFailed', {
              error: err instanceof Error ? err.message : String(err),
            }),
          });
        }
      );
      return;
    }
    if (msg.type === 'refreshAll') {
      void vscode.commands.executeCommand('skillstore.refreshAll');
      return;
    }
    if (msg.type === 'detail') {
      const summary: SkillSummary = {
        slug:
          msg.namespace && msg.namespace !== 'global'
            ? `${msg.namespace}--${msg.slug}`
            : (msg.slug as string),
      };
      vscode.commands.executeCommand('skillstore.showSkillDetail', {
        summary,
        namespace: msg.namespace,
      } as { summary: SkillSummary; namespace?: string });
      return;
    }
    if (msg.type === 'install') {
      const summary: SkillSummary = {
        slug:
          msg.namespace && msg.namespace !== 'global'
            ? `${msg.namespace}--${msg.slug}`
            : (msg.slug as string),
      };
      const cmd = msg.force
        ? 'skillstore.upgradeSkill'
        : 'skillstore.installSkill';
      vscode.commands
        .executeCommand(cmd, {
          summary,
          namespace: msg.namespace,
          version: msg.version,
        } as { summary: SkillSummary; namespace?: string; version?: string })
        .then(
          (result) => {
            const r = result as
              | { ok?: boolean; cancelled?: boolean; error?: string }
              | undefined;
            if (r && r.ok === false) {
              if (!r.cancelled) {
                panel?.webview.postMessage({
                  type: 'error',
                  message: t('market.installFailed', {
                    error: r.error || t('common.unknown'),
                  }),
                });
              }
              return;
            }
            panel?.webview.postMessage({
              type: 'installed',
              slug: msg.slug,
            });
          },
          (err) => {
            panel?.webview.postMessage({
              type: 'error',
              message: t('market.installFailed', {
                error: err instanceof Error ? err.message : String(err),
              }),
            });
          }
        );
    }
  });

  panel.onDidDispose(() => {
    panel = undefined;
  });

  void sendState({ type: 'init' });
}

export function refreshMarketPanel(): void {
  if (panel) {
    panel.webview.postMessage({ type: 'refresh' });
  }
}

export function toCard(
  s: SkillSummary,
  installed?: Map<string, InstalledEntry | string>
): CardSkill {
  const namespace = s.slug.includes('--')
    ? s.slug.slice(0, s.slug.indexOf('--'))
    : 'global';
  const shortSlug = s.slug.includes('--')
    ? s.slug.slice(s.slug.indexOf('--') + 2)
    : s.slug;
  const key = `${namespace}/${shortSlug}`;
  const local = installed?.get(key);
  const localVersion =
    typeof local === 'string' ? local : local?.version;
  const hasLocal = installed?.has(key) ?? false;
  let status: CardStatus = 'install';
  if (hasLocal) {
    if (!isComparableVersion(localVersion)) {
      status = 'overwrite';
    } else {
      status =
        isComparableVersion(s.version) &&
        compareVersions(s.version as string, localVersion as string) > 0
          ? 'upgrade'
          : 'installed';
    }
  }
  return {
    slug: shortSlug,
    namespace,
    name: s.name || s.slug,
    description: s.description || '',
    version: s.version || '',
    categories: s.categories || [],
    author: s.author?.displayName || s.author?.handle || t('market.author.unknown'),
    downloads: s.downloadCount ?? 0,
    stars: s.starCount ?? 0,
    updatedAt: s.updatedAt || '',
    status,
    installedVersion: localVersion,
  };
}

export function renderMarketHtml(
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
  .page { padding: 16px 20px 40px; max-width: 1400px; margin: 0 auto; }
  .topbar {
    position: sticky;
    top: 0;
    z-index: 20;
    margin: -16px -20px 18px;
    padding: 14px 20px 12px;
    background: var(--vscode-editor-background);
    border-bottom: 1px solid var(--vscode-panel-border);
  }
  .brand-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: 12px;
  }
  .brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .logo {
    width: 36px;
    height: 36px;
    border-radius: 10px;
    background: linear-gradient(135deg, #2b6ff0, #8b5cff);
    display: flex;
    align-items: center;
    justify-content: center;
    color: #fff;
    font-size: 17px;
    font-weight: 700;
    flex-shrink: 0;
    box-shadow: 0 4px 14px rgba(43, 111, 240, 0.35);
  }
  .logo svg { width: 22px; height: 22px; display: block; }
  .brand-title { font-size: 16px; font-weight: 700; letter-spacing: .2px; }
  .brand-sub { font-size: 12px; color: var(--vscode-descriptionForeground); margin-top: 2px; }
  .brand-sub.error { color: var(--vscode-errorForeground, #f48771); }
  .toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .search-wrap { position: relative; flex: 1; min-width: 220px; display: flex; align-items: center; }
  .search-wrap .search-icon {
    position: absolute;
    left: 10px;
    width: 14px;
    height: 14px;
    color: var(--vscode-descriptionForeground);
    pointer-events: none;
  }
  .toolbar input {
    width: 100%;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    border-radius: 8px;
    padding: 8px 30px 8px 32px;
    font-size: 13px;
    transition: border-color .15s ease, box-shadow .15s ease;
  }
  .toolbar input:focus {
    outline: none;
    border-color: var(--vscode-focusBorder);
    box-shadow: 0 0 0 1px var(--vscode-focusBorder);
  }
  .clear-btn {
    position: absolute;
    right: 6px;
    width: 20px;
    height: 20px;
    border: none;
    border-radius: 50%;
    background: transparent;
    color: var(--vscode-descriptionForeground);
    font-size: 15px;
    line-height: 1;
    cursor: pointer;
  }
  .clear-btn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.2)); }
  .toolbar select {
    background: var(--vscode-dropdown-background);
    color: var(--vscode-dropdown-foreground);
    border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border));
    border-radius: 8px;
    padding: 8px 10px;
    font-size: 13px;
    max-width: 180px;
  }
  .icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 8px;
    background: transparent;
    color: var(--vscode-foreground);
    cursor: pointer;
  }
  .icon-btn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.2)); }
  .icon-btn svg { width: 15px; height: 15px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 14px; }
  .card {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 16px;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 12px;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    cursor: pointer;
    overflow: hidden;
    transition: transform .18s ease, border-color .18s ease, box-shadow .18s ease;
  }
  .card::before {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: 12px;
    background: linear-gradient(135deg, hsla(var(--h), 80%, 60%, .10), transparent 48%);
    opacity: 0;
    transition: opacity .18s ease;
    pointer-events: none;
  }
  .card:hover, .card:focus-visible {
    transform: translateY(-2px);
    border-color: var(--vscode-focusBorder);
    box-shadow: 0 10px 26px rgba(0, 0, 0, .18);
    outline: none;
  }
  .card:hover::before, .card:focus-visible::before { opacity: 1; }
  .card-head { display: flex; gap: 10px; align-items: flex-start; position: relative; }
  .avatar {
    width: 42px;
    height: 42px;
    border-radius: 12px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 18px;
    font-weight: 700;
    color: #fff;
    background: linear-gradient(135deg, hsl(var(--h), 72%, 58%), hsl(var(--h2), 72%, 46%));
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .18);
  }
  .head-main { flex: 1; min-width: 0; }
  .name-row { display: flex; align-items: center; gap: 6px; min-width: 0; flex-wrap: wrap; }
  .name {
    font-size: 14px;
    font-weight: 600;
    min-width: 0;
    white-space: normal;
    overflow-wrap: anywhere;
    word-break: break-word;
    line-height: 1.3;
  }
  .sub-row {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    margin-top: 4px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
  }
  .sub-row .ver { font-weight: 600; }
  .sub-row .new { color: var(--vscode-charts-green, #2da44e); font-weight: 600; }
  .sub-row .arrow { opacity: .7; }
  .sub-row .dot { opacity: .5; }
  .badge {
    flex-shrink: 0;
    font-size: 10px;
    font-weight: 600;
    border-radius: 999px;
    padding: 2px 8px;
    line-height: 16px;
    white-space: nowrap;
  }
  .badge.installed {
    color: var(--vscode-charts-green, #2da44e);
    background: rgba(45, 164, 78, .14);
    border: 1px solid rgba(45, 164, 78, .35);
  }
  .badge.upgrade {
    color: var(--vscode-charts-yellow, #e2b93b);
    background: rgba(226, 185, 59, .14);
    border: 1px solid rgba(226, 185, 59, .4);
  }
  .desc {
    position: relative;
    margin: 0;
    font-size: 12px;
    line-height: 1.65;
    color: var(--vscode-descriptionForeground);
    display: -webkit-box;
    -webkit-line-clamp: 5;
    -webkit-box-orient: vertical;
    overflow: hidden;
    min-height: 3.9em;
  }
  .desc.expanded {
    display: block;
    -webkit-line-clamp: unset;
    overflow: visible;
    min-height: 0;
  }
  .desc-toggle {
    display: none;
    align-self: flex-start;
    margin-top: -5px;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--vscode-textLink-foreground, #3794fc);
    font-size: 13px;
    line-height: 1.5;
    cursor: pointer;
  }
  .desc-toggle:hover { text-decoration: underline; }
  .tags { display: flex; gap: 5px; flex-wrap: wrap; position: relative; }
  .tag {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    background: var(--vscode-badge-background, rgba(128,128,128,.15));
    border-radius: 999px;
    padding: 2px 8px;
    line-height: 15px;
  }
  .card-foot {
    position: relative;
    margin-top: auto;
    padding-top: 4px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .stats {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    min-width: 0;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
  }
  .stat { display: inline-flex; align-items: center; gap: 3px; white-space: nowrap; }
  .stat .ico { opacity: .75; }
  .btn {
    flex-shrink: 0;
    border: none;
    border-radius: 8px;
    padding: 6px 14px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    transition: background .15s ease, opacity .15s ease;
  }
  .btn:hover { background: var(--vscode-button-hoverBackground); }
  .btn:disabled { opacity: .65; cursor: default; }
  .btn.installed {
    background: transparent;
    color: var(--vscode-descriptionForeground);
    border: 1px solid var(--vscode-panel-border);
  }
  .btn.ghost {
    background: transparent;
    color: var(--vscode-textLink-foreground, var(--vscode-foreground));
    border: 1px solid var(--vscode-panel-border);
  }
  .btn.ghost:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.15)); }
  .skeleton-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 14px; }
  .skel-card {
    position: relative;
    height: 196px;
    padding: 16px;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 12px;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    display: flex;
    flex-direction: column;
    gap: 12px;
    overflow: hidden;
  }
  .skel-card::after {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(90deg, transparent, rgba(255, 255, 255, .07), transparent);
    transform: translateX(-100%);
    animation: shimmer 1.4s infinite;
  }
  @keyframes shimmer { to { transform: translateX(100%); } }
  .skel { background: var(--vscode-panel-border); border-radius: 6px; opacity: .55; }
  .skel.head { display: flex; gap: 10px; align-items: center; }
  .skel.avatar { width: 42px; height: 42px; border-radius: 12px; }
  .skel.lines { flex: 1; display: flex; flex-direction: column; gap: 7px; }
  .skel.line { height: 10px; }
  .skel.line.w60 { width: 60%; }
  .skel.line.w80 { width: 80%; }
  .skel.line.w40 { width: 40%; }
  .skel.block { height: 44px; }
  .skel.block.short { height: 26px; width: 55%; }
  .empty, .error-box {
    grid-column: 1 / -1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 56px 20px;
    text-align: center;
    border: 1px dashed var(--vscode-panel-border);
    border-radius: 14px;
    color: var(--vscode-descriptionForeground);
  }
  .empty svg { width: 56px; height: 56px; opacity: .55; margin-bottom: 4px; }
  .empty-title { font-size: 15px; font-weight: 600; color: var(--vscode-foreground); }
  .empty-sub { font-size: 12px; margin-bottom: 6px; }
  .error-box { border-style: solid; border-color: rgba(244, 135, 113, .4); }
  .error-title { font-size: 14px; font-weight: 600; color: var(--vscode-errorForeground, #f48771); }
  .error-msg { font-size: 12px; max-width: 560px; word-break: break-all; }
  @media (max-width: 560px) {
    .page { padding: 12px 12px 32px; }
    .topbar { margin: -12px -12px 14px; padding: 12px; }
    .toolbar select { flex: 1; max-width: none; }
    .grid, .skeleton-grid { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
  <div class="page">
    <div class="topbar">
      <div class="brand-row">
        <div class="brand">
          <div class="logo" aria-hidden="true">
            <svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M7 11h18l1.3 14.2A2.3 2.3 0 0 1 24 27.6H8a2.3 2.3 0 0 1-2.3-2.4L7 11z" fill="rgba(255,255,255,.14)" stroke="#fff" stroke-width="1.7" stroke-linejoin="round"/>
              <path d="M11.5 11V8.8a4.5 4.5 0 0 1 9 0V11" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/>
              <path d="M16 14.2l1.25 3.05L20.3 18.5l-3.05 1.25L16 22.8l-1.25-3.05L11.7 18.5l3.05-1.25L16 14.2z" fill="#fff"/>
            </svg>
          </div>
          <div>
            <div class="brand-title">${t('market.title')}</div>
            <div class="brand-sub" id="summary">${t('market.summary.loading')}</div>
          </div>
        </div>
      </div>
      <div class="toolbar">
        <div class="search-wrap">
          <svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7"></circle>
            <path d="M20 20l-3.5-3.5"></path>
          </svg>
          <input id="searchInput" placeholder="${t('market.search.placeholder')}" aria-label="${t('market.search.placeholder')}"/>
          <button id="clearBtn" class="clear-btn" title="${t('market.search.clear')}" aria-label="${t('market.search.clear')}" hidden>×</button>
        </div>
        <select id="catSelect" title="${t('market.category.title')}" aria-label="${t('market.category.title')}">
          <option value="">${t('market.category.all')}</option>
        </select>
        <select id="sortSelect" title="${t('market.sort.title')}" aria-label="${t('market.sort.title')}">
          <option value="relevance">${t('market.sort.relevance')}</option>
          <option value="downloads">${t('market.sort.downloads')}</option>
          <option value="stars">${t('market.sort.stars')}</option>
          <option value="updated">${t('market.sort.updated')}</option>
          <option value="name">${t('market.sort.name')}</option>
        </select>
        <button id="refreshBtn" class="icon-btn" title="${t('market.refresh.title')}" aria-label="${t('market.refresh.title')}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M21 12a9 9 0 1 1-2.64-6.36"></path>
            <path d="M21 3v6h-6"></path>
          </svg>
        </button>
        <button id="settingsBtn" class="icon-btn" title="${t('market.settings.title')}" aria-label="${t('market.settings.title')}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3"></circle>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1.08 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
          </svg>
        </button>
        <button id="registryBtn" class="icon-btn" title="${t('market.registry.title')}" aria-label="${t('market.registry.title')}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="9"></circle>
            <path d="M3 12h18"></path>
            <path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18z"></path>
          </svg>
        </button>
        <button id="uploadBtn" class="icon-btn" title="${t('market.upload.title')}" aria-label="${t('market.upload.title')}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 16V4"></path>
            <path d="M7 9l5-5 5 5"></path>
            <path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"></path>
          </svg>
        </button>
      </div>
    </div>
    <div class="grid" id="grid"></div>
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
  const grid = document.getElementById('grid');
  const summary = document.getElementById('summary');
  const searchInput = document.getElementById('searchInput');
  const clearBtn = document.getElementById('clearBtn');
  const catSelect = document.getElementById('catSelect');
  const sortSelect = document.getElementById('sortSelect');
  const refreshBtn = document.getElementById('refreshBtn');
  let lastQuery = '';
  let lastCategory = '';
  let sortKey = 'relevance';
  let skills = [];
  let loading = false;

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function hueOf(text) {
    let h = 0;
    const s = String(text || '');
    for (let i = 0; i < s.length; i++) {
      h = (h * 31 + s.charCodeAt(i)) % 360;
    }
    return h;
  }

  function fmtNum(n) {
    const v = Number(n) || 0;
    if (v >= 10000) return (v / 10000).toFixed(1).replace(/\\.0$/, '') + 'w';
    if (v >= 1000) return (v / 1000).toFixed(1).replace(/\\.0$/, '') + 'k';
    return String(v);
  }

  function relTime(iso) {
    if (!iso) return '';
    const t = new Date(iso).getTime();
    if (isNaN(t)) return '';
    const diff = Date.now() - t;
    if (diff < 60000) return tr('market.time.now');
    if (diff < 3600000) return tr('market.time.minutes', { n: Math.floor(diff / 60000) });
    if (diff < 86400000) return tr('market.time.hours', { n: Math.floor(diff / 3600000) });
    if (diff < 2592000000) return tr('market.time.days', { n: Math.floor(diff / 86400000) });
    return new Date(t).toLocaleDateString();
  }

  function updateSummary(extra) {
    const bits = [];
    bits.push(tr('market.summary.count', { count: skills.length }));
    if (lastQuery) bits.push(tr('market.summary.query', { query: lastQuery }));
    if (lastCategory) bits.push(tr('market.summary.category', { category: lastCategory }));
    if (extra) bits.push(extra);
    summary.textContent = bits.join(' · ');
    summary.classList.remove('error');
  }

  function showSkeleton() {
    loading = true;
    let html = '<div class="skeleton-grid">';
    for (let i = 0; i < 6; i++) {
      html += '<div class="skel-card">' +
        '<div class="skel head"><div class="skel avatar"></div><div class="skel lines">' +
        '<div class="skel line w60"></div><div class="skel line w40"></div></div></div>' +
        '<div class="skel block"></div><div class="skel block"></div>' +
        '<div class="skel line w80"></div></div>';
    }
    html += '</div>';
    grid.innerHTML = html;
  }

  function sorted(list) {
    const arr = list.slice();
    if (sortKey === 'downloads') {
      arr.sort(function (a, b) { return (b.downloads || 0) - (a.downloads || 0); });
    } else if (sortKey === 'stars') {
      arr.sort(function (a, b) { return (b.stars || 0) - (a.stars || 0); });
    } else if (sortKey === 'updated') {
      arr.sort(function (a, b) {
        return (new Date(b.updatedAt || 0).getTime() || 0) - (new Date(a.updatedAt || 0).getTime() || 0);
      });
    } else if (sortKey === 'name') {
      arr.sort(function (a, b) { return String(a.name).localeCompare(String(b.name), 'zh'); });
    }
    return arr;
  }

  function stateBadge(state) {
    if (state === 'upgrade') return '<span class="badge upgrade">' + tr('market.badge.upgrade') + '</span>';
    if (state === 'overwrite') return '<span class="badge installed">' + tr('market.badge.unknown') + '</span>';
    if (state === 'installed') return '<span class="badge installed">' + tr('market.badge.installed') + '</span>';
    return '';
  }

  function versionLine(s) {
    if (s.status === 'upgrade' && s.installedVersion) {
      return '<span class="ver">v' + escapeHtml(s.installedVersion) + '</span>' +
        '<span class="arrow">→</span>' +
        '<span class="new">v' + escapeHtml(s.version) + '</span>';
    }
    if (!s.version) {
      return '<span class="ver">' + escapeHtml(tr('common.latest')) + '</span>';
    }
    return '<span class="ver">v' + escapeHtml(s.version) + '</span>';
  }

  function render() {
    loading = false;
    if (skills.length === 0) {
      grid.innerHTML = '<div class="empty">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">' +
        '<circle cx="11" cy="11" r="7"></circle><path d="M20 20l-3.5-3.5"></path></svg>' +
        '<div class="empty-title">' + tr('market.empty.title') + '</div>' +
        '<div class="empty-sub">' + tr('market.empty.sub') + '</div>' +
        '<button class="btn ghost" id="resetBtn">' + tr('market.empty.reset') + '</button></div>';
      const resetBtn = document.getElementById('resetBtn');
      if (resetBtn) resetBtn.addEventListener('click', resetFilters);
      return;
    }
    const list = sorted(skills);
    let html = '';
    for (const s of list) {
      const state = s.status || 'install';
      const hue = hueOf(s.slug);
      const cats = (s.categories || []).map(function (c) {
        return '<span class="tag">' + escapeHtml(c) + '</span>';
      }).join('');
      const updated = relTime(s.updatedAt);
      const stats =
        '<span class="stat"><span class="ico">↓</span>' + fmtNum(s.downloads) + '</span>' +
        '<span class="stat"><span class="ico">★</span>' + fmtNum(s.stars) + '</span>' +
        (updated ? '<span class="stat">' + escapeHtml(tr('market.updated', { time: updated })) + '</span>' : '');
      const btnText = state === 'installed'
        ? tr('market.button.installed')
        : (state === 'upgrade'
          ? tr('market.button.upgrade')
          : (state === 'overwrite' ? tr('market.button.overwrite') : tr('market.button.install')));
      const btnCls = state === 'installed' ? 'btn installed' : 'btn';
      const disabled = state === 'installed' ? ' disabled' : '';
      html += '<article class="card" tabindex="0" data-slug="' + escapeHtml(s.slug) + '" data-ns="' + escapeHtml(s.namespace) + '" data-version="' + escapeHtml(s.version) + '" style="--h:' + hue + ';--h2:' + ((hue + 42) % 360) + '">' +
        '<div class="card-head">' +
          '<div class="avatar">' + escapeHtml(String(s.name || s.slug).slice(0, 1).toUpperCase()) + '</div>' +
          '<div class="head-main">' +
            '<div class="name-row"><span class="name" title="' + escapeHtml(s.name) + '">' + escapeHtml(s.name) + '</span>' +
              stateBadge(state) + '</div>' +
            '<div class="sub-row">' + versionLine(s) + '<span class="dot">·</span>' +
              '<span class="author">' + escapeHtml(s.author) + '</span></div>' +
          '</div>' +
        '</div>' +
        '<p class="desc">' + escapeHtml(s.description || tr('common.noDescription')) + '</p>' +
        '<button class="desc-toggle" type="button" aria-expanded="false">' + tr('market.desc.expand') + '</button>' +
        (cats ? '<div class="tags">' + cats + '</div>' : '') +
        '<div class="card-foot"><div class="stats">' + stats + '</div>' +
          '<button class="' + btnCls + '" data-state="' + escapeHtml(state) + '"' + disabled + '>' + btnText + '</button>' +
        '</div>' +
      '</article>';
    }
    grid.innerHTML = html;

    grid.querySelectorAll('.card').forEach(function (card) {
      const desc = card.querySelector('.desc');
      const descToggle = card.querySelector('.desc-toggle');
      if (desc && descToggle) {
        requestAnimationFrame(function () {
          if (desc.scrollHeight > desc.clientHeight + 1) {
            descToggle.style.display = 'inline-flex';
          }
        });
        descToggle.addEventListener('click', function (ev) {
          ev.stopPropagation();
          const expanded = desc.classList.toggle('expanded');
          descToggle.textContent = expanded ? tr('market.desc.collapse') : tr('market.desc.expand');
          descToggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        });
      }
      card.addEventListener('click', function (ev) {
        if (ev.target.closest('button')) return;
        openDetail(card);
      });
      card.addEventListener('keydown', function (ev) {
        if (ev.target.closest('button')) return;
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          openDetail(card);
        }
      });
      const btn = card.querySelector('.btn');
      if (btn && !btn.disabled) {
        btn.addEventListener('click', function (ev) {
          ev.stopPropagation();
          btn.disabled = true;
          btn.textContent = tr('market.button.processing');
          vscode.postMessage({
            type: 'install',
            slug: card.dataset.slug,
            namespace: card.dataset.ns,
            version: card.dataset.version,
            force: btn.dataset.state === 'upgrade' || btn.dataset.state === 'overwrite'
          });
        });
      }
    });
  }

  function openDetail(card) {
    vscode.postMessage({
      type: 'detail',
      slug: card.dataset.slug,
      namespace: card.dataset.ns
    });
  }

  function showError(message) {
    loading = false;
    summary.textContent = message || tr('market.loadFailed');
    summary.classList.add('error');
    grid.innerHTML = '<div class="error-box">' +
      '<div class="error-title">' + tr('market.error.title') + '</div>' +
      '<div class="error-msg">' + escapeHtml(message || tr('common.unknown')) + '</div>' +
      '<button class="btn ghost" id="retryBtn">' + tr('common.retry') + '</button></div>';
    const retry = document.getElementById('retryBtn');
    if (retry) retry.addEventListener('click', refresh);
  }

  let searchSeq = 0;

  function refresh() {
    if (loading) return;
    showSkeleton();
    summary.textContent = tr('market.summary.loading');
    summary.classList.remove('error');
    const requestId = ++searchSeq;
    vscode.postMessage({
      type: 'search',
      query: lastQuery,
      category: lastCategory,
      limit: 100,
      requestId,
    });
  }

  function resetFilters() {
    lastQuery = '';
    lastCategory = '';
    searchInput.value = '';
    catSelect.value = '';
    clearBtn.hidden = true;
    refresh();
  }

  let debounce;
  searchInput.addEventListener('input', function () {
    clearBtn.hidden = searchInput.value.length === 0;
    clearTimeout(debounce);
    debounce = setTimeout(function () {
      lastQuery = searchInput.value.trim();
      refresh();
    }, 300);
  });
  clearBtn.addEventListener('click', function () {
    searchInput.value = '';
    clearBtn.hidden = true;
    lastQuery = '';
    refresh();
    searchInput.focus();
  });
  catSelect.addEventListener('change', function () {
    lastCategory = catSelect.value;
    refresh();
  });
  sortSelect.addEventListener('change', function () {
    sortKey = sortSelect.value;
    if (skills.length > 0) render();
  });
  refreshBtn.addEventListener('click', function () {
    vscode.postMessage({ type: 'refreshAll' });
  });
  document.getElementById('settingsBtn').addEventListener('click', function () {
    vscode.postMessage({ type: 'openSettings' });
  });
  document.getElementById('registryBtn').addEventListener('click', function () {
    vscode.postMessage({ type: 'openRegistry' });
  });
  document.getElementById('uploadBtn').addEventListener('click', function () {
    vscode.postMessage({ type: 'publish' });
  });

  window.addEventListener('message', function (e) {
    const msg = e.data || {};
    if (msg.type === 'data') {
      if (msg.requestId !== undefined && msg.requestId !== searchSeq) {
        return;
      }
      if (msg.categories) {
        const current = catSelect.value;
        catSelect.innerHTML = '<option value="">' + tr('market.category.all') + '</option>' +
          msg.categories.map(function (c) {
            return '<option value="' + escapeHtml(c) + '">' + escapeHtml(c) + '</option>';
          }).join('');
        if (current) catSelect.value = current;
      }
      if (msg.skills) {
        skills = msg.skills;
        updateSummary();
        render();
      }
    } else if (msg.type === 'error') {
      showError(msg.message);
    } else if (msg.type === 'installed') {
      refresh();
    } else if (msg.type === 'refresh') {
      refresh();
    }
  });

  showSkeleton();
  vscode.postMessage({ type: 'init', limit: 100 });
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
