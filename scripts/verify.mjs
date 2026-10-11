#!/usr/bin/env node
/**
 * 校验索引与磁盘的一致性。存在问题时退出码为 1。
 *
 *   node scripts/verify.mjs
 */
import { loadConfig } from './lib/config.mjs';
import { verifyIndex } from './lib/verify.mjs';

const SEPARATOR = '─'.repeat(64);

try {
  const config = loadConfig();
  const { checks, errors, warnings } = verifyIndex(config);

  console.log('');
  console.log(SEPARATOR);
  console.log('  索引一致性校验');
  console.log(SEPARATOR);
  for (const item of checks) {
    console.log(`  ${item.ok ? '✓' : '✗'} ${item.name}${item.ok ? '' : `  → ${item.detail}`}`);
  }
  for (const warning of warnings) {
    console.log(`  ! ${warning}`);
  }
  console.log(SEPARATOR);
  if (errors.length === 0) {
    console.log(`  全部 ${checks.length} 项校验通过`);
  } else {
    console.log(`  ${errors.length} 项校验失败`);
    process.exitCode = 1;
  }
  console.log('');
} catch (error) {
  console.error(`\n校验无法执行：${error.message}\n`);
  process.exit(1);
}
