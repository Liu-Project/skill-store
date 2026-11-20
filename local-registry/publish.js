#!/usr/bin/env node
/**
 * Local SkillStore-compatible registry - publish script
 * Usage:
 *   node publish.js <skill-dir> [--namespace <ns>] [--version <v>] [--force] [--allow-downgrade]
 * Example:
 *   node publish.js ~/.zeroagent/skills/icenter-message
 *   node publish.js ~/.zeroagent/skills/icenter-message --version 1.1.0
 *   node publish.js ./my-skill --namespace my-team
 */
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const ROOT = __dirname;
let PACKAGES_DIR = path.join(ROOT, 'packages');
let INDEX_FILE = path.join(ROOT, 'index.json');

const EXCLUDE_DIRS = new Set([
  '.git',
  '__pycache__',
  'node_modules',
  '.skillstore',
]);
const EXCLUDE_FILES = new Set(['.DS_Store', 'Thumbs.db']);
const SENSITIVE_FILE_RE =
  /^(\.env(\..*)?|\.npmrc|\.netrc|id_rsa.*|id_ed25519.*|credentials.*|.*\.(pem|key|p12|pfx))$/i;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const UNSAFE_SLUG_CHARS = /[\/\\\0-\x1f\x7f<>:"|?*]/;

function parseArgs(argv) {
  const args = {
    _: [],
    namespace: 'global',
    version: '1.0.0',
    force: false,
    allowDowngrade: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--namespace') args.namespace = argv[++i];
    else if (a === '--version') args.version = argv[++i];
    else if (a === '--force') args.force = true;
    else if (a === '--allow-downgrade') args.allowDowngrade = true;
    else if (a === '--dir') {
      const d = argv[++i];
      PACKAGES_DIR = path.join(d, 'packages');
      INDEX_FILE = path.join(d, 'index.json');
    } else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: node publish.js <skill-dir> [--namespace <ns>] [--version <v>] [--force] [--allow-downgrade] [--dir <registry-dir>]'
      );
      process.exit(0);
    } else args._.push(a);
  }
  return args;
}

function parseFrontmatter(md) {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const fm = {};
  const lines = m[1].split(/\r?\n/);
  for (const line of lines) {
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].trim();
    let val = kv[2].trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1);
    fm[key] = val;
  }
  return fm;
}

function readSkillMeta(skillDir) {
  const skillMdPath = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(skillMdPath)) {
    throw new Error(`Skill directory is missing SKILL.md: ${skillDir}`);
  }
  const content = fs.readFileSync(skillMdPath, 'utf8');
  const fm = parseFrontmatter(content);
  const slug = fm.name || path.basename(skillDir);
  const description = fm.description || '';
  const categories = parseCategories(fm.categories || fm.category);
  let authorHandle = 'unknown';
  const fmText = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fmText) {
    const am = fmText[1].match(/^\s*author\s*:\s*["']?([^"'#\n]+)/m);
    if (am) authorHandle = am[1].trim();
  }
  if (fm.author) authorHandle = fm.author;
  return { slug, description, authorHandle, categories, skillMdPath };
}

function parseCategories(val) {
  if (!val) return [];
  let text = String(val).trim();
  if (
    (text.startsWith('[') && text.endsWith(']')) ||
    (text.startsWith('{') && text.endsWith('}'))
  ) {
    text = text.slice(1, -1);
  }
  return text
    .split(/[,\n]/)
    .map((c) => c.trim().replace(/^["']|["']$/g, '').trim())
    .filter(Boolean);
}

function isValidSlug(slug) {
  if (!slug || slug === '.' || slug === '..') return false;
  if (UNSAFE_SLUG_CHARS.test(slug)) return false;
  return path.basename(slug) === slug;
}

function isValidNamespace(namespace) {
  const value = String(namespace || '');
  return !value.includes('--') && /^[A-Za-z0-9@][A-Za-z0-9@._-]*$/.test(value);
}

function isValidVersion(version) {
  return VERSION_RE.test(String(version || ''));
}

function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

function collectFiles(dir, base) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      out.push(...collectFiles(full, base));
    } else {
      if (EXCLUDE_FILES.has(entry.name)) continue;
      if (SENSITIVE_FILE_RE.test(entry.name)) continue;
      const rel = path.relative(base, full);
      out.push({ abs: full, rel });
    }
  }
  return out;
}

function buildZip(skillDir, namespace, slug, version) {
  const rel = `${namespace}/${slug}/${version}.zip`;
  const zipPath = path.resolve(PACKAGES_DIR, rel);
  const base = path.resolve(PACKAGES_DIR);
  if (zipPath !== base && !zipPath.startsWith(base + path.sep)) {
    throw new Error(`Invalid skill package path: ${rel}`);
  }

  const zip = new AdmZip();
  for (const f of collectFiles(skillDir, skillDir)) {
    zip.addFile(f.rel.split(path.sep).join('/'), fs.readFileSync(f.abs));
  }
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  fs.writeFileSync(zipPath, zip.toBuffer());
  return rel;
}

function loadIndex() {
  if (!fs.existsSync(INDEX_FILE)) return { skills: [] };
  return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
}

function saveIndex(index) {
  const tmp = `${INDEX_FILE}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(index, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, INDEX_FILE);
  console.log(`Index updated: ${INDEX_FILE}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args._.length !== 1) {
    console.error('Error: please specify a skill directory');
    process.exit(1);
  }
  const skillDir = path.resolve(args._[0]);
  if (!fs.existsSync(skillDir)) {
    console.error(`Error: skill directory does not exist: ${skillDir}`);
    process.exit(1);
  }

  const meta = readSkillMeta(skillDir);
  const slug = meta.slug;
  const namespace = args.namespace;
  const version = args.version;

  if (!isValidSlug(slug)) {
    console.error(`Error: invalid skill name: ${slug}`);
    process.exit(1);
  }
  if (slug.includes('--')) {
    console.error('Error: skill slug must not contain consecutive --');
    process.exit(1);
  }
  if (!isValidNamespace(namespace)) {
    console.error(`Error: invalid namespace: ${namespace}`);
    process.exit(1);
  }
  if (!isValidVersion(version)) {
    console.error(`Error: invalid version: ${version} (expected x.y.z)`);
    process.exit(1);
  }

  const now = new Date().toISOString();
  const index = loadIndex();
  const entry = index.skills.find(
    (s) => s.slug === slug && s.namespace === namespace
  );

  if (entry) {
    if (
      compareVersions(version, entry.version) < 0 &&
      !args.allowDowngrade
    ) {
      console.error(
        `Error: downgrade not allowed ${version} < ${entry.version}. Pass --allow-downgrade to override.`
      );
      process.exit(1);
    }
    if (entry.versions.includes(version) && !args.force) {
      console.error(
        `Skill ${namespace}/${slug} version ${version} already exists. Pass --force to overwrite.`
      );
      process.exit(1);
    }
  }

  const zipFile = buildZip(skillDir, namespace, slug, version);

  if (entry) {
    if (!entry.versions.includes(version)) {
      entry.versions.push(version);
    }
    entry.files = entry.files || {};
    entry.files[version] = zipFile;
    if (compareVersions(version, entry.version) >= 0) {
      entry.version = version;
      entry.zipFile = zipFile;
    }
    entry.description = meta.description;
    if (meta.categories && meta.categories.length > 0) {
      entry.categories = meta.categories;
    }
    entry.updatedAt = now;
    if (meta.authorHandle) {
      entry.author = {
        handle: meta.authorHandle,
        displayName: meta.authorHandle,
      };
    }
    console.log(
      `Updated skill ${namespace}/${slug} -> v${version} (previous versions: ${entry.versions.join(', ')})`
    );
  } else {
    index.skills.push({
      slug,
      namespace,
      name: slug,
      description: meta.description,
      author: { handle: meta.authorHandle, displayName: meta.authorHandle },
      version,
      versions: [version],
      files: { [version]: zipFile },
      zipFile,
      downloadCount: 0,
      starCount: 0,
      categories: meta.categories || [],
      createdAt: now,
      updatedAt: now,
    });
    console.log(`Published new skill ${namespace}/${slug} v${version}`);
  }

  saveIndex(index);
  console.log(`Skill package: ${path.resolve(PACKAGES_DIR, zipFile)}`);
}

main();
