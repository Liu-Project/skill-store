const assert = require('assert');
const {
  normalizeRegistry,
  expandHome,
  compareVersions,
  isComparableVersion,
} = require('../../dist/util');

describe('util', () => {
  describe('normalizeRegistry', () => {
    it('去尾斜杠', () => {
      assert.strictEqual(normalizeRegistry('http://a.com/'), 'http://a.com');
      assert.strictEqual(
        normalizeRegistry('http://a.com///'),
        'http://a.com'
      );
    });

    it('无协议时补 https', () => {
      assert.strictEqual(
        normalizeRegistry('a.com'),
        'https://a.com'
      );
      assert.strictEqual(
        normalizeRegistry('a.com:3030'),
        'https://a.com:3030'
      );
    });

    it('本地/内网地址无协议时补 http', () => {
      assert.strictEqual(
        normalizeRegistry('10.90.235.33:3030'),
        'http://10.90.235.33:3030'
      );
      assert.strictEqual(
        normalizeRegistry('192.168.1.8:3030'),
        'http://192.168.1.8:3030'
      );
      assert.strictEqual(
        normalizeRegistry('172.16.0.2:3030'),
        'http://172.16.0.2:3030'
      );
      assert.strictEqual(
        normalizeRegistry('172.32.0.1:3030'),
        'https://172.32.0.1:3030'
      );
      assert.strictEqual(
        normalizeRegistry('localhost:3030'),
        'http://localhost:3030'
      );
      assert.strictEqual(
        normalizeRegistry('myserver:3030'),
        'http://myserver:3030'
      );
    });

    it('保留 http/https 协议', () => {
      assert.strictEqual(
        normalizeRegistry('http://127.0.0.1:3030'),
        'http://127.0.0.1:3030'
      );
      assert.strictEqual(
        normalizeRegistry('https://x.y'),
        'https://x.y'
      );
    });

    it('空值返回空串', () => {
      assert.strictEqual(normalizeRegistry(''), '');
      assert.strictEqual(normalizeRegistry('   '), '');
    });
  });

  describe('expandHome', () => {
    it('~ 展开为家目录', () => {
      const home = require('os').homedir();
      assert.strictEqual(expandHome('~'), home);
      assert.strictEqual(expandHome('~/skills'), require('path').join(home, 'skills'));
    });

    it('普通路径原样返回', () => {
      assert.strictEqual(expandHome('/opt/skills'), '/opt/skills');
      assert.strictEqual(expandHome('relative/path'), 'relative/path');
    });
  });

  describe('isComparableVersion', () => {
    it('识别合法版本号', () => {
      assert.strictEqual(isComparableVersion('1.0.0'), true);
      assert.strictEqual(isComparableVersion('2'), true);
      assert.strictEqual(isComparableVersion('1.2.3-beta.1'), true);
    });

    it('拒绝空值与未知标记', () => {
      assert.strictEqual(isComparableVersion(''), false);
      assert.strictEqual(isComparableVersion(undefined), false);
      assert.strictEqual(isComparableVersion('unknown'), false);
      assert.strictEqual(isComparableVersion('latest'), false);
    });
  });

  describe('compareVersions', () => {
    it('相等返回 0', () => {
      assert.strictEqual(compareVersions('1.2.3', '1.2.3'), 0);
      assert.strictEqual(compareVersions('1.0', '1.0.0'), 0);
    });

    it('升序判断', () => {
      assert.ok(compareVersions('1.2.3', '1.2.4') < 0);
      assert.ok(compareVersions('1.2.3', '2.0.0') < 0);
      assert.ok(compareVersions('1.9.9', '1.10.0') < 0);
    });

    it('降序判断', () => {
      assert.ok(compareVersions('2.0.0', '1.9.9') > 0);
      assert.ok(compareVersions('1.2.4', '1.2.3') > 0);
    });

    it('非数字部分按 0 处理', () => {
      assert.strictEqual(compareVersions('1.x', '1.0'), 0);
    });

    it('不同长度版本比较', () => {
      assert.ok(compareVersions('1.2', '1.2.1') < 0);
      assert.strictEqual(compareVersions('1.2.0', '1.2'), 0);
      assert.strictEqual(compareVersions('1.2.0', '1.2'), 0);
    });

    it('大版本号', () => {
      assert.ok(compareVersions('10.0.0', '9.9.9') > 0);
      assert.ok(compareVersions('2.0.0-beta', '1.9.0') > 0);
    });

    it('空字符串', () => {
      assert.ok(compareVersions('', '0.0.0') <= 0);
      assert.strictEqual(compareVersions('', ''), 0);
    });

    it('预发布版本遵循 semver 优先级', () => {
      assert.ok(compareVersions('1.0.0-beta', '1.0.0') < 0);
      assert.ok(compareVersions('1.0.0', '1.0.0-beta') > 0);
      assert.ok(compareVersions('1.0.0-alpha', '1.0.0-beta') < 0);
      assert.ok(compareVersions('1.0.0-beta.2', '1.0.0-beta.10') < 0);
      assert.ok(compareVersions('1.0.0-beta.1', '1.0.0-beta') > 0);
      assert.strictEqual(
        compareVersions('1.0.0+build.1', '1.0.0+build.2'),
        0
      );
    });
  });
});
