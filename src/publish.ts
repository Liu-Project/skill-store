import * as fs from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';
import { request } from './httpClient';
import { normalizeRegistry } from './util';

const EXCLUDE_DIRS = new Set([
  '.git',
  '__pycache__',
  'node_modules',
  '.skillstore',
]);
const EXCLUDE_FILES = new Set(['.DS_Store', 'Thumbs.db']);
const SENSITIVE_FILE_RE =
  /^(\.env(\..*)?|\.npmrc|\.netrc|id_rsa.*|id_ed25519.*|credentials.*|.*\.(pem|key|p12|pfx))$/i;

export interface SkillFrontmatter {
  name?: string;
  description?: string;
  author?: string;
  categories?: string[];
}

export function readSkillFrontmatter(skillDir: string): SkillFrontmatter {
  const skillMdPath = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(skillMdPath)) {
    throw new Error(`Skill directory is missing SKILL.md: ${skillDir}`);
  }
  const content = fs.readFileSync(skillMdPath, 'utf8');
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const fm: SkillFrontmatter = {};
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
      if (!kv) continue;
      let val = kv[2].trim();
      if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
      if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1);
      const key = kv[1].trim();
      if (key === 'name') fm.name = val;
      else if (key === 'description') fm.description = val;
      else if (key === 'author') fm.author = val;
      else if (key === 'categories' || key === 'category') {
        fm.categories = parseCategories(val);
      }
    }
    const am = m[1].match(/^\s*author\s*:\s*["']?([^"'#\n]+)/m);
    if (am) fm.author = am[1].trim();
  }
  return fm;
}

export function parseCategories(val: string): string[] {
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

export interface PublishOptions {
  namespace: string;
  categories?: string[];
  version?: string;
  force?: boolean;
}

export interface PublishResult {
  ok: boolean;
  isUpdate?: boolean;
  slug?: string;
  namespace?: string;
  version?: string;
  downloadUrl?: string;
  error?: string;
}

function loadSkillIgnore(skillDir: string): Set<string> {
  const ignoreFile = path.join(skillDir, '.skillignore');
  if (!fs.existsSync(ignoreFile)) {
    return new Set();
  }
  return new Set(
    fs
      .readFileSync(ignoreFile, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
  );
}

export function createSkillZip(skillDir: string): Buffer {
  const zip = new AdmZip();
  const ignore = loadSkillIgnore(skillDir);
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        if (EXCLUDE_DIRS.has(entry.name) || ignore.has(entry.name)) continue;
        walk(full);
      } else {
        if (EXCLUDE_FILES.has(entry.name)) continue;
        if (SENSITIVE_FILE_RE.test(entry.name)) continue;
        const rel = path.relative(skillDir, full).split(path.sep).join('/');
        if (ignore.has(entry.name) || ignore.has(rel)) continue;
        zip.addFile(rel, fs.readFileSync(full));
      }
    }
  };
  walk(skillDir);
  return zip.toBuffer();
}

export async function publishSkill(
  registry: string,
  skillDir: string,
  opts: PublishOptions
): Promise<PublishResult> {
  const fm = readSkillFrontmatter(skillDir);
  const slug = fm.name || path.basename(skillDir);
  const zipData = createSkillZip(skillDir);
  const boundary = `----skillstore${Date.now().toString(16)}`;

  const fields: Record<string, string> = {
    namespace: opts.namespace || 'global',
  };
  if (opts.categories && opts.categories.length > 0) {
    fields.categories = opts.categories.join(',');
  }
  if (opts.version) fields.version = opts.version;
  if (opts.force) fields.force = 'true';

  const chunks: Buffer[] = [];
  const text = (s: string): Buffer => Buffer.from(s, 'utf8');
  for (const [k, v] of Object.entries(fields)) {
    chunks.push(
      text(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`)
    );
  }
  chunks.push(
    text(
      `--${boundary}\r\nContent-Disposition: form-data; name="skill"; filename="${slug}.zip"\r\nContent-Type: application/zip\r\n\r\n`
    )
  );
  chunks.push(zipData);
  chunks.push(text(`\r\n--${boundary}--\r\n`));

  const headers: Record<string, string> = {
    'Content-Type': `multipart/form-data; boundary=${boundary}`,
  };

  const base = normalizeRegistry(registry);
  const res = await request('POST', `${base}/api/v1/publish`, headers, Buffer.concat(chunks));
  const bodyText = res.body.toString('utf8');
  let parsed: PublishResult;
  try {
    parsed = JSON.parse(bodyText) as PublishResult;
  } catch {
    parsed = { ok: false, error: `Unexpected server response: ${bodyText.slice(0, 200)}` };
  }
  if (res.statusCode >= 400) {
    return {
      ok: false,
      error: parsed.error || `Publish failed (HTTP ${res.statusCode})`,
    };
  }
  return parsed;
}
