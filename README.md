# QingYv Random Image API

一个部署在 Cloudflare Pages 上的随机图片 API。访问根路径直接在浏览器里显示一张随机图片，
并支持按横屏 / 竖屏 / 方形筛选。

**线上地址：<https://api.qingyv.top>** —— 已部署并通过验收。

| | |
|---|---|
| 生产域名 | <https://api.qingyv.top> |
| Pages 默认域名 | <https://qingyv-random-image-api.pages.dev> |
| GitHub 仓库 | <https://github.com/QingYvqwq/qingyv-random-image-api> |
| 图片数量 | 205 张（横屏 146 / 竖屏 57 / 方形 2） |

不需要独立服务器、数据库、Docker 或任何常驻进程。图片和代码都存放在 GitHub，
由 Cloudflare Pages 在每次提交后自动构建并发布。

---

## 目录

- [它是怎么工作的](#它是怎么工作的)
- [目录结构](#目录结构)
- [本地开发](#本地开发)
- [API 说明](#api-说明)
- [日常维护：新增图片](#日常维护新增图片)
- [脚本命令](#脚本命令)
- [配置项](#配置项)
- [图片格式与安全策略](#图片格式与安全策略)
- [已知限制](#已知限制)
- [部署到 Cloudflare Pages](#部署到-cloudflare-pages)
- [绑定自定义域名 api.qingyv.top](#绑定自定义域名-apiqingyvtop)
- [故障排查](#故障排查)

---

## 它是怎么工作的

```
GitHub 仓库
   │  ① 提交图片到 images/ 目录
   ▼
Cloudflare Pages 构建（npm run build）
   │  ② scripts/build-index.mjs 扫描图片，读取真实格式 / 尺寸 / EXIF 方向
   │     生成 data/images.json（可读索引）
   │     生成 functions/_data/images.generated.js（内嵌进函数包的索引）
   │  ③ scripts/sync-images.mjs 把有效图片复制到 public/images/
   │     超过体积阈值的图片生成同尺寸压缩副本（原图不动）
   ▼
Cloudflare 边缘节点
   │  ④ 访问 /            -> Pages Function 挑选一张图，返回 302 跳转
   │  ⑤ 访问 /images/x.jpg -> 直接由 CDN 返回静态文件，不经过函数
```

关键设计：

- **索引在构建期生成**，接口运行时既不扫描目录，也不调用 GitHub API。
- **接口只做「选图 + 302」**，不传输图片二进制，因此函数不会成为带宽瓶颈。
- **`public/_routes.json` 把函数触发范围限定为 `/`**，图片请求完全绕过函数。
- **`public/` 下没有 `index.html`**，所以根路径不会被静态首页抢占。

---

## 目录结构

```
api/
├─ images/                          # 原始图片（源目录，文件名保持原样）
├─ public/                          # Cloudflare Pages 的构建输出目录
│  ├─ images/                       # 构建产物：只包含索引内的有效图片（不进 git）
│  ├─ _headers                      # 静态资源缓存与安全响应头
│  └─ _routes.json                  # 限定函数只处理 "/"
├─ functions/                       # Cloudflare Pages Functions
│  ├─ index.js                      # 根路径随机跳转入口
│  ├─ _lib/handler.js               # 参数校验、随机抽取、响应构造
│  └─ _data/images.generated.js     # 构建期生成的内嵌索引（自动生成，勿手改）
├─ scripts/
│  ├─ build-index.mjs               # 扫描图片 -> 生成索引 + 诊断报告
│  ├─ sync-images.mjs               # 索引 -> 部署目录同步（含超大图压缩）
│  ├─ verify.mjs                    # 校验索引与磁盘是否一致
│  ├─ make-test-fixtures.mjs        # 重建测试样本
│  └─ lib/                          # 脚本内部模块
├─ tests/                           # 自动化测试（node:test）
│  └─ fixtures/                     # 小体积测试样本
├─ data/images.json                 # 可读的图片索引（进 git）
├─ config.json                      # 构建配置
├─ wrangler.toml                    # Cloudflare Pages 配置
├─ package.json / package-lock.json
└─ README.md
```

---

## 本地开发

需要 Node.js 20 或更高版本。

```bash
npm install          # 安装依赖
npm run build        # 扫描图片 -> 生成索引 -> 同步到 public/images
npm run dev          # 用 Cloudflare 官方工具启动本地模拟环境
```

`npm run dev` 会先执行一次构建，然后在 <http://127.0.0.1:8788> 启动
`wrangler pages dev`，它使用与线上一致的 workerd 运行时，因此路由、缓存头和
Pages Functions 的行为都和部署后相同。

运行测试：

```bash
npm test
```

---

## API 说明

| 请求 | 说明 | 状态码 |
|---|---|---|
| `GET /` | 从全部图片中随机跳转 | 302 |
| `GET /?orientation=landscape` | 只从横屏图片中随机跳转 | 302 |
| `GET /?orientation=portrait` | 只从竖屏图片中随机跳转 | 302 |
| `GET /?orientation=square` | 只从方形图片中随机跳转 | 302 |
| 方向参数非法 | 返回纯文本错误说明 | 400 |
| 查询参数不在允许列表内 | 返回纯文本错误说明 | 400 |
| 指定方向没有可用图片 | 返回纯文本错误说明 | 404 |
| 索引为空 | 返回纯文本错误说明 | 404 |
| 非 GET / HEAD 方法 | 返回 `Allow: GET, HEAD` | 405 |

**方向判定规则**：以图片的**实际显示尺寸**为准，并计入 JPEG EXIF 方向标记。

- `width > height` → `landscape`
- `height > width` → `portrait`
- `width = height` → `square`

例如一张存储为 3000×2000、但 EXIF 标记为 orientation=6 的 JPEG，显示时会旋转 90°，
实际显示尺寸是 2000×3000，因此被归类为 **竖屏**。

**参数处理约定**：

- 大小写不敏感：`?orientation=LANDSCAPE` 与 `?orientation=landscape` 等价。
- 首尾空白会被忽略：`?orientation=%20portrait%20` 合法。
- 空值 `?orientation=` 视为非法，返回 400，**不会**静默回退到全部图片。
- 只识别 `orientation` 一个参数。出现其他参数（例如拼错的 `?orientations=portrait`）
  一律返回 400，避免拼错参数时静默返回错误结果。

**响应头**：

- 所有接口响应都带 `Cache-Control: no-store, max-age=0, must-revalidate`，保证随机性。
- 跳转响应额外带 `Access-Control-Allow-Origin: *`，方便前端直接引用。
- 静态图片由 `public/_headers` 配置为 `public, max-age=604800, stale-while-revalidate=86400`。

**使用示例**：

```html
<!-- 每次刷新显示一张随机图片 -->
<img src="https://api.qingyv.top/" alt="random">

<!-- 只要竖屏 -->
<img src="https://api.qingyv.top/?orientation=portrait" alt="random portrait">
```

---

## 日常维护：新增图片

1. 把新图片放进 `images/` 目录，**不用改名、不用登记**。可以放子目录，中文名、空格、
   括号都没问题。
2. 运行 `npm run build` 重新生成索引并同步到 `public/images/`。
3. 运行 `npm run verify` 确认索引与磁盘一致。
4. 提交并推送：

   ```bash
   git add -A
   git commit -m "添加新图片并重建索引"
   git push
   ```

Cloudflare Pages 检测到推送后会自动重新构建并发布。

> 图片清单完全由脚本自动生成，不需要手动维护任何列表。

---

## 脚本命令

| 命令 | 作用 |
|---|---|
| `npm run build` | 生成索引 + 同步图片到 `public/images/`（部署前必须执行） |
| `npm run index` | 只扫描图片并生成索引，输出统计与诊断报告 |
| `npm run sync` | 只把索引中的图片同步到部署目录 |
| `npm run verify` | 校验索引、源文件、部署文件三者是否一致（有问题退出码为 1） |
| `npm run stats` | 只打印现有索引的统计报告，不重新扫描 |
| `npm run test` | 运行全部自动化测试 |
| `npm run fixtures` | 重建 `tests/fixtures/` 下的测试样本 |
| `npm run dev` | 构建后启动本地 Cloudflare 模拟环境 |
| `npm run deploy` | 构建后用 wrangler 直接部署（备选方案，见下文） |

`npm run index` 会输出：

- 扫描文件总数、已收录图片数、跳过文件数
- 各格式数量、横屏 / 竖屏 / 方形数量
- 图片总容量、最大图片、超过体积阈值的图片清单
- 跳过文件明细（含原因）与警告

---

## 配置项

全部配置集中在 `config.json`：

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `imagesDir` | `images` | 原始图片所在目录。也可用环境变量 `IMAGES_DIR` 临时覆盖 |
| `urlPrefix` | `images` | 图片的公开访问前缀，索引路径形如 `images/<相对路径>` |
| `excludeDirs` | 见文件 | 扫描时跳过的目录名 |
| `deployMaxBytes` | `26214400`（25 MiB） | Cloudflare Pages 单文件硬上限，超过则无法部署 |
| `optimizeThresholdBytes` | `24117248`（23 MiB） | 超过该值即生成压缩副本，为硬上限留安全余量 |
| `optimizeQualityLadder` | `[82, 70, 58, 45]` | 压缩时依次尝试的质量档位 |
| `allowedFormats` | `jpg png webp gif bmp avif tiff` | 允许进入索引的格式白名单 |
| `blockedFormats` | `svg` | 显式禁用的格式（安全原因） |

---

## 图片格式与安全策略

### 格式支持情况

尺寸、方向与格式识别使用 [`image-size`](https://www.npmjs.com/package/image-size)，
它依据**文件头 magic bytes** 判断真实格式，**不依赖扩展名**。实测支持：

| 格式 | 尺寸 | EXIF 方向 | 完整性校验 |
|---|---|---|---|
| JPEG / JPG | ✅ | ✅ | ✅ 检查 EOI 结束标记 |
| PNG | ✅ | — | ✅ 检查 IEND 结束块 |
| WebP | ✅ | ✅ | ✅ 比对 RIFF 声明长度 |
| GIF | ✅ | — | ✅ 检查 trailer 标记 |
| BMP | ✅ | — | ✅ 比对头部声明长度 |
| AVIF | ✅ | ✅ | ⚠️ 仅头部解析 |
| TIFF | ✅ | ✅ | ⚠️ 仅头部解析 |

### 安全处理

1. **SVG 默认被排除。** SVG 可以内嵌 `<script>`、外部引用和事件属性，属于主动内容。
   `config.json` 的 `blockedFormats` 显式禁用它，扫描报告会记录被跳过的 SVG 文件。
2. **不信任扩展名。** 一个内容是 PNG 但扩展名写成 `.webp` 的文件会被正确识别为 PNG，
   并在报告里产生一条「扩展名与真实格式不一致」的警告。
3. **损坏文件不会中断构建。** 非图片、空文件、截断文件、不支持的格式都会被单独记录
   原因后跳过，一张坏图片不会导致整次索引生成失败。
4. **索引只保存相对路径**，不含任何本机绝对路径。`npm run verify` 会检查这一点。
5. **原始图片不会被修改。** 压缩只发生在 `public/images/` 里的副本上，`images/` 中的
   原文件字节完全不变（测试中有断言保证）。

---

## 已知限制

- **AVIF / TIFF 不做完整性校验。** 这两种格式没有廉价可靠的整文件长度字段，
  只能依赖文件头解析，被截断的 AVIF/TIFF 可能仍会进入索引。
- **超大图片的压缩副本是有损的。** 超过 23 MiB 的图片会在部署目录生成一份同尺寸、
  较低质量的副本，视觉上可能与原图有差异。原图始终保留在 `images/` 中。
- **图片文件名不含内容哈希。** 因此静态缓存使用可过期的 `max-age` 而不是 `immutable`；
  替换同名图片后，最长需要 7 天 CDN 缓存才会完全刷新。
- **免费套餐不承诺速度与配额。** Cloudflare Pages 免费版有每月构建次数、单文件
  25 MiB、单次部署 20000 个文件的限制。中国大陆的访问速度取决于 Cloudflare 的
  网络状况，不做任何保证。
- **仓库体积。** 图片直接存在 Git 仓库里，仓库会随图片增长。GitHub 对单个文件有
  100 MB 硬限制、对仓库有约 1 GB 的软性警告线。

---

## 部署到 Cloudflare Pages

推荐使用 **GitHub 集成部署**：提交代码后自动构建发布。

### 前置条件

- 一个 GitHub 仓库（本项目的代码与图片）
- 一个 Cloudflare 账号，且域名 `qingyv.top` 的 DNS 已托管在 Cloudflare

### 步骤

**1. 创建 GitHub 仓库并推送代码**

```bash
git init
git add -A
git commit -m "初始化随机图片 API"
git branch -M main
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git push -u origin main
```

**2. 在 Cloudflare 控制台创建 Pages 项目**

1. 打开 <https://dash.cloudflare.com/> → 左侧 **Workers & Pages**
2. 点击 **Create** → 选择 **Pages** 标签页 → **Connect to Git**
3. 授权 Cloudflare 访问 GitHub（首次需要点授权按钮并选择仓库范围）
4. 选择上一步创建的仓库 → **Begin setup**

**3. 填写构建设置**（这是最关键的一步）

| 字段 | 填写内容 |
|---|---|
| Project name | `qingyv-random-image-api`（可自定义，会决定 `*.pages.dev` 地址） |
| Production branch | `main` |
| Framework preset | `None` |
| **Build command** | `npm run build` |
| **Build output directory** | `public` |
| Root directory | 留空 |

**4. 环境变量**：不需要配置任何环境变量。

**5. 点击 Save and Deploy**，等待构建完成。首次部署约需几分钟（图片较多）。

**6. 记录分配到的地址**，形如 `https://<项目名>.pages.dev`。

### 备选方案：用 Wrangler 直接部署

```bash
npx wrangler login     # 首次需要浏览器授权
npm run deploy
```

两种方案的差异：

| | GitHub 集成部署（推荐） | Wrangler 直接部署 |
|---|---|---|
| 触发方式 | `git push` 后自动构建 | 每次在本地手动执行 |
| 构建环境 | Cloudflare 的 Linux 容器 | 你自己的电脑 |
| 是否需要本地 Node 环境 | 不需要 | 需要 |
| 是否要求代码已推到 GitHub | 是 | 否 |
| 适合场景 | 日常维护、增删图片 | 临时预览、CI 之外的快速验证 |

> 注意：`wrangler pages deploy` 会直接上传你本地 `public/` 的内容。
> 执行前请务必先跑 `npm run build`，否则可能上传过期的部署目录。

**本项目的构建不需要任何 Cloudflare API Token。** 只有在你想让我通过 API 自动创建
项目或修改 DNS 时才需要，且必须使用最小权限的 Token，绝不能写进代码或提交到仓库。

---

## 绑定自定义域名 api.qingyv.top

**先确认 `pages.dev` 地址一切正常，再绑定域名。**

### 需要你手动操作的步骤

1. 打开 Cloudflare 控制台 → **Workers & Pages** → 选中你的 Pages 项目
2. 进入 **Custom domains** 标签页 → 点击 **Set up a custom domain**
3. 输入 `api.qingyv.top` → 点击 **Continue**
4. Cloudflare 会检测 `qingyv.top` 是否已托管在你的账号下：
   - **已托管**：会自动创建一条指向 Pages 项目的 CNAME 记录，点 **Activate domain** 即可。
   - **未托管**：需要在你的 DNS 服务商处手动添加 CNAME，指向 `<项目名>.pages.dev`。
5. 等待状态变为 **Active**（通常几分钟内，证书签发可能稍久）

### DNS 变更说明

- 该操作会**新增**一条 `api` 子域的记录。
- **不会**修改或删除 `qingyv.top` 上任何已有记录（例如 `@`、`www` 或其他子域）。
- 我无法替你确认现有 DNS 状态，也不会主动修改任何 DNS 记录。

如果希望我通过 API 检查或配置 DNS，请提供 **Zone → DNS → Edit** 权限的
Cloudflare API Token（**不需要** Access Key ID / Secret Access Key / S3 端点，
那些是 R2 对象存储用的，本项目完全用不到）。我会在动手前把具体的记录变更列给你确认。

---

## 故障排查

| 现象 | 可能原因与处理 |
|---|---|
| 访问 `/` 返回 404 | 索引为空。检查 `images/` 里是否有受支持的图片，然后重新 `npm run build` |
| 访问 `/` 返回 400 | URL 里有拼错的参数。只支持 `?orientation=landscape\|portrait\|square` |
| 部署失败，提示文件过大 | `public/images/` 里有超过 25 MiB 的文件。运行 `npm run build`，脚本会自动为超大图生成压缩副本 |
| 部署后图片 404 | `public/images/` 与索引不同步。运行 `npm run build && npm run verify` 后重新提交 |
| 跳转到的图片打不开 | 大概率是文件名特殊字符问题。运行 `npm test`，其中有专门针对 `#`、`?`、中文、空格的用例 |
| 新增图片后线上没变化 | 确认已 `git push`，并在 Cloudflare 控制台确认本次构建成功 |
| `npm run verify` 报「源文件全部存在」失败 | 索引过期（图片被移动或删除）。重新运行 `npm run build` |

---

## 部署进度

- [x] 图片索引生成与校验脚本
- [x] Pages Functions 随机跳转接口
- [x] 缓存策略与路由隔离
- [x] 自动化测试（53 项）
- [x] 本地 Cloudflare 环境验证
- [x] 创建 GitHub 仓库并推送（含 205 张图片）
- [x] 部署到 Cloudflare Pages（GitHub 集成，推送后自动构建）
- [x] 绑定 `api.qingyv.top` 并签发 HTTPS 证书
- [x] 线上验收（29 项全部通过）

---

## 从本机推送的注意事项

本机所在网络**无法直连 `github.com:443`**（连接超时），但 `ssh.github.com:443` 可用。
因此本仓库的 `origin` 使用 SSH over 443，相关配置写在 `.git/config`（不随仓库分发）：

```bash
git remote get-url origin
# git@ssh.github.com:QingYvqwq/qingyv-random-image-api.git

git config core.sshCommand
# ssh -i ~/.ssh/id_ed25519_qingyv_api -p 443 -o StrictHostKeyChecking=accept-new
```

`~/.ssh/id_ed25519_qingyv_api` 是专为本仓库生成的密钥，已作为
[Deploy key](https://github.com/QingYvqwq/qingyv-random-image-api/settings/keys)
注册到该仓库（带 write 权限，仅限这一个仓库）。

**如果在新机器上克隆本仓库**，需要重新生成密钥并使用上面的命令配置 `origin`，
否则 `git push` 会卡在 `github.com` 超时。也可以临时改用 HTTPS 推送：

```bash
git remote set-url origin https://<用户名>:<PersonalAccessToken>@github.com/QingYvqwq/qingyv-random-image-api.git
```

> 不要把带 Token 的地址写入脚本或提交到仓库。
