#!/usr/bin/env node
/**
 * 把索引中的有效图片同步到部署目录 public/<urlPrefix>/。
 *
 *   node scripts/sync-images.mjs
 *
 * 行为：
 *   - 体积正常的图片：字节级原样复制，不做任何修改。
 *   - 超过 optimizeThresholdBytes 的图片：在部署目录生成「同尺寸、低质量」的压缩副本，
 *     源目录中的原图保持不变，用于规避 Cloudflare Pages 25 MiB 的单文件硬上限。
 *   - 未被索引的文件（损坏、SVG、不支持格式）绝不会出现在部署目录，
 *     因此部署内容与索引始终严格一致。
 */
import path from 'node:path';
import { loadConfig, assertSourceExists, PROJECT_ROOT } from './lib/config.mjs';
import { syncImages } from './lib/sync.mjs';
import { formatBytes } from './lib/formats.mjs';

const SEPARATOR = '─'.repeat(64);

async function main() {
  const config = loadConfig();
  assertSourceExists(config);

  const result = await syncImages(config);

  console.log('');
  console.log(SEPARATOR);
  console.log('  同步图片到部署目录');
  console.log(SEPARATOR);
  console.log(`  输出目录      : ${path.relative(PROJECT_ROOT, result.deployDir)}`);
  console.log(`  原样复制      : ${result.copied.length}`);
  console.log(`  压缩副本      : ${result.optimized.length}`);
  console.log(`  失败          : ${result.failed.length}`);
  console.log(`  部署总容量    : ${formatBytes(result.totalBytes)}`);

  if (result.optimized.length > 0) {
    console.log('');
    console.log('  【压缩明细】原图保持不变，仅部署副本被重新编码');
    for (const item of result.optimized) {
      console.log(
        `    - ${item.path}  ${formatBytes(item.from)} -> ${formatBytes(item.to)} (质量 ${item.quality})`
      );
    }
  }

  if (result.failed.length > 0) {
    console.log('');
    console.log('  【失败明细】');
    for (const item of result.failed) {
      console.log(`    - ${item.path} — ${item.reason}`);
    }
  }

  console.log(SEPARATOR);
  console.log('');

  if (result.failed.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`\n同步失败：${error.message}\n`);
  process.exit(1);
});
