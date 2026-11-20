const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');

const { SkillStoreClient, parseSlug, toCanonicalSlug } = require('../../dist/skillstoreClient');

function makeZip(name) {
  const zip = new AdmZip();
  zip.addFile('SKILL.md', Buffer.from(`---\nname: ${name}\n---\n# ${name}`));
  return zip.toBuffer();
}

function compareVersions(a, b) {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

function latestOf(versions) {
  return versions.slice().sort((a, b) => compareVersions(b, a))[0];
}

function createMockRegistry() {
  const skills = {};
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const p = u.pathname;
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    if (p === '/api/v1/search') {
      const q = u.searchParams.get('q') || '';
      const category = u.searchParams.get('category') || '';
      let results = Object.values(skills).filter(
        (s) => !q || s.slug.includes(q)
      );
      if (category) {
        results = results.filter((s) =>
          (s.categories || []).includes(category)
        );
      }
      return send(200, { results, total: results.length, page: 1, limit: 50 });
    }
    if (p === '/api/v1/categories') {
      const counts = new Map();
      for (const s of Object.values(skills)) {
        for (const c of s.categories || []) {
          counts.set(c, (counts.get(c) || 0) + 1);
        }
      }
      const categories = [...counts.entries()].map(([name, count]) => ({
        name,
        count,
      }));
      return send(200, { categories });
    }
    if (p === '/api/v1/resolve') {
      const slug = u.searchParams.get('slug') || '';
      const version = u.searchParams.get('version') || '';
      const key = slug.includes('--') ? slug : `global--${slug}`;
      const entry = skills[key];
      if (!entry) return send(404, { error: '技能不存在' });
      const v = version || latestOf(entry.versions);
      if (version && !entry.versions.includes(version)) {
        return send(404, { error: `版本 ${version} 不存在` });
      }
      return send(200, {
        slug: key,
        version: v,
        downloadUrl: `/api/v1/skills/${key}/versions/${v}/download`,
      });
    }
    if (p === '/api/cli/v1/skills/search') {
      return send(200, {
        results: Object.values(skills),
        total: Object.keys(skills).length,
        page: 1,
        limit: 50,
      });
    }
    const dl = p.match(/^\/api\/v1\/skills\/(.+)\/versions\/([^/]+)\/download$/);
    if (dl) {
      const key = dl[1];
      const entry = skills[key];
      if (!entry) return send(404, { error: '技能不存在' });
      res.writeHead(200, { 'Content-Type': 'application/zip' });
      return res.end(entry.zip);
    }
    const ver = p.match(/^\/api\/v1\/skills\/(.+)\/versions$/);
    if (ver) {
      const raw = ver[1];
      const parts = raw.split('/');
      const key = parts.length === 2 ? `${parts[0]}--${parts[1]}` : raw;
      const entry = skills[key];
      if (!entry) return send(404, { error: '技能不存在' });
      return send(200, { slug: key, versions: entry.versions, latest: entry.version });
    }
    return send(404, { error: 'not found' });
  });

  return {
    server,
    start() {
      return new Promise((resolve) => {
        server.listen(0, () => resolve(server.address().port));
      });
    },
    stop() {
      server.close();
    },
    addSkill(canonical, versions, zip, categories) {
      skills[canonical] = {
        slug: canonical,
        versions,
        version: latestOf(versions),
        zip,
        categories: categories || [],
      };
    },
  };
}

describe('skillstoreClient', () => {
  let mock;
  let client;

  before(async () => {
    mock = createMockRegistry();
    const port = await mock.start();
    client = new SkillStoreClient(`http://127.0.0.1:${port}`);
    mock.addSkill('global--pdf', ['1.0.0', '1.1.0'], makeZip('pdf'), ['文档处理']);
    mock.addSkill('team--nlp', ['0.9.0'], makeZip('nlp'), ['AI', '自然语言']);
    mock.addSkill('global--chat', ['2.0.0'], makeZip('chat'), ['AI']);
    mock.addSkill('global--plain', ['1.0.0'], makeZip('plain'));
  });

  after(() => {
    mock.stop();
  });

  it('search 返回结果', async () => {
    const r = await client.search('pdf');
    assert.strictEqual(r.total, 1);
    assert.strictEqual(r.results[0].slug, 'global--pdf');
  });

  it('search 空查询返回全部', async () => {
    const r = await client.search('');
    assert.strictEqual(r.total, 4);
  });

  it('search 按分类过滤', async () => {
    const r = await client.search('', 50, 'AI');
    assert.strictEqual(r.total, 2);
    const slugs = r.results.map((s) => s.slug).sort();
    assert.deepStrictEqual(slugs, ['global--chat', 'team--nlp']);
  });

  it('search 按分类过滤无结果', async () => {
    const r = await client.search('', 50, '不存在分类');
    assert.strictEqual(r.total, 0);
  });

  it('getCategories 返回分类及数量', async () => {
    const categories = await client.getCategories();
    const byName = Object.fromEntries(categories.map((c) => [c.name, c.count]));
    assert.strictEqual(byName['AI'], 2);
    assert.strictEqual(byName['文档处理'], 1);
    assert.strictEqual(byName['自然语言'], 1);
  });

  it('search 结果携带 categories', async () => {
    const r = await client.search('pdf');
    assert.deepStrictEqual(r.results[0].categories, ['文档处理']);
  });

  it('resolve 默认返回最新版本', async () => {
    const r = await client.resolve('global', 'pdf');
    assert.strictEqual(r.version, '1.1.0');
  });

  it('resolve 指定版本', async () => {
    const r = await client.resolve('global', 'pdf', '1.0.0');
    assert.strictEqual(r.version, '1.0.0');
  });

  it('resolve 不存在的版本抛错', async () => {
    await assert.rejects(client.resolve('global', 'pdf', '9.9.9'));
  });

  it('resolve 不存在的技能抛错', async () => {
    await assert.rejects(client.resolve('global', 'nope'));
  });

  it('getVersions 返回全部版本（最新在前）', async () => {
    const versions = await client.getVersions('global', 'pdf');
    assert.deepStrictEqual(versions, ['1.1.0', '1.0.0']);
  });

  it('getVersions 对 team 命名空间', async () => {
    const versions = await client.getVersions('team', 'nlp');
    assert.deepStrictEqual(versions, ['0.9.0']);
  });

  it('downloadZip 下载指定版本返回 Buffer', async () => {
    const buf = await client.downloadZip('global', 'pdf', '1.0.0');
    assert.ok(Buffer.isBuffer(buf));
    assert.ok(buf.length > 0);
  });

  it('downloadZip 对不存在的技能抛错', async () => {
    await assert.rejects(client.downloadZip('global', 'nope'));
  });

  it('downloadZip 支持不带前导斜杠的相对 downloadUrl', async () => {
    const server = http.createServer((req, res) => {
      if (req.url === '/files/pkg.zip') {
        res.writeHead(200, { 'Content-Type': 'application/zip' });
        res.end(makeZip('relative'));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    const relativeClient = new SkillStoreClient(`http://127.0.0.1:${port}`);
    try {
      const buf = await relativeClient.downloadZip(
        'global',
        'relative',
        '1.0.0',
        'files/pkg.zip'
      );
      assert.ok(Buffer.isBuffer(buf));
      assert.ok(buf.length > 0);
    } finally {
      server.close();
    }
  });

  it('getDetail 对不存在的技能返回 undefined', async () => {
    const detail = await client.getDetail('nope');
    assert.strictEqual(detail, undefined);
  });

  it('registry 属性返回归一化 baseUrl', () => {
    assert.ok(client.registry.startsWith('http://127.0.0.1:'));
  });

  describe('search 回退端点', () => {
    it('v1 search 失败时回退到 /api/cli/v1', async () => {
      const m2 = createMockRegistry();
      const port2 = await m2.start();
      const c2 = new SkillStoreClient(`http://127.0.0.1:${port2}`);
      m2.addSkill('global--x', ['1.0.0'], makeZip('x'));
      // 该 mock 的 /api/v1/search 正常；构造一个只支持 cli 端点的 server
      m2.stop();

      const onlyCli = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://localhost');
        if (u.pathname === '/api/v1/search') {
          res.writeHead(500);
          return res.end('boom');
        }
        if (u.pathname === '/api/cli/v1/skills/search') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(
            JSON.stringify({ results: [{ slug: 'global--y' }], total: 1 })
          );
        }
        res.writeHead(404);
        res.end();
      });
      await new Promise((resolve) => onlyCli.listen(0, resolve));
      const p3 = onlyCli.address().port;
      const c3 = new SkillStoreClient(`http://127.0.0.1:${p3}`);
      const r = await c3.search('y');
      assert.strictEqual(r.total, 1);
      onlyCli.close();
    });
  });

  describe('parseSlug / toCanonicalSlug', () => {
    it('解析各种坐标格式', () => {
      assert.deepStrictEqual(parseSlug('demo'), { namespace: 'global', slug: 'demo' });
      assert.deepStrictEqual(parseSlug('@team/demo'), { namespace: 'team', slug: 'demo' });
      assert.deepStrictEqual(parseSlug('team--demo'), { namespace: 'team', slug: 'demo' });
      assert.deepStrictEqual(parseSlug('team/demo'), { namespace: 'team', slug: 'demo' });
      assert.deepStrictEqual(parseSlug('  demo  '), { namespace: 'global', slug: 'demo' });
    });

    it('toCanonicalSlug 规则', () => {
      assert.strictEqual(toCanonicalSlug('global', 'demo'), 'demo');
      assert.strictEqual(toCanonicalSlug('', 'demo'), 'demo');
      assert.strictEqual(toCanonicalSlug('team', 'demo'), 'team--demo');
    });
  });
});
