const assert = require('assert');
const { installVscodeMock } = require('../helpers/vscode-mock');

function loadI18n(language) {
  installVscodeMock({}, { language });
  delete require.cache[require.resolve('../../dist/i18n')];
  return require('../../dist/i18n');
}

describe('i18n', () => {
  it('英文环境使用英文', () => {
    const i18n = loadI18n('en');
    assert.strictEqual(i18n.currentLanguage(), 'en');
    assert.strictEqual(i18n.t('common.install'), 'Install');
    assert.strictEqual(i18n.t('settings.title'), 'SkillStore Settings');
  });

  it('中文环境使用中文', () => {
    const i18n = loadI18n('zh-cn');
    assert.strictEqual(i18n.currentLanguage(), 'zh');
    assert.strictEqual(i18n.t('common.install'), '安装');
    assert.strictEqual(i18n.t('settings.title'), 'SkillStore 设置');
  });

  it('替换占位符', () => {
    const i18n = loadI18n('en');
    assert.strictEqual(i18n.t('ext.category.count', { count: 3 }), '3 skills');
    assert.strictEqual(
      i18n.t('ext.install.progress.update', { slug: 'pdf' }),
      'Updating pdf…'
    );
  });

  it('未知 key 原样返回', () => {
    const i18n = loadI18n('en');
    assert.strictEqual(i18n.t('missing.key'), 'missing.key');
  });

  it('messages 返回当前语言完整表', () => {
    const i18n = loadI18n('zh-cn');
    const all = i18n.messages();
    assert.strictEqual(all['common.install'], '安装');
    assert.ok(all['market.title']);
    assert.ok(all['detail.about']);
  });
});
