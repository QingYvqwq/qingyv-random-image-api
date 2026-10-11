#!/usr/bin/env node
/**
 * 生成测试用的小体积图片样本，写入 tests/fixtures/。
 * 这些样本是测试用例的输入，已随仓库提交；仅在需要重建时运行：
 *   npm run fixtures
 *
 * 覆盖场景：多种格式、三种方向、EXIF 旋转、中文/空格/括号文件名、
 *          损坏文件、截断文件、空文件、扩展名与内容不一致、非图片文件、SVG。
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from './lib/config.mjs';

const OUT = path.join(PROJECT_ROOT, 'tests', 'fixtures');

const sharp = (await import('sharp')).default;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const solid = (width, height, color) =>
  sharp({ create: { width, height, channels: 3, background: color } });

const red = { r: 200, g: 60, b: 60 };
const blue = { r: 60, g: 60, b: 200 };

async function write(name, buffer) {
  writeFileSync(path.join(OUT, name), buffer);
  console.log(`  ${name.padEnd(34)} ${String(buffer.length).padStart(7)} 字节`);
}

console.log(`生成测试样本到 ${path.relative(PROJECT_ROOT, OUT)}`);

// —— 横向 300x200，覆盖各格式 ——
const wide = solid(300, 200, red);
await write('landscape.png', await wide.clone().png().toBuffer());
await write('landscape.jpg', await wide.clone().jpeg().toBuffer());
await write('landscape.webp', await wide.clone().webp().toBuffer());
await write('landscape.gif', await wide.clone().gif().toBuffer());
await write('landscape.avif', await wide.clone().avif().toBuffer());
await write('landscape.tiff', await wide.clone().tiff().toBuffer());

// —— 方形与竖向 ——
await write('square.png', await solid(100, 100, red).png().toBuffer());
await write('portrait.png', await solid(200, 300, blue).png().toBuffer());

// —— 手写 BMP（30x20 横向）：sharp 无法输出 BMP，因此手工构造 ——
function makeBmp(width, height) {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const pixels = Buffer.alloc(rowSize * height, 0x66);
  const header = Buffer.alloc(54);
  header.write('BM', 0, 'ascii');
  header.writeUInt32LE(54 + pixels.length, 2);
  header.writeUInt32LE(54, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(width, 18);
  header.writeInt32LE(height, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(24, 28);
  header.writeUInt32LE(pixels.length, 34);
  header.writeInt32LE(2835, 38);
  header.writeInt32LE(2835, 42);
  return Buffer.concat([header, pixels]);
}
await write('landscape.bmp', makeBmp(30, 20));

// —— EXIF 方向 ——
// 存储像素为 300x200，orientation=6/8 表示显示时旋转 90 度，实际显示为 200x300 竖屏
await write(
  'exif6-stored-landscape.jpg',
  await wide.clone().withMetadata({ orientation: 6 }).jpeg().toBuffer()
);
await write(
  'exif8-stored-landscape.jpg',
  await wide.clone().withMetadata({ orientation: 8 }).jpeg().toBuffer()
);
// orientation=3 只做 180 度旋转，宽高不变，仍是横屏
await write(
  'exif3-stays-landscape.jpg',
  await wide.clone().withMetadata({ orientation: 3 }).jpeg().toBuffer()
);
// 存储像素为 200x300 的竖图 + orientation=6 -> 显示为 300x200 横屏
await write(
  'exif6-stored-portrait.jpg',
  await solid(200, 300, blue).clone().withMetadata({ orientation: 6 }).jpeg().toBuffer()
);

// —— 中文、空格、括号、特殊字符文件名 ——
await write('示例 图片 (1).png', await wide.clone().png().toBuffer());
await write('带 空格 的 图片.jpg', await wide.clone().jpeg().toBuffer());
await write("quote'and#hash.png", await wide.clone().png().toBuffer());
await write('中文目录名测试.png', await wide.clone().png().toBuffer());

// —— 异常样本 ——
const pngBuffer = await wide.clone().png().toBuffer();
const jpgBuffer = await wide.clone().jpeg().toBuffer();
const webpBuffer = await wide.clone().webp().toBuffer();

await write('broken.jpg', Buffer.from('这不是图片，只是一段文本内容。'));
// 只保留文件头、去掉结束标记：image-size 仍能读出尺寸，必须靠完整性校验拦下
await write('truncated.png', pngBuffer.subarray(0, 40));
await write('truncated.jpg', jpgBuffer.subarray(0, jpgBuffer.length - 2));
// 保留完整 RIFF 头但声明了远超实际文件的长度
const badWebp = Buffer.from(webpBuffer);
badWebp.writeUInt32LE(webpBuffer.length * 8, 4);
await write('truncated.webp', badWebp);
await write('empty.png', Buffer.alloc(0));
await write('mislabeled.webp', pngBuffer); // 内容是 PNG，扩展名却是 .webp
await write('notes.txt', Buffer.from('普通文本文件，不是图片。'));
await write(
  'active.svg',
  Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200">' +
      '<script>alert(document.domain)</script></svg>'
  )
);

console.log('完成。');
