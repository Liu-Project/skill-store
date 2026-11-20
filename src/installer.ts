import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import AdmZip from 'adm-zip';
import { compareVersions } from './util';

export interface InstalledSkill {
  slug: string;
  namespace: string;
  version: string;
  agent: string;
  registry: string;
  installedAt: string;
  dir: string;
  /** true=由 SkillStore 安装（含元数据）；false=手动放置/上传的技能目录 */
  managed?: boolean;
}

const METADATA_DIR = '.skillstore';
const METADATA_FILE = 'metadata.json';
const MAX_EXTRACT_BYTES = 200 * 1024 * 1024;
const MAX_EXTRACT_FILES = 10000;

interface Metadata {
  registry: string;
  namespace: string;
  slug: string;
  version: string;
  agent: string;
  installedAt: string;
}

const UNSAFE_SLUG_CHARS = /[\/\\\0-\x1f\x7f<>:"|?*]/;

export function isValidSlug(slug: string): boolean {
  if (!slug || slug === '.' || slug === '..') {
    return false;
  }
  if (UNSAFE_SLUG_CHARS.test(slug)) {
    return false;
  }
  return path.basename(slug) === slug;
}

export function isValidNamespace(namespace: string): boolean {
  if (!namespace || namespace.includes('--')) {
    return false;
  }
  return /^[A-Za-z0-9@][A-Za-z0-9@._-]*$/.test(namespace);
}

export function installDirFor(
  installDir: string,
  slug: string,
  namespace = 'global'
): string {
  if (!isValidSlug(slug)) {
    throw new Error(`Invalid skill name: ${slug}`);
  }
  if (!isValidNamespace(namespace)) {
    throw new Error(`Invalid namespace: ${namespace}`);
  }
  const dirName =
    namespace && namespace !== 'global' ? `${namespace}--${slug}` : slug;
  if (!isValidSlug(dirName)) {
    throw new Error(`Invalid skill directory name: ${dirName}`);
  }
  return path.join(installDir, dirName);
}

export function isSafeChild(base: string, target: string): boolean {
  const rel = path.relative(base, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export async function installSkill(
  installDir: string,
  registry: string,
  namespace: string,
  slug: string,
  version: string,
  zipBuffer: Buffer,
  force = false,
  agent = 'claude-code',
  adopt = false
): Promise<InstalledSkill> {
  if (!isValidNamespace(namespace)) {
    throw new Error(`Invalid namespace: ${namespace}`);
  }
  if (!isValidSlug(slug)) {
    throw new Error(`Invalid skill name: ${slug}`);
  }

  const targetDir = installDirFor(installDir, slug, namespace);
  if (!isSafeChild(installDir, targetDir)) {
    throw new Error(`Refusing to write outside the skills directory: ${targetDir}`);
  }

  if (fs.existsSync(targetDir)) {
    if (!force) {
      throw new Error(
        `Folder already exists: ${targetDir}. Pass force=true to overwrite.`
      );
    }
    const metaFile = path.join(targetDir, METADATA_DIR, METADATA_FILE);
    if (!fs.existsSync(metaFile)) {
      const isManualSkill = fs.existsSync(path.join(targetDir, 'SKILL.md'));
      if (!adopt || !isManualSkill) {
        throw new Error(
          `This folder was not installed by SkillStore. Refusing to overwrite: ${targetDir}`
        );
      }
    }
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skillstore-'));
  const staging = path.join(
    installDir,
    `.${path.basename(targetDir)}.new-${process.pid}-${Date.now()}`
  );
  let backup: string | undefined;
  try {
    const zip = new AdmZip(zipBuffer);
    assertSafeZip(zip);
    zip.extractAllTo(tmpRoot, true);

    const src = resolvePackageRoot(tmpRoot);
    fs.mkdirSync(staging, { recursive: true });
    copyDir(src, staging);

    const metadata: Metadata = {
      registry,
      namespace,
      slug,
      version,
      agent,
      installedAt: new Date().toISOString(),
    };
    const metaDir = path.join(staging, METADATA_DIR);
    fs.mkdirSync(metaDir, { recursive: true });
    fs.writeFileSync(
      path.join(metaDir, METADATA_FILE),
      JSON.stringify(metadata, null, 2),
      'utf8'
    );

    if (fs.existsSync(targetDir)) {
      backup = path.join(
        installDir,
        `.${path.basename(targetDir)}.bak-${process.pid}-${Date.now()}`
      );
      fs.renameSync(targetDir, backup);
    }
    try {
      fs.renameSync(staging, targetDir);
    } catch (err) {
      if (backup && fs.existsSync(backup)) {
        fs.renameSync(backup, targetDir);
      }
      throw err;
    }
    if (backup) {
      fs.rmSync(backup, { recursive: true, force: true });
      backup = undefined;
    }

    return {
      slug,
      namespace,
      version,
      agent: metadata.agent,
      registry,
      installedAt: metadata.installedAt,
      dir: targetDir,
    };
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(staging, { recursive: true, force: true });
    if (backup && fs.existsSync(backup) && !fs.existsSync(targetDir)) {
      fs.renameSync(backup, targetDir);
    }
  }
}

function assertSafeZip(zip: AdmZip): void {
  const entries = zip.getEntries();
  if (entries.length > MAX_EXTRACT_FILES) {
    throw new Error(`The skill package contains too many files (limit: ${MAX_EXTRACT_FILES})`);
  }
  let total = 0;
  for (const entry of entries) {
    const name = entry.entryName.replace(/\\/g, '/');
    if (
      name.startsWith('/') ||
      name.split('/').some((part) => part === '..') ||
      name.includes('\0')
    ) {
      throw new Error(`The skill package contains an unsafe path: ${entry.entryName}`);
    }
    total += entry.header.size || 0;
    if (total > MAX_EXTRACT_BYTES) {
      throw new Error(`The skill package is too large after extraction (limit: ${MAX_EXTRACT_BYTES} bytes)`);
    }
  }
}

function resolvePackageRoot(tmpRoot: string): string {
  const topLevel = path.join(tmpRoot, 'SKILL.md');
  if (fs.existsSync(topLevel)) {
    return tmpRoot;
  }

  const found = findSkillMdFiles(tmpRoot);
  if (found.length === 0) {
    throw new Error('The skill package does not contain SKILL.md.');
  }
  if (found.length > 1) {
    throw new Error('The skill package contains multiple SKILL.md files; cannot determine the install root.');
  }
  return path.dirname(found[0]);
}

function findSkillMdFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...findSkillMdFiles(full));
    } else if (entry.name === 'SKILL.md') {
      out.push(full);
    }
  }
  return out;
}

function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

export function uninstallSkill(
  installDir: string,
  slug: string,
  namespace = 'global'
): void {
  if (!isValidSlug(slug)) {
    throw new Error(`Invalid skill name: ${slug}`);
  }
  let target = installDirFor(installDir, slug, namespace);
  if (!fs.existsSync(target) && namespace !== 'global') {
    const legacy = path.join(installDir, slug);
    const legacyMeta = path.join(legacy, METADATA_DIR, METADATA_FILE);
    if (fs.existsSync(legacyMeta)) {
      try {
        const meta = JSON.parse(
          fs.readFileSync(legacyMeta, 'utf8')
        ) as Metadata;
        if (meta.namespace === namespace && meta.slug === slug) {
          target = legacy;
        }
      } catch {
        // ignore malformed legacy metadata
      }
    }
  }
  if (!isSafeChild(installDir, target)) {
    throw new Error(`Refusing to delete outside the skills directory: ${target}`);
  }
  if (!fs.existsSync(target)) {
    throw new Error(`Skill is not installed: ${slug}`);
  }
  if (!fs.existsSync(path.join(target, METADATA_DIR, METADATA_FILE))) {
    throw new Error(`This folder was not installed by SkillStore. Refusing to delete: ${target}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
}

function isDirectoryEntry(
  installDir: string,
  entry: fs.Dirent
): boolean {
  if (entry.isDirectory()) {
    return true;
  }
  if (!entry.isSymbolicLink()) {
    return false;
  }
  try {
    return fs.statSync(path.join(installDir, entry.name)).isDirectory();
  } catch {
    return false;
  }
}

function parseInstalledDirName(dirName: string): {
  namespace: string;
  slug: string;
} {
  const idx = dirName.indexOf('--');
  if (idx > 0 && idx + 2 < dirName.length) {
    return {
      namespace: dirName.slice(0, idx),
      slug: dirName.slice(idx + 2),
    };
  }
  return { namespace: 'global', slug: dirName };
}

function readSkillVersion(skillMdPath: string): string {
  try {
    const content = fs.readFileSync(skillMdPath, 'utf8');
    const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!fm) {
      return '';
    }
    const top = fm[1].match(/^version\s*:\s*["']?([^"'#\r\n]+)/m);
    if (top) {
      return top[1].trim();
    }
    const nested = fm[1].match(/^\s+version\s*:\s*["']?([^"'#\r\n]+)/m);
    return nested ? nested[1].trim() : '';
  } catch {
    return '';
  }
}

export function listInstalled(installDir: string): InstalledSkill[] {
  if (!fs.existsSync(installDir)) {
    return [];
  }
  const out: InstalledSkill[] = [];
  for (const entry of fs.readdirSync(installDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || !isDirectoryEntry(installDir, entry)) {
      continue;
    }
    const dir = path.join(installDir, entry.name);
    const metaFile = path.join(dir, METADATA_DIR, METADATA_FILE);
    if (fs.existsSync(metaFile)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as Metadata;
        out.push({
          slug: meta.slug || entry.name,
          namespace: meta.namespace || 'global',
          version: meta.version || 'unknown',
          agent: meta.agent || 'unknown',
          registry: meta.registry || '',
          installedAt: meta.installedAt || '',
          dir,
          managed: true,
        });
      } catch {
        out.push({
          slug: entry.name,
          namespace: 'global',
          version: 'unknown',
          agent: 'unknown',
          registry: '',
          installedAt: '',
          dir,
          managed: true,
        });
      }
      continue;
    }

    // 手动放置/上传的技能目录：只要包含 SKILL.md 即视为已安装
    const skillMd = path.join(dir, 'SKILL.md');
    if (!fs.existsSync(skillMd)) {
      continue;
    }
    const { namespace, slug } = parseInstalledDirName(entry.name);
    let installedAt = '';
    try {
      installedAt = fs.statSync(dir).mtime.toISOString();
    } catch {
      installedAt = '';
    }
    out.push({
      slug,
      namespace,
      version: readSkillVersion(skillMd) || 'unknown',
      agent: 'manual',
      registry: '',
      installedAt,
      dir,
      managed: false,
    });
  }
  return out;
}

export interface VersionClient {
  resolve(
    namespace: string,
    slug: string
  ): Promise<{ version: string; downloadUrl?: string }>;
  downloadZip(
    namespace: string,
    slug: string,
    version?: string,
    downloadUrl?: string
  ): Promise<Buffer>;
}

export async function updateIfNeeded(
  client: VersionClient,
  registry: string,
  installDir: string,
  skill: InstalledSkill,
  resolved?: { version: string; downloadUrl?: string }
): Promise<boolean> {
  const info = resolved ?? (await client.resolve(skill.namespace, skill.slug));
  if (compareVersions(info.version, skill.version) <= 0) {
    return false;
  }
  const zip = await client.downloadZip(
    skill.namespace,
    skill.slug,
    info.version,
    info.downloadUrl
  );
  await installSkill(
    installDir,
    registry,
    skill.namespace,
    skill.slug,
    info.version,
    zip,
    true
  );
  return true;
}
