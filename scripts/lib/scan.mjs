import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { imageSize } from 'image-size';
import { MIME_BY_FORMAT, FORMAT_BY_EXTENSION, resolveDisplaySize } from './formats.mjs';
import { checkIntegrity } from './integrity.mjs';

/** 跳过原因代码，供报告与测试断言使用 */
export const SKIP_REASONS = {
  TOO_LARGE_TO_SCAN: 'too-large-to-scan',
  UNREADABLE: 'unreadable',
  UNRECOGNIZED: 'unrecognized-format',
  TRUNCATED: 'truncated-or-corrupt',
  BLOCKED: 'blocked-format',
  UNSUPPORTED: 'unsupported-format',
  INVALID_DIMENSIONS: 'invalid-dimensions',
};

/**
 * 递归收集候选文件。
 * 不按扩展名过滤——是否真的是图片完全交给内容嗅探决定，
 * 因此改错扩展名的图片同样能被正确识别。
 */
export async function collectFiles(dir, { root = dir, excludeDirs = [] } = {}) {
  const excluded = new Set(excludeDirs);
  const found = [];

  async function walk(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      found.push({
        absPath: current,
        relPath: path.relative(root, current),
        skip: { code: SKIP_REASONS.UNREADABLE, message: `无法读取目录: ${error.message}` },
      });
      return;
    }

    for (const entry of entries) {
      const absPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (excluded.has(entry.name)) continue;
        await walk(absPath);
      } else if (entry.isFile()) {
        if (entry.name.startsWith('.')) continue;
        found.push({ absPath, relPath: path.relative(root, absPath) });
      }
    }
  }

  await walk(dir);
  found.sort((a, b) => a.relPath.localeCompare(b.relPath, 'en'));
  return found;
}

/**
 * 识别单个文件。
 * 任何异常都会被转换成 { skip } 而不是抛出，保证一张坏图片不会中断整次扫描。
 */
export async function inspectFile(absPath, relPath, config) {
  const ext = path.extname(relPath).toLowerCase();

  let info;
  try {
    info = await stat(absPath);
  } catch (error) {
    return { relPath, skip: { code: SKIP_REASONS.UNREADABLE, message: error.message } };
  }
  const bytes = info.size;

  if (bytes === 0) {
    return { relPath, bytes, skip: { code: SKIP_REASONS.UNREADABLE, message: '空文件' } };
  }
  if (bytes > config.maxScanBytes) {
    return {
      relPath,
      bytes,
      skip: {
        code: SKIP_REASONS.TOO_LARGE_TO_SCAN,
        message: `超过扫描上限 ${config.maxScanBytes} 字节，未读取识别`,
      },
    };
  }

  let buffer;
  try {
    buffer = await readFile(absPath);
  } catch (error) {
    return { relPath, bytes, skip: { code: SKIP_REASONS.UNREADABLE, message: error.message } };
  }

  let meta;
  try {
    // image-size 依据文件头 magic bytes 判断真实格式，不读取完整像素数据。
    meta = imageSize(buffer);
  } catch (error) {
    return {
      relPath,
      bytes,
      skip: {
        code: SKIP_REASONS.UNRECOGNIZED,
        message: `无法识别为受支持的图片: ${error.message}`,
      },
    };
  }

  const format = meta?.type;
  if (!format) {
    return {
      relPath,
      bytes,
      skip: { code: SKIP_REASONS.UNRECOGNIZED, message: '文件头未给出可识别的图片格式' },
    };
  }
  if (config.blockedFormats.includes(format)) {
    return {
      relPath,
      bytes,
      format,
      skip: {
        code: SKIP_REASONS.BLOCKED,
        message: `格式 ${format} 可包含主动内容（脚本/外链），已被安全策略排除`,
      },
    };
  }
  if (!config.allowedFormats.includes(format)) {
    return {
      relPath,
      bytes,
      format,
      skip: {
        code: SKIP_REASONS.UNSUPPORTED,
        message: `格式 ${format} 不在允许列表 [${config.allowedFormats.join(', ')}] 中`,
      },
    };
  }

  // image-size 只看文件头，被截断的文件会被它当成正常图片，这里补一次廉价校验
  const integrityProblem = checkIntegrity(buffer, format);
  if (integrityProblem) {
    return {
      relPath,
      bytes,
      format,
      skip: { code: SKIP_REASONS.TRUNCATED, message: integrityProblem },
    };
  }

  const width = Number(meta.width);
  const height = Number(meta.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return {
      relPath,
      bytes,
      format,
      skip: {
        code: SKIP_REASONS.INVALID_DIMENSIONS,
        message: `读取到的尺寸无效: ${meta.width}x${meta.height}`,
      },
    };
  }

  const exifOrientation = Number.isFinite(Number(meta.orientation)) ? Number(meta.orientation) : 1;
  const { displayWidth, displayHeight, orientation, rotated } = resolveDisplaySize(
    width,
    height,
    exifOrientation
  );

  const expected = FORMAT_BY_EXTENSION[ext];
  const warnings = [];
  if (!expected) {
    warnings.push(`扩展名 "${ext || '(无)'}" 不是常见图片扩展名，但内容已确认为 ${format}`);
  } else if (expected !== format) {
    warnings.push(
      `扩展名 ${ext} 与真实格式 ${format} 不一致，部署后 Content-Type 可能不准确`
    );
  }

  return {
    relPath,
    bytes,
    image: {
      format,
      mime: MIME_BY_FORMAT[format] ?? 'application/octet-stream',
      width,
      height,
      exifOrientation,
      displayWidth,
      displayHeight,
      orientation,
      rotated,
      bytes,
      warnings,
    },
  };
}

/**
 * 扫描整个源目录并汇总。
 * @returns {{images:Array, skipped:Array, scanned:number, totalBytes:number}}
 */
export async function scanDirectory(config, { onProgress } = {}) {
  const files = await collectFiles(config.sourceDir, {
    root: config.sourceDir,
    excludeDirs: config.excludeDirs,
  });

  const images = [];
  const skipped = [];
  let totalBytes = 0;
  let index = 0;

  for (const file of files) {
    index += 1;
    if (onProgress && index % 50 === 0) onProgress(index, files.length);

    const relPosix = file.relPath.split(path.sep).join('/');

    if (file.skip) {
      skipped.push({ path: relPosix, bytes: 0, code: file.skip.code, message: file.skip.message });
      continue;
    }

    const result = await inspectFile(file.absPath, file.relPath, config);
    if (result.skip) {
      skipped.push({
        path: relPosix,
        bytes: result.bytes ?? 0,
        code: result.skip.code,
        message: result.skip.message,
      });
      continue;
    }

    const image = result.image;
    totalBytes += image.bytes;
    images.push({
      path: `${config.urlPrefix}/${relPosix}`,
      sourcePath: relPosix,
      format: image.format,
      mime: image.mime,
      width: image.displayWidth,
      height: image.displayHeight,
      storedWidth: image.width,
      storedHeight: image.height,
      exifOrientation: image.exifOrientation,
      rotated: image.rotated,
      orientation: image.orientation,
      bytes: image.bytes,
      warnings: image.warnings,
    });
  }

  images.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  skipped.sort((a, b) => a.path.localeCompare(b.path, 'en'));

  return { images, skipped, scanned: files.length, totalBytes };
}

/** 汇总统计信息 */
export function summarize(images, skipped, totalBytes) {
  const byFormat = {};
  const byOrientation = { landscape: 0, portrait: 0, square: 0 };
  const byExtension = {};
  const warnings = [];
  let largest = null;

  for (const image of images) {
    byFormat[image.format] = (byFormat[image.format] ?? 0) + 1;
    byOrientation[image.orientation] += 1;
    const ext = image.sourcePath.includes('.')
      ? image.sourcePath.slice(image.sourcePath.lastIndexOf('.')).toLowerCase()
      : '(无扩展名)';
    byExtension[ext] = (byExtension[ext] ?? 0) + 1;
    if (!largest || image.bytes > largest.bytes) largest = image;
    for (const warning of image.warnings) warnings.push({ path: image.path, message: warning });
  }

  const skippedByCode = {};
  for (const item of skipped) {
    skippedByCode[item.code] = (skippedByCode[item.code] ?? 0) + 1;
  }

  return {
    total: images.length,
    skipped: skipped.length,
    totalBytes,
    byFormat,
    byOrientation,
    byExtension,
    skippedByCode,
    warnings,
    largest: largest
      ? { path: largest.path, bytes: largest.bytes, format: largest.format }
      : null,
  };
}
