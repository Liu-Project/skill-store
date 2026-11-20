const assert = require('assert');
const {
  installVscodeMock,
  getState,
  clearVscodeMock,
} = require('../helpers/vscode-mock');

installVscodeMock();

const {
  MarketSkillNode,
  MarketCategoryNode,
  InstalledSkillNode,
  MarketTreeProvider,
  InstalledTreeProvider,
} = require('../../dist/skillTree');

describe('skillTree', () => {
  afterEach(() => {
    clearVscodeMock();
    installVscodeMock();
  });

  describe('MarketTreeProvider', () => {
    let provider;

    beforeEach(() => {
      provider = new MarketTreeProvider();
    });

    it('未安装技能显示版本与 contextValue', () => {
      const node = new MarketSkillNode({
        slug: 'pdf',
        version: '1.2.0',
        name: 'PDF 处理',
        description: '解析 PDF',
        author: { handle: 'alice' },
      });
      const item = provider.getTreeItem(node);
      assert.strictEqual(item.description, '1.2.0');
      assert.strictEqual(item.contextValue, 'skillstoreSkill');
      assert.strictEqual(item.iconPath.id, 'symbol-package');
      assert.ok(item.tooltip.value.includes('PDF 处理'));
      assert.ok(item.tooltip.value.includes('alice'));
    });

    it('已安装且无更新显示已安装', () => {
      provider.setInstalled([
        { slug: 'pdf', namespace: 'global', version: '1.2.0' },
      ]);
      const item = provider.getTreeItem(
        new MarketSkillNode({ slug: 'pdf', version: '1.2.0' })
      );
      assert.strictEqual(item.contextValue, 'skillstoreSkillInstalled');
      assert.ok(item.description.includes('已安装'));
      assert.strictEqual(item.iconPath.id, 'check');
    });

    it('已安装但有更高版本显示可升级', () => {
      provider.setInstalled([
        { slug: 'pdf', namespace: 'global', version: '1.0.0' },
      ]);
      const item = provider.getTreeItem(
        new MarketSkillNode({ slug: 'pdf', version: '1.2.0' })
      );
      assert.strictEqual(item.contextValue, 'skillstoreSkillUpgradable');
      assert.ok(item.description.includes('可升级'));
      assert.strictEqual(item.iconPath.id, 'arrow-up');
    });

    it('本地版本未知时提示覆盖安装而非可升级', () => {
      provider.setInstalled([
        { slug: 'zero-zmail', namespace: 'global', version: 'unknown' },
      ]);
      const item = provider.getTreeItem(
        new MarketSkillNode({ slug: 'zero-zmail', version: '1.0.0' })
      );
      assert.strictEqual(item.contextValue, 'skillstoreSkillOverwrite');
      assert.ok(item.description.includes('版本未知'));
      assert.ok(!item.description.includes('可升级'));
    });

    it('手动放置的技能版本较低时仍显示可升级', () => {
      provider.setInstalled([
        {
          slug: 'zero-zmail',
          namespace: 'global',
          version: '0.9.0',
          managed: false,
        },
      ]);
      const item = provider.getTreeItem(
        new MarketSkillNode({ slug: 'zero-zmail', version: '1.0.0' })
      );
      assert.strictEqual(item.contextValue, 'skillstoreSkillUpgradable');
      assert.ok(item.description.includes('可升级'));
    });

    it('命名空间技能正确匹配 installed 状态', () => {
      provider.setInstalled([
        { slug: 'pdf', namespace: 'team', version: '1.0.0' },
      ]);
      const item = provider.getTreeItem(
        new MarketSkillNode({ slug: 'team--pdf', version: '1.0.0' })
      );
      assert.strictEqual(item.contextValue, 'skillstoreSkillInstalled');
    });

    it('isInstalled 判断', () => {
      provider.setInstalled([
        { slug: 'pdf', namespace: 'team', version: '1.0.0' },
      ]);
      assert.strictEqual(provider.isInstalled('team--pdf'), true);
      assert.strictEqual(provider.isInstalled('pdf'), false);
    });

    it('getChildren: 加载中 / 错误 / 空结果 / 正常列表', () => {
      provider.setLoading(true);
      assert.strictEqual(provider.getChildren()[0].summary.slug, '加载中...');

      provider.setResults([], '网络错误');
      assert.ok(provider.getChildren()[0].summary.slug.includes('网络错误'));

      provider.setQuery('zzz');
      const empty = provider.getChildren();
      assert.strictEqual(empty.length, 1);
      assert.ok(empty[0].summary.slug.includes('zzz'));

      provider.setResults([
        { slug: 'a', version: '1' },
        { slug: 'b', version: '2' },
      ]);
      const children = provider.getChildren();
      assert.strictEqual(children.length, 2);
      assert.strictEqual(children[0].summary.slug, 'a');
    });

    it('有分类时顶层按分类分组，无分类技能也显示在顶层', () => {
      provider.setResults([
        { slug: 'pdf', version: '1', categories: ['文档处理'] },
        { slug: 'chat', version: '2', categories: ['AI'] },
        { slug: 'nlp', version: '3', categories: ['AI', '自然语言'] },
        { slug: 'plain', version: '4' },
      ]);
      const children = provider.getChildren();
      assert.strictEqual(children.length, 4);
      const names = children
        .map((c) => (c instanceof MarketCategoryNode ? c.name : null))
        .filter(Boolean);
      assert.deepStrictEqual(names, ['AI', '文档处理', '自然语言']);
      const uncategorized = children.filter(
        (c) => c instanceof MarketSkillNode
      );
      assert.strictEqual(uncategorized.length, 1);
      assert.strictEqual(uncategorized[0].summary.slug, 'plain');
    });

    it('分类节点按数量降序排列', () => {
      provider.setResults([
        { slug: 'a', version: '1', categories: ['X'] },
        { slug: 'b', version: '1', categories: ['X'] },
        { slug: 'c', version: '1', categories: ['Y'] },
      ]);
      const children = provider.getChildren();
      const cat0 = children[0];
      assert.ok(cat0 instanceof MarketCategoryNode);
      assert.strictEqual(cat0.name, 'X');
      assert.strictEqual(cat0.count, 2);
    });

    it('分类节点展开返回该分类下的技能', () => {
      provider.setResults([
        { slug: 'pdf', version: '1', categories: ['文档处理'] },
        { slug: 'chat', version: '2', categories: ['AI'] },
      ]);
      const children = provider.getChildren();
      const cat = children.find((c) => c instanceof MarketCategoryNode && c.name === '文档处理');
      assert.ok(cat instanceof MarketCategoryNode);
      const items = provider.getChildren(cat);
      assert.strictEqual(items.length, 1);
      assert.strictEqual(items[0].summary.slug, 'pdf');
    });

    it('分类节点 getTreeItem 展示数量并可折叠', () => {
      provider.setResults([
        { slug: 'pdf', version: '1', categories: ['文档处理'] },
      ]);
      const cat = provider.getChildren()[0];
      const item = provider.getTreeItem(cat);
      assert.strictEqual(item.description, '1 个技能');
      assert.strictEqual(item.contextValue, 'skillstoreCategory');
      assert.ok(item.collapsibleState !== undefined);
    });

    it('tooltip 包含分类信息', () => {
      provider.setResults([
        { slug: 'pdf', version: '1', categories: ['文档处理'] },
      ]);
      const node = new MarketSkillNode({
        slug: 'pdf',
        version: '1',
        categories: ['文档处理'],
        name: 'PDF',
      });
      const item = provider.getTreeItem(node);
      assert.ok(item.tooltip.value.includes('文档处理'));
    });

    it('currentQuery 跟踪查询词', () => {
      provider.setQuery('pdf');
      assert.strictEqual(provider.currentQuery, 'pdf');
    });

    it('activeCategory 与 setCategoryFilter', () => {
      provider.setCategoryFilter('AI');
      assert.strictEqual(provider.activeCategory, 'AI');
      provider.setCategoryFilter('');
      assert.strictEqual(provider.activeCategory, '');
    });
  });

  describe('InstalledTreeProvider', () => {
    let provider;

    beforeEach(() => {
      provider = new InstalledTreeProvider();
    });

    it('setSkills 设置 noInstalled 上下文', () => {
      provider.setSkills([]);
      assert.ok(
        getState().executed.some(
          (e) => e.cmd === 'setContext' && e.args[1] === true
        )
      );
      provider.setSkills([
        {
          slug: 'pdf',
          namespace: 'global',
          version: '1.0.0',
          agent: 'claude',
          registry: '',
          installedAt: '',
          dir: '/tmp/skills/pdf',
        },
      ]);
      assert.ok(
        getState().executed.some(
          (e) => e.cmd === 'setContext' && e.args[1] === false
        )
      );
    });

    it('自动更新默认开启，勾选状态为 Checked', () => {
      provider.setAutoUpdate(new Map());
      const node = new InstalledSkillNode({
        slug: 'pdf',
        namespace: 'global',
        version: '1.0.0',
        agent: 'claude',
        registry: '',
        installedAt: '',
        dir: '/tmp/skills/pdf',
      });
      const item = provider.getTreeItem(node);
      assert.strictEqual(item.checkboxState.state, 1);
      assert.ok(item.tooltip.value.includes('自动更新: 开启'));
    });

    it('显式关闭自动更新显示 Unchecked', () => {
      provider.setAutoUpdate(new Map([['global/pdf', false]]));
      const node = new InstalledSkillNode({
        slug: 'pdf',
        namespace: 'global',
        version: '1.0.0',
        agent: 'claude',
        registry: '',
        installedAt: '',
        dir: '/tmp/skills/pdf',
      });
      const item = provider.getTreeItem(node);
      assert.strictEqual(item.checkboxState.state, 0);
      assert.ok(item.tooltip.value.includes('自动更新: 关闭'));
    });

    it('手动放置技能标记为外部来源且不显示自动更新勾选框', () => {
      const node = new InstalledSkillNode({
        slug: 'zero-zmail',
        namespace: 'global',
        version: 'unknown',
        agent: 'manual',
        registry: '',
        installedAt: '',
        dir: '/tmp/skills/zero-zmail',
        managed: false,
      });
      const item = provider.getTreeItem(node);
      assert.strictEqual(item.contextValue, 'skillstoreInstalledExternal');
      assert.strictEqual(item.checkboxState, undefined);
      assert.ok(item.tooltip.value.includes('手动放置'));
    });

    it('同名不同命名空间的已安装节点 ID 不冲突', () => {
      const a = provider.getTreeItem(
        new InstalledSkillNode({
          slug: 'pdf',
          namespace: 'team',
          version: '1.0.0',
          agent: 'claude',
          registry: '',
          installedAt: '',
          dir: '/tmp/skills/team--pdf',
        })
      );
      const b = provider.getTreeItem(
        new InstalledSkillNode({
          slug: 'pdf',
          namespace: 'other',
          version: '1.0.0',
          agent: 'claude',
          registry: '',
          installedAt: '',
          dir: '/tmp/skills/other--pdf',
        })
      );
      assert.notStrictEqual(a.id, b.id);
    });

    it('emitCheckboxChange 触发事件', (done) => {
      provider.onDidChangeCheckboxState((e) => {
        assert.strictEqual(e.items.length, 1);
        done();
      });
      provider.emitCheckboxChange([
        [
          new InstalledSkillNode({
            slug: 'pdf',
            namespace: 'global',
            version: '1.0.0',
            agent: 'claude',
            registry: '',
            installedAt: '',
            dir: '/tmp/skills/pdf',
          }),
          1,
        ],
      ]);
    });
  });
});
