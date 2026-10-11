import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { scanDirectory, summarize } from './scan.mjs';
import { formatBytes } from './formats.mjs';

/**
 * 扫描源目录并写出索引文件。
 * @returns {Promise<object>} 完整的索引对象
 */
export async function buildIndex(config, { generatedAt = new Date().toISOString(), onProgress } = {}) {
  const { images, skipped, scanned, totalBytes } = await scanDirectory(config, { onProgress });

  const index = {
    generatedAt,
    sourceLabel: config.sourceLabel.split(path.sep).join('/'),
    urlPrefix: config.urlPrefix,
    limits: {
      deployMaxBytes: config.deployMaxBytes,
      optimizeThresholdBytes: config.optimizeThresholdBytes,
    },
    stats: summarize(images, skipped, totalBytes),
    images,
    skipped,
    scannedFiles: scanned,
  };

  writeIndexFiles(config, index);
  return index;
}

export function writeIndexFiles(config, index) {
  mkdirSync(path.dirname(config.dataFile), { recursive: true });
  mkdirSync(path.dirname(config.generatedModule), { recursive: true });
  writeFileSync(config.dataFile, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  writeFileSync(config.generatedModule, renderGeneratedModule(index), 'utf8');
}

/**
 * 生成内嵌索引模块。
 * 使用短键（p/w/h/o）压缩打包体积；运行时只需要路径与方向。
 */
export function renderGeneratedModule(index) {
  const entries = index.images.map(
    (image) =>
      `  { p: ${JSON.stringify(image.path)}, w: ${image.width}, h: ${image.height}, o: ${JSON.stringify(image.orientation)} },`
  );
  return `// 该文件由 scripts/build-index.mjs 自动生成，请勿手动编辑。
// 重新生成：npm run index
// 作用：把图片索引内嵌进 Pages Functions 的打包产物，
//      使接口在运行时无需读取文件，也不会调用任何外部 API。
export const generatedAt = ${JSON.stringify(index.generatedAt)};
export const stats = ${JSON.stringify(index.stats, null, 2)};
export default [
${entries.join('\n')}
];
`;
}

const SEPARATOR = '─'.repeat(64);

/** 把索引汇总成可读报告文本（CLI 打印与测试断言共用同一份渲染逻辑）。 */
export function renderReport(index, config) {
  const { stats, images, skipped } = index;
  const out = [];
  const push = (line = '') => out.push(line);

  push('');
  push(SEPARATOR);
  push('  随机图片 API — 图片索引报告');
  push(SEPARATOR);
  push(`  源目录        : ${index.sourceLabel}`);
  push(`  URL 前缀      : /${index.urlPrefix}`);
  push(`  生成时间      : ${index.generatedAt}`);

  push('');
  push('  【总览】');
  push(`    扫描文件总数    : ${index.scannedFiles ?? stats.total + stats.skipped}`);
  push(`    已收录图片      : ${stats.total}`);
  push(`    跳过文件        : ${stats.skipped}`);
  push(`    图片总容量      : ${formatBytes(stats.totalBytes)}`);

  push('');
  push('  【按格式】');
  const formats = Object.entries(stats.byFormat).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (formats.length === 0) push('    (无)');
  for (const [format, count] of formats) push(`    ${format.padEnd(8)} ${String(count).padStart(5)}`);

  push('');
  push('  【按方向】(依据实际显示尺寸，已计入 EXIF 旋转)');
  push(`    横屏 landscape  ${String(stats.byOrientation.landscape).padStart(5)}`);
  push(`    竖屏 portrait   ${String(stats.byOrientation.portrait).padStart(5)}`);
  push(`    方形 square     ${String(stats.byOrientation.square).padStart(5)}`);

  push('');
  push('  【体积】');
  push(`    Cloudflare Pages 单文件硬上限 : ${formatBytes(config.deployMaxBytes)}`);
  push(`    重新编码触发阈值              : ${formatBytes(config.optimizeThresholdBytes)}`);
  if (stats.largest) {
    push(`    最大图片 : ${stats.largest.path} (${formatBytes(stats.largest.bytes)})`);
  }
  const oversized = images.filter((image) => image.bytes > config.optimizeThresholdBytes);
  if (oversized.length === 0) {
    push('    超过阈值的图片 : 无');
  } else {
    push(`    超过阈值的图片 : ${oversized.length} 张（同步时生成压缩副本，原图不动）`);
    for (const image of oversized) {
      const flag = image.bytes > config.deployMaxBytes ? '超出硬上限' : '超出阈值';
      push(`      - ${image.path}  ${formatBytes(image.bytes)}  [${flag}]`);
    }
  }

  if (stats.skipped > 0) {
    push('');
    push('  【跳过文件明细】');
    const byCode = new Map();
    for (const item of skipped) {
      if (!byCode.has(item.code)) byCode.set(item.code, []);
      byCode.get(item.code).push(item);
    }
    for (const [code, items] of [...byCode.entries()].sort()) {
      push(`    ${code} (${items.length}):`);
      for (const item of items.slice(0, 10)) push(`      - ${item.path} — ${item.message}`);
      if (items.length > 10) push(`      ... 其余 ${items.length - 10} 个同类文件已省略`);
    }
  }

  if (stats.warnings.length > 0) {
    push('');
    push('  【警告】');
    for (const warning of stats.warnings.slice(0, 10)) {
      push(`    - ${warning.path} — ${warning.message}`);
    }
    if (stats.warnings.length > 10) push(`    ... 其余 ${stats.warnings.length - 10} 条已省略`);
  }

  push('');
  push(SEPARATOR);
  if (stats.total === 0) {
    push('  ⚠ 索引为空：源目录中没有任何受支持的图片，接口将对所有请求返回 404。');
    push(SEPARATOR);
  }
  push('');
  return out.join('\n');
}
