const assert = require('assert');
const {
  installVscodeMock,
  getState,
  clearVscodeMock,
} = require('../helpers/vscode-mock');

installVscodeMock();

const {
  getSources,
  getActiveSource,
  getConfig,
  saveSources,
  setActiveSource,
  isLegacySource,
  genId,
} = require('../../dist/config');

describe('config', () => {
  afterEach(() => {
    clearVscodeMock();
    installVscodeMock();
  });

  describe('getSources', () => {
    it('过滤空 url 并归一化', () => {
      installVscodeMock({
        'skillstore.registries': [
          { id: 'a', name: 'A', url: 'http://a.com/' },
          { id: 'b', name: 'B', url: '   ' },
          { id: 'c', name: '', url: 'b.com' },
        ],
      });
      const sources = getSources();
      assert.strictEqual(sources.length, 2);
      assert.deepStrictEqual(sources[0], {
        id: 'a',
        name: 'A',
        url: 'http://a.com',
      });
      assert.deepStrictEqual(sources[1], {
        id: 'c',
        name: 'b.com',
        url: 'https://b.com',
      });
    });

    it('无 id 时自动生成', () => {
      installVscodeMock({
        'skillstore.registries': [{ name: 'X', url: 'http://x.com' }],
      });
      const sources = getSources();
      assert.ok(sources[0].id);
      assert.strictEqual(sources[0].name, 'X');
      assert.strictEqual(sources[0].url, 'http://x.com');
    });

    it('未配置时返回内置默认本地技能源', () => {
      installVscodeMock({});
      assert.deepStrictEqual(getSources(), [
        { id: 'local', name: '本地技能源', url: 'http://127.0.0.1:3030' },
      ]);
    });

    it('显式清空技能源列表时尊重用户配置', () => {
      installVscodeMock({ 'skillstore.registries': [] });
      assert.deepStrictEqual(getSources(), []);
    });
  });

  describe('getActiveSource', () => {
    it('未配置时使用默认本地技能源', () => {
      installVscodeMock({});
      assert.strictEqual(getActiveSource()?.id, 'local');
      assert.strictEqual(getActiveSource()?.url, 'http://127.0.0.1:3030');
    });

    it('多源时按 activeRegistry 选择', () => {
      installVscodeMock({
        'skillstore.registries': [
          { id: 'a', name: 'A', url: 'http://a.com' },
          { id: 'b', name: 'B', url: 'http://b.com' },
        ],
        'skillstore.activeRegistry': 'b',
      });
      const src = getActiveSource();
      assert.strictEqual(src?.id, 'b');
    });

    it('activeRegistry 无效时回退第一个', () => {
      installVscodeMock({
        'skillstore.registries': [
          { id: 'a', name: 'A', url: 'http://a.com' },
          { id: 'b', name: 'B', url: 'http://b.com' },
        ],
        'skillstore.activeRegistry': 'zzz',
      });
      assert.strictEqual(getActiveSource()?.id, 'a');
    });

    it('无列表时回退旧版单源 registry', () => {
      installVscodeMock({ 'skillstore.registry': 'http://old.com' });
      const src = getActiveSource();
      assert.strictEqual(src?.id, '__legacy__');
      assert.strictEqual(src?.name, 'default');
      assert.strictEqual(src?.url, 'http://old.com');
    });

    it('legacy 单源空值时回退默认本地技能源', () => {
      installVscodeMock({ 'skillstore.registry': '' });
      assert.strictEqual(getActiveSource()?.id, 'local');
    });
  });

  describe('getConfig', () => {
    it('installDir 展开 ~', () => {
      const home = require('os').homedir();
      const path = require('path');
      installVscodeMock({ 'skillstore.installDir': '~/myskills' });
      assert.strictEqual(
        getConfig().installDir,
        path.join(home, 'myskills')
      );
    });

    it('installDir 默认值', () => {
      installVscodeMock({});
      const home = require('os').homedir();
      const path = require('path');
      assert.strictEqual(
        getConfig().installDir,
        path.join(home, '.zeroagent', 'skills')
      );
    });

    it('运行时设置默认值', () => {
      installVscodeMock({});
      const cfg = getConfig();
      assert.strictEqual(cfg.openMarketOnStartup, false);
      assert.strictEqual(cfg.autoUpdateIntervalMinutes, 20);
      assert.strictEqual(cfg.showStatusBar, true);
    });

    it('运行时设置可配置并过滤非法间隔', () => {
      installVscodeMock({
        'skillstore.openMarketOnStartup': true,
        'skillstore.autoUpdateIntervalMinutes': 1,
        'skillstore.showStatusBar': false,
      });
      const cfg = getConfig();
      assert.strictEqual(cfg.openMarketOnStartup, true);
      assert.strictEqual(cfg.autoUpdateIntervalMinutes, 20);
      assert.strictEqual(cfg.showStatusBar, false);
    });
  });

  describe('saveSources / setActiveSource', () => {
    it('写入 update 日志', async () => {
      installVscodeMock({});
      await saveSources([{ id: 'a', name: 'A', url: 'http://a.com' }]);
      await setActiveSource('a');
      const updates = getState().updateLog;
      assert.ok(updates.some((u) => u.key === 'registries'));
      assert.ok(updates.some((u) => u.key === 'activeRegistry'));
    });
  });

  describe('isLegacySource / genId', () => {
    it('isLegacySource 识别旧版源', () => {
      assert.strictEqual(isLegacySource({ id: '__legacy__', name: 'x', url: 'y' }), true);
      assert.strictEqual(isLegacySource({ id: 'a', name: 'x', url: 'y' }), false);
    });

    it('genId 生成稳定前缀 + 时间后缀', () => {
      const id = genId('http://my.registry.com:3030');
      assert.ok(id.startsWith('my.registry.com-3030-'));
      const id2 = genId('https://a/b c');
      assert.ok(id2.length > 0);
      assert.ok(!/[^a-zA-Z0-9.-]/.test(id2.split('-').slice(0, -1).join('-')));
    });
  });
});
