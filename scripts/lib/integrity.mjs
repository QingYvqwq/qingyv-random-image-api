/**
 * 轻量文件完整性校验。
 *
 * image-size 只读取文件头，因此「头部完好但文件被截断」的图片会被它当成正常图片。
 * 这里用各格式自带的长度字段或结束标记做一次廉价校验，把明显截断/损坏的文件挡在索引之外。
 *
 * 校验原则：只判定「确定的截断」，不做激进推断，避免把正常图片误判成损坏。
 *   - 容器的声明长度大于实际文件长度 -> 一定被截断。
 *   - 缺少结束标记 -> 一定不完整。
 * 反之（声明长度小于实际长度，即尾部有多余数据）视为正常，不报错。
 *
 * 已知范围：avif / tiff 没有廉价可靠的整文件长度校验手段，此处不做判定，
 * 仅依赖 image-size 的头部解析。这一点在 README 中有明确说明。
 */

const READ_TAIL = 64;

function tailContains(buffer, signature) {
  const start = Math.max(0, buffer.length - READ_TAIL);
  const tail = buffer.subarray(start);
  outer: for (let i = 0; i + signature.length <= tail.length; i += 1) {
    for (let j = 0; j < signature.length; j += 1) {
      if (tail[i + j] !== signature[j]) continue outer;
    }
    return true;
  }
  return false;
}

const IEND = Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]); // "IEND" + CRC
const EOI = Buffer.from([0xff, 0xd9]); // JPEG 结束标记

const CHECKS = {
  png(buffer) {
    if (buffer.length < 8 || buffer.readUInt32BE(0) !== 0x89504e47) {
      return 'PNG 文件头不完整';
    }
    if (!tailContains(buffer, IEND)) return 'PNG 缺少 IEND 结束块，文件被截断';
    return null;
  },

  jpg(buffer) {
    if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
      return 'JPEG 文件头不完整';
    }
    if (!tailContains(buffer, EOI)) return 'JPEG 缺少 EOI 结束标记，文件被截断';
    return null;
  },

  gif(buffer) {
    if (buffer.length < 14) return 'GIF 文件过短';
    const header = buffer.subarray(0, 6).toString('latin1');
    if (header !== 'GIF87a' && header !== 'GIF89a') return 'GIF 文件头无效';
    // 0x3B 是 GIF 的 trailer
    if (buffer[buffer.length - 1] !== 0x3b && !buffer.subarray(-READ_TAIL).includes(0x3b)) {
      return 'GIF 缺少 trailer 结束标记，文件被截断';
    }
    return null;
  },

  webp(buffer) {
    if (buffer.length < 16) return 'WebP 文件过短';
    if (buffer.subarray(0, 4).toString('latin1') !== 'RIFF') return 'WebP 缺少 RIFF 头';
    if (buffer.subarray(8, 12).toString('latin1') !== 'WEBP') return 'WebP 缺少 WEBP 标识';
    const declared = buffer.readUInt32LE(4) + 8;
    if (declared > buffer.length) {
      return `WebP 声明长度 ${declared} 字节，实际只有 ${buffer.length} 字节，文件被截断`;
    }
    return null;
  },

  bmp(buffer) {
    if (buffer.length < 14) return 'BMP 文件过短';
    if (buffer.subarray(0, 2).toString('latin1') !== 'BM') return 'BMP 缺少 BM 头';
    const declared = buffer.readUInt32LE(2);
    if (declared > buffer.length) {
      return `BMP 声明长度 ${declared} 字节，实际只有 ${buffer.length} 字节，文件被截断`;
    }
    return null;
  },
};

/**
 * @returns {string|null} 问题描述；null 表示通过（或该格式不支持校验）
 */
export function checkIntegrity(buffer, format) {
  const check = CHECKS[format];
  if (!check) return null;
  try {
    return check(buffer);
  } catch (error) {
    return `完整性校验无法完成: ${error.message}`;
  }
}
