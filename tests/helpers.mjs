import { mkdtempSync, mkdirSync, cpSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../scripts/lib/config.mjs';

export const FIXTURES_DIR = path.join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures');

/** tests/fixtures 下的全部样本文件名 */
export const ALL_FIXTURES = readdirSync(FIXTURES_DIR);

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

/** 构造 Pages Functions 的 context 对象 */
export function makeContext(url, method = 'GET') {
  return { request: new Request(url, { method }), env: {}, params: {}, data: {} };
}

/** 确定性随机源：按给定序列依次返回，用完后循环 */
export function sequenceRandom(values) {
  let i = 0;
  return () => values[i++ % values.length];
}
