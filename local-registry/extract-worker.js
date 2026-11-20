#!/usr/bin/env node
/**
 * Publish extraction worker: unzips packages, locates SKILL.md, and parses
 * frontmatter off the main thread so large uploads do not block the event loop.
 *
 * Input (workerData): { zipBuffer: Buffer, tmpDir: string }
 * Output (postMessage): { ok, slug, description, authorHandle, categories, error? }
 */
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const MAX_EXTRACT_BYTES = 200 * 1024 * 1024;
const MAX_EXTRACT_FILES = 10000;

function findSkillMdFiles(dir) {
  const out = [];
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

function assertSafeZip(zip) {
  const entries = zip.getEntries();
  if (entries.length > MAX_EXTRACT_FILES) {
    throw new Error(`Skill package exceeds file limit (${MAX_EXTRACT_FILES})`);
  }
  let total = 0;
  for (const entry of entries) {
    const name = entry.entryName.replace(/\\/g, '/');
    if (
      name.startsWith('/') ||
      name.split('/').some((part) => part === '..') ||
      name.includes('\0')
    ) {
      throw new Error(`Skill package contains an unsafe path: ${entry.entryName}`);
    }
    total += entry.header.size || 0;
    if (total > MAX_EXTRACT_BYTES) {
      throw new Error(`Extracted skill package exceeds size limit (${MAX_EXTRACT_BYTES} bytes)`);
    }
  }
}

function parseFrontmatter(md) {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    let val = kv[2].trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1);
    fm[kv[1].trim()] = val;
  }
  return fm;
}

function extractAuthor(md, fm) {
  if (fm.author) return fm.author;
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (m) {
    const am = m[1].match(/^\s*author\s*:\s*["']?([^"'#\n]+)/m);
    if (am) return am[1].trim();
  }
  return 'unknown';
}

function extractCategories(fm) {
  const raw = fm.categories || fm.category;
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.map((c) => String(c).trim()).filter(Boolean);
  }
  let text = String(raw).trim();
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

function main() {
  try {
    const data = workerData || {};
    // worker_threads structured clone turns Buffer into Uint8Array; convert it back
    const zipBuffer = data.zipBuffer ? Buffer.from(data.zipBuffer) : null;
    const tmpDir = data.tmpDir;
    if (!zipBuffer || !tmpDir) {
      throw new Error('Worker is missing required arguments');
    }
    const zip = new AdmZip(zipBuffer);
    assertSafeZip(zip);
    const extractDir = path.join(tmpDir, 'extract');
    fs.mkdirSync(extractDir, { recursive: true });
    zip.extractAllTo(extractDir, true);

    const candidates = findSkillMdFiles(extractDir);
    if (candidates.length === 0) {
      throw new Error('Skill package is missing SKILL.md');
    }
    if (candidates.length > 1) {
      throw new Error('Skill package contains multiple SKILL.md files; cannot determine the skill root');
    }
    const skillMd = candidates[0];
    const content = fs.readFileSync(skillMd, 'utf8');
    const fm = parseFrontmatter(content);
    parentPort.postMessage({
      ok: true,
      slug: String(fm.name || path.basename(path.dirname(skillMd))).trim(),
      description: fm.description || '',
      authorHandle: extractAuthor(content, fm),
      categories: extractCategories(fm),
    });
  } catch (e) {
    parentPort.postMessage({ ok: false, error: e.message || String(e) });
  }
}

main();
