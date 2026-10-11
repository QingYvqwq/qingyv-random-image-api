/**
 * Cloudflare Pages Function —— 根路径随机图片接口。
 *
 *   GET /                          从全部图片中随机跳转
 *   GET /?orientation=landscape    仅横屏
 *   GET /?orientation=portrait     仅竖屏
 *   GET /?orientation=square       仅方形
 *
 * 路由说明：
 *   public/_routes.json 将 Functions 的触发范围限定为 "/"，
 *   因此 /images/** 的静态图片请求完全绕过函数，直接由 CDN 边缘返回。
 *
 * 图片清单来源：
 *   functions/_data/images.generated.js 由 scripts/build-index.mjs 在构建期生成，
 *   随函数一起打包。运行时不会扫描目录，也不会调用 GitHub API。
 */
import images from './_data/images.generated.js';
import { createHandler } from './_lib/handler.js';

const handler = createHandler(images);

export const onRequest = handler.onRequest;
