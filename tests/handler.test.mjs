import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createHandler,
  parseOrientation,
  buildPools,
  secureRandomIndex,
  pickImage,
  VALID_ORIENTATIONS,
  NO_STORE,
} from '../functions/_lib/handler.js';
import { makeContext, sequenceRandom } from './helpers.mjs';

const SAMPLE = [
  { p: 'images/a-landscape.webp', w: 1920, h: 1080, o: 'landscape' },
  { p: 'images/b-landscape.jpg', w: 800, h: 600, o: 'landscape' },
  { p: 'images/c-portrait.png', w: 1080, h: 1920, o: 'portrait' },
  { p: 'images/d-square.png', w: 500, h: 500, o: 'square' },
  { p: 'images/示例 图片 (1).png', w: 300, h: 200, o: 'landscape' },
];

const ORIGIN = 'https://api.qingyv.top';

function handlerWith(entries = SAMPLE, random) {
  return createHandler(entries, random ? { randomUint32: random } : {});
}

test('默认请求返回 302 且指向索引中的图片', async () => {
  const { onRequest } = handlerWith(SAMPLE, () => 0);
  const response = await onRequest(makeContext(`${ORIGIN}/`));
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('Location'), `${ORIGIN}/images/a-landscape.webp`);
});

/** 从跳转响应中还原出索引里的相对路径 */
function relativeOf(response) {
  return decodeURIComponent(new URL(response.headers.get('Location')).pathname).replace(/^\//, '');
}

test('随机抽取可以覆盖索引中的每一张图片，且结果始终在索引内', async () => {
  const { onRequest } = handlerWith(SAMPLE, sequenceRandom([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
  const seen = new Set();
  for (let i = 0; i < SAMPLE.length; i += 1) {
    const response = await onRequest(makeContext(`${ORIGIN}/`));
    const relative = relativeOf(response);
    assert.ok(
      SAMPLE.some((entry) => entry.p === relative),
      `跳转目标 ${relative} 不在索引中`
    );
    seen.add(relative);
  }
  assert.equal(seen.size, SAMPLE.length, '应当能抽到索引中的每一张图片');
});

test('真实随机源下结果具有多样性（不是固定返回同一张）', async () => {
  const { onRequest } = handlerWith(SAMPLE);
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) {
    const response = await onRequest(makeContext(`${ORIGIN}/`));
    seen.add(response.headers.get('Location'));
  }
  assert.ok(seen.size > 1, `200 次请求只出现了 ${seen.size} 种结果`);
});

for (const orientation of VALID_ORIENTATIONS) {
  test(`orientation=${orientation} 只返回该方向的图片`, async () => {
    const { onRequest } = handlerWith(SAMPLE, sequenceRandom([0, 1, 2, 3, 4, 5, 6, 7]));
    const expected = SAMPLE.filter((entry) => entry.o === orientation).map((entry) => entry.p);
    for (let i = 0; i < 8; i += 1) {
      const response = await onRequest(makeContext(`${ORIGIN}/?orientation=${orientation}`));
      assert.equal(response.status, 302);
      assert.ok(expected.includes(relativeOf(response)), `返回了非 ${orientation} 的图片`);
    }
  });
}

test('orientation 参数大小写不敏感并忽略首尾空白', async () => {
  const { onRequest } = handlerWith(SAMPLE, () => 0);
  for (const raw of ['LANDSCAPE', 'Landscape', ' landscape ', 'PoRtRaIt']) {
    const response = await onRequest(makeContext(`${ORIGIN}/?orientation=${encodeURIComponent(raw)}`));
    assert.equal(response.status, 302, `"${raw}" 应被接受`);
  }
});

test('非法 orientation 返回 400，而不是静默回退到全部图片', async () => {
  const { onRequest } = handlerWith(SAMPLE, () => 0);
  for (const raw of ['abc', 'horizontal', 'land', '1', 'landscape,portrait', '横屏']) {
    const response = await onRequest(makeContext(`${ORIGIN}/?orientation=${encodeURIComponent(raw)}`));
    assert.equal(response.status, 400, `"${raw}" 应返回 400`);
    const body = await response.text();
    assert.match(body, /Invalid orientation/);
    assert.match(body, /landscape, portrait, square/);
  }
});

test('空 orientation 值返回 400', async () => {
  const { onRequest } = handlerWith(SAMPLE, () => 0);
  const response = await onRequest(makeContext(`${ORIGIN}/?orientation=`));
  assert.equal(response.status, 400);
});

test('未知查询参数返回 400，避免参数拼错时静默返回全部图片', async () => {
  const { onRequest } = handlerWith(SAMPLE, () => 0);
  const response = await onRequest(makeContext(`${ORIGIN}/?orientations=portrait`));
  assert.equal(response.status, 400);
  assert.match(await response.text(), /Unknown query parameter "orientations"/);
});

test('指定方向没有可用图片时返回 404', async () => {
  const onlyLandscape = SAMPLE.filter((entry) => entry.o === 'landscape');
  const { onRequest } = handlerWith(onlyLandscape, () => 0);
  const response = await onRequest(makeContext(`${ORIGIN}/?orientation=square`));
  assert.equal(response.status, 404);
  const body = await response.text();
  assert.match(body, /No images available for orientation "square"/);
});

test('空图片索引返回 404', async () => {
  const { onRequest } = handlerWith([], () => 0);
  for (const url of [`${ORIGIN}/`, `${ORIGIN}/?orientation=portrait`]) {
    const response = await onRequest(makeContext(url));
    assert.equal(response.status, 404);
    assert.match(await response.text(), /No images available/);
  }
});

test('非 GET/HEAD 方法返回 405 并带 Allow 头', async () => {
  const { onRequest } = handlerWith(SAMPLE, () => 0);
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const response = await onRequest(makeContext(`${ORIGIN}/`, method));
    assert.equal(response.status, 405, `${method} 应返回 405`);
    assert.equal(response.headers.get('Allow'), 'GET, HEAD');
  }
});

test('HEAD 请求同样返回 302', async () => {
  const { onRequest } = handlerWith(SAMPLE, () => 0);
  const response = await onRequest(makeContext(`${ORIGIN}/`, 'HEAD'));
  assert.equal(response.status, 302);
  assert.ok(response.headers.get('Location'));
});

test('所有响应都带 Cache-Control: no-store', async () => {
  const { onRequest } = handlerWith(SAMPLE, () => 0);
  const cases = [
    [`${ORIGIN}/`, 'GET'],
    [`${ORIGIN}/?orientation=portrait`, 'GET'],
    [`${ORIGIN}/?orientation=bad`, 'GET'],
    [`${ORIGIN}/?foo=1`, 'GET'],
    [`${ORIGIN}/`, 'POST'],
  ];
  for (const [url, method] of cases) {
    const response = await onRequest(makeContext(url, method));
    assert.equal(response.headers.get('Cache-Control'), NO_STORE, `${url} 的缓存头不正确`);
  }
});

test('空索引的 404 响应同样带 no-store', async () => {
  const { onRequest } = handlerWith([], () => 0);
  const response = await onRequest(makeContext(`${ORIGIN}/`));
  assert.equal(response.headers.get('Cache-Control'), NO_STORE);
});

test('跳转地址使用请求自身的域名，不泄露服务器本地路径', async () => {
  const { onRequest } = handlerWith(SAMPLE, () => 4);
  const response = await onRequest(makeContext(`https://api.qingyv.top/`));
  const location = response.headers.get('Location');
  const parsed = new URL(location);
  assert.equal(parsed.protocol, 'https:');
  assert.equal(parsed.host, 'api.qingyv.top');
  assert.ok(parsed.pathname.startsWith('/images/'));

  // 路径部分绝不能带盘符或反斜杠（协议里的 "https:" 不算）
  assert.ok(!parsed.pathname.includes(':'), `路径中不应出现盘符: ${parsed.pathname}`);
  assert.ok(!parsed.pathname.includes('\\'), `路径中不应出现反斜杠: ${parsed.pathname}`);
  assert.ok(!/^\/[A-Za-z]:/.test(parsed.pathname));
});

test('中文、空格、括号文件名被正确百分号编码', async () => {
  const { onRequest } = handlerWith(SAMPLE, () => 4);
  const response = await onRequest(makeContext(`${ORIGIN}/`));
  const location = response.headers.get('Location');
  assert.equal(
    location,
    `${ORIGIN}/images/${encodeURIComponent('示例 图片 (1).png').replace(/%2F/g, '/')}`
  );
  assert.ok(!location.includes(' '), 'Location 中不应包含未编码的空格');
  // 反向验证：解码后应回到原始路径
  assert.equal(decodeURIComponent(new URL(location).pathname), '/images/示例 图片 (1).png');
});

test('索引中的无效条目会被忽略，不会导致接口出错', async () => {
  const dirty = [null, { w: 1, h: 1 }, { p: 123, o: 'landscape' }, { p: 'images/ok.png', o: 'weird' }, ...SAMPLE];
  const { onRequest } = handlerWith(dirty, () => 0);
  const response = await onRequest(makeContext(`${ORIGIN}/`));
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('Location'), `${ORIGIN}/images/a-landscape.webp`);
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
  assert.equal(pools.landscape.length, 3);
  assert.equal(pools.portrait.length, 1);
  assert.equal(pools.square.length, 1);
});

test('含 # 与 ? 的文件名会被正确转义，不会被当成 URL 片段或查询串', async () => {
  const tricky = [
    { p: "images/quote'and#hash.png", w: 300, h: 200, o: 'landscape' },
    { p: 'images/what?.png', w: 300, h: 200, o: 'landscape' },
    { p: 'images/100%.png', w: 300, h: 200, o: 'landscape' },
  ];
  for (let i = 0; i < tricky.length; i += 1) {
    const { onRequest } = handlerWith(tricky, () => i);
    const response = await onRequest(makeContext(`${ORIGIN}/`));
    const location = response.headers.get('Location');

    // 还原出的路径必须与索引完全一致（# 若未转义，这里会丢掉 "#hash.png"）
    assert.equal(relativeOf(response), tricky[i].p, `跳转地址转义错误: ${location}`);
    assert.ok(!location.includes('#'), `# 必须被转义: ${location}`);
    assert.ok(!location.includes('?'), `? 必须被转义: ${location}`);
    assert.equal(new URL(location).hash, '');
    assert.equal(new URL(location).search, '');
  }
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
