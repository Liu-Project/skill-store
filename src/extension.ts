import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
  SkillStoreClient,
  SkillSummary,
  parseSlug,
  toCanonicalSlug,
  mapLimit,
} from './skillstoreClient';
import {
  getConfig,
  getActiveSource,
  getSources,
  saveSources,
  setActiveSource,
  genId,
  RegistrySource,
} from './config';
import { installSkill, listInstalled, uninstallSkill, updateIfNeeded, InstalledSkill, installDirFor } from './installer';
import {
  InstalledSkillNode,
  InstalledTreeProvider,
  MarketSkillNode,
  MarketTreeProvider,
} from './skillTree';
import { openSkillDetail, DetailPayload } from './webview';
import { openSettingsPanel } from './settingsPanel';
import { openMarketPanel, refreshMarketPanel } from './marketPanel';
import { refreshViews } from './refresh';
import {
  publishSkill,
  readSkillFrontmatter,
} from './publish';
import { compareVersions, isComparableVersion } from './util';
import { t } from './i18n';

interface InstallTarget {
  summary: SkillSummary;
  namespace?: string;
  version?: string;
}

export interface InstallCommandResult {
  ok: boolean;
  cancelled?: boolean;
  error?: string;
  version?: string;
  dir?: string;
}

let logChannel: vscode.OutputChannel | undefined;

function log(message: string): void {
  logChannel?.appendLine(`[${new Date().toISOString()}] ${message}`);
}

export function activate(context: vscode.ExtensionContext): void {
  logChannel = vscode.window.createOutputChannel('SkillStore');
  context.subscriptions.push(logChannel);

  const marketProvider = new MarketTreeProvider();
  const installedProvider = new InstalledTreeProvider();

  const marketView = vscode.window.createTreeView('skillstore.marketView', {
    treeDataProvider: marketProvider,
  });

  context.subscriptions.push(
    marketView,
    vscode.window.registerTreeDataProvider(
      'skillstore.installedView',
      installedProvider
    )
  );

  const fetchStoreKeys = async (
    src: RegistrySource
  ): Promise<Set<string> | undefined> => {
    try {
      const result = await new SkillStoreClient(src.url).search('', 500);
      const keys = new Set<string>();
      for (const s of result.results ?? []) {
        const { namespace, slug } = parseSlug(s.slug);
        keys.add(`${namespace}/${slug}`);
      }
      return keys;
    } catch (err) {
      log(
        `Failed to read registry list; the installed view will only show registry-installed skills: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      return undefined;
    }
  };

  const syncInstalled = async (): Promise<void> => {
    const all = listInstalled(getConfig().installDir);
    // 技能广场视图需要全部本地技能，才能把手动放置的同名技能识别为已安装
    marketProvider.setInstalled(all);
    const managed = all.filter((s) => s.managed !== false);
    // 先展示技能广场安装的技能，再异步补充技能源中存在的手动技能
    installedProvider.setSkills(managed);
    const src = getActiveSource();
    if (!src) {
      return;
    }
    const storeKeys = await fetchStoreKeys(src);
    if (storeKeys) {
      installedProvider.setSkills(
        all.filter(
          (s) =>
            s.managed !== false ||
            storeKeys.has(`${s.namespace}/${s.slug}`)
        )
      );
    }
  };
  void syncInstalled();

  const syncInstalledAndPanel = (): void => {
    void syncInstalled().then(() => refreshMarketPanel());
  };

  const autoUpdateKey = 'skillstore.autoUpdate';
  const autoUpdateMap = new Map<string, boolean>(
    Object.entries(
      context.globalState.get<Record<string, boolean>>(autoUpdateKey, {})
    )
  );
  installedProvider.setAutoUpdate(
    autoUpdateMap,
    getConfig().autoUpdateIntervalMinutes
  );

  installedProvider.onDidChangeCheckboxState((e) => {
    for (const [node, state] of e.items) {
      const key = `${node.skill.namespace}/${node.skill.slug}`;
      autoUpdateMap.set(
        key,
        state === vscode.TreeItemCheckboxState.Checked
      );
    }
    context.globalState.update(
      autoUpdateKey,
      Object.fromEntries(autoUpdateMap)
    );
  });

  const runAutoUpdate = async (): Promise<void> => {
    try {
      await autoUpdateCheck(context, syncInstalledAndPanel);
    } catch {
      // Auto-update failures must never block activation.
    }
  };
  let autoUpdateTimer: NodeJS.Timeout | undefined;
  const startAutoUpdateTimer = (): void => {
    if (autoUpdateTimer) {
      clearInterval(autoUpdateTimer);
    }
    const minutes = Math.max(5, getConfig().autoUpdateIntervalMinutes);
    autoUpdateTimer = setInterval(runAutoUpdate, minutes * 60 * 1000);
  };
  setTimeout(runAutoUpdate, 3000);
  startAutoUpdateTimer();
  context.subscriptions.push(
    new vscode.Disposable(() => {
      if (autoUpdateTimer) {
        clearInterval(autoUpdateTimer);
      }
    })
  );

  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  statusBar.command = 'skillstore.openSettings';
  context.subscriptions.push(statusBar);
  const updateStatusBar = (): void => {
    if (!getConfig().showStatusBar) {
      statusBar.hide();
      return;
    }
    const src = getActiveSource();
    if (src) {
      statusBar.text = `$(server) ${src.name}`;
      statusBar.tooltip = t('status.registryTooltip', { url: src.url });
    } else {
      statusBar.text = t('status.noRegistry');
      statusBar.tooltip = t('status.noRegistryTooltip');
    }
    statusBar.show();
  };
  updateStatusBar();

  const updateNoSourceContext = (): void => {
    vscode.commands.executeCommand(
      'setContext',
      'skillstore.noSource',
      !getActiveSource()
    );
  };

  const refreshAllViews = async (): Promise<void> => {
    updateStatusBar();
    updateNoSourceContext();
    await refreshViews({
      installed: syncInstalled,
      market: async () => {
        const src = getActiveSource();
        if (src) {
          await runSearch(
            marketProvider,
            new SkillStoreClient(src.url),
            marketProvider.currentQuery
          );
        }
      },
      panel: refreshMarketPanel,
    });
  };

  const refreshAllFull = (): void => {
    void refreshAllViews();
  };
  updateNoSourceContext();

  context.subscriptions.push(
    vscode.commands.registerCommand('skillstore.openSettings', () => {
      openSettingsPanel(context, refreshAllFull);
    }),

    vscode.commands.registerCommand('skillstore.openMarketPanel', () => {
      openMarketPanel(context);
    }),

    vscode.commands.registerCommand('skillstore.searchSkill', async () => {
      const src = await requireSource();
      if (!src) {
        return;
      }
      const query = await vscode.window.showInputBox({
        placeHolder: t('ext.search.placeholder'),
        prompt: t('ext.search.prompt', { name: src.name }),
        ignoreFocusOut: true,
      });
      if (query === undefined) {
        return;
      }
      await runSearch(marketProvider, new SkillStoreClient(src.url), query);
    }),

    vscode.commands.registerCommand('skillstore.refreshMarket', async () => {
      const src = await requireSource();
      if (!src) {
        refreshMarketPanel();
        return;
      }
      await refreshViews({
        market: () =>
          runSearch(
            marketProvider,
            new SkillStoreClient(src.url),
            marketProvider.currentQuery
          ),
        panel: refreshMarketPanel,
      });
    }),

    vscode.commands.registerCommand('skillstore.refreshAll', async () => {
      await refreshAllViews();
    }),

    vscode.commands.registerCommand(
      'skillstore.filterCategory',
      async () => {
        const src = await requireSource();
        if (!src) {
          return;
        }
        const categories = marketProvider.getCategories();
        const items: Array<vscode.QuickPickItem & { value: string }> = [
          {
            label: t('ext.category.all'),
            description: t('ext.category.allDescription'),
            value: '',
          },
          ...categories.map((c) => ({
            label: c.name,
            description: t('ext.category.count', { count: c.count }),
            value: c.name,
          })),
        ];
        const picked = await vscode.window.showQuickPick(items, {
          placeHolder: t('ext.category.placeholder', {
            category:
              marketProvider.activeCategory || t('ext.category.all'),
          }),
        });
        if (!picked) {
          return;
        }
        const category = picked.value;
        if (category) {
          const result = await new SkillStoreClient(src.url).search(
            marketProvider.currentQuery,
            50,
            category
          );
          marketProvider.setResults(result.results ?? []);
        } else {
          await runSearch(
            marketProvider,
            new SkillStoreClient(src.url),
            marketProvider.currentQuery
          );
        }
        marketProvider.setCategoryFilter(category);
      }
    ),

    vscode.commands.registerCommand('skillstore.refreshInstalled', async () => {
      await refreshViews({
        installed: syncInstalled,
        panel: refreshMarketPanel,
      });
    }),

    vscode.commands.registerCommand(
      'skillstore.installSkill',
      async (target?: InstallTarget | MarketSkillNode) => {
        const resolvedTarget = await normalizeTarget(target);
        if (!resolvedTarget) {
          return;
        }
        return doInstall(
          resolvedTarget.summary,
          resolvedTarget.namespace,
          installedProvider,
          false,
          resolvedTarget.version
        );
      }
    ),

    vscode.commands.registerCommand(
      'skillstore.upgradeSkill',
      async (target?: InstallTarget | MarketSkillNode) => {
        const resolvedTarget = await normalizeTarget(target);
        if (!resolvedTarget) {
          return;
        }
        return doInstall(
          resolvedTarget.summary,
          resolvedTarget.namespace,
          installedProvider,
          true,
          resolvedTarget.version
        );
      }
    ),

    vscode.commands.registerCommand(
      'skillstore.uninstallSkill',
      async (node?: InstalledSkillNode) => {
        const skill = node?.skill ?? (await pickInstalled(installedProvider));
        if (!skill) {
          return;
        }
        const uninstallLabel = t('common.uninstall');
        const ok = await vscode.window.showWarningMessage(
          t('ext.uninstall.confirm', { slug: skill.slug, dir: skill.dir }),
          { modal: true },
          uninstallLabel
        );
        if (ok !== uninstallLabel) {
          return;
        }
        try {
          uninstallSkill(
            getConfig().installDir,
            skill.slug,
            skill.namespace
          );
          vscode.window.showInformationMessage(
            t('ext.uninstall.done', { slug: skill.slug })
          );
        } catch (err) {
          vscode.window.showErrorMessage(
            t('ext.uninstall.failed', {
              error: err instanceof Error ? err.message : String(err),
            })
          );
        }
        await refreshViews({
          installed: syncInstalled,
          panel: refreshMarketPanel,
        });
      }
    ),

    vscode.commands.registerCommand(
      'skillstore.showSkillDetail',
      async (target?: InstallTarget | MarketSkillNode | InstalledSkillNode) => {
        const selected = marketView.selection[0];
        const node =
          target ??
          (selected instanceof MarketSkillNode ? selected : undefined);
        const detail = await buildDetail(node);
        if (!detail) {
          return;
        }
        openSkillDetail(context, {
          ...detail,
          autoUpdateIntervalMinutes: getConfig().autoUpdateIntervalMinutes,
        });
      }
    ),

    vscode.commands.registerCommand(
      'skillstore.openSkillFolder',
      async (node?: InstalledSkillNode) => {
        const skill = node?.skill ?? (await pickInstalled(installedProvider));
        if (!skill) {
          return;
        }
        await vscode.commands.executeCommand(
          'revealFileInOS',
          vscode.Uri.file(skill.dir)
        );
      }
    ),

    vscode.commands.registerCommand(
      'skillstore.openSkillManifest',
      async (node?: InstalledSkillNode) => {
        const skill = node?.skill ?? (await pickInstalled(installedProvider));
        if (!skill) {
          return;
        }
        const manifest = path.join(skill.dir, 'SKILL.md');
        if (!fs.existsSync(manifest)) {
          vscode.window.showWarningMessage(
            t('ext.openManifest.missing', { dir: skill.dir })
          );
          return;
        }
        await vscode.window.showTextDocument(vscode.Uri.file(manifest), {
          preview: false,
        });
      }
    ),

    vscode.commands.registerCommand(
      'skillstore.copySkillCoordinate',
      async (node?: MarketSkillNode | InstalledSkillNode) => {
        let coordinate: string | undefined;
        if (node instanceof MarketSkillNode) {
          coordinate = node.summary.slug;
        } else if (node instanceof InstalledSkillNode) {
          coordinate = toCanonicalSlug(
            node.skill.namespace,
            node.skill.slug
          );
        } else {
          const input = await vscode.window.showInputBox({
            placeHolder: t('ext.install.coordinatePlaceholder'),
            prompt: t('ext.install.coordinatePrompt'),
            ignoreFocusOut: true,
          });
          coordinate = input?.trim() || undefined;
        }
        if (!coordinate) {
          return;
        }
        await vscode.env.clipboard.writeText(coordinate);
        vscode.window.showInformationMessage(
          t('ext.copyCoordinate.done', { value: coordinate })
        );
      }
    ),

    vscode.commands.registerCommand('skillstore.publishSkill', async () => {
      await doPublish(marketProvider);
    }),

    vscode.commands.registerCommand('skillstore.checkUpdates', async () => {
      await checkUpdates(installedProvider);
    }),

    vscode.commands.registerCommand(
      'skillstore.updateSkill',
      async (node?: InstalledSkillNode) => {
        const skill = node?.skill ?? (await pickInstalled(installedProvider));
        if (!skill) {
          return;
        }
        const updateLabel = t('common.update');
        const ok = await vscode.window.showWarningMessage(
          t('ext.update.confirm', { slug: skill.slug }),
          { modal: true },
          updateLabel
        );
        if (ok !== updateLabel) {
          return;
        }
        await updateOneSkill(
          skill.namespace,
          skill.slug,
          skill.registry || getActiveSource()?.url || '',
          installedProvider
        );
      }
    ),

    vscode.commands.registerCommand('skillstore.selectRegistry', async () => {
      await selectRegistry(updateStatusBar);
    }),

    vscode.commands.registerCommand('skillstore.addRegistry', async () => {
      await addRegistry(updateStatusBar);
    }),

    vscode.commands.registerCommand('skillstore.removeRegistry', async () => {
      await removeRegistry(updateStatusBar);
    }),

    vscode.commands.registerCommand('skillstore.openRegistry', async () => {
      const src = await requireSource();
      if (!src) {
        return;
      }
      vscode.env.openExternal(vscode.Uri.parse(src.url));
    })
  );

  vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('skillstore.autoUpdateIntervalMinutes')) {
      installedProvider.setAutoUpdate(
        autoUpdateMap,
        getConfig().autoUpdateIntervalMinutes
      );
      startAutoUpdateTimer();
    }
    if (e.affectsConfiguration('skillstore.showStatusBar')) {
      updateStatusBar();
    }
    if (
      e.affectsConfiguration('skillstore.installDir') ||
      e.affectsConfiguration('skillstore.registries') ||
      e.affectsConfiguration('skillstore.activeRegistry') ||
      e.affectsConfiguration('skillstore.registry')
    ) {
      refreshAllFull();
    }
  });

  void refreshAllViews();
  if (getConfig().openMarketOnStartup && getActiveSource()) {
    setTimeout(() => openMarketPanel(context), 500);
  }
}

async function requireSource(): Promise<RegistrySource | undefined> {
  const src = getActiveSource();
  if (src) {
    return src;
  }
  const configure = t('ext.noSource.configure');
  const action = await vscode.window.showWarningMessage(
    t('ext.noSource.warning'),
    configure
  );
  if (action === configure) {
    await vscode.commands.executeCommand('skillstore.openSettings');
  }
  return undefined;
}

async function selectRegistry(updateStatusBar: () => void): Promise<void> {
  const src = await requireSource();
  if (!src) {
    return;
  }
  const sources = getSources();
  if (sources.length <= 1) {
    vscode.window.showInformationMessage(
      t('ext.registry.onlyOne', { name: src.name })
    );
    return;
  }
  const picked = await vscode.window.showQuickPick(
    sources.map((s) => ({
      label: s.name,
      description: s.url,
      detail: s.id === src.id ? t('ext.registry.current') : undefined,
      value: s.id,
    })),
    { placeHolder: t('ext.registry.pick', { name: src.name }) }
  );
  if (!picked) {
    return;
  }
  await setActiveSource(picked.value);
  updateStatusBar();
  vscode.window.showInformationMessage(
    t('ext.registry.switched', { name: picked.label })
  );
}

async function addRegistry(updateStatusBar: () => void): Promise<void> {
  await vscode.commands.executeCommand('skillstore.openSettings');
  updateStatusBar();
}

async function removeRegistry(updateStatusBar: () => void): Promise<void> {
  const src = await requireSource();
  if (!src) {
    return;
  }
  vscode.window.showInformationMessage(
    t('ext.registry.manageInSettings')
  );
  await vscode.commands.executeCommand('skillstore.openSettings');
  updateStatusBar();
}

async function runSearch(
  provider: MarketTreeProvider,
  c: SkillStoreClient,
  query: string
): Promise<void> {
  provider.setQuery(query);
  provider.setLoading(true);
  try {
    const result = await c.search(query);
    provider.setResults(result.results ?? []);
  } catch (err) {
    provider.setResults(
      [],
      err instanceof Error ? err.message : String(err)
    );
    vscode.window.showErrorMessage(
      t('ext.search.failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    );
  }
}

async function normalizeTarget(
  target?: InstallTarget | MarketSkillNode
): Promise<InstallTarget | undefined> {
  if (target instanceof MarketSkillNode) {
    return { summary: target.summary };
  }
  if (target && 'summary' in target && target.summary) {
    return target;
  }
  const input = await vscode.window.showInputBox({
    placeHolder: t('ext.install.coordinatePlaceholder'),
    prompt: t('ext.install.coordinatePrompt'),
    ignoreFocusOut: true,
  });
  if (!input) {
    return undefined;
  }
  const { namespace, slug } = parseSlug(input);
  return {
    summary: { slug: toDisplaySlug(namespace, slug) },
    namespace,
  };
}

function toDisplaySlug(namespace: string, slug: string): string {
  return namespace === 'global' ? slug : `${namespace}--${slug}`;
}

async function pickVersion(
  c: SkillStoreClient,
  namespace: string,
  slug: string
): Promise<string | undefined> {
  const versions = await c.getVersions(namespace, slug);
  const latest = versions[0] || 'latest';
  const items: Array<vscode.QuickPickItem & { value: string }> = [
    {
      label: t('ext.version.latest', { version: latest }),
      description: t('ext.version.recommended'),
      value: '',
    },
    ...versions.map((v) => ({ label: v, value: v })),
    { label: t('ext.version.manual'), value: '__manual__' },
  ];
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: t('ext.version.pick', { slug }),
  });
  if (!picked) {
    return undefined;
  }
  if (picked.value === '__manual__') {
    const input = await vscode.window.showInputBox({
      prompt: t('ext.version.prompt'),
      ignoreFocusOut: true,
    });
    if (!input || !input.trim()) {
      return undefined;
    }
    return input.trim();
  }
  return picked.value;
}

async function autoUpdateCheck(
  context: vscode.ExtensionContext,
  syncInstalled: () => void
): Promise<void> {
  const cfg = getConfig();
  const installed = listInstalled(cfg.installDir);
  const stored = context.globalState.get<Record<string, boolean>>(
    'skillstore.autoUpdate',
    {}
  );
  const active = getActiveSource();
  const updated: string[] = [];
  const targets = installed.filter(
    (s) =>
      s.managed !== false &&
      stored[`${s.namespace}/${s.slug}`] !== false &&
      Boolean(s.registry || active?.url)
  );
  await mapLimit(targets, 6, async (s) => {
    const registry = s.registry || active?.url;
    if (!registry) {
      return;
    }
    try {
      const c = new SkillStoreClient(registry);
      const resolved = await c.resolve(s.namespace, s.slug);
      if (compareVersions(resolved.version, s.version) <= 0) {
        return;
      }
      const ok = await updateIfNeeded(c, registry, cfg.installDir, s, resolved);
      if (ok) {
        updated.push(`${s.slug} → v${resolved.version}`);
      }
    } catch (err) {
      log(
        `Auto-update ${s.namespace}/${s.slug} failed: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  });
  if (updated.length > 0) {
    syncInstalled();
    vscode.window.showInformationMessage(
      t('ext.autoUpdate.done', {
        count: updated.length,
        list: updated.join('\n'),
      })
    );
  }
}

async function doInstall(
  summary: SkillSummary,
  namespaceHint: string | undefined,
  installedProvider: InstalledTreeProvider,
  force = false,
  requestedVersion?: string
): Promise<InstallCommandResult> {
  const cfg = getConfig();
  const src = getActiveSource();
  if (!src) {
    await requireSource();
    return { ok: false, cancelled: true };
  }
  const { namespace, slug } = parseSlug(summary.slug);
  const finalNamespace = namespaceHint || namespace;

  const c = new SkillStoreClient(src.url);

  let version = requestedVersion;
  if (!force && !requestedVersion) {
    const pickedVersion = await pickVersion(c, finalNamespace, slug);
    if (pickedVersion === undefined) {
      return { ok: false, cancelled: true };
    }
    version = pickedVersion || undefined;
  }

  const targetDir = installDirFor(cfg.installDir, slug, finalNamespace);
  const targetMeta = path.join(targetDir, '.skillstore', 'metadata.json');
  const isManualTarget =
    fs.existsSync(targetDir) &&
    fs.existsSync(path.join(targetDir, 'SKILL.md')) &&
    !fs.existsSync(targetMeta);
  let adopt = false;
  if (isManualTarget) {
    const overwriteLabel = t('common.overwriteUpgrade');
    const choice = await vscode.window.showWarningMessage(
      t('ext.install.manualConfirm', { slug, dir: targetDir }),
      { modal: true },
      overwriteLabel,
      t('common.cancel')
    );
    if (choice !== overwriteLabel) {
      return { ok: false, cancelled: true };
    }
    force = true;
    adopt = true;
  } else if (!force && fs.existsSync(targetDir)) {
    const overwriteLabel = t('common.overwriteInstall');
    const choice = await vscode.window.showWarningMessage(
      t('ext.install.existsConfirm', { dir: targetDir }),
      { modal: true },
      overwriteLabel,
      t('common.cancel')
    );
    if (choice !== overwriteLabel) {
      return { ok: false, cancelled: true };
    }
    force = true;
  }

  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: t(
        force
          ? 'ext.install.progress.update'
          : 'ext.install.progress.install',
        { slug }
      ),
      cancellable: false,
    },
    async (progress): Promise<InstallCommandResult> => {
      progress.report({ message: t('ext.install.progress.resolve') });
      try {
        const resolved = await c.resolve(finalNamespace, slug, version);

        progress.report({ message: t('ext.install.progress.extract') });
        const zip = await c.downloadZip(
          finalNamespace,
          slug,
          resolved.version,
          resolved.downloadUrl
        );

        const installed = await installSkill(
          cfg.installDir,
          src.url,
          finalNamespace,
          slug,
          resolved.version,
          zip,
          force,
          undefined,
          adopt
        );

        await vscode.commands.executeCommand('skillstore.refreshInstalled');
        return { ok: true, version: resolved.version, dir: installed.dir };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(
          `${force ? 'Update' : 'Install'} ${finalNamespace}/${slug} failed: ${message}`
        );
        vscode.window.showErrorMessage(
          t(
            force
              ? 'ext.install.failed.update'
              : 'ext.install.failed.install',
            { error: message }
          )
        );
        return { ok: false, error: message };
      }
    }
  );

  if (result.ok && result.dir) {
    const openLabel = t('common.openFolder');
    void vscode.window
      .showInformationMessage(
        t(
          force
            ? 'ext.install.done.update'
            : 'ext.install.done.install',
          { slug, version: result.version || '', dir: result.dir }
        ),
        openLabel
      )
      .then((open) => {
        if (open === openLabel) {
          void vscode.commands.executeCommand(
            'revealFileInOS',
            vscode.Uri.file(result.dir as string)
          );
        }
      });
  }
  return result;
}

async function doPublish(marketProvider: MarketTreeProvider): Promise<void> {
  const cfg = getConfig();
  const src = getActiveSource();
  if (!src) {
    await requireSource();
    return;
  }
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: t('ext.publish.selectLabel'),
    title: t('ext.publish.selectTitle'),
  });
  if (!picked || picked.length === 0) {
    return;
  }
  const skillDir = picked[0].fsPath;

  let fm;
  try {
    fm = readSkillFrontmatter(skillDir);
  } catch (err) {
    vscode.window.showErrorMessage(
      err instanceof Error ? err.message : String(err)
    );
    return;
  }
  const slug = fm.name || path.basename(skillDir) || 'skill';

  const strategy = await vscode.window.showQuickPick(
    [
      {
        label: t('ext.publish.strategy.auto'),
        description: t('ext.publish.strategy.autoDesc'),
        detail: t('ext.publish.strategy.autoDetail'),
        value: 'auto',
      },
      {
        label: t('ext.publish.strategy.manual'),
        description: t('ext.publish.strategy.manualDesc'),
        value: 'manual',
      },
      {
        label: t('ext.publish.strategy.force'),
        description: t('ext.publish.strategy.forceDesc'),
        value: 'force',
      },
    ],
    {
      placeHolder: t('ext.publish.strategy.placeholder', { slug }),
    }
  );
  if (!strategy) {
    return;
  }

  let categories: string[] | undefined;
  const catInput = await vscode.window.showInputBox({
    prompt: t('ext.publish.categoriesPrompt'),
    placeHolder: t('ext.publish.categoriesPlaceholder'),
    ignoreFocusOut: true,
  });
  if (catInput !== undefined && catInput.trim()) {
    categories = catInput
      .split(/[,，]/)
      .map((c) => c.trim())
      .filter(Boolean);
  }

  let version: string | undefined;
  let force = false;
  if (strategy.value === 'manual') {
    const input = await vscode.window.showInputBox({
      prompt: t('ext.publish.versionPrompt'),
      ignoreFocusOut: true,
    });
    if (!input) {
      return;
    }
    version = input.trim();
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
      vscode.window.showErrorMessage(
        t('ext.publish.invalidVersion', { version })
      );
      return;
    }
  } else if (strategy.value === 'force') {
    force = true;
    try {
      const latest = await new SkillStoreClient(src.url).resolve(
        'global',
        slug
      );
      version = latest.version;
    } catch {
      // 新技能没有可覆盖的版本，按 1.0.0 发布
    }
  }

  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: t('ext.publish.progress', { slug }),
      cancellable: false,
    },
    async () =>
      publishSkill(src.url, skillDir, {
        namespace: 'global',
        categories,
        version,
        force,
      })
  );

  if (!result.ok) {
    const error = result.error || t('common.unknown');
    log(`Publish ${slug} failed: ${error}`);
    vscode.window.showErrorMessage(t('ext.publish.failed', { error }));
    return;
  }

  const refreshLabel = t('ext.publish.refresh');
  const action = await vscode.window.showInformationMessage(
    t('ext.publish.done', {
      namespace: result.namespace || 'global',
      slug: result.slug || slug,
      version: result.version || '',
      action: t(
        result.isUpdate
          ? 'ext.publish.action.update'
          : 'ext.publish.action.publish'
      ),
    }),
    refreshLabel
  );
  if (action === refreshLabel) {
    await refreshViews({
      market: () =>
        runSearch(
          marketProvider,
          new SkillStoreClient(src.url),
          marketProvider.currentQuery
        ),
      panel: refreshMarketPanel,
    });
  }
}

async function checkUpdates(
  installedProvider: InstalledTreeProvider
): Promise<void> {
  const src = getActiveSource();
  if (!src) {
    await requireSource();
    return;
  }
  const installed = listInstalled(getConfig().installDir).filter(
    (s) => s.managed !== false
  );
  if (installed.length === 0) {
    vscode.window.showInformationMessage(t('ext.noInstalled'));
    return;
  }

  const updatable: Array<{
    namespace: string;
    slug: string;
    current: string;
    latest: string;
    registry: string;
  }> = [];
  const errors: string[] = [];

  const results = await mapLimit(installed, 6, async (s) => {
    const registry = s.registry || src.url;
    try {
      const c = new SkillStoreClient(registry);
      const resolved = await c.resolve(s.namespace, s.slug);
      if (compareVersions(resolved.version, s.version) > 0) {
        return {
          updatable: {
            namespace: s.namespace,
            slug: s.slug,
            current: s.version,
            latest: resolved.version,
            registry,
          },
          error: null,
        };
      }
      return { updatable: null, error: null };
    } catch {
      return { updatable: null, error: s.slug };
    }
  });
  for (const r of results) {
    if (r.updatable) updatable.push(r.updatable);
    if (r.error) errors.push(r.error);
  }

  if (updatable.length === 0) {
    const msg =
      errors.length > 0
        ? t('ext.checkUpdates.allUpToDateWithErrors', {
            count: errors.length,
          })
        : t('ext.checkUpdates.allUpToDate');
    vscode.window.showInformationMessage(msg);
    return;
  }

  const picked = await vscode.window.showQuickPick(
    updatable.map((u) => ({
      label: `${u.slug}`,
      description: `${u.current} → ${u.latest}`,
      detail: t('ext.checkUpdates.itemDetail', {
        namespace: u.namespace,
      }),
      data: u,
    })),
    {
      placeHolder: t('ext.checkUpdates.pick', {
        count: updatable.length,
      }),
      canPickMany: true,
    }
  );
  if (!picked) {
    return;
  }

  for (const item of picked) {
    await updateOneSkill(
      item.data.namespace,
      item.data.slug,
      item.data.registry,
      installedProvider
    );
  }
}

async function updateOneSkill(
  namespace: string,
  slug: string,
  registry: string,
  installedProvider: InstalledTreeProvider
): Promise<void> {
  const cfg = getConfig();
  if (!registry) {
    await requireSource();
    return;
  }
  try {
    const c = new SkillStoreClient(registry);
    const resolved = await c.resolve(namespace, slug);
    const zip = await c.downloadZip(
      namespace,
      slug,
      resolved.version,
      resolved.downloadUrl
    );
    await installSkill(
      cfg.installDir,
      registry,
      namespace,
      slug,
      resolved.version,
      zip,
      true
    );
    await vscode.commands.executeCommand('skillstore.refreshInstalled');
    vscode.window.showInformationMessage(
      t('ext.update.done', { slug, version: resolved.version })
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`Update ${namespace}/${slug} failed: ${message}`);
    vscode.window.showErrorMessage(
      t('ext.update.failed', { error: message })
    );
  }
}

async function pickInstalled(
  provider: InstalledTreeProvider
): Promise<InstalledSkillNode['skill'] | undefined> {
  const skills = listInstalled(getConfig().installDir).filter(
    (s) => s.managed !== false
  );
  if (skills.length === 0) {
    vscode.window.showInformationMessage(t('ext.noInstalled'));
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    skills.map((s) => ({
      label: s.slug,
      description: s.version,
      detail: s.dir,
      skill: s,
    })),
    { placeHolder: t('ext.uninstall.pick') }
  );
  return picked?.skill;
}

async function buildDetail(
  target: InstallTarget | MarketSkillNode | InstalledSkillNode | undefined
): Promise<DetailPayload | undefined> {
  const src = getActiveSource();

  const normalizeCoordinate = (
    namespace: string,
    slug: string
  ): { namespace: string; slug: string } => {
    if (slug.includes('--')) {
      return parseSlug(slug);
    }
    return { namespace, slug };
  };

  const findInstalled = (
    namespace: string,
    slug: string
  ): InstalledSkill | undefined => {
    const coord = normalizeCoordinate(namespace, slug);
    const installed = listInstalled(getConfig().installDir);
    return installed.find(
      (s) => s.slug === coord.slug && s.namespace === coord.namespace
    );
  };

  const fetchVersions = async (
    namespace: string,
    slug: string
  ): Promise<string[] | undefined> => {
    if (!src) {
      return undefined;
    }
    const coord = normalizeCoordinate(namespace, slug);
    try {
      const versions = await new SkillStoreClient(src.url).getVersions(
        coord.namespace,
        coord.slug
      );
      return versions.length > 0 ? versions : undefined;
    } catch {
      return undefined;
    }
  };

  const enrich = async (
    summary: SkillSummary,
    namespace: string
  ): Promise<SkillSummary> => {
    if (!src) {
      return summary;
    }
    if (summary.description || summary.categories?.length) {
      return summary;
    }
    try {
      const canonical = summary.slug.includes('--')
        ? summary.slug
        : toDisplaySlug(namespace, summary.slug);
      const detail = await new SkillStoreClient(src.url).getDetail(canonical);
      return detail ?? summary;
    } catch {
      return summary;
    }
  };

  if (target instanceof MarketSkillNode) {
    const summary = target.summary;
    const ns = parseSlug(summary.slug).namespace;
    const full = await enrich(summary, ns);
    const installedSkill = findInstalled(ns, full.slug);
    return {
      summary: full,
      namespace: ns,
      installed: !!installedSkill,
      installedVersion:
        installedSkill && isComparableVersion(installedSkill.version)
          ? installedSkill.version
          : undefined,
      managed: installedSkill ? installedSkill.managed !== false : undefined,
      registry: src?.url ?? '',
      versions: await fetchVersions(ns, full.slug),
    };
  }
  if (target && 'summary' in target && target.summary) {
    const ns = target.namespace || parseSlug(target.summary.slug).namespace;
    const full = await enrich(target.summary, ns);
    const installedSkill = findInstalled(ns, full.slug);
    return {
      summary: full,
      namespace: ns,
      installed: !!installedSkill,
      installedVersion:
        installedSkill && isComparableVersion(installedSkill.version)
          ? installedSkill.version
          : undefined,
      managed: installedSkill ? installedSkill.managed !== false : undefined,
      registry: src?.url ?? '',
      versions: await fetchVersions(ns, full.slug),
    };
  }
  if (target instanceof InstalledSkillNode) {
    const s = target.skill;
    return {
      summary: {
        slug: toDisplaySlug(s.namespace, s.slug),
        name: s.slug,
        version: s.version,
        description: t('tree.installed.dir', { dir: s.dir }),
        author: { handle: s.namespace },
        updatedAt: s.installedAt,
      },
      namespace: s.namespace,
      installed: true,
      installedVersion: isComparableVersion(s.version)
        ? s.version
        : undefined,
      managed: s.managed !== false,
      registry: s.registry || src?.url || '',
      versions: await fetchVersions(s.namespace, s.slug),
    };
  }
  const input = await vscode.window.showInputBox({
    placeHolder: t('ext.detail.coordinatePlaceholder'),
    prompt: t('ext.detail.coordinatePrompt'),
    ignoreFocusOut: true,
  });
  if (!input) {
    return undefined;
  }
  const { namespace, slug } = parseSlug(input);
  const displaySlug = toDisplaySlug(namespace, slug);
  const summary: SkillSummary = { slug: displaySlug };
  let detailed: SkillSummary | undefined;
  if (src) {
    detailed = await new SkillStoreClient(src.url).getDetail(displaySlug);
  }
  return {
    summary: detailed ?? summary,
    namespace,
    installed: false,
    registry: src?.url ?? '',
  };
}

export function deactivate(): void {
  // no-op
}
