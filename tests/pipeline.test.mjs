import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { imageSize } from 'image-size';
import { buildIndex } from '../scripts/lib/index-builder.mjs';
import { syncImages } from '../scripts/lib/sync.mjs';
import { verifyIndex } from '../scripts/lib/verify.mjs';
import { createHandler } from '../functions/_lib/handler.js';
import { createTempProject, makeContext, directoryAssets } from './helpers.mjs';

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

/** 用真实部署目录作为 ASSETS 绑定 */
const assets = directoryAssets(full.project.config.publicDir);

const ENTRIES = full.index.images.map((image) => ({
  p: image.path,
  w: image.width,
  h: image.height,
  o: image.orientation,
}));

function contextFor(query = '') {
  return makeContext(`${ORIGIN}/${query}`, 'GET', { ASSETS: assets });
}

function deployedPath(entryPath) {
  return path.join(full.project.config.publicDir, entryPath);
}

test('完整流水线（索引 -> 同步 -> 校验）全部通过', () => {
  assert.equal(full.sync.failed.length, 0, `同步失败: ${JSON.stringify(full.sync.failed)}`);
  assert.equal(full.verification.errors.length, 0, `校验失败: ${full.verification.errors.join('; ')}`);
  assert.ok(full.verification.checks.length > 0);
});

test('索引中的每一条路径都对应真实存在的部署文件', () => {
  assert.ok(full.index.images.length > 0);
  for (const image of full.index.images) {
    const deployed = deployedPath(image.path);
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
    const deployed = deployedPath(image.path);
    assert.deepEqual(readFileSync(deployed), readFileSync(source), `${image.path} 内容不一致`);
  }
});

test('接口返回的图片字节与部署文件逐字节一致（逐张指定抽取）', async () => {
  // 注意：样本里有多张内容完全相同的图片（同一张纯色 PNG），
  // 所以不能用「按内容反查」来判定，必须用确定的随机源锁定索引下标。
  for (let i = 0; i < ENTRIES.length; i += 1) {
    const { onRequest } = createHandler(ENTRIES, { randomUint32: () => i });
    const response = await onRequest(contextFor());
    assert.equal(response.status, 200, `抽取第 ${i} 张时失败`);

    const body = Buffer.from(await response.arrayBuffer());
    assert.deepEqual(body, readFileSync(deployedPath(ENTRIES[i].p)), `${ENTRIES[i].p} 字节不一致`);
  }
});

test('指定方向时返回的图片方向全部正确（逐张校验）', async () => {
  for (const orientation of ['landscape', 'portrait', 'square']) {
    const pool = ENTRIES.filter((entry) => entry.o === orientation);
    assert.ok(pool.length > 0, `${orientation} 应当有可用图片`);

    for (let i = 0; i < pool.length; i += 1) {
      const { onRequest } = createHandler(ENTRIES, { randomUint32: () => i });
      const response = await onRequest(contextFor(`?orientation=${orientation}`));
      assert.equal(response.status, 200);

      const body = Buffer.from(await response.arrayBuffer());
      assert.deepEqual(
        body,
        readFileSync(deployedPath(pool[i].p)),
        `?orientation=${orientation} 返回了第 ${i} 张，与预期的 ${pool[i].p} 不符`
      );
      assert.equal(pool[i].o, orientation);
    }
  }
});

test('中文与含空格文件名的图片可以正常返回', async () => {
  const landscapePool = ENTRIES.filter((entry) => entry.o === 'landscape');
  const index = landscapePool.findIndex((entry) => entry.p.includes('示例 图片'));
  assert.ok(index >= 0, '样本中应包含中文文件名图片');

  const { onRequest } = createHandler(ENTRIES, { randomUint32: () => index });
  const response = await onRequest(contextFor('?orientation=landscape'));
  assert.equal(response.status, 200);

  const body = Buffer.from(await response.arrayBuffer());
  assert.deepEqual(body, readFileSync(deployedPath(landscapePool[index].p)));
});

test('响应头不会泄露静态资源自带的长缓存（否则刷新换不了图）', async () => {
  const { onRequest } = createHandler(ENTRIES, () => 0);
  const response = await onRequest(contextFor());
  assert.equal(response.headers.get('Cache-Control'), 'no-store, max-age=0, must-revalidate');
  assert.equal(response.headers.get('Location'), null);
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
