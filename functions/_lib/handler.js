/**
 * 随机图片接口的核心逻辑。
 *
 * 关键设计：**不使用 302 跳转，而是直接把图片内容返回给 "/"**。
 *
 * 为什么必须这样：
 *   如果 "/" 返回 302 跳到 /images/xxx.webp，浏览器会把地址栏改成那个图片地址。
 *   用户按 F5 时刷新的是图片地址而不是 "/"，于是永远是同一张图。
 *   只有让 "/" 本身返回图片字节，地址栏才会一直停在 https://api.qingyv.top，
 *   每次刷新都是一次全新的随机请求。
 *
 * 图片字节通过 Pages 提供的 ASSETS 绑定获取（env.ASSETS.fetch），
 * 不经过任何外部网络，也不在函数里做额外的编解码。
 */

export const VALID_ORIENTATIONS = ['landscape', 'portrait', 'square'];

/**
 * 随机结果绝不能进任何缓存，否则刷新就换不了图。
 * 注意这个头会覆盖静态资源自带的 7 天缓存策略，这是刻意为之。
 */
export const NO_STORE = 'no-store, max-age=0, must-revalidate';

/** 唯一被接受的查询参数。未知参数一律报错，避免拼错参数时静默返回全部图片。 */
export const ALLOWED_PARAMS = ['orientation'];

function plainText(status, message, extraHeaders = {}) {
  return new Response(`${message}\n`, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': NO_STORE,
      'X-Robots-Tag': 'noindex',
      ...extraHeaders,
    },
  });
}

export const errorResponse = plainText;

/**
 * 逐段对路径做百分号编码。
 *
 * 不能直接把路径交给 new URL() 拼接：文件名里的 "#" 会被当成片段分隔符、
 * "?" 会被当成查询串起始符，导致请求到一个并不存在的资源。
 */
export function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

/**
 * 解析并校验 orientation 参数。
 * @returns {{ok:true, value:string|null}} value 为 null 表示不限方向
 *        | {{ok:false, status:number, message:string}}
 */
export function parseOrientation(searchParams) {
  for (const key of searchParams.keys()) {
    if (!ALLOWED_PARAMS.includes(key)) {
      return {
        ok: false,
        status: 400,
        message: `Unknown query parameter "${key}". The only supported parameter is "orientation".`,
      };
    }
  }

  const raw = searchParams.get('orientation');
  if (raw === null) return { ok: true, value: null };

  // 大小写不敏感并忽略首尾空白；空值同样视为非法，不做静默回退。
  const normalized = raw.trim().toLowerCase();
  if (!VALID_ORIENTATIONS.includes(normalized)) {
    return {
      ok: false,
      status: 400,
      message: `Invalid orientation "${raw}". Allowed values: ${VALID_ORIENTATIONS.join(', ')}.`,
    };
  }
  return { ok: true, value: normalized };
}

/** 把索引按方向分桶，避免每次请求都做一次过滤。 */
export function buildPools(entries) {
  const pools = { all: [], landscape: [], portrait: [], square: [] };
  for (const entry of entries) {
    if (!entry || typeof entry.p !== 'string') continue;
    if (!VALID_ORIENTATIONS.includes(entry.o)) continue;
    pools.all.push(entry);
    pools[entry.o].push(entry);
  }
  return pools;
}

function defaultRandomUint32() {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}

/**
 * 无偏随机下标（拒绝采样，避免取模偏差）。
 * randomUint32 可注入，便于测试确定化。
 */
export function secureRandomIndex(length, randomUint32 = defaultRandomUint32) {
  if (!Number.isInteger(length) || length <= 0) {
    throw new RangeError('length 必须是正整数');
  }
  if (length === 1) return 0;
  const space = 0x100000000;
  const limit = space - (space % length);
  let value = randomUint32();
  while (value >= limit) value = randomUint32();
  return value % length;
}

/** 从候选池中等概率抽取一张；池为空返回 null。 */
export function pickImage(pool, randomUint32) {
  if (!pool || pool.length === 0) return null;
  return pool[secureRandomIndex(pool.length, randomUint32)];
}

/**
 * 从静态资源绑定读取图片，并把自带的长缓存头替换成 no-store。
 * 只保留内容类型与长度，其余一律不继承。
 */
async function serveAsset(assets, assetPath, origin, method) {
  const assetUrl = new URL(`/${encodePath(assetPath)}`, origin);
  const assetResponse = await assets.fetch(new Request(assetUrl.toString(), { method }));

  if (!assetResponse.ok) {
    return {
      ok: false,
      status: 502,
      message:
        `Selected image could not be served (HTTP ${assetResponse.status}): ${assetPath}\n` +
        'The deployed file is missing or out of sync with the index. Run `npm run build` and redeploy.',
    };
  }

  const headers = new Headers();
  const contentType = assetResponse.headers.get('Content-Type');
  if (contentType) headers.set('Content-Type', contentType);
  const contentLength = assetResponse.headers.get('Content-Length');
  if (contentLength) headers.set('Content-Length', contentLength);

  headers.set('Cache-Control', NO_STORE);
  headers.set('X-Robots-Tag', 'noindex');
  headers.set('Access-Control-Allow-Origin', '*');

  return {
    ok: true,
    response: new Response(method === 'HEAD' ? null : assetResponse.body, {
      status: 200,
      headers,
    }),
  };
}

/**
 * 生成 Pages Functions 的请求处理器。
 * @param {Array<{p:string,w:number,h:number,o:string}>} entries 构建期内嵌的图片索引
 * @param {{randomUint32?:Function}} options 测试用的注入点
 */
export function createHandler(entries = [], options = {}) {
  const pools = buildPools(entries);
  const { randomUint32 } = options;

  async function onRequest(context) {
    const request = context?.request;
    if (!request) {
      return plainText(500, 'Internal error: missing request.');
    }

    const method = (request.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      return plainText(405, `Method ${method} not allowed. Use GET.`, { Allow: 'GET, HEAD' });
    }

    const url = new URL(request.url);

    const parsed = parseOrientation(url.searchParams);
    if (!parsed.ok) {
      return plainText(parsed.status, parsed.message);
    }

    if (pools.all.length === 0) {
      return plainText(404, 'No images available. The image index is empty.');
    }

    const pool = parsed.value === null ? pools.all : pools[parsed.value];
    if (pool.length === 0) {
      return plainText(404, `No images available for orientation "${parsed.value}".`);
    }

    const assets = context.env?.ASSETS;
    if (!assets || typeof assets.fetch !== 'function') {
      return plainText(500, 'Internal error: the ASSETS binding is unavailable.');
    }

    const chosen = pickImage(pool, randomUint32);
    const served = await serveAsset(assets, chosen.p, url.origin, method);
    if (!served.ok) {
      return plainText(served.status, served.message);
    }
    return served.response;
  }

  return { onRequest };
}
