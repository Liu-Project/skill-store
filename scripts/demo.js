#!/usr/bin/env node
/**
 * One-command demo: start a local registry, publish the example skills, and
 * print instructions for opening the marketplace in VS Code.
 *
 * Usage:
 *   npm run demo
 *   SKILLSTORE_DEMO_PORT=4040 npm run demo
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DEMO_DIR = path.join(ROOT, '.demo-registry');
const SKILLS_DIR = path.join(ROOT, 'examples', 'skills');
const SERVER = path.join(ROOT, 'local-registry', 'server.js');
const PUBLISH = path.join(ROOT, 'local-registry', 'publish.js');
const PORT = Number(process.env.SKILLSTORE_DEMO_PORT || 3030);
const BASE = `http://127.0.0.1:${PORT}`;

function log(message) {
  console.log(`\x1b[36m[demo]\x1b[0m ${message}`);
}

function fail(message) {
  console.error(`\x1b[31m[demo]\x1b[0m ${message}`);
}

function request(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode || 0));
    });
    req.on('error', reject);
    req.setTimeout(2000, () => {
      req.destroy(new Error('timeout'));
    });
  });
}

async function waitForServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const status = await request(`${BASE}/api/v1/search?q=&limit=1`);
      if (status < 500) {
        return true;
      }
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

function skillFolders() {
  if (!fs.existsSync(SKILLS_DIR)) {
    return [];
  }
  return fs
    .readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(SKILLS_DIR, entry.name))
    .filter((dir) => fs.existsSync(path.join(dir, 'SKILL.md')))
    .sort();
}

function publishExamples() {
  const folders = skillFolders();
  if (folders.length === 0) {
    log('No example skills found; starting an empty registry.');
    return;
  }
  for (const dir of folders) {
    const name = path.basename(dir);
    const result = spawnSync(
      process.execPath,
      [PUBLISH, dir, '--dir', DEMO_DIR, '--namespace', 'global', '--force'],
      { stdio: 'ignore' }
    );
    if (result.status === 0) {
      log(`Published example: ${name}`);
    } else {
      fail(`Failed to publish example: ${name}`);
    }
  }
}

async function main() {
  fs.mkdirSync(DEMO_DIR, { recursive: true });

  log(`Starting local registry on ${BASE}`);
  const server = spawn(
    process.execPath,
    [SERVER, '--port', String(PORT), '--dir', DEMO_DIR],
    { stdio: 'inherit' }
  );

  const stop = () => {
    if (!server.killed) {
      server.kill('SIGTERM');
    }
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  const ready = await waitForServer(10000);
  if (!ready) {
    fail(`Registry did not start on ${BASE}. Is port ${PORT} already in use?`);
    fail('Set SKILLSTORE_DEMO_PORT to use another port.');
    server.kill('SIGTERM');
    process.exit(1);
  }

  publishExamples();

  console.log('');
  log('Demo registry is ready.');
  log(`  Web UI:    ${BASE}`);
  log('  VS Code:   run "SkillStore: Card View"');
  if (PORT === 3030) {
    log(`  Registry:  ${BASE} (already the default)`);
  } else {
    log(`  Registry:  ${BASE} (add it in SkillStore Settings)`);
  }
  log('Press Ctrl+C to stop.');
  console.log('');
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
