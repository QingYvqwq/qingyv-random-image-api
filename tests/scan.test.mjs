import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex, renderReport } from '../scripts/lib/index-builder.mjs';
import { SKIP_REASONS } from '../scripts/lib/scan.mjs';
import { createTempProject } from './helpers.mjs';

const project = createTempProject();
// 整个文件共用一次扫描结果：25 个样本
const index = await buildIndex(project.config, { generatedAt: '2026-01-01T00:00:00.000Z' });
test.after(() => project.cleanup());

const byPath = new Map(index.images.map((image) => [image.sourcePath, image]));
const skippedByPath = new Map(index.skipped.map((item) => [item.path, item]));

test('扫描不会因为存在损坏文件而整体失败', () => {
  assert.ok(index.images.length > 0);
  assert.ok(index.skipped.length > 0);
  assert.equal(index.images.length + index.skipped.length, index.scannedFiles);
});

test('各格式图片均能被正确识别（不依赖扩展名）', () => {
  const expected = {
    'landscape.png': ['png', 300, 200, 'landscape'],
    'landscape.jpg': ['jpg', 300, 200, 'landscape'],
    'landscape.webp': ['webp', 300, 200, 'landscape'],
    'landscape.gif': ['gif', 300, 200, 'landscape'],
    'landscape.avif': ['avif', 300, 200, 'landscape'],
    'landscape.tiff': ['tiff', 300, 200, 'landscape'],
    'landscape.bmp': ['bmp', 30, 20, 'landscape'],
    'square.png': ['png', 100, 100, 'square'],
    'portrait.png': ['png', 200, 300, 'portrait'],
  };
  for (const [name, [format, width, height, orientation]] of Object.entries(expected)) {
    const image = byPath.get(name);
    assert.ok(image, `${name} 应当被收录`);
    assert.equal(image.format, format, `${name} 格式`);
    assert.equal(image.width, width, `${name} 宽度`);
    assert.equal(image.height, height, `${name} 高度`);
    assert.equal(image.orientation, orientation, `${name} 方向`);
  }
});

test('扩展名与真实内容不一致时以真实内容为准，并给出警告', () => {
  const image = byPath.get('mislabeled.webp');
  assert.ok(image, '内容为 PNG 但扩展名为 .webp 的文件应被收录');
  assert.equal(image.format, 'png');
  assert.ok(
    image.warnings.some((warning) => warning.includes('不一致')),
    '应提示扩展名与真实格式不一致'
  );
  assert.equal(image.mime, 'image/png');
});

test('EXIF 旋转方向会改变分类结果', () => {
  // 存储 300x200 + orientation 6/8 -> 显示 200x300，属于竖屏
  for (const name of ['exif6-stored-landscape.jpg', 'exif8-stored-landscape.jpg']) {
    const image = byPath.get(name);
    assert.ok(image, `${name} 应当被收录`);
    assert.equal(image.storedWidth, 300);
    assert.equal(image.storedHeight, 200);
    assert.equal(image.rotated, true);
    assert.equal(image.width, 200);
    assert.equal(image.height, 300);
    assert.equal(image.orientation, 'portrait', `${name} 旋转后应为竖屏`);
  }

  // 存储 200x300 + orientation 6 -> 显示 300x200，属于横屏
  const flipped = byPath.get('exif6-stored-portrait.jpg');
  assert.equal(flipped.rotated, true);
  assert.equal(flipped.orientation, 'landscape');
  assert.equal(flipped.width, 300);
  assert.equal(flipped.height, 200);

  // orientation=3 只做 180 度旋转，宽高不变
  const rotated180 = byPath.get('exif3-stays-landscape.jpg');
  assert.equal(rotated180.rotated, false);
  assert.equal(rotated180.orientation, 'landscape');
  assert.equal(rotated180.width, 300);
  assert.equal(rotated180.height, 200);
});

test('中文、空格、括号、引号、井号文件名均被正常收录', () => {
  for (const name of [
    '示例 图片 (1).png',
    '带 空格 的 图片.jpg',
    "quote'and#hash.png",
    '中文目录名测试.png',
  ]) {
    const image = byPath.get(name);
    assert.ok(image, `${name} 应当被收录`);
    assert.equal(image.path, `images/${name}`);
    assert.equal(image.orientation, 'landscape');
  }
});

test('损坏、截断、空文件被跳过并记录原因，且不影响其他图片', () => {
  assert.equal(skippedByPath.get('broken.jpg').code, SKIP_REASONS.UNRECOGNIZED);
  assert.equal(skippedByPath.get('notes.txt').code, SKIP_REASONS.UNRECOGNIZED);
  assert.equal(skippedByPath.get('empty.png').code, SKIP_REASONS.UNREADABLE);

  // image-size 只读文件头，这三个文件的头部完好，必须由完整性校验拦下
  for (const name of ['truncated.png', 'truncated.jpg', 'truncated.webp']) {
    const item = skippedByPath.get(name);
    assert.ok(item, `${name} 应当被跳过`);
    assert.equal(item.code, SKIP_REASONS.TRUNCATED, `${name} 的跳过原因`);
    assert.match(item.message, /截断/);
  }
  assert.ok(!byPath.has('truncated.png'), '截断的文件不应进入索引');
});

test('SVG 因可能包含主动内容被安全策略排除', () => {
  const item = skippedByPath.get('active.svg');
  assert.ok(item, 'SVG 应当被跳过');
  assert.equal(item.code, SKIP_REASONS.BLOCKED);
  assert.match(item.message, /主动内容/);
});

test('索引路径均为相对路径，不含本机绝对路径', () => {
  for (const image of index.images) {
    assert.ok(image.path.startsWith('images/'), `路径前缀错误: ${image.path}`);
    assert.ok(!image.path.includes('\\'), `不应出现反斜杠: ${image.path}`);
    assert.ok(!/^[A-Za-z]:/.test(image.path), `不应出现盘符: ${image.path}`);
  }
  const raw = JSON.stringify(index);
  assert.ok(!/[A-Za-z]:\\\\/.test(raw), '索引中不应出现 Windows 绝对路径');
});

test('统计数字与明细一致', () => {
  const { stats } = index;
  assert.equal(stats.total, index.images.length);
  assert.equal(stats.skipped, index.skipped.length);

  const orientationSum =
    stats.byOrientation.landscape + stats.byOrientation.portrait + stats.byOrientation.square;
  assert.equal(orientationSum, stats.total);

  const formatSum = Object.values(stats.byFormat).reduce((a, b) => a + b, 0);
  assert.equal(formatSum, stats.total);

  const byteSum = index.images.reduce((sum, image) => sum + image.bytes, 0);
  assert.equal(stats.totalBytes, byteSum);
});

test('样本集合覆盖三种方向与全部目标格式', () => {
  const { stats } = index;
  assert.ok(stats.byOrientation.landscape > 0);
  assert.ok(stats.byOrientation.portrait > 0);
  assert.ok(stats.byOrientation.square > 0);
  for (const format of ['jpg', 'png', 'webp', 'gif', 'bmp', 'avif', 'tiff']) {
    assert.ok(stats.byFormat[format] > 0, `样本中缺少 ${format} 格式`);
  }
});

test('报告包含总数、格式、方向与跳过明细', () => {
  const report = renderReport(index, project.config);
  assert.match(report, /已收录图片/);
  assert.match(report, /横屏 landscape/);
  assert.match(report, /竖屏 portrait/);
  assert.match(report, /方形 square/);
  assert.match(report, /跳过文件明细/);
  assert.match(report, /truncated-or-corrupt/);
  assert.match(report, /blocked-format/);
});

test('空图片目录也能正常生成索引且不报错', async () => {
  const empty = createTempProject({ fixtures: [] });
  try {
    const emptyIndex = await buildIndex(empty.config);
    assert.equal(emptyIndex.images.length, 0);
    assert.equal(emptyIndex.skipped.length, 0);
    assert.equal(emptyIndex.stats.total, 0);
    const report = renderReport(emptyIndex, empty.config);
    assert.match(report, /索引为空/);
  } finally {
    empty.cleanup();
  }
});
