import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { buildIndex } from '../scripts/lib/index-builder.mjs';
import { syncImages } from '../scripts/lib/sync.mjs';
import { verifyIndex } from '../scripts/lib/verify.mjs';
import { createHandler } from '../functions/_lib/handler.js';
import { createTempProject, makeContext, sequenceRandom } from './helpers.mjs';

const ORIGIN = 'https://api.qingyv.top';

/** 跑完整流水线：生成索引 -> 同步到部署目录 -> 校验 */
async function runPipeline(options = {}) {
  const project = createTempProject(options);
  const index = await buildIndex(project.config, { generatedAt: '2026-01-01T00:00:00.000Z' });
  const sync = await syncImages(project.config);
  const verification = verifyIndex(project.config);
  return { project, index, sync, verification };
}

const full = await runPipeline();
test.after(() => full.project.cleanup());

test('完整流水线（索引 -> 同步 -> 校验）全部通过', () => {
  assert.equal(full.sync.failed.length, 0, `同步失败: ${JSON.stringify(full.sync.failed)}`);
  assert.equal(full.verification.errors.length, 0, `校验失败: ${full.verification.errors.join('; ')}`);
  assert.ok(full.verification.checks.length > 0);
});

test('索引中的每一条路径都对应真实存在的部署文件', () => {
  assert.ok(full.index.images.length > 0);
  for (const image of full.index.images) {
    const deployed = path.join(full.project.config.deployDir, image.sourcePath);
    assert.ok(existsSync(deployed), `部署文件缺失: ${image.path}`);
    assert.ok(statSync(deployed).size > 0, `部署文件为空: ${image.path}`);
  }
});

test('部署目录中不存在索引之外的文件（跳过的样本不会上线）', () => {
  const deployDir = full.project.config.deployDir;
  assert.ok(!existsSync(path.join(deployDir, 'active.svg')), 'SVG 不应出现在部署目录');
  assert.ok(!existsSync(path.join(deployDir, 'truncated.png')), '截断文件不应出现在部署目录');
  assert.ok(!existsSync(path.join(deployDir, 'broken.jpg')), '损坏文件不应出现在部署目录');
  assert.ok(!existsSync(path.join(deployDir, 'notes.txt')), '非图片文件不应出现在部署目录');
});

test('原样复制的部署文件与源文件字节完全一致', () => {
  for (const image of full.index.images) {
    if (image.bytes > full.project.config.optimizeThresholdBytes) continue;
    const source = path.join(full.project.config.sourceDir, image.sourcePath);
    const deployed = path.join(full.project.config.deployDir, image.sourcePath);
    assert.deepEqual(readFileSync(deployed), readFileSync(source), `${image.path} 内容不一致`);
  }
});

test('接口跳转目标与真实部署文件逐一对应（全量遍历）', async () => {
  const entries = full.index.images.map((image) => ({
    p: image.path,
    w: image.width,
    h: image.height,
    o: image.orientation,
  }));
  const { onRequest } = createHandler(entries, {
    randomUint32: sequenceRandom(Array.from({ length: entries.length }, (_, i) => i)),
  });

  const resolved = new Set();
  for (let i = 0; i < entries.length; i += 1) {
    const response = await onRequest(makeContext(`${ORIGIN}/`));
    assert.equal(response.status, 302);
    const location = response.headers.get('Location');
    const url = new URL(location);

    // 用请求域名还原出部署目录中的真实文件路径
    const relative = decodeURIComponent(url.pathname).replace(/^\//, '');
    const deployed = path.join(full.project.config.publicDir, relative);
    assert.ok(existsSync(deployed), `跳转目标不存在: ${location} -> ${deployed}`);
    resolved.add(location);
  }
  assert.equal(resolved.size, entries.length, '应当能覆盖到每一张图片');
});

test('按方向筛选时跳转目标全部真实存在且方向正确', async () => {
  const entries = full.index.images.map((image) => ({
    p: image.path,
    w: image.width,
    h: image.height,
    o: image.orientation,
  }));
  const { onRequest } = createHandler(entries);

  for (const orientation of ['landscape', 'portrait', 'square']) {
    for (let i = 0; i < 20; i += 1) {
      const response = await onRequest(makeContext(`${ORIGIN}/?orientation=${orientation}`));
      assert.equal(response.status, 302, `${orientation} 应当有可用图片`);
      const url = new URL(response.headers.get('Location'));
      const relative = decodeURIComponent(url.pathname).replace(/^\//, '');
      assert.ok(existsSync(path.join(full.project.config.publicDir, relative)));

      const expected = entries.find((entry) => entry.p === relative);
      assert.equal(expected.o, orientation, `返回了方向不符的图片: ${relative}`);
    }
  }
});

test('中文与含空格文件名的图片可以通过跳转地址直接打开', async () => {
  const entries = full.index.images.map((image) => ({
    p: image.path,
    w: image.width,
    h: image.height,
    o: image.orientation,
  }));
  const index = entries.findIndex((entry) => entry.p.includes('示例 图片'));
  assert.ok(index >= 0, '样本中应包含中文文件名图片');

  const { onRequest } = createHandler(entries, { randomUint32: () => index });
  const response = await onRequest(makeContext(`${ORIGIN}/?orientation=landscape`));
  const location = response.headers.get('Location');
  assert.ok(!location.includes(' '));

  const relative = decodeURIComponent(new URL(location).pathname).replace(/^\//, '');
  assert.ok(existsSync(path.join(full.project.config.publicDir, relative)), '中文文件名对应的文件应存在');
});

test('超出体积阈值的图片会生成同尺寸压缩副本，且原图不被修改', async () => {
  const project = createTempProject({
    fixtures: ['landscape.png', 'portrait.png', 'square.png'],
    overrides: { optimizeThresholdBytes: 1200, deployMaxBytes: 8000 },
  });
  try {
    const index = await buildIndex(project.config);
    const sourcesBefore = new Map(
      index.images.map((image) => [
        image.sourcePath,
        readFileSync(path.join(project.config.sourceDir, image.sourcePath)),
      ])
    );

    const sync = await syncImages(project.config);

    assert.ok(sync.optimized.length > 0, '应当有图片被压缩');
    for (const item of sync.optimized) {
      assert.ok(item.to < item.from, `${item.path} 压缩后应更小`);
      assert.ok(item.to <= project.config.deployMaxBytes);
    }
    assert.ok(sync.copied.length > 0, '较小的图片应被原样复制');

    // 源文件必须保持一模一样的字节
    for (const [sourcePath, before] of sourcesBefore) {
      const after = readFileSync(path.join(project.config.sourceDir, sourcePath));
      assert.deepEqual(after, before, `源文件被改动了: ${sourcePath}`);
    }

    // 压缩副本的尺寸必须与索引记录一致
    for (const image of index.images) {
      const deployed = path.join(project.config.deployDir, image.sourcePath);
      if (!existsSync(deployed)) continue;
      const { imageSize } = await import('image-size');
      const meta = imageSize(readFileSync(deployed));
      assert.equal(meta.width, image.width, `${image.path} 压缩后宽度变化`);
      assert.equal(meta.height, image.height, `${image.path} 压缩后高度变化`);
    }

    const verification = verifyIndex(project.config);
    assert.equal(verification.errors.length, 0, verification.errors.join('; '));
  } finally {
    project.cleanup();
  }
});

test('无法压缩的超大图片会被明确报告为同步失败', async () => {
  const project = createTempProject({
    fixtures: ['landscape.bmp'],
    overrides: { optimizeThresholdBytes: 100, deployMaxBytes: 200 },
  });
  try {
    await buildIndex(project.config);
    const sync = await syncImages(project.config);
    assert.equal(sync.failed.length, 1);
    assert.match(sync.failed[0].reason, /bmp/);
    assert.ok(!existsSync(path.join(project.config.deployDir, 'landscape.bmp')));
  } finally {
    project.cleanup();
  }
});

test('索引过期（源文件被删除）时同步会报错而不是静默输出不完整结果', async () => {
  const project = createTempProject({ fixtures: ['landscape.png', 'square.png'] });
  try {
    const { rmSync } = await import('node:fs');
    await buildIndex(project.config);
    rmSync(path.join(project.config.sourceDir, 'square.png'));

    const sync = await syncImages(project.config);
    assert.equal(sync.failed.length, 1);
    assert.match(sync.failed[0].reason, /源文件不存在/);

    const verification = verifyIndex(project.config);
    assert.ok(verification.errors.some((error) => error.includes('源文件全部存在')));
  } finally {
    project.cleanup();
  }
});

test('校验能发现索引与部署目录不一致', async () => {
  const project = createTempProject({ fixtures: ['landscape.png', 'square.png'] });
  try {
    await buildIndex(project.config);
    await syncImages(project.config);

    // 手工塞入一个索引外的文件
    mkdirSync(project.config.deployDir, { recursive: true });
    writeFileSync(path.join(project.config.deployDir, 'sneaky.png'), 'not-in-index');

    const verification = verifyIndex(project.config);
    assert.ok(
      verification.errors.some((error) => error.includes('多余文件')),
      `应报告多余文件，实际: ${verification.errors.join('; ')}`
    );
  } finally {
    project.cleanup();
  }
});
