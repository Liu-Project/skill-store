const assert = require('assert');
const { refreshViews } = require('../../dist/refresh');

describe('refreshViews', () => {
  it('按已安装、市场、卡片面板顺序联动刷新', async () => {
    const calls = [];
    await refreshViews({
      installed: () => calls.push('installed'),
      market: async () => calls.push('market'),
      panel: () => calls.push('panel'),
    });
    assert.deepStrictEqual(calls, ['installed', 'market', 'panel']);
  });

  it('市场刷新失败时仍刷新卡片面板', async () => {
    const calls = [];
    await assert.rejects(
      refreshViews({
        market: async () => {
          calls.push('market');
          throw new Error('boom');
        },
        panel: () => calls.push('panel'),
      }),
      /boom/
    );
    assert.deepStrictEqual(calls, ['market', 'panel']);
  });

  it('已安装刷新失败时仍刷新卡片面板', async () => {
    const calls = [];
    await assert.rejects(
      refreshViews({
        installed: () => {
          calls.push('installed');
          throw new Error('installed-failed');
        },
        panel: () => calls.push('panel'),
      }),
      /installed-failed/
    );
    assert.deepStrictEqual(calls, ['installed', 'panel']);
  });

  it('仅刷新卡片面板', async () => {
    let count = 0;
    await refreshViews({ panel: () => { count += 1; } });
    assert.strictEqual(count, 1);
  });
});
