import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../scripts/lib/config.mjs';
import { onRequest } from '../functions/index.js';
import images from '../functions/_data/images.generated.js';
import { makeContext } from './helpers.mjs';

const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');

test('public/ 下没有 index.html，根路径不会被静态首页抢占', () => {
  assert.ok(!existsSync(path.join(PUBLIC_DIR, 'index.html')), 'public/index.html 会抢占根路径');
  const entries = readdirSync(PUBLIC_DIR);
  assert.ok(!entries.includes('index.html'));
});

test('_routes.json 只让 "/" 触发函数，图片请求完全绕过函数', () => {
  const routesPath = path.join(PUBLIC_DIR, '_routes.json');
  assert.ok(existsSync(routesPath), '_routes.json 必须存在，否则所有静态请求都会走函数');
  const routes = JSON.parse(readFileSync(routesPath, 'utf8'));
  assert.equal(routes.version, 1);
  assert.deepEqual(routes.include, ['/']);
  assert.deepEqual(routes.exclude, []);
});

test('_headers 为静态图片配置了缓存，且接口本身不在这里声明缓存', () => {
  const headersPath = path.join(PUBLIC_DIR, '_headers');
  assert.ok(existsSync(headersPath));
  const content = readFileSync(headersPath, 'utf8');
  assert.match(content, /\/images\/\*/);
  assert.match(content, /Cache-Control: public, max-age=\d+/);

  // 去掉注释行后再判断，避免把说明文字当成实际规则
  const rules = content
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
  assert.ok(!/no-store/.test(rules), '接口的 no-store 由函数自身设置，不应写进 _headers');
});

test('functions/index.js 正确导出 onRequest 并返回可用结果', async () => {
  assert.equal(typeof onRequest, 'function');

  const response = await onRequest(makeContext('https://api.qingyv.top/'));

  if (images.length === 0) {
    // 尚未运行 npm run index 时，索引为空，应返回 404 而不是崩溃
    assert.equal(response.status, 404);
    return;
  }

  assert.equal(response.status, 302);
  const location = response.headers.get('Location');
  assert.ok(location.startsWith('https://api.qingyv.top/images/'), location);
  assert.equal(response.headers.get('Cache-Control'), 'no-store, max-age=0, must-revalidate');

  const relative = decodeURIComponent(new URL(location).pathname).replace(/^\//, '');
  assert.ok(
    images.some((image) => image.p === relative),
    `跳转目标 ${relative} 必须存在于内嵌索引中`
  );

  // 已构建部署目录时，跳转目标必须真实存在
  const deployDir = path.join(PUBLIC_DIR, 'images');
  if (existsSync(deployDir)) {
    assert.ok(existsSync(path.join(PUBLIC_DIR, relative)), `部署文件缺失: ${relative}`);
  }
});

test('内嵌索引中的每一项都是合法的相对路径（不泄露绝对路径）', () => {
  for (const image of images) {
    assert.ok(image.p.startsWith('images/'), image.p);
    assert.ok(!image.p.includes('\\'), image.p);
    assert.ok(!/^[A-Za-z]:/.test(image.p), image.p);
    assert.ok(['landscape', 'portrait', 'square'].includes(image.o), `${image.p} 方向非法`);
    assert.ok(Number.isInteger(image.w) && image.w > 0, `${image.p} 宽度非法`);
    assert.ok(Number.isInteger(image.h) && image.h > 0, `${image.p} 高度非法`);
  }
});

test('内嵌索引与 data/images.json 保持一致', () => {
  const dataPath = path.join(PROJECT_ROOT, 'data', 'images.json');
  assert.ok(existsSync(dataPath), 'data/images.json 必须存在');
  const data = JSON.parse(readFileSync(dataPath, 'utf8'));
  assert.equal(images.length, data.images.length, '条数不一致，请重新运行 npm run index');

  const modulePaths = new Set(images.map((image) => image.p));
  for (const image of data.images) {
    assert.ok(modulePaths.has(image.path), `内嵌索引缺少 ${image.path}`);
  }
});
