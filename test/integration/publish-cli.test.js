const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const AdmZip = require('adm-zip');

const PUBLISH_JS = path.resolve(
  __dirname,
  '../..',
  'local-registry',
  'publish.js'
);

function makeSkillDir(root, name, categories) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const catLine = categories
    ? `categories: ${categories.join(', ')}\n`
    : '';
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} 描述\nauthor: "Tester"\n${catLine}---\n# ${name}`
  );
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'scripts', 'run.js'), '// run');
  return dir;
}

describe('integration: publish.js CLI (直写 index)', function () {
  this.timeout(30000);

  let root;
  let registryDir;
  let installDir;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillstore-cli-'));
    registryDir = path.join(root, 'registry');
    installDir = path.join(root, 'skills');
    fs.mkdirSync(registryDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function runPublish(skillDir, extra = []) {
    return execFileSync(
      'node',
      [PUBLISH_JS, skillDir, '--dir', registryDir, ...extra],
      { encoding: 'utf8' }
    );
  }

  it('发布新技能并写入 categories', () => {
    const dir = makeSkillDir(root, 'cli-demo', ['AI', '工具']);
    runPublish(dir, ['--version', '1.0.0']);
    const index = JSON.parse(
      fs.readFileSync(path.join(registryDir, 'index.json'), 'utf8')
    );
    const entry = index.skills.find((s) => s.slug === 'cli-demo');
    assert.ok(entry);
    assert.deepStrictEqual(entry.categories, ['AI', '工具']);
    assert.strictEqual(entry.version, '1.0.0');
    assert.ok(fs.existsSync(path.join(registryDir, 'packages', 'global', 'cli-demo', '1.0.0.zip')));
  });

  it('更新时保留分类', () => {
    const dir = makeSkillDir(root, 'cli-demo', ['AI', '工具']);
    runPublish(dir, ['--version', '1.0.0']);
    runPublish(dir, ['--version', '1.1.0']);
    const index = JSON.parse(
      fs.readFileSync(path.join(registryDir, 'index.json'), 'utf8')
    );
    const entry = index.skills.find((s) => s.slug === 'cli-demo');
    assert.deepStrictEqual(entry.categories, ['AI', '工具']);
    assert.deepStrictEqual(entry.versions, ['1.0.0', '1.1.0']);
  });

  it('无分类时 categories 为空数组', () => {
    const dir = makeSkillDir(root, 'nocat');
    runPublish(dir, ['--version', '1.0.0']);
    const index = JSON.parse(
      fs.readFileSync(path.join(registryDir, 'index.json'), 'utf8')
    );
    const entry = index.skills.find((s) => s.slug === 'nocat');
    assert.deepStrictEqual(entry.categories, []);
  });

  it('重复版本无 --force 时拒绝', () => {
    const dir = makeSkillDir(root, 'dup');
    runPublish(dir, ['--version', '1.0.0']);
    assert.throws(
      () => runPublish(dir, ['--version', '1.0.0']),
      /already exists/
    );
    runPublish(dir, ['--version', '1.0.0', '--force']);
  });

  it('缺少 SKILL.md 时失败', () => {
    const bad = path.join(root, 'bad');
    fs.mkdirSync(bad, { recursive: true });
    fs.writeFileSync(path.join(bad, 'README.md'), 'x');
    assert.throws(() => runPublish(bad), /SKILL\.md/);
  });

  it('CLI 打包排除敏感文件', () => {
    const dir = makeSkillDir(root, 'leak-cli');
    fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1');
    fs.writeFileSync(path.join(dir, 'server.pem'), 'CERT');
    runPublish(dir, ['--version', '1.0.0']);
    const zip = new AdmZip(
      path.join(registryDir, 'packages', 'global', 'leak-cli', '1.0.0.zip')
    );
    const names = zip.getEntries().map((e) => e.entryName);
    assert.ok(!names.includes('.env'));
    assert.ok(!names.includes('server.pem'));
  });

  it('发布到非 global 命名空间', () => {
    const dir = makeSkillDir(root, 'team-skill');
    runPublish(dir, ['--namespace', 'team', '--version', '0.1.0']);
    const index = JSON.parse(
      fs.readFileSync(path.join(registryDir, 'index.json'), 'utf8')
    );
    const entry = index.skills.find(
      (s) => s.slug === 'team-skill' && s.namespace === 'team'
    );
    assert.ok(entry);
    assert.strictEqual(entry.namespace, 'team');
  });
});
