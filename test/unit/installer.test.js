const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const {
  installSkill,
  uninstallSkill,
  listInstalled,
  installDirFor,
  isSafeChild,
  updateIfNeeded,
} = require('../../dist/installer');

function makeSkillZip(slug, fileContents = {}) {
  const zip = new AdmZip();
  zip.addFile('SKILL.md', Buffer.from('---\nname: ' + slug + '\n---\n# ' + slug));
  for (const [name, content] of Object.entries(fileContents)) {
    zip.addFile(name, Buffer.from(content));
  }
  return zip.toBuffer();
}

describe('installer', () => {
  let root;
  let installDir;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillstore-test-'));
    installDir = path.join(root, 'skills');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe('installSkill', () => {
    it('安装 zip 到目标目录并写入元数据', async () => {
      const result = await installSkill(
        installDir,
        'http://localhost:3030',
        'global',
        'demo',
        '1.0.0',
        makeSkillZip('demo', { 'scripts/run.js': 'console.log(1)' })
      );

      assert.strictEqual(result.slug, 'demo');
      assert.strictEqual(result.version, '1.0.0');
      assert.ok(fs.existsSync(path.join(installDir, 'demo', 'SKILL.md')));
      assert.ok(fs.existsSync(path.join(installDir, 'demo', 'scripts', 'run.js')));

      const meta = JSON.parse(
        fs.readFileSync(
          path.join(installDir, 'demo', '.skillstore', 'metadata.json'),
          'utf8'
        )
      );
      assert.strictEqual(meta.slug, 'demo');
      assert.strictEqual(meta.namespace, 'global');
      assert.strictEqual(meta.version, '1.0.0');
      assert.strictEqual(meta.registry, 'http://localhost:3030');
    });

    it('处理包内单层目录（解包根目录）', async () => {
      const zip = new AdmZip();
      zip.addFile('my-skill/SKILL.md', Buffer.from('---\nname: my-skill\n---'));
      zip.addFile('my-skill/tool.py', Buffer.from('print(1)'));
      const result = await installSkill(
        installDir,
        'http://x',
        'global',
        'my-skill',
        '1.0.0',
        zip.toBuffer()
      );
      assert.ok(fs.existsSync(path.join(installDir, 'my-skill', 'SKILL.md')));
      assert.ok(fs.existsSync(path.join(installDir, 'my-skill', 'tool.py')));
      assert.strictEqual(result.slug, 'my-skill');
    });

    it('目录已存在且非 force 时抛错', async () => {
      await installSkill(
        installDir,
        'http://x',
        'global',
        'demo',
        '1.0.0',
        makeSkillZip('demo')
      );
      await assert.rejects(
        installSkill(
          installDir,
          'http://x',
          'global',
          'demo',
          '1.0.0',
          makeSkillZip('demo')
        ),
        /already exists/
      );
    });

    it('force 覆盖已存在目录', async () => {
      await installSkill(
        installDir,
        'http://x',
        'global',
        'demo',
        '1.0.0',
        makeSkillZip('demo', { 'old.txt': 'old' })
      );
      await installSkill(
        installDir,
        'http://x',
        'global',
        'demo',
        '1.0.1',
        makeSkillZip('demo', { 'new.txt': 'new' }),
        true
      );
      assert.ok(fs.existsSync(path.join(installDir, 'demo', 'new.txt')));
      assert.ok(!fs.existsSync(path.join(installDir, 'demo', 'old.txt')));
      const list = listInstalled(installDir);
      assert.strictEqual(list[0].version, '1.0.1');
    });

    it('空包抛错', async () => {
      await assert.rejects(
        installSkill(
          installDir,
          'http://x',
          'global',
          'demo',
          '1.0.0',
          new AdmZip().toBuffer()
        ),
        /does not contain SKILL\.md|empty/
      );
    });

    it('拒绝安装路径穿越与空 slug', async () => {
      const zip = makeSkillZip('demo');
      await assert.rejects(
        installSkill(installDir, 'http://x', 'global', '../outside', '1.0.0', zip, true),
        /Invalid skill name/
      );
      await assert.rejects(
        installSkill(installDir, 'http://x', 'global', '', '1.0.0', zip, true),
        /Invalid skill name/
      );
      await assert.rejects(
        installSkill(installDir, 'http://x', '../team', 'demo', '1.0.0', zip, true),
        /Invalid namespace/
      );
    });

    it('adopt 允许覆盖含 SKILL.md 的手动技能目录', async () => {
      const dir = path.join(installDir, 'manual');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'SKILL.md'),
        '---\nname: manual\nversion: 1.0.0\n---\n'
      );
      await installSkill(
        installDir,
        'http://x',
        'global',
        'manual',
        '1.0.1',
        makeSkillZip('manual', { 'new.txt': 'new' }),
        true,
        'claude-code',
        true
      );
      assert.ok(
        fs.existsSync(path.join(installDir, 'manual', '.skillstore', 'metadata.json'))
      );
      assert.ok(fs.existsSync(path.join(installDir, 'manual', 'new.txt')));
      const list = listInstalled(installDir);
      assert.strictEqual(list[0].managed, true);
      assert.strictEqual(list[0].version, '1.0.1');
    });

    it('adopt 仍拒绝覆盖无 SKILL.md 的普通目录', async () => {
      const dir = path.join(installDir, 'plain');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'keep.txt'), 'keep');
      await assert.rejects(
        installSkill(
          installDir,
          'http://x',
          'global',
          'plain',
          '1.0.0',
          makeSkillZip('plain'),
          true,
          'claude-code',
          true
        ),
        /not installed by SkillStore/
      );
      assert.strictEqual(
        fs.readFileSync(path.join(dir, 'keep.txt'), 'utf8'),
        'keep'
      );
    });

    it('force 拒绝覆盖非 SkillStore 目录', async () => {
      const userDir = path.join(installDir, 'user-skill');
      fs.mkdirSync(userDir, { recursive: true });
      fs.writeFileSync(path.join(userDir, 'important.txt'), 'keep');
      await assert.rejects(
        installSkill(installDir, 'http://x', 'global', 'user-skill', '1.0.0', makeSkillZip('user-skill'), true),
        /not installed by SkillStore/
      );
      assert.strictEqual(
        fs.readFileSync(path.join(userDir, 'important.txt'), 'utf8'),
        'keep'
      );
    });

    it('非 global 命名空间使用独立目录', async () => {
      await installSkill(installDir, 'http://x', 'global', 'same', '1.0.0', makeSkillZip('same'));
      await installSkill(installDir, 'http://x', 'team', 'same', '2.0.0', makeSkillZip('same'));
      assert.ok(fs.existsSync(path.join(installDir, 'same', '.skillstore', 'metadata.json')));
      assert.ok(fs.existsSync(path.join(installDir, 'team--same', '.skillstore', 'metadata.json')));
      assert.strictEqual(listInstalled(installDir).length, 2);
    });

    it('覆盖失败时保留旧版本', async () => {
      await installSkill(installDir, 'http://x', 'global', 'demo', '1.0.0', makeSkillZip('demo', { old: 'old' }));
      await assert.rejects(
        installSkill(installDir, 'http://x', 'global', 'demo', '2.0.0', Buffer.from('not-a-zip'), true)
      );
      const list = listInstalled(installDir);
      assert.strictEqual(list[0].version, '1.0.0');
      assert.ok(fs.existsSync(path.join(installDir, 'demo', 'old')));
    });
  });

  describe('listInstalled', () => {
    it('空目录返回 []', () => {
      assert.deepStrictEqual(listInstalled(installDir), []);
    });

    it('仅列出带元数据的目录', async () => {
      await installSkill(
        installDir,
        'http://x',
        'global',
        'a',
        '1.0.0',
        makeSkillZip('a')
      );
      fs.mkdirSync(path.join(installDir, 'plain-dir'), { recursive: true });
      fs.writeFileSync(path.join(installDir, 'plain-dir', 'x.txt'), 'x');
      const list = listInstalled(installDir);
      assert.strictEqual(list.length, 1);
      assert.strictEqual(list[0].slug, 'a');
    });

    it('识别手动放置且包含 SKILL.md 的技能目录', () => {
      const dir = path.join(installDir, 'zero-zmail');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'SKILL.md'),
        '---\nname: zero-zmail\ndescription: 发邮件\n---\n# zero-zmail'
      );
      const list = listInstalled(installDir);
      assert.strictEqual(list.length, 1);
      assert.strictEqual(list[0].slug, 'zero-zmail');
      assert.strictEqual(list[0].namespace, 'global');
      assert.strictEqual(list[0].version, 'unknown');
      assert.strictEqual(list[0].managed, false);
    });

    it('从 SKILL.md frontmatter 读取手动技能版本', () => {
      const dir = path.join(installDir, 'demo-manual');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'SKILL.md'),
        '---\nname: demo-manual\nversion: 1.2.3\n---\n'
      );
      const list = listInstalled(installDir);
      assert.strictEqual(list.length, 1);
      assert.strictEqual(list[0].version, '1.2.3');
    });

    it('手动技能目录名支持命名空间前缀', () => {
      const dir = path.join(installDir, 'team--demo');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: demo\n---\n');
      const list = listInstalled(installDir);
      assert.strictEqual(list[0].slug, 'demo');
      assert.strictEqual(list[0].namespace, 'team');
    });

    it('忽略隐藏目录与无 SKILL.md 的普通目录', () => {
      fs.mkdirSync(path.join(installDir, '.staging'), { recursive: true });
      fs.writeFileSync(path.join(installDir, '.staging', 'SKILL.md'), '# x');
      fs.mkdirSync(path.join(installDir, 'plain'), { recursive: true });
      fs.writeFileSync(path.join(installDir, 'plain', 'x.txt'), 'x');
      assert.deepStrictEqual(listInstalled(installDir), []);
    });

    it('metadata 损坏时仍列出并标记 unknown', async () => {
      fs.mkdirSync(path.join(installDir, 'corrupt'), { recursive: true });
      fs.mkdirSync(path.join(installDir, 'corrupt', '.skillstore'), { recursive: true });
      fs.writeFileSync(
        path.join(installDir, 'corrupt', '.skillstore', 'metadata.json'),
        '{broken json'
      );
      const list = listInstalled(installDir);
      assert.strictEqual(list.length, 1);
      assert.strictEqual(list[0].slug, 'corrupt');
      assert.strictEqual(list[0].version, 'unknown');
    });
  });

  describe('uninstallSkill', () => {
    it('卸载已安装技能', async () => {
      await installSkill(
        installDir,
        'http://x',
        'global',
        'demo',
        '1.0.0',
        makeSkillZip('demo')
      );
      uninstallSkill(installDir, 'demo');
      assert.ok(!fs.existsSync(path.join(installDir, 'demo')));
    });

    it('卸载不存在的技能抛错', () => {
      assert.throws(() => uninstallSkill(installDir, 'nope'), /not installed/);
    });

    it('拒绝删除无元数据的目录', async () => {
      fs.mkdirSync(path.join(installDir, 'hack'), { recursive: true });
      assert.throws(() => uninstallSkill(installDir, 'hack'), /not installed by SkillStore/);
    });

    it('拒绝路径穿越', () => {
      assert.throws(
        () => uninstallSkill(installDir, '../outside'),
        /Invalid skill name|outside the skills directory/
      );
      assert.throws(
        () => uninstallSkill(installDir, '..'),
        /Invalid skill name|outside the skills directory/
      );
      assert.throws(
        () => uninstallSkill(installDir, '../a/b'),
        /Invalid skill name|outside the skills directory/
      );
      assert.strictEqual(isSafeChild('/a/b', '/a/b/c'), true);
      assert.strictEqual(isSafeChild('/a/b', '/a/b'), false);
      assert.strictEqual(isSafeChild('/a/b', '/a'), false);
      assert.strictEqual(isSafeChild('/a/b', '/a/other'), false);
    });
  });

  describe('updateIfNeeded', () => {
    function fakeClient(remoteVersion, zipBuffer) {
      let downloads = 0;
      return {
        async resolve() {
          return { version: remoteVersion };
        },
        async downloadZip() {
          downloads++;
          return zipBuffer;
        },
        downloads() {
          return downloads;
        },
      };
    }

    it('远端版本更高时执行更新', async () => {
      await installSkill(
        installDir,
        'http://x',
        'global',
        'demo',
        '1.0.0',
        makeSkillZip('demo')
      );
      const installed = listInstalled(installDir)[0];
      const client = fakeClient('2.0.0', makeSkillZip('demo', { v: '2' }));
      const ok = await updateIfNeeded(client, 'http://x', installDir, installed);
      assert.strictEqual(ok, true);
      assert.strictEqual(client.downloads(), 1);
      const list = listInstalled(installDir);
      assert.strictEqual(list[0].version, '2.0.0');
    });

    it('远端版本不高于本地时不更新', async () => {
      await installSkill(
        installDir,
        'http://x',
        'global',
        'demo',
        '1.0.0',
        makeSkillZip('demo')
      );
      const installed = listInstalled(installDir)[0];
      const client = fakeClient('1.0.0', makeSkillZip('demo'));
      const ok = await updateIfNeeded(client, 'http://x', installDir, installed);
      assert.strictEqual(ok, false);
      assert.strictEqual(client.downloads(), 0);
      assert.strictEqual(listInstalled(installDir)[0].version, '1.0.0');
    });
  });

  describe('installDirFor', () => {
    it('拼接安装目录与 slug', () => {
      assert.strictEqual(
        installDirFor('/s', 'demo'),
        path.join('/s', 'demo')
      );
      assert.strictEqual(
        installDirFor('/s', 'demo', 'team'),
        path.join('/s', 'team--demo')
      );
      assert.throws(() => installDirFor('/s', '../demo'), /Invalid skill name/);
    });
  });
});
