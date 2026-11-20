#!/usr/bin/env node
/**
 * 生成用于压测的合成技能索引与技能包。
 *
 * 用法:
 *   node scripts/perf/gen-index.js [--dir /tmp/perf-reg] [--count 5000] [--zip-size 8192]
 *
 * 输出:
 *   <dir>/index.json           合成技能索引（skills 数组）
 *   <dir>/packages/...         每个技能一个 zip 包（可选，--no-zip 跳过）
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function parseArgs(argv) {
  const args = { dir: '/tmp/perf-reg', count: 5000, zipSize: 8192, withZip: true };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') args.dir = argv[++i];
    else if (argv[i] === '--count') args.count = parseInt(argv[++i], 10) || 5000;
    else if (argv[i] === '--zip-size') args.zipSize = parseInt(argv[++i], 10) || 8192;
    else if (argv[i] === '--no-zip') args.withZip = false;
  }
  return args;
}

const CATS = ['分类A', '分类B', '分类C', '分类D', '分类E', '消息', 'AI', '自动化', '办公效率', '数据'];
const WORDS = ['alpha', 'beta', 'gamma', 'delta', '搜索', '技能', '自动化', '高效', '智能', '助手', '集成', '流程'];

function pseudoZip(size, slug) {
  // 构造一个最小合法 zip（local file header + deflate 数据 + central directory + EOCD）
  const content = Buffer.alloc(size, 0);
  content.write('hello from ' + slug);
  const deflated = zlib.deflateRawSync(content);
  const name = Buffer.from('payload.txt');
  const crc = crc32(content);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt16LE(0, 10);
  local.writeUInt16LE(0, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(deflated.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt16LE(0, 12);
  central.writeUInt16LE(0, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(deflated.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(name.length, 28);
  const comment = Buffer.from('perf-test');
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length + name.length + deflated.length, 16);
  eocd.writeUInt16LE(comment.length, 20);
  return Buffer.concat([
    local,
    name,
    deflated,
    central,
    name,
    comment,
    eocd,
  ]);
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  fs.mkdirSync(path.join(args.dir, 'packages'), { recursive: true });
  const start = Date.now();
  const skills = [];
  for (let i = 1; i <= args.count; i++) {
    const slug = `skill-${String(i).padStart(4, '0')}`;
    const ns = i % 5 === 0 ? 'team' : 'global';
    const cats = [CATS[i % CATS.length], CATS[(i + 3) % CATS.length]];
    const desc =
      (WORDS[i % WORDS.length] + ' ' + WORDS[(i + 1) % WORDS.length] + ' ') +
      '合成技能描述 alpha beta gamma '.repeat(10) +
      `#${i}`;
    const versions = ['0.9.0', '0.9.1', '1.0.0'];
    const rel = `${ns}/${slug}/1.0.0.zip`;
    if (args.withZip) {
      const p = path.join(args.dir, 'packages', ns, slug, '1.0.0.zip');
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, pseudoZip(args.zipSize, slug));
    }
    skills.push({
      slug,
      namespace: ns,
      name: `${slug}-名称`,
      description: desc,
      author: { handle: `author-${i % 50}`, displayName: `Author ${i % 50}` },
      version: '1.0.0',
      versions,
      files: { '1.0.0': rel },
      zipFile: rel,
      downloadCount: i % 17,
      starCount: i % 9,
      categories: cats,
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
    });
  }
  const json = JSON.stringify({ skills }, null, 2) + '\n';
  fs.writeFileSync(path.join(args.dir, 'index.json'), json);
  const sizeMB = (Buffer.byteLength(json) / 1024 / 1024).toFixed(2);
  console.log(
    `已生成 ${args.count} 个技能 -> ${args.dir}/index.json (${sizeMB}MB)，耗时 ${Date.now() - start}ms`
  );
}

main();
