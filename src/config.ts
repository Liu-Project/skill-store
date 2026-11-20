import * as vscode from 'vscode';
import {
  DEFAULT_INSTALL_DIR,
  expandHome,
  normalizeRegistry,
} from './util';
import { t } from './i18n';

export interface RegistrySource {
  id: string;
  name: string;
  url: string;
}

export interface SkillStoreConfig {
  sources: RegistrySource[];
  activeSource?: RegistrySource;
  installDir: string;
  openMarketOnStartup: boolean;
  autoUpdateIntervalMinutes: number;
  showStatusBar: boolean;
}

const LEGACY_ID = '__legacy__';

export const DEFAULT_SOURCES: RegistrySource[] = [
  {
    id: 'local',
    name: t('config.defaultSourceName'),
    url: 'http://127.0.0.1:3030',
  },
];

function hasExplicitSetting(
  cfg: vscode.WorkspaceConfiguration,
  key: string
): boolean {
  if (typeof cfg.inspect !== 'function') {
    return false;
  }
  const inspected = cfg.inspect(key);
  if (!inspected) {
    return false;
  }
  return (
    inspected.globalValue !== undefined ||
    inspected.workspaceValue !== undefined ||
    inspected.workspaceFolderValue !== undefined
  );
}

function normalizeSources(list: RegistrySource[]): RegistrySource[] {
  return list
    .filter((r) => r && typeof r.url === 'string' && r.url.trim())
    .map((r) => ({
      id: r.id || genId(r.url),
      name: r.name || r.url,
      url: normalizeRegistry(r.url),
    }));
}

export function getSources(): RegistrySource[] {
  const cfg = vscode.workspace.getConfiguration('skillstore');
  const explicit = hasExplicitSetting(cfg, 'registries');
  const sources = normalizeSources(
    cfg.get<RegistrySource[]>('registries', []) ?? []
  );
  if (explicit) {
    return sources;
  }

  // 升级兼容：用户曾通过旧版单源配置自定义技能源时，保留其配置
  const legacyUrl = (cfg.get<string>('registry', '') || '').trim();
  if (legacyUrl && hasExplicitSetting(cfg, 'registry')) {
    return [
      {
        id: LEGACY_ID,
        name: 'default',
        url: normalizeRegistry(legacyUrl),
      },
    ];
  }

  return sources.length > 0 ? sources : DEFAULT_SOURCES.map((s) => ({ ...s }));
}

export function getActiveSource(): RegistrySource | undefined {
  const sources = getSources();
  if (sources.length > 0) {
    const cfg = vscode.workspace.getConfiguration('skillstore');
    const activeId = cfg.get<string>('activeRegistry', '');
    return sources.find((s) => s.id === activeId) || sources[0];
  }
  const cfg = vscode.workspace.getConfiguration('skillstore');
  const legacyUrl = (cfg.get<string>('registry', '') || '').trim();
  if (!legacyUrl) {
    return undefined;
  }
  return {
    id: LEGACY_ID,
    name: 'default',
    url: normalizeRegistry(legacyUrl),
  };
}

export function getConfig(): SkillStoreConfig {
  const cfg = vscode.workspace.getConfiguration('skillstore');
  const interval = Number(cfg.get<number>('autoUpdateIntervalMinutes', 20));
  return {
    sources: getSources(),
    activeSource: getActiveSource(),
    installDir: expandHome(cfg.get<string>('installDir', DEFAULT_INSTALL_DIR)),
    openMarketOnStartup: Boolean(cfg.get<boolean>('openMarketOnStartup', false)),
    autoUpdateIntervalMinutes:
      Number.isFinite(interval) && interval >= 5 ? interval : 20,
    showStatusBar: Boolean(cfg.get<boolean>('showStatusBar', true)),
  };
}

export async function saveSources(sources: RegistrySource[]): Promise<void> {
  const clean = sources.map((s) => ({
    id: s.id,
    name: s.name,
    url: s.url,
  }));
  await vscode.workspace
    .getConfiguration('skillstore')
    .update('registries', clean, vscode.ConfigurationTarget.Global);
}

export async function setActiveSource(id: string): Promise<void> {
  await vscode.workspace
    .getConfiguration('skillstore')
    .update('activeRegistry', id, vscode.ConfigurationTarget.Global);
}

export function isLegacySource(source: RegistrySource): boolean {
  return source.id === LEGACY_ID;
}

export function genId(url: string): string {
  const base = url
    .replace(/^https?:\/\//, '')
    .replace(/[^a-zA-Z0-9.-]/g, '-')
    .slice(0, 40);
  return `${base}-${Date.now().toString(36)}`;
}
