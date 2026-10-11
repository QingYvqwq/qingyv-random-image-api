#!/usr/bin/env node
/**
 * 扫描源图片目录，生成图片索引与诊断报告。
 *
 *   node scripts/build-index.mjs              扫描并生成索引
 *   node scripts/build-index.mjs --stats-only 只读取现有索引并打印统计，不重新扫描
 *
 * 产出：
 *   data/images.json                      可读索引（纳入 git）
 *   functions/_data/images.generated.js   供 Pages Functions 打包时内嵌的精简索引
 *
 * 设计要点：
 *   - 索引在构建期生成，接口运行时不扫描目录、不调用 GitHub API。
 *   - 索引只记录相对路径，绝不写入本机绝对路径。
 *   - 单张图片出错只记录原因，不会让整次扫描失败。
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { loadConfig, assertSourceExists, PROJECT_ROOT } from './lib/config.mjs';
import { buildIndex, renderReport } from './lib/index-builder.mjs';

const statsOnly = process.argv.includes('--stats-only');

async function main() {
  const config = loadConfig();

  if (statsOnly) {
    if (!existsSync(config.dataFile)) {
      console.error(`找不到索引文件 ${config.dataFile}，请先运行 npm run index`);
      process.exitCode = 1;
      return;
    }
    const index = JSON.parse(readFileSync(config.dataFile, 'utf8'));
    process.stdout.write(renderReport(index, config));
    return;
  }

  assertSourceExists(config);

  console.log(`\n正在扫描 ${config.sourceDir} ...`);
  const started = Date.now();

  const index = await buildIndex(config, {
    onProgress: (done, total) => process.stdout.write(`\r  已扫描 ${done}/${total} 个文件...`),
  });

  process.stdout.write('\r'.padEnd(40) + '\r');
  process.stdout.write(renderReport(index, config));
  console.log(`  扫描 ${index.scannedFiles} 个文件，耗时 ${Date.now() - started}ms`);
  console.log(`  已写入 ${path.relative(PROJECT_ROOT, config.dataFile)}`);
  console.log(`  已写入 ${path.relative(PROJECT_ROOT, config.generatedModule)}`);
  console.log('');
}

main().catch((error) => {
  console.error(`\n索引生成失败：${error.message}\n`);
  process.exit(1);
});
