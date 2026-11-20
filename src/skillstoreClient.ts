import { getJson, request, DOWNLOAD_TIMEOUT_MS, HttpError } from './httpClient';
import { normalizeRegistry, compareVersions } from './util';

export interface SkillAuthor {
  handle: string;
  displayName?: string;
}

export interface SkillSummary {
  slug: string;
  name?: string;
  description?: string;
  author?: SkillAuthor;
  version?: string;
  downloadCount?: number;
  starCount?: number;
  categories?: string[];
  createdAt?: string;
  updatedAt?: string;
}

export interface SkillSearchResult {
  results: SkillSummary[];
  total: number;
  page: number;
  limit: number;
}

export interface SkillResolveResult {
  slug: string;
  version: string;
  downloadUrl?: string;
}

export interface SkillNamespace {
  namespace: string;
  slug: string;
}

export function parseSlug(coordinate: string): SkillNamespace {
  let c = coordinate.trim();
  if (c.startsWith('@')) {
    c = c.slice(1);
  }
  if (c.includes('--')) {
    const idx = c.indexOf('--');
    return { namespace: c.slice(0, idx), slug: c.slice(idx + 2) };
  }
  if (c.includes('/')) {
    const idx = c.indexOf('/');
    return { namespace: c.slice(0, idx), slug: c.slice(idx + 1) };
  }
  return { namespace: 'global', slug: c };
}

export function toCanonicalSlug(namespace: string, slug: string): string {
  if (!namespace || namespace === 'global') {
    return slug;
  }
  return `${namespace}--${slug}`;
}

export class SkillStoreClient {
  private readonly baseUrl: string;

  constructor(registry: string) {
    this.baseUrl = normalizeRegistry(registry);
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  async search(query: string, limit = 50, category?: string): Promise<SkillSearchResult> {
    const params = new URLSearchParams({ q: query || '', limit: String(limit) });
    if (category) {
      params.set('category', category);
    }
    try {
      return await getJson<SkillSearchResult>(
        this.url(`/api/v1/search?${params.toString()}`)
      );
    } catch (err) {
      // Fall back to the legacy endpoint only when the modern one is
      // missing (404) or failing (5xx). Network errors are surfaced as-is.
      if (
        !(err instanceof HttpError) ||
        (err.statusCode < 500 && err.statusCode !== 404)
      ) {
        throw err;
      }
      return getJson<SkillSearchResult>(
        this.url(`/api/cli/v1/skills/search?${params.toString()}`)
      );
    }
  }

  async getCategories(): Promise<Array<{ name: string; count: number }>> {
    try {
      const result = await getJson<{ categories: Array<{ name: string; count: number }> }>(
        this.url('/api/v1/categories')
      );
      return result.categories ?? [];
    } catch {
      return [];
    }
  }

  async getDetail(canonicalSlug: string): Promise<SkillSummary | undefined> {
    try {
      return await getJson<SkillSummary>(
        this.url(`/api/v1/skills/${encodeURIComponent(canonicalSlug)}`)
      );
    } catch {
      return undefined;
    }
  }

  async resolve(
    namespace: string,
    slug: string,
    version?: string
  ): Promise<SkillResolveResult> {
    const canonical = toCanonicalSlug(namespace, slug);
    const params = new URLSearchParams({ slug: canonical });
    if (version) {
      params.set('version', version);
    }
    return getJson<SkillResolveResult>(
      this.url(`/api/v1/resolve?${params.toString()}`)
    );
  }

  async getVersions(
    namespace: string,
    slug: string
  ): Promise<string[]> {
    const ns = namespace && namespace !== 'global' ? namespace : 'global';
    try {
      const result = await getJson<{ versions?: string[] }>(
        this.url(
          `/api/v1/skills/${encodeURIComponent(ns)}/${encodeURIComponent(slug)}/versions`
        )
      );
      if (result.versions && result.versions.length > 0) {
        return result.versions
          .slice()
          .sort((a, b) => compareVersions(b, a));
      }
    } catch {
      // 端点不可用时回退到 resolve
    }
    try {
      const resolved = await this.resolve(namespace, slug);
      return resolved.version ? [resolved.version] : [];
    } catch {
      return [];
    }
  }

  /**
   * 下载技能包。调用方若已 resolve 过，可传入 downloadUrl 避免重复 resolve（减少一次往返）。
   */
  async downloadZip(
    namespace: string,
    slug: string,
    version?: string,
    downloadUrl?: string
  ): Promise<Buffer> {
    const canonical = toCanonicalSlug(namespace, slug);
    let resolved: SkillResolveResult | undefined;
    if (!downloadUrl) {
      try {
        resolved = await this.resolve(namespace, slug, version);
      } catch {
        resolved = undefined;
      }
    }

    let url: string;
    if (downloadUrl) {
      url = this.absoluteUrl(downloadUrl);
    } else if (resolved?.downloadUrl) {
      url = this.absoluteUrl(resolved.downloadUrl);
    } else {
      const params = new URLSearchParams({ slug: canonical });
      if (version) {
        params.set('version', version);
      }
      url = this.url(
        `/api/v1/download/${encodeURIComponent(canonical)}?${params.toString()}`
      );
    }

    const res = await request('GET', url, { timeoutMs: DOWNLOAD_TIMEOUT_MS });
    if (res.statusCode >= 400) {
      throw new Error(
        `Download failed (${res.statusCode}): ${res.body.toString('utf8')}`
      );
    }
    return res.body;
  }

  get registry(): string {
    return this.baseUrl;
  }

  /**
   * Resolve a download URL returned by a registry. Registries may return an
   * absolute URL, an absolute path (`/api/...`), or a path relative to the
   * registry root (`api/v1/...`). All three are supported.
   */
  private absoluteUrl(url: string): string {
    if (/^https?:\/\//i.test(url)) {
      return url;
    }
    if (url.startsWith('/')) {
      return this.url(url);
    }
    return new URL(url, `${this.baseUrl}/`).toString();
  }

  /** Lightweight reachability probe used by the settings panel. */
  async health(): Promise<{ ok: boolean; count: number }> {
    const result = await this.search('', 1);
    return {
      ok: true,
      count: result.total ?? result.results?.length ?? 0
    };
  }
}

/**
 * 并发受限的 map：以 limit 个并发处理 items，保持顺序。
 * 用于检查更新等"多个技能逐个请求"的场景，把 N 次串行 RTT 降为 N/limit 批。
 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  const n = Math.min(Math.max(1, limit), items.length);
  await Promise.all(Array.from({ length: n }, () => worker()));
  return out;
}
