/**
 * 随机图片跳转接口的核心逻辑。
 *
 * 该模块刻意不依赖任何 Node.js 专有 API，也不读取文件系统：
 * 图片清单在构建期由 scripts/build-index.mjs 生成并内嵌进打包产物，
 * 因此运行时只做「挑选 + 302 跳转」，不传输图片二进制、不发起外部请求。
 */

export const VALID_ORIENTATIONS = ['landscape', 'portrait', 'square'];

/** 随机结果绝不能进缓存，否则接口就失去随机性。 */
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
 * "?" 会被当成查询串起始符，导致跳转到一个并不存在的地址。
 * 逐段 encodeURIComponent 可以确保 "#"、"?"、"%"、空格、中文都被正确转义。
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

    const chosen = pickImage(pool, randomUint32);

    // 用请求自身的 origin 组装绝对地址：这是公开访问域名，不含任何服务器本地路径信息。
    const location = `${url.origin}/${encodePath(chosen.p)}`;

    return new Response(null, {
      status: 302,
      headers: {
        Location: location,
        'Cache-Control': NO_STORE,
        'X-Robots-Tag': 'noindex',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  return { onRequest };
}
