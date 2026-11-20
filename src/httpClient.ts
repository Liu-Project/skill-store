import * as http from 'http';
import * as https from 'https';
import * as zlib from 'zlib';
import { URL } from 'url';
import { EXTENSION_VERSION } from './util';

export interface HttpResponse {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export class HttpError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly requestId?: string
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface RequestOptions {
  headers?: Record<string, string>;
  body?: Buffer | string;
  /** 总超时（毫秒），默认 30s */
  timeoutMs?: number;
  /** 连接阶段超时（毫秒），默认 5s */
  connectTimeoutMs?: number;
  /** 取消信号 */
  signal?: AbortSignal;
  /** 是否声明并解压 gzip 响应（默认 true） */
  gzip?: boolean;
}

const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_CONNECT_TIMEOUT_MS = 5000;
/** 下载（大文件）总超时 */
export const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

// 连接复用：同一进程内所有请求共享 keep-alive 连接池，减少 TCP/TLS 握手
const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 16,
  keepAliveMsecs: 30_000,
  timeout: DEFAULT_CONNECT_TIMEOUT_MS,
});
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 16,
  keepAliveMsecs: 30_000,
  timeout: DEFAULT_CONNECT_TIMEOUT_MS,
});

/**
 * 发送 HTTP 请求。兼容旧签名：
 *   request(method, url)
 *   request(method, url, headers)
 *   request(method, url, headers, body)
 * 新的 options 形式：
 *   request(method, url, { headers, body, timeoutMs, signal, gzip })
 */
export function request(
  method: string,
  url: string,
  headersOrOptions?: Record<string, string> | RequestOptions,
  body?: Buffer | string,
  redirectCount = 0
): Promise<HttpResponse> {
  let opts: RequestOptions;
  if (
    headersOrOptions &&
    typeof headersOrOptions === 'object' &&
    !Array.isArray(headersOrOptions) &&
    ('body' in headersOrOptions ||
      'timeoutMs' in headersOrOptions ||
      'signal' in headersOrOptions ||
      'gzip' in headersOrOptions ||
      'connectTimeoutMs' in headersOrOptions)
  ) {
    opts = headersOrOptions as RequestOptions;
  } else {
    opts = { headers: headersOrOptions as Record<string, string> | undefined, body };
  }

  return new Promise<HttpResponse>((resolve, reject) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch (err) {
      reject(new Error(`Invalid URL: ${url}`));
      return;
    }

    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const headers: Record<string, string> = {
      'User-Agent': `skillstore/${EXTENSION_VERSION}`,
      Accept: 'application/json',
      ...(opts.headers ?? {}),
    };
    const acceptGzip = opts.gzip ?? true;
    if (acceptGzip && !('accept-encoding' in headers)) {
      headers['Accept-Encoding'] = 'gzip';
    }

    const lib = target.protocol === 'https:' ? https : http;
    const agent = target.protocol === 'https:' ? httpsAgent : httpAgent;
    const req = lib.request(
      target,
      {
        method,
        headers,
        agent,
      },
      (res) => {
        const status = res.statusCode ?? 0;

        if (
          status >= 300 &&
          status < 400 &&
          res.headers.location &&
          redirectCount < MAX_REDIRECTS
        ) {
          res.resume();
          const next = new URL(res.headers.location, target).toString();
          request(method, next, opts, undefined, redirectCount + 1)
            .then(resolve)
            .catch(reject);
          return;
        }

        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          let responseBody = Buffer.concat(chunks);
          const encoding = (res.headers['content-encoding'] || '').toLowerCase();
          const finish = (buf: Buffer) => {
            resolve({
              statusCode: status,
              headers: res.headers,
              body: buf,
            });
          };
          if (encoding === 'gzip' || encoding === 'x-gzip') {
            zlib.gunzip(responseBody, (err, out) => {
              if (err) {
                reject(new Error(`Failed to decompress response: ${err.message}`));
              } else {
                finish(out);
              }
            });
            return;
          }
          finish(responseBody);
        });
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Request timed out (${timeoutMs}ms)`));
    });

    req.on('error', (err) => {
      if (opts.signal?.aborted) {
        reject(new Error('Request cancelled'));
      } else {
        reject(new Error(`Network request failed: ${err.message}`));
      }
    });

    if (opts.signal) {
      if (opts.signal.aborted) {
        req.destroy();
      } else {
        const onAbort = () => req.destroy(new Error('aborted'));
        opts.signal.addEventListener('abort', onAbort, { once: true });
        req.on('close', () => {
          opts.signal?.removeEventListener('abort', onAbort);
        });
      }
    }

    if (opts.body !== undefined) {
      req.write(opts.body);
    }
    req.end();
  });
}

export async function getJson<T>(url: string): Promise<T> {
  const res = await request('GET', url);
  if (res.statusCode >= 400) {
    throw new HttpError(
      `Request failed (${res.statusCode}): ${errorText(res.body)}`,
      res.statusCode,
      (res.headers['x-request-id'] as string) || undefined
    );
  }
  return JSON.parse(res.body.toString('utf8')) as T;
}

function decodeBody(body: Buffer): string {
  try {
    return body.toString('utf8');
  } catch {
    return '';
  }
}

function errorText(body: Buffer): string {
  const text = decodeBody(body);
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (parsed && parsed.error !== undefined) {
      return String(parsed.error).slice(0, 200);
    }
  } catch {
    // 非 JSON 响应
  }
  return text.slice(0, 200);
}
