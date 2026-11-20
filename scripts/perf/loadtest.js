#!/usr/bin/env node
/**
 * 轻量 HTTP 压测器（不依赖第三方库）。
 *
 * 用法:
 *   node scripts/perf/loadtest.js \
 *     --url http://127.0.0.1:4010 \
 *     --mode search|categories|resolve|download|mixed \
 *     --concurrency 50 --duration 15 \
 *     [--pid <server-pid>] [--rate <max-rps>]
 *
 * 输出: JSON（吞吐、延迟分位、错误、CPU/RSS 采样）
 */
const http = require('http');
const fs = require('fs');

function parseArgs(argv) {
  const args = {
    url: 'http://127.0.0.1:4010',
    mode: 'mixed',
    concurrency: 50,
    duration: 15,
    pid: 0,
    rate: 0,
    gzip: false,
    etag: false,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--url') args.url = argv[++i];
    else if (argv[i] === '--mode') args.mode = argv[++i];
    else if (argv[i] === '--concurrency') args.concurrency = parseInt(argv[++i], 10) || 1;
    else if (argv[i] === '--duration') args.duration = parseInt(argv[++i], 10) || 15;
    else if (argv[i] === '--pid') args.pid = parseInt(argv[++i], 10) || 0;
    else if (argv[i] === '--rate') args.rate = parseInt(argv[++i], 10) || 0;
    else if (argv[i] === '--gzip') args.gzip = true;
    else if (argv[i] === '--etag') args.etag = true;
  }
  return args;
}

const PERCENTILES = [0.5, 0.9, 0.95, 0.99];

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)));
  return sorted[idx];
}

function readProc(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ');
    const rssPages = parseInt(stat[23], 10) || 0;
    const utime = parseInt(stat[13], 10) || 0;
    const stime = parseInt(stat[14], 10) || 0;
    const startTime = parseInt(stat[21], 10) || 0;
    const state = stat[2];
    return {
      rssKB: Math.round((rssPages * 4096) / 1024),
      cpuTicks: utime + stime,
      startTime,
      state,
    };
  } catch {
    return null;
  }
}

function randomGlobalIndex() {
  // 合成数据中 i%5===0 的技能属于 team 命名空间；只返回 global 的技能序号
  let i;
  do {
    i = Math.floor(Math.random() * 4999) + 1;
  } while (i % 5 === 0);
  return i;
}

function buildRequest(args, forPath) {
  const u = new URL(args.url);
  let path;
  const idx = randomGlobalIndex();
  switch (args.mode) {
    case 'search':
      path = '/api/v1/search?q=alpha&limit=50';
      break;
    case 'searchAll':
      path = '/api/v1/search?q=&limit=500';
      break;
    case 'categories':
      path = '/api/v1/categories';
      break;
    case 'resolve':
      path = `/api/v1/resolve?slug=skill-${String(idx).padStart(4, '0')}`;
      break;
    case 'download':
      path = `/api/v1/skills/global/skill-${String(idx).padStart(4, '0')}/versions/1.0.0/download`;
      break;
    case 'mixed': {
      const r = Math.random();
      if (r < 0.7) path = '/api/v1/search?q=alpha&limit=50';
      else if (r < 0.8) path = '/api/v1/categories';
      else if (r < 0.9) path = `/api/v1/resolve?slug=skill-${String(idx).padStart(4, '0')}`;
      else path = `/api/v1/skills/global/skill-${String(idx).padStart(4, '0')}/versions/1.0.0/download`;
      break;
    }
    default:
      throw new Error('未知 mode: ' + args.mode);
  }
  if (forPath) return path;
  return { host: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const u = new URL(args.url);
  const host = u.hostname;
  const port = u.port || (u.protocol === 'https:' ? 443 : 80);
  const durationMs = args.duration * 1000;
  const latencies = [];
  const errors = [];
  let completed = 0;
  let bytes = 0;
  let inflight = 0;
  let lastRateWindow = 0;
  let startTs = 0;
  let etag = null;

  // 周期性采样 CPU/RSS
  const cpuSamples = [];
  let prev = null;
  const sampler = setInterval(() => {
    if (!args.pid) return;
    const now = readProc(args.pid);
    if (now && prev) {
      const elapsed = now.cpuTicks - prev.cpuTicks;
      const cores = require('os').cpus().length;
      cpuSamples.push({
        cpuPct: Math.min(100, (elapsed / (cores * 100)) * 100),
        rssKB: now.rssKB,
      });
    }
    prev = now;
  }, 1000);

  function one() {
    if (Date.now() - startTs >= durationMs) {
      return;
    }
    if (args.rate > 0) {
      const elapsedSec = (Date.now() - startTs) / 1000;
      const target = Math.floor(elapsedSec * args.rate);
      if (completed + inflight >= target + args.concurrency) {
        setTimeout(one, 5);
        return;
      }
    }
    inflight++;
    const t0 = Date.now();
    const path = buildRequest(args, true);
    const headers = { Connection: 'keep-alive' };
    if (args.gzip) headers['Accept-Encoding'] = 'gzip';
    if (args.etag && etag && path.indexOf('/download') < 0) headers['If-None-Match'] = etag;
    const req = http.request(
      { host, port, path, method: 'GET', headers },
      (res) => {
        res.on('data', (c) => (bytes += c.length));
        res.on('end', () => {
          const t1 = Date.now();
          inflight--;
          completed++;
          latencies.push(t1 - t0);
          if (args.etag && !etag && res.headers.etag) etag = res.headers.etag;
          if (res.statusCode >= 400) errors.push({ code: res.statusCode, at: t1 });
          one();
        });
      }
    );
    req.on('error', (err) => {
      inflight--;
      completed++;
      errors.push({ code: 'ERR', msg: err.message });
      latencies.push(Date.now() - t0);
      one();
    });
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
    req.end();
  }

  startTs = Date.now();
  for (let i = 0; i < args.concurrency; i++) one();

  const timer = setInterval(() => {
    if (Date.now() - startTs >= durationMs) {
      clearInterval(timer);
      clearInterval(sampler);
      // 等待在途请求完成（最多 5s）
      const wait = setInterval(() => {
        if (inflight === 0 || Date.now() - startTs > durationMs + 5000) {
          clearInterval(wait);
          finish();
        }
      }, 50);
    }
  }, 100);

  function finish() {
    const elapsedSec = (Date.now() - startTs) / 1000;
    const sorted = latencies.slice().sort((a, b) => a - b);
    const errRate = latencies.length ? errors.length / latencies.length : 0;
    let cpuAvg = 0;
    let rssAvg = 0;
    let rssMax = 0;
    if (cpuSamples.length) {
      cpuAvg = cpuSamples.reduce((s, x) => s + x.cpuPct, 0) / cpuSamples.length;
      rssAvg = cpuSamples.reduce((s, x) => s + x.rssKB, 0) / cpuSamples.length;
      rssMax = cpuSamples.reduce((s, x) => Math.max(s, x.rssKB), 0);
    }
    const out = {
      mode: args.mode,
      url: `${args.url}${buildRequest(args, true)}`,
      concurrency: args.concurrency,
      gzip: args.gzip,
      etag: args.etag,
      durationSec: Number(elapsedSec.toFixed(1)),
      totalRequests: completed,
      qps: Number((completed / elapsedSec).toFixed(1)),
      avgMs: latencies.length ? Number((latencies.reduce((s, x) => s + x, 0) / latencies.length).toFixed(1)) : 0,
      p50: percentile(sorted, 0.5),
      p90: percentile(sorted, 0.9),
      p95: percentile(sorted, 0.95),
      p99: percentile(sorted, 0.99),
      maxMs: sorted.length ? sorted[sorted.length - 1] : 0,
      errorRate: Number(errRate.toFixed(4)),
      errors: errors.slice(0, 5),
      bytesTransferred: bytes,
      server: args.pid
        ? { cpuAvgPct: Number(cpuAvg.toFixed(1)), rssAvgMB: Number((rssAvg / 1024).toFixed(1)), rssMaxMB: Number((rssMax / 1024).toFixed(1)) }
        : null,
    };
    console.log(JSON.stringify(out, null, 2));
    process.exit(0);
  }
}

main();
