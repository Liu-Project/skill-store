const assert = require('assert');
const { installVscodeMock } = require('../helpers/vscode-mock');

const MODULES = [
  '../../dist/i18n',
  '../../dist/config',
  '../../dist/installer',
  '../../dist/marketPanel',
  '../../dist/webview',
  '../../dist/settingsPanel',
];

function loadModules(language) {
  installVscodeMock({}, { language });
  for (const id of MODULES) {
    try {
      delete require.cache[require.resolve(id)];
    } catch {
      // Ignore modules that have not been loaded yet.
    }
  }
  return {
    market: require('../../dist/marketPanel'),
    detail: require('../../dist/webview'),
    settings: require('../../dist/settingsPanel'),
  };
}

const panel = { webview: { cspSource: 'vscode-resource:' } };

describe('webviews', () => {
  it('英文市场模板包含英文文案与 I18N 注入', () => {
    const { market } = loadModules('en');
    const html = market.renderMarketHtml(panel);
    assert.ok(html.includes('Search by name'));
    assert.ok(html.includes('<html lang="en">'));
    assert.ok(html.includes('const I18N ='));
    assert.ok(!html.includes('技能广场'));
  });

  it('中文市场模板包含中文文案', () => {
    const { market } = loadModules('zh-cn');
    const html = market.renderMarketHtml(panel);
    assert.ok(html.includes('搜索技能名称'));
    assert.ok(html.includes('<html lang="zh-CN">'));
    assert.ok(html.includes('技能广场'));
  });

  it('详情模板渲染基础字段', () => {
    const { detail } = loadModules('en');
    const html = detail.renderDetailHtml(panel, {
      summary: {
        slug: 'pdf',
        name: 'PDF',
        description: 'Parse PDFs',
        version: '1.0.0',
      },
      namespace: 'global',
      installed: false,
      registry: 'http://localhost:3030',
      versions: ['1.0.0'],
    });
    assert.ok(html.includes('About this skill'));
    assert.ok(html.includes('Install skill'));
    assert.ok(html.includes('Parse PDFs'));
    assert.ok(html.includes('const installed = false;'));
    assert.ok(html.includes('const installedManaged = true;'));
    assert.ok(html.includes('const latestVersion = "1.0.0";'));
  });

  it('详情模板对已安装技能注入真实布尔值', () => {
    const { detail } = loadModules('en');
    const html = detail.renderDetailHtml(panel, {
      summary: {
        slug: 'pdf',
        name: 'PDF',
        description: 'Parse PDFs',
        version: '1.1.0',
      },
      namespace: 'global',
      installed: true,
      installedVersion: '1.0.0',
      managed: false,
      registry: 'http://localhost:3030',
      versions: ['1.0.0', '1.1.0'],
    });
    assert.ok(html.includes('const installed = true;'));
    assert.ok(html.includes('const installedManaged = false;'));
    assert.ok(html.includes('const installedVersion = "1.0.0";'));
  });

  it('设置模板包含技能源与目录区块', () => {
    const { settings } = loadModules('en');
    const html = settings.renderSettingsHtml(panel);
    assert.ok(html.includes('SkillStore Settings'));
    assert.ok(html.includes('Skills directory'));
    assert.ok(html.includes('const I18N ='));
  });
});
