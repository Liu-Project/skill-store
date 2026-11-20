#!/usr/bin/env node
/**
 * 汇总 loadtest 生成的 JSONL 结果（支持多行 pretty-print 记录）。
 *
 * 用法:
 *   node scripts/perf/summarize.js scripts/perf/results/baseline.raw.jsonl
 */
const fs = require('fs');

function parseRecords(file) {
  const text = fs.readFileSync(file, 'utf8');
  const records = [];
  let depth = 0;
  let cur = '';
  let inStr = false;
  let esc = false;
  for (const ch of text) {
    if (esc) {
      cur += ch;
      esc = false;
      continue;
    }
    if (inStr) {
      cur += ch;
      if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      cur += ch;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    cur += ch;
    if (depth === 0 && cur.trim()) {
      records.push(JSON.parse(cur));
      cur = '';
    }
  }
  return records;
}

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('用法: node summarize.js <raw.jsonl>');
    process.exit(1);
  }
  const records = parseRecords(file);
  console.log(
    ['mode', 'c', 'QPS', 'P50', 'P95', 'P99', 'max', 'err%', 'CPU%', 'RSS_MB'].join('\t')
  );
  for (const r of records) {
    const s = r.server || {};
    console.log(
      [
        r.mode,
        r.concurrency,
        r.qps,
        r.p50,
        r.p95,
        r.p99,
        r.maxMs,
        (r.errorRate * 100).toFixed(1),
        s.cpuAvgPct != null ? s.cpuAvgPct : '-',
        s.rssAvgMB != null ? s.rssAvgMB : '-',
      ].join('\t')
    );
  }
}

main();
