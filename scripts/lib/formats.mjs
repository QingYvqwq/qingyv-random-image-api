/**
 * 格式与方向相关的纯函数。
 * 这里刻意不引入任何图片解码依赖，方便被测试直接引用。
 */

/** image-size 识别出的格式 -> 标准 MIME 类型 */
export const MIME_BY_FORMAT = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  avif: 'image/avif',
  tiff: 'image/tiff',
};

/** 常见扩展名 -> image-size 格式名，仅用于「扩展名与真实格式是否一致」的告警 */
export const FORMAT_BY_EXTENSION = {
  '.jpg': 'jpg',
  '.jpeg': 'jpg',
  '.jpe': 'jpg',
  '.jfif': 'jpg',
  '.png': 'png',
  '.webp': 'webp',
  '.gif': 'gif',
  '.bmp': 'bmp',
  '.avif': 'avif',
  '.tif': 'tiff',
  '.tiff': 'tiff',
};

/**
 * EXIF 方向值 5/6/7/8 表示图像需要旋转 90 度显示，
 * 此时「显示尺寸」的宽高与文件中存储的像素宽高互换。
 * 2/3/4 是镜像或 180 度旋转，不改变宽高。
 */
export const SWAP_ORIENTATIONS = new Set([5, 6, 7, 8]);

/** 根据宽高判定方向 */
export function orientationOf(width, height) {
  if (width > height) return 'landscape';
  if (height > width) return 'portrait';
  return 'square';
}

/**
 * 结合 EXIF 方向计算用于分类的最终尺寸与方向。
 * @returns {{displayWidth:number, displayHeight:number, orientation:string, rotated:boolean}}
 */
export function resolveDisplaySize(width, height, exifOrientation) {
  const rotated = SWAP_ORIENTATIONS.has(Number(exifOrientation));
  const displayWidth = rotated ? height : width;
  const displayHeight = rotated ? width : height;
  return {
    displayWidth,
    displayHeight,
    orientation: orientationOf(displayWidth, displayHeight),
    rotated,
  };
}

/** 人类可读的体积 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'n/a';
  const mib = bytes / 1048576;
  if (mib >= 1) return `${mib.toFixed(2)} MiB`;
  return `${(bytes / 1024).toFixed(1)} KiB`;
}
