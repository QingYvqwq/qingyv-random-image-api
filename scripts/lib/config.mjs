import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根目录（scripts/lib/config.mjs 上溯两级） */
export const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

export const DEFAULTS = {
  imagesDir: 'images',
  urlPrefix: 'images',
  excludeDirs: ['node_modules', '.git', '.wrangler', 'public', 'tests', 'scripts', 'functions', 'data'],
  deployMaxBytes: 26214400,
  optimizeThresholdBytes: 24117248,
  optimizeQualityLadder: [82, 70, 58, 45],
  maxScanBytes: 209715200,
  allowedFormats: ['jpg', 'png', 'webp', 'gif', 'bmp', 'avif', 'tiff'],
  blockedFormats: ['svg'],
};

/**
 * 读取并归一化配置。
 *
 * @param {object} [options]
 * @param {string} [options.root]      项目根目录，测试时可指向临时目录
 * @param {object} [options.overrides] 显式覆盖项，优先级高于 config.json 与环境变量
 * @param {object} [options.env]       环境变量来源
 */
export function loadConfig({ root = PROJECT_ROOT, overrides = {}, env = process.env } = {}) {
  const configPath = path.join(root, 'config.json');
  let raw = {};
  if (existsSync(configPath)) {
    try {
      raw = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch (error) {
      throw new Error(`config.json 解析失败: ${error.message}`);
    }
  }

  // 剥掉以下划线开头的注释键
  const clean = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith('_')) continue;
    clean[key] = value;
  }

  const config = { ...DEFAULTS, ...clean, ...overrides };

  if (!overrides.imagesDir && env.IMAGES_DIR) config.imagesDir = env.IMAGES_DIR;
  if (!overrides.urlPrefix && env.URL_PREFIX) config.urlPrefix = env.URL_PREFIX;

  const urlPrefix = String(config.urlPrefix).replace(/^\/+|\/+$/g, '');
  if (!urlPrefix) throw new Error('urlPrefix 不能为空');

  return {
    ...config,
    urlPrefix,
    root,
    sourceDir: path.resolve(root, config.imagesDir),
    publicDir: path.join(root, 'public'),
    deployDir: path.join(root, 'public', urlPrefix),
    dataFile: config.dataFile ?? path.join(root, 'data', 'images.json'),
    generatedModule:
      config.generatedModule ?? path.join(root, 'functions', '_data', 'images.generated.js'),
    sourceLabel: path.relative(root, path.resolve(root, config.imagesDir)) || '.',
  };
}

/** 要求源目录必须存在，否则抛出可读的错误。 */
export function assertSourceExists(config) {
  if (!existsSync(config.sourceDir)) {
    throw new Error(
      `源图片目录不存在: ${config.sourceDir}\n` +
        '请创建该目录并放入图片，或修改 config.json 中的 "imagesDir"，' +
        '或设置环境变量 IMAGES_DIR 指向图片所在目录。'
    );
  }
}
