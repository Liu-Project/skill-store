#!/usr/bin/env node
/**
 * Local skill registry server
 *
 * Implements the registry REST API plus local publish endpoints:
 *   GET  /api/v1/search?q=&limit=                        Search skills
 *   GET  /api/v1/skills/{slug}                           Skill detail
 *   GET  /api/v1/resolve?slug=&version=                  Resolve a version and download URL
 *   GET  /api/v1/skills/{ns}/{slug}/versions/{v}/download Download a skill package (zip)
 *   GET  /api/v1/download/{slug}?version=                Download a skill package (zip)
 *   GET  /api/v1/whoami                                  Identity (no auth required locally)
 *   POST /api/v1/publish                                 Publish or update a skill (multipart)
 *
 * Usage:
 *   node server.js [--port 3030] [--host 0.0.0.0] [--dir <registry-dir>]
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const { Worker } = require('worker_threads');

const ROOT = __dirname;
let PACKAGES_DIR = path.join(ROOT, 'packages');
let INDEX_FILE = path.join(ROOT, 'index.json');
let AUTH_TOKEN = '';
let ALLOW_DOWNGRADE = false;

// Index memory model: cachedIndex is the mutable raw index object; derived holds
// precomputed structures. Read paths (search/categories/resolve/detail/versions/download)
// only touch derived, so they no longer rebuild summaries, scan linearly, or parse everything.
let cachedIndex = null;
let derived = null;
let indexVersion = 0;
let indexMtimeMs = 0;
let lastMtimeCheck = 0;
let saveTimer = null;

const MAX_BODY_BYTES = 50 * 1024 * 1024;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const UNSAFE_SLUG_CHARS = /[\/\\\0-\x1f\x7f<>:"|?*]/;
const GZIP_THRESHOLD = 2048;
const MAX_SEARCH_LIMIT = 500;

// FNV-1a hash: produce a short ETag hash without per-request crypto overhead
function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(36);
}

function toKey(namespace, slug) {
  return `${namespace}\x00${slug}`;
}

function parseArgs(argv) {
  const args = { port: 3030, host: '127.0.0.1', token: '', allowDowngrade: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') args.port = parseInt(argv[++i], 10);
    else if (argv[i] === '--host') args.host = argv[++i];
    else if (argv[i] === '--dir') args.dir = argv[++i];
    else if (argv[i] === '--token') args.token = argv[++i];
    else if (argv[i] === '--allow-downgrade') args.allowDowngrade = true;
  }
  if (args.dir) {
    PACKAGES_DIR = path.join(args.dir, 'packages');
    INDEX_FILE = path.join(args.dir, 'index.json');
  }
  AUTH_TOKEN = args.token || '';
  ALLOW_DOWNGRADE = Boolean(args.allowDowngrade);
  return args;
}

function rebuildDerived(index) {
  const byKey = new Map();
  const summaries = new Array(index.skills.length);
  const searchText = new Array(index.skills.length);
  const categoryCounts = new Map();
  const summaryByEntry = new Map();
  for (let i = 0; i < index.skills.length; i++) {
    const e = index.skills[i];
    byKey.set(toKey(e.namespace, e.slug), e);
    summaries[i] = toSummary(e);
    summaryByEntry.set(e, summaries[i]);
    searchText[i] = (
      e.slug +
      ' ' +
      (e.name || '') +
      ' ' +
      (e.description || '') +
      ' ' +
      (e.categories || []).join(' ')
    ).toLowerCase();
    for (const c of e.categories || []) {
      categoryCounts.set(c, (categoryCounts.get(c) || 0) + 1);
    }
  }
  derived = { byKey, summaries, searchText, categoryCounts, summaryByEntry };
}

function loadIndex() {
  if (cachedIndex) {
    // External change detection: compare mtime at most once every 500ms to avoid per-request stat calls
    const now = Date.now();
    if (now - lastMtimeCheck < 500) {
      return cachedIndex;
    }
    lastMtimeCheck = now;
    try {
      const st = fs.statSync(INDEX_FILE);
      if (st.mtimeMs === indexMtimeMs) {
        return cachedIndex;
      }
    } catch {
      return cachedIndex;
    }
  }
  let index;
  if (!fs.existsSync(INDEX_FILE)) {
    index = { skills: [] };
  } else {
    try {
      index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    } catch {
      index = { skills: [] };
    }
  }
  if (!Array.isArray(index.skills)) {
    index.skills = [];
  }
  cachedIndex = index;
  try {
    indexMtimeMs = fs.statSync(INDEX_FILE).mtimeMs;
  } catch {
    indexMtimeMs = 0;
  }
  indexVersion++;
  rebuildDerived(index);
  return index;
}

function saveIndex(index) {
  cachedIndex = index;
  const tmp = `${INDEX_FILE}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(index, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, INDEX_FILE);
  try {
    indexMtimeMs = fs.statSync(INDEX_FILE).mtimeMs;
  } catch {
    indexMtimeMs = 0;
  }
  indexVersion++;
  rebuildDerived(index);
}

function saveIndexSoon(index) {
  cachedIndex = index;
  if (saveTimer) {
    return;
  }
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      saveIndex(cachedIndex || index);
    } catch (err) {
      console.error('[index] save failed:', err.message);
    }
  }, 1000);
}

function isValidSlug(slug) {
  if (!slug || slug === '.' || slug === '..') {
    return false;
  }
  if (UNSAFE_SLUG_CHARS.test(slug)) {
    return false;
  }
  return path.basename(slug) === slug;
}

function isValidNamespace(namespace) {
  if (!namespace || namespace.includes('--')) {
    return false;
  }
  return /^[A-Za-z0-9@][A-Za-z0-9@._-]*$/.test(namespace);
}

function isValidVersion(version) {
  return VERSION_RE.test(version);
}

function decodePathPart(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function safePackagePath(entry, version) {
  const wanted = version || entry.version;
  let rel;
  if (entry.files && entry.files[wanted]) {
    rel = entry.files[wanted];
  } else if (entry.zipFile && wanted === entry.version) {
    rel = entry.zipFile;
  } else {
    rel = `${entry.namespace}/${entry.slug}/${wanted}.zip`;
  }
  const full = path.resolve(PACKAGES_DIR, rel);
  const base = path.resolve(PACKAGES_DIR);
  if (full !== base && !full.startsWith(base + path.sep)) {
    throw new Error(`Refusing to access unsafe package path: ${rel}`);
  }
  return full;
}

function splitCanonical(slug) {
  if (slug.includes('--')) {
    const i = slug.indexOf('--');
    return { namespace: slug.slice(0, i), slug: slug.slice(i + 2) };
  }
  return { namespace: 'global', slug };
}

function toCanonical(ns, slug) {
  return ns === 'global' || !ns ? slug : `${ns}--${slug}`;
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

function findSkill(index, namespace, slug) {
  if (!derived) {
    return index.skills.find((s) => s.slug === slug && s.namespace === namespace);
  }
  return derived.byKey.get(toKey(namespace, slug));
}

// After incrementing the download counter, update the precomputed summary so search/detail
// reflect it immediately (saveIndexSoon batches the disk write).
function syncSummaryCount(entry) {
  if (!derived || !derived.summaryByEntry) return;
  const sum = derived.summaryByEntry.get(entry);
  if (sum) {
    sum.downloadCount = entry.downloadCount || 0;
  }
}

function toSummary(entry) {
  return {
    slug: toCanonical(entry.namespace, entry.slug),
    name: entry.name || entry.slug,
    description: entry.description || '',
    author: entry.author || { handle: 'unknown' },
    version: entry.version,
    downloadCount: entry.downloadCount || 0,
    starCount: entry.starCount || 0,
    categories: entry.categories || [],
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

function nextVersion(versions) {
  const list = Array.isArray(versions) ? versions : [];
  const latest = list
    .slice()
    .sort((a, b) => compareVersions(b, a))[0];
  if (!latest || !isValidVersion(latest)) {
    return '1.0.0';
  }
  const parts = latest.split('.');
  parts[parts.length - 1] = String((parseInt(parts[parts.length - 1], 10) || 0) + 1);
  return parts.join('.');
}

function parseMultipart(body, boundary) {
  const fields = {};
  const escaped = String(boundary).replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&');
  const parts = body
    .toString('binary')
    .split(new RegExp(`--${escaped}`))
    .slice(1);
  for (const part of parts) {
    if (part.trim() === '--' || part.trim() === '') continue;
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd < 0) continue;
    const header = part.slice(0, headerEnd);
    const content = part.slice(headerEnd + 4);
    const nameMatch = header.match(/name="([^"]+)"/);
    if (!nameMatch) continue;
    const name = nameMatch[1];
    const filenameMatch = header.match(/filename="([^"]+)"/);
    if (filenameMatch) {
      fields[name] = {
        filename: filenameMatch[1],
        data: Buffer.from(content.replace(/\r\n$/, ''), 'binary'),
      };
    } else {
      fields[name] = Buffer.from(
        content.replace(/\r\n$/, ''),
        'binary'
      ).toString('utf8');
    }
  }
  return fields;
}

function stringField(fields, name, fallback = '') {
  const value = fields[name];
  return typeof value === 'string' ? value : fallback;
}

function extractInWorker(zipBuffer, tmpDir) {
  return new Promise((resolve) => {
    let settled = false;
    const worker = new Worker(path.join(__dirname, 'extract-worker.js'), {
      workerData: { zipBuffer, tmpDir },
    });
    const done = (msg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(msg);
    };
    const timer = setTimeout(() => {
      worker.terminate();
      done({ ok: false, error: 'Skill package extraction timed out' });
    }, 120000);
    worker.once('message', (msg) => done(msg));
    worker.once('error', (err) => done({ ok: false, error: err.message || String(err) }));
    worker.once('exit', (code) => {
      if (code !== 0) {
        done({ ok: false, error: `Extraction process exited unexpectedly (code ${code})` });
      }
    });
  });
}

async function handlePublish(req, res, body) {
  try {
    if (AUTH_TOKEN) {
      const auth = req.headers['authorization'] || '';
      if (auth !== `Bearer ${AUTH_TOKEN}`) {
        return json(res, 401, { error: 'Unauthorized: missing or invalid Bearer token' });
      }
    }

    const ctype = req.headers['content-type'] || '';
    const bm = ctype.match(/boundary=(.+)$/);
    if (!bm) {
      return json(res, 400, { error: 'Missing multipart boundary' });
    }
    const fields = parseMultipart(body, bm[1].trim().replace(/^"|"$/g, ''));
    for (const key of ['namespace', 'version', 'force', 'categories']) {
      if (fields[key] !== undefined && typeof fields[key] !== 'string') {
        return json(res, 400, { error: `Invalid format for field ${key}` });
      }
    }
    const fileField = fields.skill || fields.file;
    if (!fileField || !Buffer.isBuffer(fileField.data)) {
      return json(res, 400, { error: 'Missing skill package file (skill)' });
    }

    const namespace =
      stringField(fields, 'namespace', 'global').trim() || 'global';
    const requestedVersion = stringField(fields, 'version', '').trim();
    const force =
      stringField(fields, 'force', '') === 'true' ||
      stringField(fields, 'force', '') === '1';
    const userCategories = stringField(fields, 'categories', '')
      .split(/[,，]/)
      .map((c) => c.trim())
      .filter(Boolean);

    if (!isValidNamespace(namespace)) {
      return json(res, 400, { error: `Invalid namespace: ${namespace}` });
    }
    if (requestedVersion && !isValidVersion(requestedVersion)) {
      return json(res, 400, {
        error: `Invalid version: ${requestedVersion} (expected x.y.z)`,
      });
    }

    const index = loadIndex();
    let slug;
    let description = '';
    let authorHandle = 'unknown';
    let categories = [];

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillstore-pub-'));
    try {
      const meta = await extractInWorker(fileField.data, tmpDir);
      if (!meta.ok) {
        return json(res, 400, { error: `Failed to parse skill package: ${meta.error}` });
      }
      slug = meta.slug;
      description = meta.description;
      authorHandle = meta.authorHandle;
      categories = meta.categories || [];
    } catch (e) {
      return json(res, 500, { error: `Failed to parse skill package: ${e.message}` });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    if (!isValidSlug(slug)) {
      return json(res, 400, { error: `Invalid skill name: ${slug}` });
    }
    if (slug.includes('--')) {
      return json(res, 400, { error: 'Skill slug must not contain consecutive --' });
    }

    const existing = findSkill(index, namespace, slug);
    let version;
    let isUpdate = false;

    if (userCategories.length > 0) {
      categories = [...new Set([...(categories || []), ...userCategories])];
    }

    if (existing) {
      isUpdate = true;
      if (requestedVersion) {
        version = requestedVersion;
        if (
          compareVersions(version, existing.version) < 0 &&
          !ALLOW_DOWNGRADE
        ) {
          return json(res, 409, {
            error: `Downgrade not allowed: ${version} < ${existing.version} (start with --allow-downgrade to override)`,
          });
        }
        if (existing.versions.includes(version) && !force) {
          return json(res, 409, {
            error: `Version ${version} already exists; pass force=true to overwrite`,
          });
        }
        if (!existing.versions.includes(version)) existing.versions.push(version);
      } else {
        version = nextVersion(existing.versions);
        existing.versions.push(version);
      }
    } else {
      version = requestedVersion || '1.0.0';
    }

    const rel = `${namespace}/${slug}/${version}.zip`;
    const zipPath = path.resolve(PACKAGES_DIR, rel);
    const base = path.resolve(PACKAGES_DIR);
    if (zipPath !== base && !zipPath.startsWith(base + path.sep)) {
      return json(res, 400, { error: 'Invalid skill package path' });
    }
    fs.mkdirSync(path.dirname(zipPath), { recursive: true });
    fs.writeFileSync(zipPath, fileField.data);

    const now = new Date().toISOString();
    if (existing) {
      existing.files = existing.files || {};
      existing.files[version] = rel;
      if (compareVersions(version, existing.version) >= 0) {
        existing.version = version;
        existing.zipFile = rel;
      }
      existing.description = description;
      if (categories && categories.length > 0) existing.categories = categories;
      if (authorHandle) existing.author = { handle: authorHandle, displayName: authorHandle };
      existing.updatedAt = now;
    } else {
      index.skills.push({
        slug,
        namespace,
        name: slug,
        description,
        author: { handle: authorHandle, displayName: authorHandle },
        version,
        versions: [version],
        files: { [version]: rel },
        zipFile: rel,
        downloadCount: 0,
        starCount: 0,
        categories: categories || [],
        createdAt: now,
        updatedAt: now,
      });
    }

    saveIndex(index);
    console.log(
      `[publish] ${isUpdate ? 'Updated' : 'Published'} ${namespace}/${slug} v${version}${force ? ' (force)' : ''}`
    );
    return json(res, 200, {
      ok: true,
      id: `${namespace}/${slug}`,
      version,
      isUpdate,
      slug,
      namespace,
      downloadUrl: `/api/v1/skills/${encodeURIComponent(namespace)}/${encodeURIComponent(slug)}/versions/${encodeURIComponent(version)}/download`,
    });
  } catch (e) {
    console.error('[publish] Unhandled exception:', e);
    if (!res.headersSent) {
      return json(res, 500, { error: `Publish failed: ${e.message}` });
    }
    res.end();
  }
}

function json(res, code, obj, opts) {
  const body = JSON.stringify(obj);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': '*',
  };
  if (opts) {
    if (opts.etag) {
      headers['ETag'] = opts.etag;
      if (opts.req && opts.req.headers['if-none-match'] === opts.etag) {
        if (opts.cacheControl) headers['Cache-Control'] = opts.cacheControl;
        res.writeHead(304, headers);
        return res.end();
      }
    }
    if (opts.cacheControl) headers['Cache-Control'] = opts.cacheControl;
  }

  const send = (buf, extra) => {
    res.writeHead(code, extra ? { ...headers, ...extra } : headers);
    res.end(buf);
  };

  const acceptGzip =
    opts &&
    opts.req &&
    body.length > GZIP_THRESHOLD &&
    /gzip/i.test(opts.req.headers['accept-encoding'] || '');
  if (acceptGzip) {
    // zlib runs on the libuv thread pool and does not block the event loop
    zlib.gzip(body, (err, zipped) => {
      if (err) {
        send(Buffer.from(body, 'utf8'));
      } else {
        send(zipped, { 'Content-Encoding': 'gzip' });
      }
    });
    return;
  }
  send(Buffer.from(body, 'utf8'));
}

function etagFor(parts) {
  return `"${indexVersion}-${hashString(parts.join('\x00'))}"`;
}

// Build Content-Disposition: use filename for pure ASCII, and add RFC 5987 filename*
// for non-ASCII names such as Chinese.
function dispositionFor(filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_');
  if (ascii === filename) {
    return `attachment; filename="${filename}"`;
  }
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function sendFileStream(req, res, filePath, mime, downloadName) {
  let st;
  try {
    st = fs.statSync(filePath);
  } catch {
    return json(res, 404, { error: 'Skill package not found' });
  }
  const etag = `"${st.size}-${st.mtimeMs}"`;
  const headers = {
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
    ETag: etag,
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': '*',
  };
  if (downloadName) {
    headers['Content-Disposition'] = dispositionFor(downloadName);
  }

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }

  if (req.method === 'HEAD') {
    headers['Content-Length'] = st.size;
    res.writeHead(200, headers);
    return res.end();
  }

  const range = req.headers.range;
  if (range) {
    const m = range.match(/^bytes=(\d*)-(\d*)$/);
    if (m) {
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : st.size - 1;
      if (Number.isNaN(start) || start < 0) start = 0;
      if (Number.isNaN(end) || end >= st.size) end = st.size - 1;
      if (start > end || start >= st.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        return res.end();
      }
      headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
      headers['Content-Length'] = end - start + 1;
      res.writeHead(206, headers);
      const stream = fs.createReadStream(filePath, { start, end });
      stream.on('error', () => res.destroy());
      return stream.pipe(res);
    }
  }

  headers['Content-Length'] = st.size;
  res.writeHead(200, headers);
  const stream = fs.createReadStream(filePath);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

function sendHtml(res, html) {
  const data = Buffer.from(html, 'utf8');
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function renderHome() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>SkillStore Registry · Local skill registry</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%20128%20128%22%20width%3D%22128%22%20height%3D%22128%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22bg%22%20x1%3D%220%22%20y1%3D%220%22%20x2%3D%221%22%20y2%3D%221%22%3E%3Cstop%20offset%3D%220%22%20stop-color%3D%22%232b6ff0%22%2F%3E%3Cstop%20offset%3D%220.55%22%20stop-color%3D%22%235b8cff%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%238b5cff%22%2F%3E%3C%2FlinearGradient%3E%3ClinearGradient%20id%3D%22shine%22%20x1%3D%220%22%20y1%3D%220%22%20x2%3D%220%22%20y2%3D%221%22%3E%3Cstop%20offset%3D%220%22%20stop-color%3D%22%23ffffff%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%23e6edff%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Crect%20x%3D%226%22%20y%3D%226%22%20width%3D%22116%22%20height%3D%22116%22%20rx%3D%2228%22%20fill%3D%22url%28%23bg%29%22%2F%3E%3Cpath%20d%3D%22M30%2046h68l5%2052a8%208%200%200%201-8%208.8H33a8%208%200%200%201-8-8.8l5-52z%22%20fill%3D%22%23ffffff%22%20fill-opacity%3D%220.16%22%20stroke%3D%22%23ffffff%22%20stroke-width%3D%226%22%20stroke-linejoin%3D%22round%22%2F%3E%3Cpath%20d%3D%22M46%2046V38a18%2018%200%200%201%2036%200v8%22%20fill%3D%22none%22%20stroke%3D%22%23ffffff%22%20stroke-width%3D%226%22%20stroke-linecap%3D%22round%22%2F%3E%3Cpath%20d%3D%22M64%2058l5%2012%2012%205-12%205-5%2012-5-12-12-5%2012-5%205-12z%22%20fill%3D%22url%28%23shine%29%22%2F%3E%3C%2Fsvg%3E"/>
<style>
  :root {
    color-scheme: dark;
    --bg: #0b1020;
    --panel: rgba(20, 29, 52, .72);
    --panel-solid: #141d34;
    --border: rgba(148, 170, 220, .16);
    --text: #e8eeff;
    --muted: #93a3c9;
    --accent: #5b8cff;
    --green: #2da44e;
    --yellow: #e2b93b;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, "BlinkMacSystemFont", "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    background: radial-gradient(1000px 500px at 15% -10%, rgba(59, 130, 246, .22), transparent 60%),
                radial-gradient(900px 500px at 90% 0%, rgba(139, 92, 246, .18), transparent 55%),
                var(--bg);
    color: var(--text);
    min-height: 100vh;
  }
  a { color: inherit; text-decoration: none; }
  .container { max-width: 1180px; margin: 0 auto; padding: 0 22px 56px; }
  header {
    position: sticky;
    top: 0;
    z-index: 10;
    backdrop-filter: blur(14px);
    background: rgba(11, 16, 32, .72);
    border-bottom: 1px solid var(--border);
  }
  .header-inner {
    max-width: 1180px;
    margin: 0 auto;
    padding: 14px 22px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .brand { display: flex; align-items: center; gap: 11px; min-width: 0; }
  .logo {
    width: 38px; height: 38px; border-radius: 11px;
    display: flex; align-items: center; justify-content: center;
    box-shadow: 0 6px 18px rgba(43, 111, 240, .35);
    flex-shrink: 0;
    overflow: hidden;
  }
  .logo svg { width: 100%; height: 100%; display: block; }
  .brand-title { font-size: 15px; font-weight: 700; letter-spacing: .2px; }
  .brand-sub { font-size: 11px; color: var(--muted); margin-top: 2px; }
  .status {
    display: inline-flex; align-items: center; gap: 7px;
    font-size: 11px; color: var(--muted);
    border: 1px solid var(--border); border-radius: 999px; padding: 5px 11px;
    background: rgba(255, 255, 255, .03);
    white-space: nowrap;
  }
  .status .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--green); box-shadow: 0 0 0 3px rgba(45, 164, 78, .18); }
  .hero { padding: 34px 0 18px; }
  .hero h1 { font-size: 30px; line-height: 1.2; margin: 0 0 8px; letter-spacing: .2px; }
  .hero p { margin: 0; color: var(--muted); font-size: 13px; line-height: 1.7; max-width: 640px; }
  .stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 22px 0 26px; }
  .stat {
    padding: 14px 16px;
    border: 1px solid var(--border);
    border-radius: 14px;
    background: var(--panel);
    backdrop-filter: blur(8px);
  }
  .stat .k { font-size: 11px; color: var(--muted); margin-bottom: 6px; }
  .stat .v { font-size: 22px; font-weight: 800; letter-spacing: .3px; }
  .toolbar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 14px; }
  .search-wrap { position: relative; flex: 1; min-width: 240px; }
  .search-wrap svg { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); width: 15px; height: 15px; color: var(--muted); pointer-events: none; }
  input[type="search"], select {
    width: 100%;
    background: rgba(255, 255, 255, .04);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 10px 12px 10px 36px;
    font-size: 13px;
    outline: none;
    transition: border-color .15s ease, box-shadow .15s ease;
  }
  select { padding-left: 12px; width: auto; min-width: 150px; cursor: pointer; }
  input[type="search"]:focus, select:focus { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  input::placeholder { color: #6d7da4; }
  .chips { display: flex; gap: 7px; flex-wrap: wrap; margin-bottom: 18px; }
  .chip {
    border: 1px solid var(--border);
    background: rgba(255, 255, 255, .03);
    color: var(--muted);
    border-radius: 999px;
    padding: 5px 12px;
    font-size: 11px;
    cursor: pointer;
    transition: all .15s ease;
  }
  .chip:hover { color: var(--text); border-color: rgba(91, 140, 255, .5); }
  .chip.active { color: #fff; background: rgba(91, 140, 255, .18); border-color: rgba(91, 140, 255, .65); }
  .result-line { font-size: 11px; color: var(--muted); margin-bottom: 12px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(310px, 1fr)); gap: 14px; }
  .card {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 17px;
    border: 1px solid var(--border);
    border-radius: 15px;
    background: var(--panel);
    backdrop-filter: blur(8px);
    overflow: hidden;
    transition: transform .18s ease, border-color .18s ease, box-shadow .18s ease;
  }
  .card::before {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(135deg, hsla(var(--h), 80%, 60%, .10), transparent 50%);
    opacity: 0;
    transition: opacity .18s ease;
    pointer-events: none;
  }
  .card:hover { transform: translateY(-3px); border-color: rgba(91, 140, 255, .55); box-shadow: 0 14px 34px rgba(0, 0, 0, .35); }
  .card:hover::before { opacity: 1; }
  .card-head { position: relative; display: flex; gap: 11px; align-items: flex-start; }
  .avatar {
    width: 44px; height: 44px; border-radius: 13px; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center;
    font-size: 19px; font-weight: 800; color: #fff;
    background: linear-gradient(135deg, hsl(var(--h), 72%, 58%), hsl(var(--h2), 72%, 46%));
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .18);
  }
  .head-main { flex: 1; min-width: 0; }
  .name-row { display: flex; align-items: center; gap: 7px; min-width: 0; }
  .name { font-size: 14px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ns {
    flex-shrink: 0; font-size: 10px; color: var(--muted);
    border: 1px solid var(--border); border-radius: 999px; padding: 1px 7px;
  }
  .sub { display: flex; align-items: center; gap: 7px; margin-top: 4px; font-size: 11px; color: var(--muted); flex-wrap: wrap; }
  .ver { color: #9db7ff; font-weight: 700; }
  .desc {
    position: relative;
    margin: 0;
    font-size: 12px;
    line-height: 1.65;
    color: var(--muted);
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
    min-height: 3.9em;
  }
  .desc.expanded {
    display: block;
    -webkit-line-clamp: unset;
    overflow: visible;
    min-height: 0;
  }
  .desc-toggle {
    display: none;
    align-self: flex-start;
    margin-top: -5px;
    padding: 0;
    border: none;
    background: transparent;
    color: #8fb4ff;
    font-size: 11px;
    line-height: 1.5;
    cursor: pointer;
  }
  .desc-toggle:hover { text-decoration: underline; }
  .tags { position: relative; display: flex; gap: 5px; flex-wrap: wrap; }
  .tag { font-size: 10px; color: var(--muted); background: rgba(255, 255, 255, .05); border-radius: 999px; padding: 2px 8px; }
  .card-foot {
    position: relative;
    margin-top: auto;
    padding-top: 4px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }
  .meta { display: flex; gap: 10px; font-size: 11px; color: var(--muted); flex-wrap: wrap; }
  .btn {
    flex-shrink: 0;
    border: none;
    border-radius: 9px;
    padding: 7px 14px;
    font-size: 11px;
    font-weight: 700;
    color: #fff;
    background: linear-gradient(135deg, #2b6ff0, #6a5cff);
    cursor: pointer;
    box-shadow: 0 4px 14px rgba(43, 111, 240, .3);
    transition: filter .15s ease, transform .15s ease;
  }
  .btn:hover { filter: brightness(1.12); transform: translateY(-1px); }
  .empty, .error {
    grid-column: 1 / -1;
    padding: 56px 20px;
    text-align: center;
    border: 1px dashed var(--border);
    border-radius: 16px;
    color: var(--muted);
  }
  .empty-title, .error-title { font-size: 15px; font-weight: 700; color: var(--text); margin-bottom: 6px; }
  .empty-sub { font-size: 12px; }
  .skeleton-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(310px, 1fr)); gap: 14px; }
  .skel-card {
    position: relative;
    height: 200px;
    border: 1px solid var(--border);
    border-radius: 15px;
    background: var(--panel);
    overflow: hidden;
  }
  .skel-card::after {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(90deg, transparent, rgba(255, 255, 255, .06), transparent);
    transform: translateX(-100%);
    animation: shimmer 1.4s infinite;
  }
  @keyframes shimmer { to { transform: translateX(100%); } }
  footer {
    margin-top: 42px;
    padding-top: 18px;
    border-top: 1px solid var(--border);
    font-size: 11px;
    color: var(--muted);
    display: flex;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }
  code { background: rgba(255, 255, 255, .06); border-radius: 5px; padding: 1px 5px; font-size: 10px; }
  @media (max-width: 720px) {
    .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .hero h1 { font-size: 24px; }
    .grid, .skeleton-grid { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
  <header>
    <div class="header-inner">
      <div class="brand">
        <div class="logo" aria-hidden="true">
          <svg viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <linearGradient id="logoBg" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stop-color="#2b6ff0"/>
                <stop offset="0.55" stop-color="#5b8cff"/>
                <stop offset="1" stop-color="#8b5cff"/>
              </linearGradient>
              <linearGradient id="logoShine" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stop-color="#ffffff"/>
                <stop offset="1" stop-color="#e6edff"/>
              </linearGradient>
            </defs>
            <rect x="6" y="6" width="116" height="116" rx="28" fill="url(#logoBg)"/>
            <path d="M30 46h68l5 52a8 8 0 0 1-8 8.8H33a8 8 0 0 1-8-8.8l5-52z" fill="#ffffff" fill-opacity="0.16" stroke="#ffffff" stroke-width="6" stroke-linejoin="round"/>
            <path d="M46 46V38a18 18 0 0 1 36 0v8" fill="none" stroke="#ffffff" stroke-width="6" stroke-linecap="round"/>
            <path d="M64 58l5 12 12 5-12 5-5 12-5-12-12-5 12-5 5-12z" fill="url(#logoShine)"/>
          </svg>
        </div>
        <div>
          <div class="brand-title">SkillStore Registry</div>
          <div class="brand-sub">Local skill registry</div>
        </div>
      </div>
      <span class="status"><span class="dot"></span>Service running</span>
    </div>
  </header>

  <div class="container">
    <section class="hero">
      <h1>Registry console</h1>
      <p>Browse, search, and download Agent Skills from this registry. Add this URL as a registry in VS Code to install and auto-update skills with one click.</p>
    </section>

    <section class="stats">
      <div class="stat"><div class="k">Skills</div><div class="v" id="statSkills">-</div></div>
      <div class="stat"><div class="k">Downloads</div><div class="v" id="statDownloads">-</div></div>
      <div class="stat"><div class="k">Stars</div><div class="v" id="statStars">-</div></div>
      <div class="stat"><div class="k">Categories</div><div class="v" id="statCats">-</div></div>
    </section>

    <div class="toolbar">
      <div class="search-wrap">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
          <circle cx="11" cy="11" r="7"></circle>
          <path d="M20 20l-3.5-3.5"></path>
        </svg>
        <input id="searchInput" type="search" placeholder="Search by name, description, or publisher…" aria-label="Search skills"/>
      </div>
      <select id="sortSelect" aria-label="Sort by">
        <option value="updated">Recently updated</option>
        <option value="downloads">Most downloaded</option>
        <option value="stars">Most starred</option>
        <option value="name">Name A-Z</option>
      </select>
    </div>

    <div class="chips" id="chips"></div>
    <div class="result-line" id="resultLine">Loading…</div>
    <div class="grid" id="grid"></div>

    <footer>
      <span>SkillStore Registry · Local skill registry · <code>GET /api/v1/search</code></span>
      <span id="footerRegistry"></span>
    </footer>
  </div>

<script>
  const grid = document.getElementById('grid');
  const chips = document.getElementById('chips');
  const resultLine = document.getElementById('resultLine');
  const searchInput = document.getElementById('searchInput');
  const sortSelect = document.getElementById('sortSelect');
  const state = { skills: [], categories: [], category: '', query: '', sort: 'updated', loading: true };

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function hueOf(text) {
    let h = 0;
    const s = String(text || '');
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
    return h;
  }

  function fmtNum(n) {
    const v = Number(n) || 0;
    if (v >= 10000) return (v / 10000).toFixed(1).replace(/\\.0$/, '') + 'w';
    if (v >= 1000) return (v / 1000).toFixed(1).replace(/\\.0$/, '') + 'k';
    return String(v);
  }

  function relTime(iso) {
    if (!iso) return '';
    const t = new Date(iso).getTime();
    if (isNaN(t)) return '';
    const diff = Date.now() - t;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' min ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + ' h ago';
    if (diff < 2592000000) return Math.floor(diff / 86400000) + ' d ago';
    return new Date(t).toLocaleDateString();
  }

  function showSkeleton() {
    let html = '<div class="skeleton-grid">';
    for (let i = 0; i < 6; i++) html += '<div class="skel-card"></div>';
    html += '</div>';
    grid.innerHTML = html;
  }

  function renderStats() {
    const downloads = state.skills.reduce(function (n, s) { return n + (s.downloadCount || 0); }, 0);
    const stars = state.skills.reduce(function (n, s) { return n + (s.starCount || 0); }, 0);
    document.getElementById('statSkills').textContent = state.skills.length;
    document.getElementById('statDownloads').textContent = fmtNum(downloads);
    document.getElementById('statStars').textContent = fmtNum(stars);
    document.getElementById('statCats').textContent = state.categories.length;
  }

  function renderChips() {
    let html = '<button class="chip' + (state.category === '' ? ' active' : '') + '" data-cat="">All</button>';
    for (const c of state.categories) {
      html += '<button class="chip' + (state.category === c.name ? ' active' : '') + '" data-cat="' + escapeHtml(c.name) + '">' +
        escapeHtml(c.name) + ' <span style="opacity:.65">' + c.count + '</span></button>';
    }
    chips.innerHTML = html;
    chips.querySelectorAll('.chip').forEach(function (chip) {
      chip.addEventListener('click', function () {
        state.category = chip.dataset.cat;
        renderChips();
        render();
      });
    });
  }

  function filtered() {
    const q = state.query.toLowerCase();
    const list = state.skills.filter(function (s) {
      const author = (s.author && (s.author.displayName || s.author.handle)) || '';
      const text = (s.slug + ' ' + (s.name || '') + ' ' + (s.description || '') + ' ' + author + ' ' + (s.categories || []).join(' ')).toLowerCase();
      const matchQ = !q || text.indexOf(q) >= 0;
      const matchC = !state.category || (s.categories || []).indexOf(state.category) >= 0;
      return matchQ && matchC;
    });
    list.sort(function (a, b) {
      if (state.sort === 'downloads') return (b.downloadCount || 0) - (a.downloadCount || 0);
      if (state.sort === 'stars') return (b.starCount || 0) - (a.starCount || 0);
      if (state.sort === 'name') return String(a.name || a.slug).localeCompare(String(b.name || b.slug), 'en');
      return (new Date(b.updatedAt || 0).getTime() || 0) - (new Date(a.updatedAt || 0).getTime() || 0);
    });
    return list;
  }

  function render() {
    if (state.loading) { showSkeleton(); return; }
    const list = filtered();
    const bits = [list.length + (list.length === 1 ? ' skill' : ' skills')];
    if (state.query) bits.push('query “' + state.query + '”');
    if (state.category) bits.push('category “' + state.category + '”');
    resultLine.textContent = bits.join(' · ');

    if (list.length === 0) {
      grid.innerHTML = '<div class="empty"><div class="empty-title">No matching skills</div>' +
        '<div class="empty-sub">Try a different keyword or category</div></div>';
      return;
    }

    let html = '';
    for (const s of list) {
      const hue = hueOf(s.slug);
      const ns = s.slug.indexOf('--') >= 0 ? s.slug.slice(0, s.slug.indexOf('--')) : 'global';
      const shortSlug = s.slug.indexOf('--') >= 0 ? s.slug.slice(s.slug.indexOf('--') + 2) : s.slug;
      const publisher = (s.author && (s.author.displayName || s.author.handle)) || ns;
      const tags = (s.categories || []).map(function (c) {
        return '<span class="tag">' + escapeHtml(c) + '</span>';
      }).join('');
      const updated = relTime(s.updatedAt);
      const dl = '/api/v1/skills/' + encodeURIComponent(ns) + '/' + encodeURIComponent(shortSlug) +
        '/versions/' + encodeURIComponent(s.version) + '/download';
      html += '<article class="card" style="--h:' + hue + ';--h2:' + ((hue + 42) % 360) + '">' +
        '<div class="card-head">' +
          '<div class="avatar">' + escapeHtml(String(s.name || shortSlug).slice(0, 1).toUpperCase()) + '</div>' +
          '<div class="head-main">' +
            '<div class="name-row"><span class="name" title="' + escapeHtml(s.name || shortSlug) + '">' + escapeHtml(s.name || shortSlug) + '</span>' +
              '<span class="ns" title="Publisher">' + escapeHtml(publisher) + '</span></div>' +
            '<div class="sub"><span class="ver">v' + escapeHtml(s.version) + '</span>' +
              (updated ? '<span>· updated ' + escapeHtml(updated) + '</span>' : '') + '</div>' +
          '</div>' +
        '</div>' +
        '<p class="desc">' + escapeHtml(s.description || 'No description') + '</p>' +
        '<button class="desc-toggle" type="button" aria-expanded="false">Expand</button>' +
        (tags ? '<div class="tags">' + tags + '</div>' : '') +
        '<div class="card-foot"><div class="meta">' +
          '<span>↓ ' + fmtNum(s.downloadCount || 0) + '</span>' +
          '<span>★ ' + fmtNum(s.starCount || 0) + '</span>' +
          '<span>@' + escapeHtml(ns) + '/' + escapeHtml(shortSlug) + '</span>' +
        '</div><button class="btn" data-url="' + escapeHtml(dl) + '">Download</button></div>' +
      '</article>';
    }
    grid.innerHTML = html;
    grid.querySelectorAll('.card').forEach(function (card) {
      var desc = card.querySelector('.desc');
      var descToggle = card.querySelector('.desc-toggle');
      if (desc && descToggle) {
        requestAnimationFrame(function () {
          if (desc.scrollHeight > desc.clientHeight + 1) {
            descToggle.style.display = 'inline-flex';
          }
        });
        descToggle.addEventListener('click', function (ev) {
          ev.stopPropagation();
          var expanded = desc.classList.toggle('expanded');
          descToggle.textContent = expanded ? 'Collapse' : 'Expand';
          descToggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        });
      }
    });
    grid.querySelectorAll('.btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        window.location.href = btn.dataset.url;
      });
    });
  }

  function showError(message) {
    state.loading = false;
    resultLine.textContent = 'Failed to load';
    grid.innerHTML = '<div class="error"><div class="error-title">⚠ Could not read registry data</div>' +
      '<div class="empty-sub">' + escapeHtml(message) + '</div></div>';
  }

  async function load() {
    try {
      const [searchRes, catRes] = await Promise.all([
        fetch('/api/v1/search?limit=500'),
        fetch('/api/v1/categories')
      ]);
      if (!searchRes.ok) throw new Error('HTTP ' + searchRes.status);
      const searchData = await searchRes.json();
      const catData = catRes.ok ? await catRes.json() : { categories: [] };
      state.skills = searchData.results || [];
      state.categories = catData.categories || [];
      state.loading = false;
      renderStats();
      renderChips();
      render();
    } catch (err) {
      showError(err && err.message ? err.message : String(err));
    }
  }

  let debounce;
  searchInput.addEventListener('input', function () {
    clearTimeout(debounce);
    debounce = setTimeout(function () {
      state.query = searchInput.value.trim();
      render();
    }, 250);
  });
  sortSelect.addEventListener('change', function () {
    state.sort = sortSelect.value;
    render();
  });

  document.getElementById('footerRegistry').textContent = window.location.origin;
  showSkeleton();
  load();
</script>
</body>
</html>`;
}

function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    });
    return res.end();
  }

  if (req.method === 'GET' && (p === '/' || p === '/index.html' || p === '/ui')) {
    return sendHtml(res, renderHome());
  }

  if (req.method === 'POST' && p === '/api/v1/publish') {
    const chunks = [];
    let size = 0;
    let rejected = false;
    req.on('data', (c) => {
      if (rejected) {
        return;
      }
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        rejected = true;
        chunks.length = 0;
        if (!res.headersSent) {
          json(res, 413, {
            error: `Upload exceeds limit (${MAX_BODY_BYTES} bytes)`,
          });
        }
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (rejected) {
        return;
      }
      handlePublish(req, res, Buffer.concat(chunks)).catch((err) => {
        console.error('[publish] Failed:', err);
        if (!res.headersSent) {
          json(res, 500, { error: `Publish failed: ${err.message}` });
        }
      });
    });
    req.on('error', (err) => {
      if (!res.headersSent) {
        json(res, 400, { error: `Failed to read request: ${err.message}` });
      }
    });
    return;
  }

  if (req.method === 'GET' && p === '/api/v1/whoami') {
    return json(res, 200, { user: { handle: 'local', displayName: 'Local Registry' } });
  }

  const index = loadIndex();

  if (req.method === 'GET' && p === '/api/v1/search') {
    const q = (url.searchParams.get('q') || '').toLowerCase();
    const category = (url.searchParams.get('category') || '').trim();
    const rawLimit = parseInt(url.searchParams.get('limit') || '50', 10);
    const limit = Math.max(0, Math.min(Number.isFinite(rawLimit) ? rawLimit : 50, MAX_SEARCH_LIMIT));
    const catLower = category.toLowerCase();
    const summaries = derived.summaries;
    const searchText = derived.searchText;
    const results = [];
    let total = 0;
    for (let i = 0; i < summaries.length; i++) {
      if (q && !searchText[i].includes(q)) {
        continue;
      }
      if (catLower) {
        const cats = summaries[i].categories || [];
        let hit = false;
        for (let j = 0; j < cats.length; j++) {
          if (cats[j].toLowerCase() === catLower) {
            hit = true;
            break;
          }
        }
        if (!hit) {
          continue;
        }
      }
      total++;
      if (results.length < limit) {
        results.push(summaries[i]);
      }
    }
    return json(
      res,
      200,
      {
        results,
        total,
        page: 1,
        limit,
      },
      {
        req,
        etag: etagFor(['search', q, category, String(limit)]),
        cacheControl: 'public, max-age=30',
      }
    );
  }

  if (req.method === 'GET' && p === '/api/v1/categories') {
    const categories = [...derived.categoryCounts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'en'));
    return json(
      res,
      200,
      { categories },
      {
        req,
        etag: etagFor(['categories']),
        cacheControl: 'public, max-age=300',
      }
    );
  }

  if (req.method === 'GET' && p === '/api/v1/skills') {
    const slug = url.searchParams.get('slug') || '';
    const { namespace, slug: s } = splitCanonical(slug);
    const entry = findSkill(index, namespace, s);
    if (!entry) return json(res, 404, { error: 'Skill not found' });
    return json(
      res,
      200,
      toSummary(entry),
      {
        req,
        etag: etagFor(['detail', toKey(entry.namespace, entry.slug)]),
        cacheControl: 'public, max-age=60',
      }
    );
  }

  let dm = p.match(/^\/api\/v1\/skills\/(.+)$/);
  if (req.method === 'GET' && dm && !dm[1].includes('/')) {
    const decoded = decodePathPart(dm[1]);
    if (decoded === null) {
      return json(res, 400, { error: 'Invalid skill identifier encoding' });
    }
    const { namespace, slug: s } = splitCanonical(decoded);
    const entry = findSkill(index, namespace, s);
    if (!entry) return json(res, 404, { error: 'Skill not found' });
    return json(
      res,
      200,
      toSummary(entry),
      {
        req,
        etag: etagFor(['detail', toKey(entry.namespace, entry.slug)]),
        cacheControl: 'public, max-age=60',
      }
    );
  }

  if (req.method === 'GET' && p === '/api/v1/resolve') {
    const slug = url.searchParams.get('slug') || '';
    const version = url.searchParams.get('version') || '';
    const { namespace, slug: s } = splitCanonical(slug);
    const entry = findSkill(index, namespace, s);
    if (!entry) return json(res, 404, { error: 'Skill not found' });
    const v = version || entry.version;
    if (version && !entry.versions.includes(version)) {
      return json(res, 404, { error: `Version ${version} not found` });
    }
    return json(
      res,
      200,
      {
        slug: toCanonical(namespace, s),
        version: v,
        downloadUrl: `/api/v1/skills/${encodeURIComponent(namespace)}/${encodeURIComponent(s)}/versions/${encodeURIComponent(v)}/download`,
      },
      {
        req,
        etag: etagFor(['resolve', toKey(namespace, s), v]),
        cacheControl: 'public, max-age=30',
      }
    );
  }

  let m = p.match(/^\/api\/v1\/skills\/([^/]+)\/([^/]+)\/versions$/);
  if (req.method === 'GET' && m) {
    const namespace = decodePathPart(m[1]);
    const s = decodePathPart(m[2]);
    if (namespace === null || s === null) {
      return json(res, 400, { error: 'Invalid skill identifier encoding' });
    }
    const entry = findSkill(index, namespace, s);
    if (!entry) return json(res, 404, { error: 'Skill not found' });
    return json(
      res,
      200,
      {
        slug: toCanonical(namespace, s),
        versions: entry.versions || [entry.version],
        latest: entry.version,
      },
      {
        req,
        etag: etagFor(['versions', toKey(namespace, s)]),
        cacheControl: 'public, max-age=60',
      }
    );
  }

  m = p.match(/^\/api\/v1\/skills\/([^/]+)\/([^/]+)\/versions\/([^/]+)\/download$/);
  if ((req.method === 'GET' || req.method === 'HEAD') && m) {
    const namespace = decodePathPart(m[1]);
    const s = decodePathPart(m[2]);
    const v = decodePathPart(m[3]);
    if (namespace === null || s === null || v === null) {
      return json(res, 400, { error: 'Invalid skill identifier encoding' });
    }
    const entry = findSkill(index, namespace, s);
    if (!entry) return json(res, 404, { error: 'Skill not found' });
    if (!(entry.versions || []).includes(v)) {
      return json(res, 404, { error: `Version ${v} not found` });
    }
    if (req.method === 'HEAD') {
      try {
        return sendFileStream(req, res, safePackagePath(entry, v), 'application/zip', `${entry.slug}.zip`);
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }
    entry.downloadCount = (entry.downloadCount || 0) + 1;
    syncSummaryCount(entry);
    saveIndexSoon(index);
    try {
      return sendFileStream(req, res, safePackagePath(entry, v), 'application/zip', `${entry.slug}.zip`);
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  m = p.match(/^\/api\/v1\/download\/(.+)$/);
  if ((req.method === 'GET' || req.method === 'HEAD') && m) {
    const slug = decodePathPart(m[1]);
    if (slug === null) {
      return json(res, 400, { error: 'Invalid skill identifier encoding' });
    }
    const version = url.searchParams.get('version') || '';
    if (version && !isValidVersion(version)) {
      return json(res, 400, { error: `Invalid version: ${version}` });
    }
    const { namespace, slug: s } = splitCanonical(slug);
    const entry = findSkill(index, namespace, s);
    if (!entry) return json(res, 404, { error: 'Skill not found' });
    const v = version || entry.version;
    if (!(entry.versions || []).includes(v)) {
      return json(res, 404, { error: `Version ${v} not found` });
    }
    if (req.method === 'HEAD') {
      try {
        return sendFileStream(req, res, safePackagePath(entry, v), 'application/zip', `${entry.slug}.zip`);
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }
    entry.downloadCount = (entry.downloadCount || 0) + 1;
    syncSummaryCount(entry);
    saveIndexSoon(index);
    try {
      return sendFileStream(req, res, safePackagePath(entry, v), 'application/zip', `${entry.slug}.zip`);
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  return json(res, 404, { error: `Endpoint not found: ${req.method} ${p}` });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  fs.mkdirSync(PACKAGES_DIR, { recursive: true });
  if (!fs.existsSync(INDEX_FILE)) {
    saveIndex({ skills: [] });
  } else {
    loadIndex();
  }

  const server = http.createServer((req, res) => {
    try {
      handle(req, res);
    } catch (err) {
      console.error('[server] Unhandled exception:', err);
      if (!res.headersSent) {
        json(res, 500, { error: `Server error: ${err.message}` });
      } else {
        res.end();
      }
    }
  });
  // HTTP-layer stability: align keep-alive with the default 60s reverse-proxy timeout
  // so slow or idle connections do not occupy sockets indefinitely.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.requestTimeout = 30_000;
  server.maxRequestsPerSocket = 1000;
  server.on('clientError', (err, socket) => {
    if (socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    }
  });
  let shuttingDown = false;
  const flushAndExit = (code) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      if (cachedIndex) {
        saveIndex(cachedIndex);
      }
    } catch {
      // ignore
    }
    server.close(() => process.exit(code));
    // Fallback: force exit after 5s
    setTimeout(() => process.exit(code), 5000).unref();
  };
  process.on('exit', () => {
    if (cachedIndex && !shuttingDown) {
      try {
        saveIndex(cachedIndex);
      } catch {
        // ignore
      }
    }
  });
  process.on('SIGTERM', () => flushAndExit(0));
  process.on('SIGINT', () => flushAndExit(0));
  server.listen(args.port, args.host, () => {
    console.log(`Local skill registry started: http://${args.host}:${args.port}`);
    console.log(`  Package directory: ${PACKAGES_DIR}`);
    console.log(`  Skill index:       ${INDEX_FILE}`);
    console.log(`  Auth:              ${AUTH_TOKEN ? 'Bearer token enabled' : 'disabled (bind to 127.0.0.1 only)'}`);
    console.log(`  Extension setting: skillstore.registry = http://localhost:${args.port}`);
  });
}

main();
