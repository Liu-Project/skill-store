const assert = require('assert');
const http = require('http');

const { request, getJson, HttpError } = require('../../dist/httpClient');

describe('httpClient', () => {
  let server;
  let port;
  let base;

  before((done) => {
    server = http.createServer((req, res) => {
      const u = new URL(req.url, `http://localhost`);
      const p = u.pathname;
      if (p === '/hello') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      } else if (p === '/json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"a":1,"b":"x"}');
      } else if (p === '/bad-json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('not-json{{{');
      } else if (p === '/notfound') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{"error":"技能不存在"}');
      } else if (p === '/redirect') {
        res.writeHead(302, { Location: '/hello' });
        res.end();
      } else if (p === '/redirect-loop') {
        res.writeHead(302, { Location: '/redirect-loop' });
        res.end();
      } else if (p === '/error500') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end('{"error":"服务器内部错误"}');
      } else if (p === '/redirect-bad') {
        res.writeHead(302, { Location: '/notfound' });
        res.end();
      } else if (p === '/binary') {
        res.writeHead(200, { 'Content-Type': 'application/zip' });
        res.end(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{"error":"not found"}');
      }
    });
    server.listen(0, () => {
      port = server.address().port;
      base = `http://127.0.0.1:${port}`;
      done();
    });
  });

  after(() => {
    server.close();
  });

  describe('request', () => {
    it('GET 成功返回状态码与 body', async () => {
      const res = await request('GET', `${base}/hello`);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.toString('utf8'), '{"ok":true}');
    });

    it('POST 携带 body', async () => {
      let gotBody = '';
      const one = http.createServer((req, res) => {
        req.on('data', (c) => (gotBody += c));
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{}');
        });
      });
      await new Promise((resolve) => one.listen(0, resolve));
      const p2 = one.address().port;
      await request('POST', `http://127.0.0.1:${p2}/x`, {}, 'hello');
      assert.strictEqual(gotBody, 'hello');
      one.close();
    });

    it('跟随 302 重定向', async () => {
      const res = await request('GET', `${base}/redirect`);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.toString('utf8'), '{"ok":true}');
    });

    it('重定向到 404 返回最终状态', async () => {
      const res = await request('GET', `${base}/redirect-bad`);
      assert.strictEqual(res.statusCode, 404);
    });

    it('无效 URL 抛错', async () => {
      await assert.rejects(request('GET', 'not-a-url'), /Invalid URL/);
    });

    it('连接失败抛网络错误', async () => {
      await assert.rejects(
        request('GET', 'http://127.0.0.1:1/nope'),
        /Network request failed/
      );
    });
  });

  describe('getJson', () => {
    it('解析 JSON 对象', async () => {
      const data = await getJson(`${base}/json`);
      assert.deepStrictEqual(data, { a: 1, b: 'x' });
    });

    it('404 抛出 HttpError 且携带状态码', async () => {
      try {
        await getJson(`${base}/notfound`);
        assert.fail('应当抛错');
      } catch (err) {
        assert.ok(err instanceof HttpError);
        assert.strictEqual(err.statusCode, 404);
      }
    });

    it('500 抛出 HttpError', async () => {
      await assert.rejects(getJson(`${base}/error500`), HttpError);
    });

    it('无效 JSON 抛 SyntaxError', async () => {
      await assert.rejects(getJson(`${base}/bad-json`), SyntaxError);
    });
  });
});
