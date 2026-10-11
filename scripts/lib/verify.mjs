import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { orientationOf } from './formats.mjs';

/** 递归列出目录下所有文件，返回相对 root 的 posix 路径 */
export function listFiles(dir, root = dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(abs, root));
    else if (entry.isFile()) out.push(path.relative(root, abs).split(path.sep).join('/'));
  }
  return out;
}

/**
 * 校验索引与磁盘的一致性。
 * @returns {{checks:Array<{name:string,ok:boolean,detail:string}>, errors:string[], warnings:string[]}}
 */
export function verifyIndex(config) {
  const checks = [];
  const errors = [];
  const warnings = [];

  const check = (name, condition, detail = '') => {
    const ok = Boolean(condition);
    checks.push({ name, ok, detail });
    if (!ok) errors.push(`${name}: ${detail}`);
  };

  check('索引文件存在', existsSync(config.dataFile), config.dataFile);
  if (!existsSync(config.dataFile)) return { checks, errors, warnings };

  const index = JSON.parse(readFileSync(config.dataFile, 'utf8'));
  const images = index.images ?? [];
  const skipped = index.skipped ?? [];
  const raw = JSON.stringify(index);

  // 1. 绝不泄露本机绝对路径
  const badPaths = images.filter(
    (image) =>
      typeof image.path !== 'string' ||
      /^[A-Za-z]:/.test(image.path) ||
      image.path.startsWith('/') ||
      image.path.includes('\\')
  );
  check('索引路径均为安全相对路径', badPaths.length === 0, `${badPaths.length} 条异常`);
  check(
    '索引全文不含盘符/反斜杠绝对路径',
    !/"[^"]*[A-Za-z]:[\\/]/.test(raw) && !raw.includes('\\\\'),
    '检测到疑似本机绝对路径'
  );
  check(
    '索引路径前缀正确',
    images.every((image) => image.path.startsWith(`${config.urlPrefix}/`)),
    `应全部以 "${config.urlPrefix}/" 开头`
  );

  // 2. 无重复
  const seen = new Set();
  const duplicates = [];
  for (const image of images) {
    if (seen.has(image.path)) duplicates.push(image.path);
    seen.add(image.path);
  }
  check('索引无重复路径', duplicates.length === 0, duplicates.slice(0, 5).join(', '));

  // 3. 源文件真实存在
  const missingSource = images
    .filter((image) => !existsSync(path.join(config.sourceDir, image.sourcePath)))
    .map((image) => image.path);
  check(
    '索引中的源文件全部存在',
    missingSource.length === 0,
    `缺失 ${missingSource.length} 个: ${missingSource.slice(0, 5).join(', ')}`
  );

  // 4. 尺寸 / 方向自洽
  const badOrientation = images.filter(
    (image) => image.orientation !== orientationOf(image.width, image.height)
  );
  check('方向与宽高自洽', badOrientation.length === 0, `${badOrientation.length} 条不一致`);

  const invalid = images.filter(
    (image) =>
      !['landscape', 'portrait', 'square'].includes(image.orientation) ||
      !Number.isInteger(image.width) ||
      !Number.isInteger(image.height) ||
      image.width <= 0 ||
      image.height <= 0
  );
  check('尺寸与方向取值合法', invalid.length === 0, `${invalid.length} 条非法`);

  // 5. 生成模块与索引同步
  if (existsSync(config.generatedModule)) {
    const source = readFileSync(config.generatedModule, 'utf8');
    const moduleCount = (source.match(/\{ p: /g) ?? []).length;
    check(
      '函数内嵌索引条数与索引一致',
      moduleCount === images.length,
      `模块 ${moduleCount} 条 vs 索引 ${images.length} 条`
    );
    const missing = images.filter((image) => !source.includes(JSON.stringify(image.path)));
    check('函数内嵌索引覆盖全部路径', missing.length === 0, `缺失 ${missing.length} 条`);
  } else {
    check('函数内嵌索引文件存在', false, path.relative(config.root, config.generatedModule));
  }

  // 6. 部署目录与索引严格一致
  if (!existsSync(config.deployDir)) {
    warnings.push(
      `部署目录 ${path.relative(config.root, config.deployDir)} 不存在，已跳过部署一致性校验（运行 npm run build 生成）`
    );
  } else {
    const deployed = new Set(listFiles(config.deployDir));
    const missingDeploy = images.filter((image) => !deployed.has(image.sourcePath));
    check(
      '索引中的图片全部已部署',
      missingDeploy.length === 0,
      `缺失 ${missingDeploy.length} 个: ${missingDeploy.slice(0, 5).map((i) => i.path).join(', ')}`
    );

    const indexedSources = new Set(images.map((image) => image.sourcePath));
    const extra = [...deployed].filter((file) => !indexedSources.has(file));
    check('部署目录没有索引外的多余文件', extra.length === 0, `${extra.slice(0, 5).join(', ')}`);

    const oversized = [];
    for (const image of images) {
      const abs = path.join(config.deployDir, image.sourcePath);
      if (!existsSync(abs)) continue;
      const size = statSync(abs).size;
      if (size > config.deployMaxBytes) oversized.push(`${image.path} (${size})`);
    }
    check(
      `部署文件均未超过单文件上限 ${config.deployMaxBytes} 字节`,
      oversized.length === 0,
      oversized.slice(0, 5).join(', ')
    );

    const mismatch = [];
    for (const image of images) {
      const abs = path.join(config.deployDir, image.sourcePath);
      if (!existsSync(abs)) continue;
      const size = statSync(abs).size;
      // 原样复制的文件体积必须与源文件完全相同；压缩副本只会更小
      if (image.bytes <= config.optimizeThresholdBytes && size !== image.bytes) {
        mismatch.push(`${image.path} (${size} != ${image.bytes})`);
      }
    }
    check('原样复制的文件体积与源文件一致', mismatch.length === 0, mismatch.slice(0, 5).join(', '));
  }

  // 7. 统计与明细一致
  if (index.stats) {
    check('统计的图片总数与明细一致', index.stats.total === images.length, `${index.stats.total} vs ${images.length}`);
    check('统计的跳过数与明细一致', index.stats.skipped === skipped.length, `${index.stats.skipped} vs ${skipped.length}`);
    const sum = Object.values(index.stats.byOrientation).reduce((a, b) => a + b, 0);
    check('方向统计之和等于图片总数', sum === images.length, `${sum} vs ${images.length}`);
  }

  return { checks, errors, warnings };
}
