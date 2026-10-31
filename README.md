# WhoIP

IP 查询和 WHOIS 放在同一个站里。打开页面能看自己的网络信息，也能查任意 IP 或域名的位置；`/whois` 查域名的注册局、日期和名字服务器。两处的「联系」都指向 `/contact`，没有第二套表单。

品牌名是 **WhoIP**，以后可以换。页面沿用米黄纸底、粗黑描边、硬阴影的便当格。

## 架构

```
浏览器
  ├─ /              IP 查询页。curl / wget 访问时只回一行纯文本 IP
  ├─ /whois         WHOIS 查询页
  ├─ /contact       唯一联系页
  ├─ /json          边缘 whoami，和 /api/whoami 同一份数据
  └─ /api/whois/*   Pages Function，转发到 who-dat
                         │  WHOIS_API_BASE
                         ▼
                    who-dat（Go，独立进程）
                      GET /v1/whois/{domain}
                      GET /multi?domains=a.com,b.com
                      GET /health
```

Cloudflare Pages Functions 不能跑完整的 Go 程序，所以 who-dat 不塞进 Pages。仓库仍然一次交齐：

- `public/`：三个页面和 IP 页的前端逻辑
- `functions/`：whoami、curl 分流、WHOIS 反向代理、联系方式配置
- `who-dat/`：WHOIS / RDAP API 的源码副本，许可证见该目录的 `LICENSE`

浏览器只请求本站的 `/api/whois/example.com`。代理把路径限制在域名上，不跟随上游重定向，避免变成开放代理。who-dat 可以只对这台前端开放。

who-dat 自己也带了一套页面和联系表单，那是上游项目的界面。WhoIP 不使用它。对访客只公开本仓库的 `/`、`/whois`、`/contact`。

### 环境变量

| 变量 | 用在哪 | 作用 |
| --- | --- | --- |
| `WHOIS_API_BASE` | Pages / 本地预览 | who-dat 的根地址，例如 `https://whois.example.com` 或 `http://127.0.0.1:8080`。不带末尾路径 |
| `WHOIS_API_KEY` | 同上 | 可选。who-dat 设置了 `AUTH_KEY` 时，代理会带 `Authorization: Bearer` |
| `CONTACT_EMAIL` | `/api/site` | 联系页邮箱。不填或格式不对时显示 `hello@example.com` |
| `CONTACT_URL` | `/api/site` | 可选链接，只接受 `http` 或 `https` |
| `CONTACT_URL_LABEL` | `/api/site` | 上面那个链接的文字，默认「相关链接」 |

`/api/site` 只返回品牌、邮箱、链接和「WHOIS 是否已配置」。它不回传 `WHOIS_API_BASE`。

who-dat 进程自己的变量（缓存、限流、端口）见 `who-dat/.github/README.md`。常用的是 `PORT`（默认 `8080`）和 `ENABLE_CACHE`（默认开）。

## 本地运行

需要 Node.js 20+，以及 Go **1.26.5**（`who-dat/go.mod` 里的 toolchain）。Docker 部署不要求本机装 Go。

两个终端：

```bash
# 终端 1：WHOIS API
cd who-dat
go run ./cmd/server
# 监听 :8080 ，GET /health 返回 {"status":"ok"}

# 终端 2：页面
cp .dev.vars.example .dev.vars
npm install
npm run preview
```

打开 <http://127.0.0.1:8788> 、<http://127.0.0.1:8788/whois> 、<http://127.0.0.1:8788/contact>。

`npm run preview` 用 Node 直接跑 `functions/` 里的同一套处理函数，所以 `WHOIS_API_BASE=http://127.0.0.1:8080` 可以打到本机的 who-dat。

`npm run dev` 是 `wrangler pages dev`，更接近 Cloudflare 运行时。Workers 运行时经常拒绝访问回环地址；本机 who-dat 请用 `npm run preview`。把 `WHOIS_API_BASE` 指到一台公网 who-dat 时，两种方式都可以。

用 Docker 起 API：

```bash
docker compose up --build
```

然后同样 `npm run preview`。

检查：

```bash
curl -s http://127.0.0.1:8080/health
curl -s http://127.0.0.1:8788/api/whois/example.com
curl -s http://127.0.0.1:8788/api/site
npm test
```

`cd who-dat && go test ./...` 跑的是上游测试。

## 部署

### 前端：Cloudflare Pages

项目根目录就是这个仓库。

- 构建命令：留空
- 输出目录：`public`
- `functions/` 放在仓库根目录，Pages 会把它当成 Functions
- `wrangler.jsonc` 里写了 `pages_build_output_dir`

在 Pages 项目的 Production 和 Preview 环境变量里填上表里的五项。`WHOIS_API_BASE` 用 who-dat 的公网地址，不要写 `127.0.0.1`。

命令行部署（先 `npx wrangler login`）：

```bash
npx wrangler pages deploy public --project-name whoip
```

环境变量仍在 Pages 项目设置里改，不写进仓库。`.dev.vars` 只给本地用，已在 `.gitignore` 里。

### WHOIS API：who-dat

在 `who-dat/` 目录里构建和发布。不要把整个 WhoIP 仓库当成一个 Go 模块部署。

**本机二进制**

```bash
cd who-dat
go build -o bin/who-dat ./cmd/server
PORT=8080 ./bin/who-dat
```

**Docker**

`who-dat/Dockerfile` 是上游的多阶段构建，镜像入口是 `who-dat`，容器端口 `8080`。仓库根目录的 `docker-compose.yml` 会构建这个目录并映射到宿主机 `8080`。

```bash
docker compose up --build -d
```

把镜像推到任意能跑容器的平台即可。Fly.io 可以在 `who-dat/` 里用这份 Dockerfile：`fly launch` 之后确认对外端口是 `8080`，再把得到的 `https://….fly.dev` 填进 Pages 的 `WHOIS_API_BASE`。

**Vercel**

`who-dat/vercel.json` 指定了 Go。把 **`who-dat/` 单独做成一个 Vercel 项目**（Root Directory 设为 `who-dat`），不要用仓库根目录。部署完成后把它的域名填进 `WHOIS_API_BASE`。

上游说明还在 `who-dat/.github/README.md`。

如果 who-dat 设了 `AUTH_KEY`，Pages 侧要配同一个值到 `WHOIS_API_KEY`。不设密钥时，API 是公开的，请自己加网络限制或速率限制（who-dat 在 Vercel 上默认有每 IP 限额）。

建议不要把 who-dat 的 `/contact` 放进导航或文档给访客用。需要的话可以在反向代理上只放行 `/v1/whois/`、`/multi` 和 `/health`。

### 联系方式

编辑 Pages 环境变量或本地 `.dev.vars`：

```bash
CONTACT_EMAIL=you@example.com
CONTACT_URL=https://example.com/about
CONTACT_URL_LABEL=关于我们
```

`CONTACT_URL` 留空就只显示邮箱。邮箱不填时，页面和 `/api/site` 都使用占位 `hello@example.com`。改完重新部署 Pages（或重启 `npm run preview`）即可，不用改 HTML。

## 接口摘要

IP 部分与来源站相同：

```bash
curl -L https://你的域名
curl -sL https://你的域名/json?pretty
```

WHOIS：

```bash
curl -sL https://你的域名/api/whois/example.com
curl -sL "https://你的域名/api/whois?domains=example.com,wikipedia.org"
```

直接打 who-dat 时路径是 `/v1/whois/example.com` 和 `/multi?domains=`。本站页面走的是前面带 `/api` 的那组。

## 和来源的差别

材料来自两处，都按远程仓库读取后迁入：

- IP 前端与边缘函数：[niesgeek/ip](https://github.com/niesgeek/ip) 的 `cursor/ip-lookup-pages-9e91`，提交 `843ec2a7fee6ba60f3aaffbddf5e7d986337ad03`
- WHOIS API：[niesgeek/who-dat](https://github.com/niesgeek/who-dat)，提交 `74424bcdf94a6bbc6f20c13507ccfe5b7b24258e`。它 fork 自 [lissy93/who-dat](https://github.com/lissy93/who-dat)

和这些来源、以及参考站 ip.fs.kg 相比：

- 站名是 WhoIP。不用 IP Lookup 做顶栏品牌，也不用参考站的 F.S. / Fast & Secure 文案
- 顶栏和底栏固定为 IP、WHOIS、联系。IP 页原来的章节锚点改到查询卡内部
- 新增 `/whois`。它调用本仓库的 `/api/whois/:domain`，由函数转发到 who-dat 的 `/v1/whois/:domain`，样式跟 IP 页同一套便当格
- 新增 `/contact`，是 IP 页和 WHOIS 页共用的唯一联系入口。只有邮箱和可选链接，没有 who-dat 那套 Turnstile / Resend 表单
- 没有英文版、OpenAPI 文档站、访问统计信标
- IP 的多源地理、DoH、风险分、curl 分流和便当格布局保持迁入时的行为。风险分仍是关键词和少量 ASN 的启发式，没有逐条复刻参考站的内部规则
- who-dat 的代码放在 `who-dat/`，Go 模块路径和 MIT 声明保持上游原样，没有改查询逻辑

## 许可证与署名

`who-dat/` 是 MIT 许可的派生副本：

> Copyright (c) 2022 Alicia Sykes <https://aliciasykes.com>

完整文本在 `who-dat/LICENSE`。分发这一目录时请保留该文件。WhoIP 页面上的 WHOIS 结果卡也注明了这个来源。

IP 查询页的前端与 `functions/` 里的 whoami 逻辑来自 niesgeek/ip 的上述提交，在本仓库里改了导航、站名，并加上 WHOIS 代理和联系页。
