import { mkdtempSync, mkdirSync, cpSync, rmSync, readdirSync, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../scripts/lib/config.mjs';

export const FIXTURES_DIR = path.join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures');

/** tests/fixtures 下的全部样本文件名 */
export const ALL_FIXTURES = readdirSync(FIXTURES_DIR);

const MIME_BY_EXT = {
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
};

export function mimeOf(filePath) {
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * 创建一次性临时项目：把指定样本复制到 <tmp>/images/，并返回与之匹配的配置。
 * 配置基于仓库默认值（临时目录下没有 config.json），因此测试结果不受本地配置影响。
 */
export function createTempProject({ fixtures = ALL_FIXTURES, overrides = {} } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'qingyv-image-api-'));
  const imagesDir = path.join(root, 'images');
  mkdirSync(imagesDir, { recursive: true });

  for (const name of fixtures) {
    cpSync(path.join(FIXTURES_DIR, name), path.join(imagesDir, name));
  }

  const config = loadConfig({
    root,
    overrides: { imagesDir: 'images', urlPrefix: 'images', ...overrides },
  });

  return {
    root,
    config,
    imagesDir,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * 模拟 Cloudflare Pages 的 ASSETS 绑定。
 * @param {(relPath:string) => ({body:Buffer, contentType:string}|null)} resolve
 */
export function createAssetFetcher(resolve) {
  return {
    async fetch(request) {
      const url = new URL(request.url);
      const relPath = decodeURIComponent(url.pathname).replace(/^\//, '');
      const found = await resolve(relPath);
      if (!found) {
        return new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
      }
      return new Response(request.method === 'HEAD' ? null : found.body, {
        status: 200,
        headers: {
          'Content-Type': found.contentType,
          'Content-Length': String(found.body.length),
          // 真实的静态资源会带长缓存，接口必须把它覆盖掉，这里刻意保留以验证覆盖行为
          'Cache-Control': 'public, max-age=604800',
        },
      });
    },
  };
}

/** 基于内存的 ASSETS 绑定，用于单元测试。值可以是字符串、Buffer 或 { body } */
export function memoryAssets(map) {
  return createAssetFetcher((relPath) => {
    const entry = map[relPath];
    if (entry === undefined || entry === null) return null;
    let body;
    if (Buffer.isBuffer(entry)) body = entry;
    else if (typeof entry === 'string') body = Buffer.from(entry, 'utf8');
    else body = Buffer.from(entry.body);

    return {
      body,
      contentType:
        (typeof entry === 'object' && !Buffer.isBuffer(entry) && entry.contentType) ||
        MIME_BY_EXT[path.extname(relPath).toLowerCase()] ||
        'application/octet-stream',
    };
  });
}

/** 基于真实目录的 ASSETS 绑定，用于端到端测试 */
export function directoryAssets(dir) {
  const root = path.resolve(dir);
  return createAssetFetcher((relPath) => {
    const abs = path.resolve(path.join(root, relPath));
    if (abs !== root && !abs.startsWith(root + path.sep)) return null;
    if (!existsSync(abs) || !statSync(abs).isFile()) return null;
    return { body: readFileSync(abs), contentType: mimeOf(abs) };
  });
}

/** 构造 Pages Functions 的 context 对象 */
export function makeContext(url, method = 'GET', env = {}) {
  return { request: new Request(url, { method }), env, params: {}, data: {} };
}

/** 确定性随机源：按给定序列依次返回，用完后循环 */
export function sequenceRandom(values) {
  let i = 0;
  return () => values[i++ % values.length];
}

/** 从响应中还原出索引里的相对路径（仅用于错误路径断言） */
export function relativeOf(location) {
  return decodeURIComponent(new URL(location).pathname).replace(/^\//, '');
}
