const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const AdmZip = require('adm-zip');
const { SkillStoreClient } = require('../../dist/skillstoreClient');
const {
  installSkill,
  uninstallSkill,
  listInstalled,
  updateIfNeeded,
} = require('../../dist/installer');
const { publishSkill, createSkillZip } = require('../../dist/publish');

const SERVER_JS = path.resolve(
  __dirname,
  '../..',
  'local-registry',
  'server.js'
);

const net = require('net');

function isPortFree(p) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => {
      srv.close(() => resolve(true));
    });
    srv.listen(p, '127.0.0.1');
  });
}

async function freePort() {
  for (let i = 0; i < 200; i++) {
    const p = 18000 + Math.floor(Math.random() * 2000);
    if (await isPortFree(p)) {
      return p;
    }
  }
  throw new Error('无法分配空闲测试端口');
}

function makeSkillDir(root, name, version, author = 'Test Author') {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: 集成测试技能 ${name}\nauthor: "${author}"\n---\n# ${name} v${version}`
  );
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'scripts', 'run.js'), `// ${name} ${version}`);
  return dir;
}

describe('integration: local registry e2e', function () {
  this.timeout(60000);

  let server;
  let port;
  let base;
  let dataDir;
  let installDir;
  let skillDir;

  before(async () => {
    port = await freePort();
    base = `http://127.0.0.1:${port}`;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skillstore-it-'));
    dataDir = path.join(tmp, 'registry');
    installDir = path.join(tmp, 'skills');
    fs.mkdirSync(dataDir, { recursive: true });
    skillDir = makeSkillDir(tmp, 'it-demo', '1.0.0');

    server = spawn(
      'node',
      [SERVER_JS, '--port', String(port), '--host', '127.0.0.1', '--dir', dataDir],
      { stdio: 'pipe' }
    );
    server.stderr.on('data', (d) => process.stderr.write(`[registry] ${d}`));
    server.stdout.on('data', (d) => process.stderr.write(`[registry] ${d}`));
    await waitForServer(base);
  });

  after(() => {
    if (server) server.kill();
  });

  function waitForServer(url, tries = 40) {
    return new Promise((resolve, reject) => {
      const attempt = (n) => {
        const req = require('http').get(url, (res) => {
          res.resume();
          resolve();
        });
        req.on('error', () => {
          if (n <= 0) reject(new Error('server 未启动'));
          else setTimeout(() => attempt(n - 1), 250);
        });
      };
      attempt(tries);
    });
  }

  it('发布技能 v1.0.0', async () => {
    const result = await publishSkill(base, skillDir, {
      namespace: 'global',
      version: '1.0.0',
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.slug, 'it-demo');
    assert.strictEqual(result.version, '1.0.0');
    assert.strictEqual(result.namespace, 'global');
  });

  it('发布 v1.0.0 重复版本返回 409', async () => {
    const result = await publishSkill(base, skillDir, {
      namespace: 'global',
      version: '1.0.0',
    });
    assert.strictEqual(result.ok, false);
    assert.ok(result.error);
  });

  it('发布 v1.1.0（更新）', async () => {
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: it-demo\ndescription: 集成测试技能 v2\nauthor: "Test Author"\n---\n# it-demo v1.1.0'
    );
    const result = await publishSkill(base, skillDir, {
      namespace: 'global',
      version: '1.1.0',
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.isUpdate, true);
    assert.strictEqual(result.version, '1.1.0');
  });

  it('自动递增版本发布 v1.1.1', async () => {
    const result = await publishSkill(base, skillDir, {
      namespace: 'global',
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.version, '1.1.1');
  });

  it('搜索命中', async () => {
    const c = new SkillStoreClient(base);
    const r = await c.search('it-demo');
    assert.strictEqual(r.total, 1);
    assert.strictEqual(r.results[0].slug, 'it-demo');
    assert.strictEqual(r.results[0].version, '1.1.1');
  });

  it('下载后 downloadCount 递增', async () => {
    const c = new SkillStoreClient(base);
    const before = (await c.search('it-demo')).results[0].downloadCount || 0;
    await c.downloadZip('global', 'it-demo');
    const after = (await c.search('it-demo')).results[0].downloadCount || 0;
    assert.strictEqual(after, before + 1);
  });

  it('getVersions 返回全部版本且 latest 最新（降序）', async () => {
    const c = new SkillStoreClient(base);
    const versions = await c.getVersions('global', 'it-demo');
    assert.deepStrictEqual(versions, ['1.1.1', '1.1.0', '1.0.0']);
  });

  it('resolve 指定版本', async () => {
    const c = new SkillStoreClient(base);
    const r = await c.resolve('global', 'it-demo', '1.0.0');
    assert.strictEqual(r.version, '1.0.0');
    assert.ok(r.downloadUrl.includes('1.0.0'));
  });

  it('安装指定版本 v1.0.0', async () => {
    const c = new SkillStoreClient(base);
    const zip = await c.downloadZip('global', 'it-demo', '1.0.0');
    const installed = await installSkill(
      installDir,
      base,
      'global',
      'it-demo',
      '1.0.0',
      zip
    );
    assert.strictEqual(installed.version, '1.0.0');
    assert.ok(fs.existsSync(path.join(installDir, 'it-demo', 'SKILL.md')));
  });

  it('已安装列表显示指定版本', () => {
    const list = listInstalled(installDir);
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].slug, 'it-demo');
    assert.strictEqual(list[0].version, '1.0.0');
  });

  it('updateIfNeeded 从 v1.0.0 升级到最新 v1.1.1', async () => {
    const c = new SkillStoreClient(base);
    const installed = listInstalled(installDir)[0];
    const ok = await updateIfNeeded(c, base, installDir, installed);
    assert.strictEqual(ok, true);
    assert.strictEqual(listInstalled(installDir)[0].version, '1.1.1');
  });

  it('再次 updateIfNeeded 无更新', async () => {
    const c = new SkillStoreClient(base);
    const installed = listInstalled(installDir)[0];
    const ok = await updateIfNeeded(c, base, installDir, installed);
    assert.strictEqual(ok, false);
  });

  it('卸载技能', () => {
    uninstallSkill(installDir, 'it-demo');
    assert.strictEqual(listInstalled(installDir).length, 0);
  });

  it('whoami 返回本地身份', async () => {
    const { getJson } = require('../../dist/httpClient');
    const data = await getJson(`${base}/api/v1/whoami`);
    assert.ok(data.user);
    assert.strictEqual(data.user.handle, 'local');
  });

  it('CORS 预检返回 204', async () => {
    const http = require('http');
    const status = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/api/v1/search',
          method: 'OPTIONS',
        },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        }
      );
      req.on('error', reject);
      req.end();
    });
    assert.strictEqual(status, 204);
  });

  it('搜索过滤不命中返回空', async () => {
    const c = new SkillStoreClient(base);
    const r = await c.search('不存在的技能xyz');
    assert.strictEqual(r.total, 0);
    assert.strictEqual(r.results.length, 0);
  });

  it('未知端点返回 404', async () => {
    const { request } = require('../../dist/httpClient');
    const res = await request('GET', `${base}/api/v1/unknown`);
    assert.strictEqual(res.statusCode, 404);
  });

  it('resolve 不存在的技能返回 404', async () => {
    await assert.rejects(
      new SkillStoreClient(base).resolve('global', 'no-such-skill')
    );
  });

  it('download 不存在的版本返回 404', async () => {
    await assert.rejects(
      new SkillStoreClient(base).downloadZip('global', 'it-demo', '9.9.9')
    );
  });

  it('getDetail 通过 slug 获取详情', async () => {
    const c = new SkillStoreClient(base);
    const detail = await c.getDetail('it-demo');
    assert.ok(detail);
    assert.strictEqual(detail.slug, 'it-demo');
    assert.strictEqual(detail.version, '1.1.1');
  });

  it('publish 缺少 SKILL.md 客户端抛错', async () => {
    const badDir = path.join(path.dirname(skillDir), 'bad-skill');
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(path.join(badDir, 'README.md'), 'no skill md');
    await assert.rejects(
      publishSkill(base, badDir, { namespace: 'global' }),
      /SKILL\.md/
    );
  });

  it('server 对无 SKILL.md 的 zip 返回 400', async () => {
    const http = require('http');
    const zip = new AdmZip();
    zip.addFile('README.md', Buffer.from('no skill md'));
    const boundary = `----skillstore${Date.now().toString(16)}`;
    const chunks = [];
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="namespace"\r\n\r\nglobal\r\n`,
        'utf8'
      )
    );
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="skill"; filename="bad.zip"\r\nContent-Type: application/zip\r\n\r\n`,
        'utf8'
      )
    );
    chunks.push(zip.toBuffer());
    chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
    const body = Buffer.concat(chunks);

    const res = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/api/v1/publish',
          method: 'POST',
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': body.length,
          },
        },
        (r) => {
          const data = [];
          r.on('data', (c) => data.push(c));
          r.on('end', () =>
            resolve({ status: r.statusCode, body: Buffer.concat(data).toString('utf8') })
          );
        }
      );
      req.on('error', reject);
      req.end(body);
    });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.includes('SKILL.md'));
  });

  it('publish 到 team 命名空间（多命名空间隔离）', async () => {
    const teamDir = path.join(path.dirname(skillDir), 'team-skill');
    fs.mkdirSync(teamDir, { recursive: true });
    fs.writeFileSync(
      path.join(teamDir, 'SKILL.md'),
      '---\nname: team-skill\ndescription: team 技能\nauthor: "Bob"\n---\n# team'
    );
    const result = await publishSkill(base, teamDir, {
      namespace: 'team',
      version: '0.1.0',
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.namespace, 'team');
    assert.strictEqual(result.slug, 'team-skill');
  });

  it('team 命名空间技能可通过 canonical 搜索与解析', async () => {
    const c = new SkillStoreClient(base);
    const r = await c.search('team-skill');
    assert.strictEqual(r.total, 1);
    assert.strictEqual(r.results[0].slug, 'team--team-skill');

    const resolved = await c.resolve('team', 'team-skill');
    assert.strictEqual(resolved.version, '0.1.0');

    const versions = await c.getVersions('team', 'team-skill');
    assert.deepStrictEqual(versions, ['0.1.0']);
  });

  it('global 与 team 同名技能互不干扰', async () => {
    const teamDemoDir = path.join(path.dirname(skillDir), 'team-it-demo');
    fs.mkdirSync(teamDemoDir, { recursive: true });
    fs.writeFileSync(
      path.join(teamDemoDir, 'SKILL.md'),
      '---\nname: it-demo\ndescription: team 版同名技能\nauthor: "Bob"\n---\n# team it-demo'
    );
    const result = await publishSkill(base, teamDemoDir, {
      namespace: 'team',
      version: '0.5.0',
    });
    assert.strictEqual(result.ok, true);

    const c = new SkillStoreClient(base);
    const g = await c.resolve('global', 'it-demo');
    const t = await c.resolve('team', 'it-demo');
    assert.strictEqual(g.version, '1.1.1');
    assert.strictEqual(t.version, '0.5.0');
    assert.strictEqual(g.slug, 'it-demo');
    assert.strictEqual(t.slug, 'team--it-demo');

    const gs = await c.search('it-demo');
    const slugs = gs.results.map((s) => s.slug).sort();
    assert.deepStrictEqual(slugs, ['it-demo', 'team--it-demo']);
  });

  it('打包 ZIP 可被再次解压安装（downloadZip 直接端点）', async () => {
    const c = new SkillStoreClient(base);
    const zip = await c.downloadZip('team', 'team-skill', '0.1.0');
    const installed = await installSkill(
      installDir,
      base,
      'team',
      'team-skill',
      '0.1.0',
      zip
    );
    assert.strictEqual(installed.version, '0.1.0');
    assert.ok(fs.existsSync(path.join(installDir, 'team--team-skill', 'SKILL.md')));
    uninstallSkill(installDir, 'team-skill', 'team');
  });

  it('发布带分类的技能并持久化', async () => {
    const catDir = path.join(path.dirname(skillDir), 'cat-skill');
    fs.mkdirSync(catDir, { recursive: true });
    fs.writeFileSync(
      path.join(catDir, 'SKILL.md'),
      '---\nname: cat-skill\ndescription: 分类技能\ncategories: AI, 自动化\nauthor: "Carol"\n---\n# cat'
    );
    const result = await publishSkill(base, catDir, {
      namespace: 'global',
      version: '1.0.0',
    });
    assert.strictEqual(result.ok, true);

    const c = new SkillStoreClient(base);
    const r = await c.search('cat-skill');
    assert.deepStrictEqual(r.results[0].categories, ['AI', '自动化']);
  });

  it('发布时用户分类与技能内分类取不重复并集', async () => {
    const catDir = path.join(path.dirname(skillDir), 'cat-skill');
    const result = await publishSkill(base, catDir, {
      namespace: 'global',
      categories: ['自动化', '消息', '办公效率'],
      version: '1.1.0',
    });
    assert.strictEqual(result.ok, true);

    const c = new SkillStoreClient(base);
    const r = await c.search('cat-skill');
    assert.deepStrictEqual(r.results[0].categories, [
      'AI',
      '自动化',
      '消息',
      '办公效率',
    ]);
  });

  it('getCategories 返回聚合分类与数量', async () => {
    const c = new SkillStoreClient(base);
    const categories = await c.getCategories();
    const byName = Object.fromEntries(categories.map((x) => [x.name, x.count]));
    assert.strictEqual(byName['AI'], 1);
    assert.strictEqual(byName['自动化'], 1);
  });

  it('search 按分类过滤', async () => {
    const c = new SkillStoreClient(base);
    const r = await c.search('', 50, '自动化');
    assert.strictEqual(r.total, 1);
    assert.strictEqual(r.results[0].slug, 'cat-skill');
  });

  it('search 按分类过滤不匹配分类', async () => {
    const c = new SkillStoreClient(base);
    const r = await c.search('', 50, '不存在分类');
    assert.strictEqual(r.total, 0);
  });

  it('无分类技能不进入分类列表', async () => {
    const c = new SkillStoreClient(base);
    const r = await c.search('it-demo');
    assert.deepStrictEqual(r.results[0].categories ?? [], []);
  });

  it('Web UI 根路径返回卡片页面', async () => {
    const { request } = require('../../dist/httpClient');
    const res = await request('GET', `${base}/`);
    assert.strictEqual(res.statusCode, 200);
    assert.ok(String(res.headers['content-type']).includes('text/html'));
    const html = res.body.toString('utf8');
    assert.ok(html.includes('SkillStore Registry'));
    assert.ok(html.includes('id="grid"'));
    assert.ok(html.includes('/api/v1/search'));
    assert.ok(html.includes('desc-toggle'));
    assert.ok(html.includes('Expand'));
    assert.ok(html.includes('.desc.expanded'));
  });

  it('Web UI /ui 别名可用', async () => {
    const { request } = require('../../dist/httpClient');
    const res = await request('GET', `${base}/ui`);
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.body.toString('utf8').includes('Registry console'));
  });

  it('中文搜索与非 ASCII 技能下载', async () => {
    const dir = makeSkillDir(path.dirname(skillDir), '中文技能', '1.0.0');
    const pub = await publishSkill(base, dir, {
      namespace: 'global',
      version: '1.0.0',
    });
    assert.strictEqual(pub.ok, true);
    const c = new SkillStoreClient(base);
    const found = await c.search('中文');
    assert.ok(found.results.some((s) => s.slug === '中文技能'));
    const buf = await c.downloadZip('global', '中文技能', '1.0.0');
    const zip = new AdmZip(buf);
    assert.ok(zip.getEntry('SKILL.md'));
  });

  it('跨命名空间同名技能包内容互不覆盖', async () => {
    const root = path.dirname(skillDir);
    const make = (dirName, marker) => {
      const dir = path.join(root, dirName);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'SKILL.md'),
        '---\nname: collide\ndescription: collide\n---\n# collide'
      );
      fs.writeFileSync(path.join(dir, 'marker.txt'), marker);
      return dir;
    };
    const gDir = make('collide-global', 'GLOBAL');
    const tDir = make('collide-team', 'TEAM');
    assert.strictEqual(
      (await publishSkill(base, gDir, { namespace: 'global', version: '1.0.0' })).ok,
      true
    );
    assert.strictEqual(
      (await publishSkill(base, tDir, { namespace: 'team', version: '1.0.0' })).ok,
      true
    );
    const c = new SkillStoreClient(base);
    const gz = new AdmZip(await c.downloadZip('global', 'collide', '1.0.0'));
    const tz = new AdmZip(await c.downloadZip('team', 'collide', '1.0.0'));
    assert.strictEqual(gz.getEntry('marker.txt').getData().toString(), 'GLOBAL');
    assert.strictEqual(tz.getEntry('marker.txt').getData().toString(), 'TEAM');
  });

  it('拒绝版本降级发布', async () => {
    const dir = makeSkillDir(path.dirname(skillDir), 'downgrade', '2.0.0');
    assert.strictEqual(
      (await publishSkill(base, dir, { namespace: 'global', version: '2.0.0' })).ok,
      true
    );
    const down = await publishSkill(base, dir, {
      namespace: 'global',
      version: '1.5.0',
    });
    assert.strictEqual(down.ok, false);
    assert.ok(/Downgrade/i.test(down.error || ''));
    const resolved = await new SkillStoreClient(base).resolve('global', 'downgrade');
    assert.strictEqual(resolved.version, '2.0.0');
  });

  it('拒绝发布路径穿越技能名', async () => {
    const dir = makeSkillDir(path.dirname(skillDir), 'evil-src', '1.0.0');
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      '---\nname: ../../evil-e2e\ndescription: evil\n---\n# evil'
    );
    const res = await publishSkill(base, dir, {
      namespace: 'global',
      version: '1.0.0',
    });
    assert.strictEqual(res.ok, false);
    assert.ok(!fs.existsSync(path.join(path.dirname(dataDir), 'evil-e2e-1.0.0.zip')));
  });

  it('畸形 multipart 返回 400 且服务不崩溃', async () => {
    const { request } = require('../../dist/httpClient');
    const dir = makeSkillDir(path.dirname(skillDir), 'malformed-src', '1.0.0');
    const zip = createSkillZip(dir);
    const boundary = '----skillstore-test';
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="namespace"; filename="ns.txt"\r\n\r\nx\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="skill"; filename="s.zip"\r\nContent-Type: application/zip\r\n\r\n`
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([head, zip, tail]);
    const res = await request('POST', `${base}/api/v1/publish`, {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    }, body);
    assert.strictEqual(res.statusCode, 400);
    const alive = await request('GET', `${base}/api/v1/whoami`);
    assert.strictEqual(alive.statusCode, 200);
  });

  it('发布包排除 .env 与符号链接目标内容', () => {
    const dir = makeSkillDir(path.dirname(skillDir), 'leak-src', '1.0.0');
    fs.writeFileSync(path.join(dir, '.env'), 'SECRET=abc');
    try {
      fs.symlinkSync('/etc/hostname', path.join(dir, 'leak.txt'));
    } catch {
      // 某些环境不允许创建符号链接
    }
    const zip = new AdmZip(createSkillZip(dir));
    const names = zip.getEntries().map((e) => e.entryName);
    assert.ok(!names.includes('.env'));
    assert.ok(!names.includes('leak.txt'));
  });

  it('通过 files 映射下载旧版本', async () => {
    const dir = makeSkillDir(path.dirname(skillDir), 'multi-version', '1.0.0');
    assert.strictEqual(
      (await publishSkill(base, dir, { namespace: 'global', version: '1.0.0' })).ok,
      true
    );
    assert.strictEqual(
      (await publishSkill(base, dir, { namespace: 'global', version: '2.0.0' })).ok,
      true
    );
    const client = new SkillStoreClient(base);
    assert.deepStrictEqual(
      await client.getVersions('global', 'multi-version'),
      ['2.0.0', '1.0.0']
    );
    const zip = new AdmZip(
      await client.downloadZip('global', 'multi-version', '1.0.0')
    );
    assert.ok(zip.getEntry('SKILL.md'));
  });

  it('强制覆盖同名同版本会替换包内容', async () => {
    const dir = makeSkillDir(path.dirname(skillDir), 'force-src', '1.0.0');
    fs.writeFileSync(path.join(dir, 'marker.txt'), 'A');
    assert.strictEqual(
      (await publishSkill(base, dir, { namespace: 'global', version: '1.0.0' })).ok,
      true
    );
    fs.writeFileSync(path.join(dir, 'marker.txt'), 'B');
    const res = await publishSkill(base, dir, {
      namespace: 'global',
      version: '1.0.0',
      force: true,
    });
    assert.strictEqual(res.ok, true);
    const zip = new AdmZip(
      await new SkillStoreClient(base).downloadZip('global', 'force-src', '1.0.0')
    );
    assert.strictEqual(zip.getEntry('marker.txt').getData().toString(), 'B');
  });
});
