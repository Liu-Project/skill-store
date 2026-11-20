const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const {
  readSkillFrontmatter,
  createSkillZip,
  publishSkill,
} = require('../../dist/publish');
const { parseSlug, toCanonicalSlug } = require('../../dist/skillstoreClient');

describe('publish', () => {
  let root;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillstore-pub-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function makeSkillDir(name, extra = {}) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: 测试技能\nauthor: Liu, Hongcun_10305396\n---\n# ${name}`
    );
    for (const [rel, content] of Object.entries(extra)) {
      const p = path.join(dir, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    }
    return dir;
  }

  describe('readSkillFrontmatter', () => {
    it('解析 name/description/author', () => {
      const dir = makeSkillDir('demo');
      const fm = readSkillFrontmatter(dir);
      assert.strictEqual(fm.name, 'demo');
      assert.strictEqual(fm.description, '测试技能');
      assert.strictEqual(fm.author, 'Liu, Hongcun_10305396');
    });

    it('缺少 SKILL.md 抛错', () => {
      const empty = path.join(root, 'empty');
      fs.mkdirSync(empty);
      assert.throws(() => readSkillFrontmatter(empty), /SKILL\.md/);
    });

    it('author 值含空格也能完整提取', () => {
      const dir = path.join(root, 'a2');
      fs.mkdirSync(dir);
      fs.writeFileSync(
        path.join(dir, 'SKILL.md'),
        '---\nauthor: "Zhao, Wei_12345"\n---\n'
      );
      assert.strictEqual(readSkillFrontmatter(dir).author, 'Zhao, Wei_12345');
    });

    it('无 frontmatter 时返回空对象', () => {
      const dir = path.join(root, 'no-fm');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'SKILL.md'), '# 无元数据技能\n正文');
      const fm = readSkillFrontmatter(dir);
      assert.deepStrictEqual(fm, {});
    });

    it('带引号的值去除引号', () => {
      const dir = path.join(root, 'quoted');
      fs.mkdirSync(dir);
      fs.writeFileSync(
        path.join(dir, 'SKILL.md'),
        '---\nname: "quoted-skill"\ndescription: \'带引号描述\'\n---\n'
      );
      const fm = readSkillFrontmatter(dir);
      assert.strictEqual(fm.name, 'quoted-skill');
      assert.strictEqual(fm.description, '带引号描述');
    });

    it('嵌套深层 frontmatter 字段', () => {
      const dir = path.join(root, 'deep');
      fs.mkdirSync(dir);
      fs.writeFileSync(
        path.join(dir, 'SKILL.md'),
        '---\nname: deep\ndescription: 多行\n 描述继续\n---\n'
      );
      const fm = readSkillFrontmatter(dir);
      assert.strictEqual(fm.name, 'deep');
    });

    it('categories 逗号分隔解析', () => {
      const dir = path.join(root, 'cats');
      fs.mkdirSync(dir);
      fs.writeFileSync(
        path.join(dir, 'SKILL.md'),
        '---\ncategories: AI, 文档处理, 工具\n---\n'
      );
      const fm = readSkillFrontmatter(dir);
      assert.deepStrictEqual(fm.categories, ['AI', '文档处理', '工具']);
    });

    it('categories YAML flow 序列去除方括号与引号', () => {
      const dir = path.join(root, 'cats-flow');
      fs.mkdirSync(dir);
      fs.writeFileSync(
        path.join(dir, 'SKILL.md'),
        '---\ncategories: [documentation, "git", \'quality\']\n---\n'
      );
      const fm = readSkillFrontmatter(dir);
      assert.deepStrictEqual(fm.categories, [
        'documentation',
        'git',
        'quality',
      ]);
    });

    it('category 单值解析', () => {
      const dir = path.join(root, 'cat');
      fs.mkdirSync(dir);
      fs.writeFileSync(
        path.join(dir, 'SKILL.md'),
        '---\ncategory: 自动化\n---\n'
      );
      const fm = readSkillFrontmatter(dir);
      assert.deepStrictEqual(fm.categories, ['自动化']);
    });

    it('无 categories 时返回 undefined', () => {
      const dir = path.join(root, 'nocat');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: x\n---\n');
      const fm = readSkillFrontmatter(dir);
      assert.strictEqual(fm.categories, undefined);
    });
  });

  describe('createSkillZip', () => {
    it('排除 node_modules 与 .skillstore 等目录', () => {
      const dir = makeSkillDir('demo', {
        'scripts/run.js': 'x',
        'node_modules/pkg/index.js': 'x',
        '.skillstore/metadata.json': '{}',
        '.git/config': 'x',
      });
      const zip = new AdmZip(createSkillZip(dir));
      const names = zip.getEntries().map((e) => e.entryName);
      assert.ok(names.includes('SKILL.md'));
      assert.ok(names.includes('scripts/run.js'));
      assert.ok(!names.some((n) => n.startsWith('node_modules/')));
      assert.ok(!names.some((n) => n.startsWith('.skillstore/')));
      assert.ok(!names.some((n) => n.startsWith('.git/')));
    });
  });

  describe('publishSkill', () => {
    it('multipart 中包含 categories 字段', async () => {
      const dir = makeSkillDir('demo');
      let body = Buffer.alloc(0);
      const server = require('http').createServer((req, res) => {
        req.on('data', (c) => {
          body = Buffer.concat([body, c]);
        });
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        });
      });
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      const port = server.address().port;
      try {
        const result = await publishSkill(`http://127.0.0.1:${port}`, dir, {
          namespace: 'global',
          categories: ['消息', '办公效率'],
        });
        assert.strictEqual(result.ok, true);
        const text = body.toString('utf8');
        assert.ok(text.includes('name="categories"'), '缺少 categories 字段');
        assert.ok(text.includes('消息,办公效率'), 'categories 值缺失');
        assert.ok(text.includes('name="namespace"'));
      } finally {
        server.close();
      }
    });

    it('未传 categories 时不包含该字段', async () => {
      const dir = makeSkillDir('demo');
      let body = Buffer.alloc(0);
      const server = require('http').createServer((req, res) => {
        req.on('data', (c) => {
          body = Buffer.concat([body, c]);
        });
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        });
      });
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      const port = server.address().port;
      try {
        await publishSkill(`http://127.0.0.1:${port}`, dir, {
          namespace: 'global',
        });
        const text = body.toString('utf8');
        assert.ok(!text.includes('name="categories"'));
      } finally {
        server.close();
      }
    });
  });
});

describe('skillstoreClient parseSlug', () => {
  it('global 无前缀', () => {
    assert.deepStrictEqual(parseSlug('demo'), { namespace: 'global', slug: 'demo' });
  });

  it('@ 前缀', () => {
    assert.deepStrictEqual(parseSlug('@team/demo'), { namespace: 'team', slug: 'demo' });
  });

  it('-- 分隔', () => {
    assert.deepStrictEqual(parseSlug('team--demo'), { namespace: 'team', slug: 'demo' });
  });

  it('/ 分隔', () => {
    assert.deepStrictEqual(parseSlug('team/demo'), { namespace: 'team', slug: 'demo' });
  });

  it('toCanonicalSlug', () => {
    assert.strictEqual(toCanonicalSlug('global', 'demo'), 'demo');
    assert.strictEqual(toCanonicalSlug('team', 'demo'), 'team--demo');
    assert.strictEqual(toCanonicalSlug('', 'demo'), 'demo');
  });
});
