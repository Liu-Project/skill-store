import * as vscode from 'vscode';
import { SkillSummary, parseSlug, toCanonicalSlug } from './skillstoreClient';
import { InstalledSkill } from './installer';
import { compareVersions, isComparableVersion } from './util';
import { currentLanguage, t } from './i18n';

export class MarketSkillNode {
  constructor(public readonly summary: SkillSummary) {}
}

export class MarketCategoryNode {
  constructor(
    public readonly name: string,
    public readonly count: number
  ) {}
}

export class InstalledSkillNode {
  constructor(public readonly skill: InstalledSkill) {}
}

export class MarketTreeProvider
  implements vscode.TreeDataProvider<MarketSkillNode | MarketCategoryNode>
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    MarketSkillNode | MarketCategoryNode | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private skills: SkillSummary[] = [];
  private query = '';
  private loading = false;
  private error: string | undefined;
  private installed = new Map<
    string,
    { version: string; managed: boolean }
  >();
  private currentCategory = '';

  get currentQuery(): string {
    return this.query;
  }

  get activeCategory(): string {
    return this.currentCategory;
  }

  setInstalled(skills: InstalledSkill[]): void {
    this.installed.clear();
    for (const s of skills) {
      this.installed.set(toCanonicalSlug(s.namespace, s.slug), {
        version: s.version,
        managed: s.managed !== false,
      });
    }
    this._onDidChangeTreeData.fire();
  }

  isInstalled(slug: string): boolean {
    const { namespace, slug: s } = parseSlug(slug);
    return this.installed.has(toCanonicalSlug(namespace, s));
  }

  setQuery(query: string): void {
    this.query = query;
    this.skills = [];
    this.currentCategory = '';
    this.error = undefined;
    this._onDidChangeTreeData.fire();
  }

  setLoading(loading: boolean): void {
    this.loading = loading;
    this._onDidChangeTreeData.fire();
  }

  setResults(results: SkillSummary[], error?: string): void {
    this.skills = results;
    this.error = error;
    this.loading = false;
    this._onDidChangeTreeData.fire();
  }

  setCategoryFilter(category: string): void {
    this.currentCategory = category;
    this._onDidChangeTreeData.fire();
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getCategories(): MarketCategoryNode[] {
    const map = new Map<string, number>();
    for (const s of this.skills) {
      const cats = s.categories && s.categories.length > 0 ? s.categories : [''];
      for (const c of cats) {
        map.set(c, (map.get(c) || 0) + 1);
      }
    }
    const locale = currentLanguage() === 'zh' ? 'zh' : 'en';
    const nodes = [...map.entries()]
      .filter(([c]) => c !== '')
      .map(([name, count]) => new MarketCategoryNode(name, count))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, locale));
    return nodes;
  }

  private matchesCategory(s: SkillSummary): boolean {
    if (!this.currentCategory) {
      return true;
    }
    return (s.categories || []).includes(this.currentCategory);
  }

  getTreeItem(
    element: MarketSkillNode | MarketCategoryNode
  ): vscode.TreeItem {
    if (element instanceof MarketCategoryNode) {
      const item = new vscode.TreeItem(element.name);
      item.id = `market:cat:${element.name}`;
      item.description = t('tree.category.count', { count: element.count });
      item.iconPath = new vscode.ThemeIcon(
        'folder',
        new vscode.ThemeColor('charts.blue')
      );
      item.contextValue = 'skillstoreCategory';
      item.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
      item.tooltip = new vscode.MarkdownString(
        t('tree.category.tooltip', {
          name: element.name,
          count: element.count,
        }),
        true
      );
      return item;
    }
    const item = new vscode.TreeItem(element.summary.slug);
    item.id = `market:${element.summary.slug}`;
    const { namespace, slug } = parseSlug(element.summary.slug);
    const local = this.installed.get(toCanonicalSlug(namespace, slug));
    if (local) {
      const upgradable =
        isComparableVersion(local.version) &&
        isComparableVersion(element.summary.version) &&
        compareVersions(element.summary.version as string, local.version) > 0;
      if (upgradable) {
        item.description = t('tree.skill.upgradable', {
          version: local.version,
          latest: element.summary.version as string,
        });
        item.contextValue = 'skillstoreSkillUpgradable';
        item.iconPath = new vscode.ThemeIcon(
          'arrow-up',
          new vscode.ThemeColor('charts.yellow')
        );
      } else if (isComparableVersion(local.version)) {
        item.description = t('tree.skill.installed', {
          version: local.version,
        });
        item.contextValue = 'skillstoreSkillInstalled';
        item.iconPath = new vscode.ThemeIcon(
          'check',
          new vscode.ThemeColor('charts.green')
        );
      } else {
        item.description = t('tree.skill.unknown');
        item.contextValue = 'skillstoreSkillOverwrite';
        item.iconPath = new vscode.ThemeIcon(
          'cloud-download',
          new vscode.ThemeColor('charts.blue')
        );
      }
    } else {
      item.description = element.summary.version;
      item.contextValue = 'skillstoreSkill';
      item.iconPath = new vscode.ThemeIcon('symbol-package');
    }
    item.tooltip = new vscode.MarkdownString(
      this.tooltip(element.summary),
      true
    );
    item.command = {
      command: 'skillstore.showSkillDetail',
      title: t('tree.showDetails'),
    };
    return item;
  }

  getChildren(
    element?: MarketSkillNode | MarketCategoryNode
  ): vscode.ProviderResult<Array<MarketSkillNode | MarketCategoryNode>> {
    if (this.loading) {
      return [new MarketSkillNode({ slug: t('tree.skill.loading') })];
    }
    if (this.error) {
      return [
        new MarketSkillNode({
          slug: t('tree.skill.error', { error: this.error }),
        }),
      ];
    }
    if (this.skills.length === 0) {
      if (this.query) {
        return [
          new MarketSkillNode({
            slug: t('tree.skill.empty', { query: this.query }),
          }),
        ];
      }
      return [];
    }
    if (element instanceof MarketCategoryNode) {
      return this.skills
        .filter((s) => (s.categories || []).includes(element.name))
        .map((s) => new MarketSkillNode(s));
    }
    if (element) {
      return [];
    }
    if (this.query) {
      return this.skills.map((s) => new MarketSkillNode(s));
    }
    const categories = this.getCategories();
    if (categories.length === 0) {
      return this.skills.map((s) => new MarketSkillNode(s));
    }
    const uncategorized = this.skills
      .filter((s) => !s.categories || s.categories.length === 0)
      .map((s) => new MarketSkillNode(s));
    return [...categories, ...uncategorized];
  }

  private tooltip(s: SkillSummary): string {
    const parts: string[] = [];
    parts.push(`**${s.name || s.slug}**`);
    if (s.version) {
      parts.push(t('tree.tooltip.version', { version: s.version }));
    }
    if (s.categories && s.categories.length > 0) {
      parts.push(
        t('tree.tooltip.categories', { categories: s.categories.join(' / ') })
      );
    }
    if (s.description) {
      parts.push('');
      parts.push(s.description);
    }
    if (s.author?.displayName || s.author?.handle) {
      parts.push('');
      parts.push(
        t('tree.tooltip.author', {
          author: s.author.displayName || s.author.handle,
        })
      );
    }
    parts.push(
      t('tree.tooltip.stats', {
        downloads: s.downloadCount ?? 0,
        stars: s.starCount ?? 0,
      })
    );
    return parts.join('\n\n');
  }
}

export class InstalledTreeProvider
  implements vscode.TreeDataProvider<InstalledSkillNode>
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    InstalledSkillNode | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly _onDidChangeCheckboxState = new vscode.EventEmitter<
    vscode.TreeCheckboxChangeEvent<InstalledSkillNode>
  >();
  readonly onDidChangeCheckboxState = this._onDidChangeCheckboxState.event;

  private skills: InstalledSkill[] = [];
  private autoUpdate = new Map<string, boolean>();
  private autoUpdateIntervalMinutes = 20;

  setSkills(skills: InstalledSkill[]): void {
    this.skills = skills;
    vscode.commands.executeCommand(
      'setContext',
      'skillstore.noInstalled',
      skills.length === 0
    );
    this._onDidChangeTreeData.fire();
  }

  setAutoUpdate(
    map: Map<string, boolean>,
    intervalMinutes = this.autoUpdateIntervalMinutes
  ): void {
    this.autoUpdate = map;
    this.autoUpdateIntervalMinutes = intervalMinutes;
    this._onDidChangeTreeData.fire();
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: InstalledSkillNode): vscode.TreeItem {
    const managed = element.skill.managed !== false;
    const versionText = isComparableVersion(element.skill.version)
      ? element.skill.version
      : t('tree.installed.versionUnknown');
    const item = new vscode.TreeItem(element.skill.slug);
    item.id = `installed:${toCanonicalSlug(
      element.skill.namespace,
      element.skill.slug
    )}`;
    item.description = versionText;
    const tooltip = new vscode.MarkdownString('', true);
    tooltip.appendMarkdown(`**${element.skill.slug}**  \n`);
    tooltip.appendMarkdown(
      `${t('tree.installed.namespace', {
        namespace: element.skill.namespace,
      })}  \n`
    );
    tooltip.appendMarkdown(
      `${t('tree.installed.version', { version: versionText })}  \n`
    );
    tooltip.appendMarkdown(
      `${t('tree.installed.dir', { dir: element.skill.dir })}  \n`
    );
    if (managed) {
      const autoUpdate = this.isAutoUpdate(element.skill);
      tooltip.appendMarkdown(`${t('tree.installed.source.managed')}  \n`);
      tooltip.appendMarkdown(
        t(
          autoUpdate
            ? 'tree.installed.autoUpdate.on'
            : 'tree.installed.autoUpdate.off'
        )
      );
    } else {
      tooltip.appendMarkdown(t('tree.installed.source.manual'));
    }
    item.tooltip = tooltip;
    item.contextValue = managed
      ? 'skillstoreInstalled'
      : 'skillstoreInstalledExternal';
    item.iconPath = new vscode.ThemeIcon(
      'check',
      new vscode.ThemeColor('charts.green')
    );
    if (managed) {
      item.checkboxState = {
        state: this.isAutoUpdate(element.skill)
          ? vscode.TreeItemCheckboxState.Checked
          : vscode.TreeItemCheckboxState.Unchecked,
        tooltip: t('tree.installed.checkbox.tooltip', {
          minutes: this.autoUpdateIntervalMinutes,
        }),
      };
    }
    return item;
  }

  private isAutoUpdate(skill: InstalledSkill): boolean {
    return this.autoUpdate.get(`${skill.namespace}/${skill.slug}`) !== false;
  }

  emitCheckboxChange(
    items: ReadonlyArray<[
      InstalledSkillNode,
      vscode.TreeItemCheckboxState
    ]>
  ): void {
    this._onDidChangeCheckboxState.fire({ items });
  }

  getChildren(): vscode.ProviderResult<InstalledSkillNode[]> {
    return this.skills.map((s) => new InstalledSkillNode(s));
  }
}
