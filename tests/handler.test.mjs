import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createHandler,
  parseOrientation,
  buildPools,
  secureRandomIndex,
  pickImage,
  encodePath,
  VALID_ORIENTATIONS,
  NO_STORE,
} from '../functions/_lib/handler.js';
import { makeContext, memoryAssets, sequenceRandom } from './helpers.mjs';

const SAMPLE = [
  { p: 'images/a-landscape.webp', w: 1920, h: 1080, o: 'landscape' },
  { p: 'images/b-landscape.jpg', w: 800, h: 600, o: 'landscape' },
  { p: 'images/c-portrait.png', w: 1080, h: 1920, o: 'portrait' },
  { p: 'images/d-square.png', w: 500, h: 500, o: 'square' },
  { p: 'images/e-portrait.gif', w: 400, h: 800, o: 'portrait' },
];

const ORIGIN = 'https://api.qingyv.top';

/** 每个路径给一段独一无二的内容，便于断言「到底返回了哪一张」 */
const ASSETS = memoryAssets(
  Object.fromEntries(SAMPLE.map((entry) => [entry.p, `BYTES-OF:${entry.p}`]))
);

function handlerWith(entries = SAMPLE, random, assets = ASSETS) {
  return createHandler(entries, random ? { randomUint32: random } : {});
}

function contextFor(url, method = 'GET', assets = ASSETS) {
  return makeContext(url, method, { ASSETS: assets });
}

/** 断言响应体是某张图片的内容 */
async function assertServes(response, expectedPath) {
  assert.equal(response.status, 200);
  assert.equal(await response.text(), `BYTES-OF:${expectedPath}`);
}

test('根路径直接返回图片内容，不是重定向', async () => {
  const { onRequest } = handlerWith(SAMPLE, () => 0);
  const response = await onRequest(contextFor(`${ORIGIN}/`));

  assert.equal(response.status, 200, '必须直接返回 200，而不是 3xx 跳转');
  assert.equal(response.headers.get('Location'), null, '不应带 Location 头');
  await assertServes(response, SAMPLE[0].p);
});

test('地址栏不会跳走：任何情况下都不返回 3xx', async () => {
  const { onRequest } = handlerWith(SAMPLE);
  const urls = [
    `${ORIGIN}/`,
    `${ORIGIN}/?orientation=landscape`,
    `${ORIGIN}/?orientation=portrait`,
    `${ORIGIN}/?orientation=square`,
    `${ORIGIN}/?orientation=bad`,
    `${ORIGIN}/?foo=1`,
  ];
  for (const url of urls) {
    const response = await onRequest(contextFor(url));
    assert.ok(
      response.status < 300 || response.status >= 400,
      `${url} 不应返回重定向（实际 ${response.status}），否则刷新时地址栏会跑到图片地址`
    );
    assert.equal(response.headers.get('Location'), null, `${url} 不应带 Location 头`);
  }
});

test('Content-Type 与所选中图片的真实类型一致', async () => {
  for (let i = 0; i < SAMPLE.length; i += 1) {
    const { onRequest } = handlerWith(SAMPLE, () => i);
    const response = await onRequest(contextFor(`${ORIGIN}/`));
    const expected = {
      webp: 'image/webp',
      jpg: 'image/jpeg',
      png: 'image/png',
      gif: 'image/gif',
    }[SAMPLE[i].p.split('.').pop()];
    assert.equal(response.headers.get('Content-Type'), expected, SAMPLE[i].p);
  }
});

test('Cache-Control 必须是 no-store，覆盖静态资源自带的长缓存', async () => {
  const { onRequest } = handlerWith(SAMPLE, () => 0);
  const response = await onRequest(contextFor(`${ORIGIN}/`));
  // 模拟的静态资源返回 public, max-age=604800，接口必须把它换掉，
  // 否则浏览器会缓存住，刷新就换不了图
  assert.equal(response.headers.get('Cache-Control'), NO_STORE);
});

test('随机抽取可以覆盖索引中的每一张图片，结果始终在索引内', async () => {
  const { onRequest } = handlerWith(SAMPLE, sequenceRandom([0, 1, 2, 3, 4, 5, 6, 7]));
  const seen = new Set();
  for (let i = 0; i < SAMPLE.length; i += 1) {
    const response = await onRequest(contextFor(`${ORIGIN}/`));
    const body = await response.text();
    assert.match(body, /^BYTES-OF:images\//, `返回了索引外的内容: ${body}`);
    seen.add(body);
  }
  assert.equal(seen.size, SAMPLE.length, '应当能抽到索引中的每一张图片');
});

test('真实随机源下结果具有多样性（不是固定返回同一张）', async () => {
  const { onRequest } = handlerWith(SAMPLE);
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) {
    const response = await onRequest(contextFor(`${ORIGIN}/`));
    seen.add(await response.text());
  }
  assert.ok(seen.size > 1, `200 次请求只出现了 ${seen.size} 种结果`);
});

for (const orientation of VALID_ORIENTATIONS) {
  test(`orientation=${orientation} 只返回该方向的图片`, async () => {
    const { onRequest } = handlerWith(SAMPLE);
    const expected = new Set(
      SAMPLE.filter((entry) => entry.o === orientation).map((entry) => `BYTES-OF:${entry.p}`)
    );
    for (let i = 0; i < 20; i += 1) {
      const response = await onRequest(contextFor(`${ORIGIN}/?orientation=${orientation}`));
      assert.equal(response.status, 200);
      assert.ok(expected.has(await response.text()), `返回了非 ${orientation} 的图片`);
    }
  });
}

test('orientation 参数大小写不敏感并忽略首尾空白', async () => {
  const { onRequest } = handlerWith(SAMPLE);
  for (const raw of ['LANDSCAPE', 'Landscape', ' landscape ', 'PoRtRaIt']) {
    const response = await onRequest(contextFor(`${ORIGIN}/?orientation=${encodeURIComponent(raw)}`));
    assert.equal(response.status, 200, `"${raw}" 应被接受`);
  }
});

test('非法 orientation 返回 400，而不是静默回退到全部图片', async () => {
  const { onRequest } = handlerWith(SAMPLE);
  for (const raw of ['abc', 'horizontal', 'land', '1', 'landscape,portrait', '横屏']) {
    const response = await onRequest(contextFor(`${ORIGIN}/?orientation=${encodeURIComponent(raw)}`));
    assert.equal(response.status, 400, `"${raw}" 应返回 400`);
    const body = await response.text();
    assert.match(body, /Invalid orientation/);
    assert.match(body, /landscape, portrait, square/);
  }
});

test('空 orientation 值与未知查询参数都返回 400', async () => {
  const { onRequest } = handlerWith(SAMPLE);
  const empty = await onRequest(contextFor(`${ORIGIN}/?orientation=`));
  assert.equal(empty.status, 400);

  const unknown = await onRequest(contextFor(`${ORIGIN}/?orientations=portrait`));
  assert.equal(unknown.status, 400);
  assert.match(await unknown.text(), /Unknown query parameter "orientations"/);
});

test('指定方向没有可用图片时返回 404', async () => {
  const onlyLandscape = SAMPLE.filter((entry) => entry.o === 'landscape');
  const { onRequest } = handlerWith(onlyLandscape);
  const response = await onRequest(contextFor(`${ORIGIN}/?orientation=square`));
  assert.equal(response.status, 404);
  assert.match(await response.text(), /No images available for orientation "square"/);
});

test('空图片索引返回 404', async () => {
  const { onRequest } = handlerWith([]);
  for (const url of [`${ORIGIN}/`, `${ORIGIN}/?orientation=portrait`]) {
    const response = await onRequest(contextFor(url));
    assert.equal(response.status, 404);
    assert.match(await response.text(), /No images available/);
  }
});

test('非 GET/HEAD 方法返回 405 并带 Allow 头', async () => {
  const { onRequest } = handlerWith(SAMPLE);
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const response = await onRequest(contextFor(`${ORIGIN}/`, method));
    assert.equal(response.status, 405, `${method} 应返回 405`);
    assert.equal(response.headers.get('Allow'), 'GET, HEAD');
  }
});

test('HEAD 请求返回 200 且无响应体，但仍带正确的 Content-Type', async () => {
  const { onRequest } = handlerWith(SAMPLE, () => 2);
  const response = await onRequest(contextFor(`${ORIGIN}/`, 'HEAD'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'image/png');
  assert.equal(await response.text(), '');
});

test('所有响应都带 Cache-Control: no-store', async () => {
  const { onRequest } = handlerWith(SAMPLE);
  const cases = [
    [`${ORIGIN}/`, 'GET'],
    [`${ORIGIN}/?orientation=portrait`, 'GET'],
    [`${ORIGIN}/?orientation=bad`, 'GET'],
    [`${ORIGIN}/?foo=1`, 'GET'],
    [`${ORIGIN}/`, 'POST'],
    [`${ORIGIN}/`, 'HEAD'],
  ];
  for (const [url, method] of cases) {
    const response = await onRequest(contextFor(url, method));
    assert.equal(response.headers.get('Cache-Control'), NO_STORE, `${url} ${method} 缓存头不正确`);
  }
});

test('响应中不泄露服务器本地路径', async () => {
  const { onRequest } = handlerWith(SAMPLE, () => 0);
  const response = await onRequest(contextFor(`${ORIGIN}/`));
  for (const [, value] of response.headers) {
    assert.ok(!/[A-Za-z]:[\\/]/.test(value), `响应头泄露本地路径: ${value}`);
    assert.ok(!value.includes('\\'), `响应头泄露本地路径: ${value}`);
  }
});

test('含 # 与 ? 的文件名会被正确转义后再取资源', async () => {
  const tricky = [
    { p: "images/quote'and#hash.png", w: 300, h: 200, o: 'landscape' },
    { p: 'images/what?.png', w: 300, h: 200, o: 'landscape' },
    { p: 'images/100%.png', w: 300, h: 200, o: 'landscape' },
  ];
  const assets = memoryAssets(Object.fromEntries(tricky.map((e) => [e.p, `BYTES-OF:${e.p}`])));

  for (let i = 0; i < tricky.length; i += 1) {
    const { onRequest } = handlerWith(tricky, () => i, assets);
    const response = await onRequest(contextFor(`${ORIGIN}/`, 'GET', assets));
    assert.equal(response.status, 200, `${tricky[i].p} 未能取到`);
    assert.equal(await response.text(), `BYTES-OF:${tricky[i].p}`);
  }

  assert.equal(encodePath("images/quote'and#hash.png"), "images/quote'and%23hash.png");
  assert.equal(encodePath('images/what?.png'), 'images/what%3F.png');
});

test('索引中的无效条目会被忽略，不会导致接口出错', async () => {
  const dirty = [null, { w: 1, h: 1 }, { p: 123, o: 'landscape' }, { p: 'images/ok.png', o: 'weird' }, ...SAMPLE];
  const { onRequest } = handlerWith(dirty, () => 0);
  const response = await onRequest(contextFor(`${ORIGIN}/`));
  await assertServes(response, SAMPLE[0].p);
});

test('缺少 ASSETS 绑定时报 500 而不是崩溃', async () => {
  const { onRequest } = handlerWith(SAMPLE, () => 0);
  const response = await onRequest(makeContext(`${ORIGIN}/`, 'GET', {}));
  assert.equal(response.status, 500);
  assert.match(await response.text(), /ASSETS/);
});

test('索引与部署不一致（资源缺失）时报 502 并说明原因', async () => {
  const empty = memoryAssets({});
  const { onRequest } = handlerWith(SAMPLE, () => 0, empty);
  const response = await onRequest(contextFor(`${ORIGIN}/`, 'GET', empty));
  assert.equal(response.status, 502);
  assert.match(await response.text(), /out of sync with the index/);
});

test('parseOrientation 的返回值符合约定', () => {
  assert.deepEqual(parseOrientation(new URLSearchParams('')).value, null);
  assert.equal(parseOrientation(new URLSearchParams('orientation=portrait')).value, 'portrait');
  assert.equal(parseOrientation(new URLSearchParams('orientation=SQUARE')).value, 'square');
  assert.equal(parseOrientation(new URLSearchParams('orientation=nope')).ok, false);
  assert.equal(parseOrientation(new URLSearchParams('a=1')).status, 400);
});

test('buildPools 按方向正确分桶', () => {
  const pools = buildPools(SAMPLE);
  assert.equal(pools.all.length, 5);
  assert.equal(pools.landscape.length, 2);
  assert.equal(pools.portrait.length, 2);
  assert.equal(pools.square.length, 1);
});

test('secureRandomIndex 使用拒绝采样，取值无偏且落在范围内', () => {
  // 2^32 % 5 == 1，因此 limit == 4294967295，只有 0xffffffff 会被拒绝
  const calls = [];
  const random = () => {
    const value = [0xffffffff, 0xfffffffe, 7][calls.length] ?? 0;
    calls.push(value);
    return value;
  };
  assert.equal(secureRandomIndex(5, random), 0xfffffffe % 5);
  assert.equal(calls.length, 2, '第一个越界值应被拒绝后重试');

  assert.equal(secureRandomIndex(1, () => 12345), 0);
  assert.throws(() => secureRandomIndex(0), RangeError);
  assert.throws(() => secureRandomIndex(-1), RangeError);
});

test('pickImage 在空池上返回 null', () => {
  assert.equal(pickImage([], () => 0), null);
  assert.equal(pickImage(null, () => 0), null);
  assert.equal(pickImage([{ p: 'x' }], () => 0).p, 'x');
});
