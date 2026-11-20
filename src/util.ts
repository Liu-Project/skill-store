import * as os from 'os';
import * as path from 'path';

export const DEFAULT_REGISTRY = '';
export const DEFAULT_INSTALL_DIR = '~/.zeroagent/skills';
export const EXTENSION_VERSION = '0.1.1';

export function isComparableVersion(version: string | undefined): boolean {
  if (!version) {
    return false;
  }
  return /^v?\d+(?:\.\d+)*(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
    version.trim()
  );
}

export function normalizeRegistry(registry: string): string {
  let url = registry.trim();
  if (!url) {
    return DEFAULT_REGISTRY;
  }
  while (url.endsWith('/')) {
    url = url.slice(0, -1);
  }
  if (!/^https?:\/\//i.test(url)) {
    url = `${defaultScheme(url)}://${url}`;
  }
  return url;
}

function defaultScheme(url: string): 'http' | 'https' {
  const authority = url.split('/')[0].toLowerCase();
  let hostname = authority;
  const at = hostname.lastIndexOf('@');
  if (at >= 0) {
    hostname = hostname.slice(at + 1);
  }
  if (hostname.startsWith('[')) {
    const end = hostname.indexOf(']');
    hostname = end >= 0 ? hostname.slice(1, end) : hostname.slice(1);
  } else if ((hostname.match(/:/g) || []).length === 1) {
    hostname = hostname.replace(/:\d+$/, '');
  }
  if (
    hostname === 'localhost' ||
    hostname === '0.0.0.0' ||
    hostname === '::1' ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    isPrivateHost(hostname) ||
    isLocalIpv6(hostname) ||
    (!hostname.includes('.') && !hostname.includes(':'))
  ) {
    return 'http';
  }
  return 'https';
}

function isLocalIpv6(host: string): boolean {
  return (
    host === '::1' ||
    host.startsWith('fc') ||
    host.startsWith('fd') ||
    host.startsWith('fe80')
  );
}

function isPrivateHost(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) {
    return false;
  }
  const a = Number(m[1]);
  const b = Number(m[2]);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

export function expandHome(p: string): string {
  if (p === '~') {
    return os.homedir();
  }
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

interface ParsedVersion {
  core: number[];
  prerelease: string[];
}

function parseVersion(version: string): ParsedVersion {
  const withoutBuild = version.trim().replace(/^v/i, '').split('+')[0];
  const dash = withoutBuild.indexOf('-');
  const coreText = dash >= 0 ? withoutBuild.slice(0, dash) : withoutBuild;
  const preText = dash >= 0 ? withoutBuild.slice(dash + 1) : '';
  return {
    core: coreText.split('.').map((n) => parseInt(n, 10) || 0),
    prerelease: preText ? preText.split('.') : []
  };
}

/**
 * Semver-aware comparison with sensible fallbacks for non-semver strings.
 * Build metadata is ignored; prerelease identifiers follow semver precedence.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  const len = Math.max(pa.core.length, pb.core.length);
  for (let i = 0; i < len; i++) {
    const x = pa.core[i] || 0;
    const y = pb.core[i] || 0;
    if (x !== y) {
      return x - y;
    }
  }
  if (pa.prerelease.length === 0 && pb.prerelease.length === 0) {
    return 0;
  }
  if (pa.prerelease.length === 0) {
    return 1;
  }
  if (pb.prerelease.length === 0) {
    return -1;
  }
  const preLen = Math.max(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < preLen; i++) {
    if (i >= pa.prerelease.length) {
      return -1;
    }
    if (i >= pb.prerelease.length) {
      return 1;
    }
    const x = pa.prerelease[i];
    const y = pb.prerelease[i];
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      const diff = parseInt(x, 10) - parseInt(y, 10);
      if (diff !== 0) {
        return diff;
      }
    } else if (xNumeric) {
      return -1;
    } else if (yNumeric) {
      return 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}
