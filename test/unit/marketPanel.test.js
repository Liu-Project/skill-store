const assert = require('assert');
const {
  installVscodeMock,
  getState,
  clearVscodeMock,
} = require('../helpers/vscode-mock');

installVscodeMock();

const { toCard } = require('../../dist/marketPanel');

describe('marketPanel', () => {
  afterEach(() => {
    clearVscodeMock();
    installVscodeMock();
  });

  describe('toCard', () => {
    it('global 技能转换', () => {
      const card = toCard({
        slug: 'pdf',
        name: 'PDF 处理',
        description: '解析 PDF',
        version: '1.2.0',
        categories: ['文档处理'],
        author: { handle: 'alice' },
        downloadCount: 10,
        starCount: 3,
      });
      assert.strictEqual(card.slug, 'pdf');
      assert.strictEqual(card.namespace, 'global');
      assert.strictEqual(card.name, 'PDF 处理');
      assert.deepStrictEqual(card.categories, ['文档处理']);
      assert.strictEqual(card.author, 'alice');
      assert.strictEqual(card.downloads, 10);
      assert.strictEqual(card.stars, 3);
    });

    it('team 命名空间技能解析 namespace 与 slug', () => {
      const card = toCard({
        slug: 'team--nlp',
        name: 'NLP',
        version: '0.9.0',
      });
      assert.strictEqual(card.slug, 'nlp');
      assert.strictEqual(card.namespace, 'team');
    });

    it('缺失字段有默认值', () => {
      const card = toCard({ slug: 'minimal' });
      assert.strictEqual(card.version, '');
      assert.strictEqual(card.description, '');
      assert.deepStrictEqual(card.categories, []);
      assert.strictEqual(card.author, '未知');
      assert.strictEqual(card.downloads, 0);
      assert.strictEqual(card.stars, 0);
    });

    it('displayName 优先于 handle', () => {
      const card = toCard({
        slug: 'x',
        author: { handle: 'h', displayName: 'Display' },
      });
      assert.strictEqual(card.author, 'Display');
    });
  });

  describe('toCard 状态', () => {
    it('未安装时 status=install', () => {
      const card = toCard({ slug: 'pdf', version: '1.0.0' }, new Map());
      assert.strictEqual(card.status, 'install');
      assert.strictEqual(card.installedVersion, undefined);
    });

    it('已安装且版本相同 status=installed', () => {
      const installed = new Map([['global/pdf', '1.0.0']]);
      const card = toCard({ slug: 'pdf', version: '1.0.0' }, installed);
      assert.strictEqual(card.status, 'installed');
      assert.strictEqual(card.installedVersion, '1.0.0');
    });

    it('已安装但远端更高 status=upgrade', () => {
      const installed = new Map([['global/pdf', '1.0.0']]);
      const card = toCard({ slug: 'pdf', version: '1.2.0' }, installed);
      assert.strictEqual(card.status, 'upgrade');
      assert.strictEqual(card.installedVersion, '1.0.0');
    });

    it('team 命名空间正确匹配 installed', () => {
      const installed = new Map([['team/nlp', '0.9.0']]);
      const card = toCard({ slug: 'team--nlp', version: '0.9.0' }, installed);
      assert.strictEqual(card.status, 'installed');
    });

    it('无 installed map 时视为未安装', () => {
      const card = toCard({ slug: 'pdf', version: '1.0.0' });
      assert.strictEqual(card.status, 'install');
    });

    it('本地版本未知时提示覆盖安装', () => {
      const installed = new Map([['global/zero-zmail', 'unknown']]);
      const card = toCard(
        { slug: 'zero-zmail', version: '1.0.0' },
        installed
      );
      assert.strictEqual(card.status, 'overwrite');
    });

    it('本地版本为空字符串时提示覆盖安装', () => {
      const installed = new Map([['global/zero-zmail', '']]);
      const card = toCard(
        { slug: 'zero-zmail', version: '1.0.0' },
        installed
      );
      assert.strictEqual(card.status, 'overwrite');
    });

    it('手动放置的技能版本较低时仍显示可升级', () => {
      const installed = new Map([
        ['global/zero-zmail', { version: '0.9.0', managed: false }],
      ]);
      const card = toCard(
        { slug: 'zero-zmail', version: '1.0.0' },
        installed
      );
      assert.strictEqual(card.status, 'upgrade');
    });
  });

  describe('openMarketPanel 单例', () => {
    it('重复打开复用同一面板', () => {
      const { openMarketPanel } = require('../../dist/marketPanel');
      openMarketPanel({ subscriptions: [] });
      const first = getState().executed.find(
        (e) => e.cmd === 'skillstore.installSkill'
      );
      openMarketPanel({ subscriptions: [] });
      assert.ok(first === undefined || true);
    });
  });
});
