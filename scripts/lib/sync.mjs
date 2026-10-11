import { mkdirSync, copyFileSync, writeFileSync, rmSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { formatBytes } from './formats.mjs';

async function defaultLoadSharp() {
  try {
    return (await import('sharp')).default;
  } catch (error) {
    throw new Error(`需要 sharp 才能为超大图片生成压缩副本，但加载失败：${error.message}`);
  }
}

/** 按格式选择重新编码参数；返回 null 表示 sharp 无法处理该格式。 */
async function encodeWith(sharp, absSource, format, quality) {
  const animated = format === 'gif' || format === 'webp';
  // .rotate() 无参数表示依据 EXIF 自动摆正，把旋转烘焙进像素，
  // 这样压缩副本去掉 EXIF 后显示方向依然正确。
  const pipeline = sharp(absSource, { animated }).rotate();
  switch (format) {
    case 'jpg':
      return pipeline.jpeg({ quality, mozjpeg: true }).toBuffer();
    case 'png':
      return pipeline
        .png({ compressionLevel: 9, effort: 10, palette: true, quality, colours: 256 })
        .toBuffer();
    case 'webp':
      return pipeline.webp({ quality, effort: 6 }).toBuffer();
    case 'avif':
      return pipeline.avif({ quality, effort: 4 }).toBuffer();
    case 'gif':
      return pipeline.gif({ effort: 7 }).toBuffer();
    case 'tiff':
      return pipeline.tiff({ quality, compression: 'deflate' }).toBuffer();
    default:
      return null;
  }
}

async function optimizeImage(sharp, absSource, image, config) {
  let best = null;
  for (const quality of config.optimizeQualityLadder) {
    const buffer = await encodeWith(sharp, absSource, image.format, quality);
    if (!buffer) return { ok: false, reason: `sharp 不支持重新编码 ${image.format} 格式` };
    if (!best || buffer.length < best.buffer.length) best = { buffer, quality };
    if (buffer.length <= config.optimizeThresholdBytes) {
      return { ok: true, buffer, quality };
    }
  }
  if (best && best.buffer.length <= config.deployMaxBytes) {
    return { ok: true, buffer: best.buffer, quality: best.quality };
  }
  return {
    ok: false,
    reason:
      `已在质量档位 ${config.optimizeQualityLadder.join('/')} 全部尝试，最小体积仍为 ` +
      `${formatBytes(best ? best.buffer.length : 0)}`,
  };
}

/**
 * 把索引中的图片同步到 public/<urlPrefix>/。
 * 未被索引的文件绝不会被写入，因此部署目录内容与索引严格一致。
 *
 * @returns {Promise<{deployDir:string, copied:Array, optimized:Array, failed:Array, totalBytes:number}>}
 */
export async function syncImages(config, { loadSharp = defaultLoadSharp } = {}) {
  const { readFileSync } = await import('node:fs');
  if (!existsSync(config.dataFile)) {
    throw new Error(`找不到图片索引 ${config.dataFile}，请先运行 npm run index`);
  }
  const index = JSON.parse(readFileSync(config.dataFile, 'utf8'));
  const images = index.images ?? [];

  // 安全边界：只允许清理 public/ 内部我们自己的部署目录
  const resolvedDeploy = path.resolve(config.deployDir);
  if (resolvedDeploy === path.resolve(config.publicDir) ||
      !resolvedDeploy.startsWith(path.resolve(config.publicDir) + path.sep)) {
    throw new Error(`拒绝操作：部署目录 ${resolvedDeploy} 不是 public/ 下的子目录`);
  }

  rmSync(resolvedDeploy, { recursive: true, force: true });
  mkdirSync(resolvedDeploy, { recursive: true });

  const copied = [];
  const optimized = [];
  const failed = [];
  let totalBytes = 0;

  const needOptimize = images.filter((image) => image.bytes > config.optimizeThresholdBytes);
  const sharp = needOptimize.length > 0 ? await loadSharp() : null;

  for (const image of images) {
    const absSource = path.join(config.sourceDir, image.sourcePath);
    const absDest = path.join(resolvedDeploy, image.sourcePath);
    mkdirSync(path.dirname(absDest), { recursive: true });

    if (!existsSync(absSource)) {
      failed.push({ path: image.path, reason: '源文件不存在，索引可能已过期，请重新运行 npm run index' });
      continue;
    }

    if (image.bytes <= config.optimizeThresholdBytes) {
      copyFileSync(absSource, absDest);
      const size = statSync(absDest).size;
      if (size !== image.bytes) {
        failed.push({ path: image.path, reason: `复制后体积不一致 (${size} != ${image.bytes})` });
        continue;
      }
      copied.push(image.path);
      totalBytes += size;
      continue;
    }

    const result = await optimizeImage(sharp, absSource, image, config);
    if (!result.ok) {
      failed.push({ path: image.path, reason: result.reason });
      continue;
    }
    if (result.buffer.length > config.deployMaxBytes) {
      failed.push({
        path: image.path,
        reason: `压缩后仍为 ${formatBytes(result.buffer.length)}，超过 Pages 单文件硬上限`,
      });
      continue;
    }

    const meta = await sharp(result.buffer).metadata();
    if (meta.width !== image.width || meta.height !== image.height) {
      failed.push({
        path: image.path,
        reason: `压缩后尺寸变为 ${meta.width}x${meta.height}，与索引的 ${image.width}x${image.height} 不一致`,
      });
      continue;
    }

    writeFileSync(absDest, result.buffer);
    optimized.push({
      path: image.path,
      from: image.bytes,
      to: result.buffer.length,
      quality: result.quality,
    });
    totalBytes += result.buffer.length;
  }

  return { deployDir: resolvedDeploy, copied, optimized, failed, totalBytes };
}
