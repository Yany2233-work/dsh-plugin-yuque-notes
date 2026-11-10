# dsh-plugin-yuque-notes（语雀笔记）

把当前会话里与 agent 的对话**提炼成一篇笔记**，并直接写入你已登录的**语雀**账号（知识库）。

- 斜杠命令：`/yuque-save` —— 让 agent 先提炼，再调用 `yuque_save` 工具上传；支持 `@目录` / `--catalog` 在保存时指定目录
- 模型工具：`yuque_save` —— 接收 `title` + `markdown`（可选 `namespace`、`catalog`），创建语雀文档并返回链接
- 凭据命令：`/yuque-login`（**自动打开浏览器登录并抓取登录态**，免费账号可用）、`/yuque-token`（开放 API Token，需语雀会员）
- 辅助命令：`/yuque-account`（查看登录账号信息）、`/yuque-book`（查看配置与可用知识库）、`/yuque-dir`（列出目标知识库的目录，供选择保存位置）

## 工作原理

```
/yuque-save [标题] [@目录]
      │  命令处理器（不经过模型消息）；若 @目录 给出则先校验目录存在
      ▼
agent.followup(提炼指令)      ← 让 agent 读自己的会话历史
      │
      ▼
模型输出 Markdown 笔记 + 调用 yuque_save 工具（可带 catalog 指定目录）
      │
      ├─ 有 Token → API v2  POST /repos/{namespace}/docs（写到知识库根目录）
      └─ 只有 Cookie → 网页接口 POST /api/docs（x-csrf-token + Cookie，可带 parent_id 写入目录）
      ▼
返回文档链接 https://www.yuque.com/{login}/{book}/{slug}
```

要点：

- 提炼用的是**当前会话的上下文**，不需要把整段对话再抄一遍给模型。
- 两种凭据都能用：Token 走官方 v2 接口；Cookie 走网页版接口（带 `x-csrf-token` 与 `Origin/Referer`）。
- 凭据都存在 DSH 凭据库（`~/.dsh/.credentials.yaml`），**不写进配置文件**。
- 目录选择：`/yuque-save 标题 @目录/路径`（或 `--catalog`）在保存时指定目录；也可让 `yuque_save` 传 `catalog`（目录名或路径）或配置 `catalog` 字段。**仅网页登录态支持**（开放 API 不能把文档挂到指定目录，会明确报错）。

## 安装（第三方）

本插件是一个标准的 DeepSeek Harness 组合包（bundle，即一个普通 npm 包），第三方用户任选一种来源安装即可：

| 来源 | 命令 |
|---|---|
| npm 源（发布后） | `pnpm add dsh-plugin-yuque-notes` |
| Git 仓库 | `pnpm add github:Yany2233-work/dsh-plugin-yuque-notes`（或 `git+https://github.com/Yany2233-work/dsh-plugin-yuque-notes.git`） |
| 压缩包 | `pnpm add ./dsh-plugin-yuque-notes-0.2.0.tgz`（或 GitHub Release 上挂的 `.tgz` 地址） |

安装进目标 profile（以 `desktop` 为例，把 `<profile>` 换成你的 profile 名）：

```powershell
# 用 DSH 自带的 node/pnpm（也可用系统安装的 pnpm）
& "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" `
  "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.cjs" `
  add --dir "$env:USERPROFILE\.dsh\profiles\desktop" "<来源，如 dsh-plugin-yuque-notes>"
```

然后确认 profile 的 `package.json` 两处：

```json
{
  "dependencies": {
    "dsh-plugin-yuque-notes": "^0.2.0"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-plugin-yuque-notes"]
    }
  }
}
```

- `dependencies` 由上面的 `pnpm add` 写入；
- `dsh.profile.bundles` 里加入 `"dsh-plugin-yuque-notes"`（安装/启用组合包时通常会自动加入）。

最后**重启 DeepSeek Harness**（新包需重启才会加载）。挂载条目由插件自带的 `cordis.patch.yml` 提供（`id: yuque-notes`），**不要在** profile 的 `cordis.patch.yml` 里再写 `- insert:`。

### 开发者本地安装（软链）

作者本机当前用软链方式接入 `desktop` profile，改源码即刻生效：

| 项目 | 位置 |
|---|---|
| 插件源码 | `D:\workspace\plugins\yuque-notes` |
| 依赖声明 | profile `package.json` → `dsh-plugin-yuque-notes: link:D:/workspace/plugins/yuque-notes` |
| bundle 选择 | 同一文件的 `dsh.profile.bundles` 已包含 `dsh-plugin-yuque-notes` |
| 挂载条目 | 插件自带 `cordis.patch.yml`（`id: yuque-notes`），profile 的 `cordis.patch.yml` **不再重复 insert** |

换机器软链方式同第三方安装，只需把来源换成 `link:<你的本地路径>`。

覆盖配置时**不要**再写 `- insert:`，而是按 id 覆盖：

```yaml
- id: yuque-notes
  config:
    book: 'your-login/your-book'
```

## 配置凭据

两条路，任选其一：

### A. 网页登录态（免费账号可用，推荐）

语雀的开放 API Token 属于会员功能；普通账号直接用浏览器里已有的登录态即可。下面这条路径已在真实账号上验证通过（读取账号、列 27 个知识库、创建并删除文档）。

**方式一（推荐）：自动登录。**

直接执行：

```
/yuque-login
```

插件会：

1. 用一个**独立的临时配置**启动一个干净的 Microsoft Edge 窗口，打开语雀登录页；
2. 你在窗口里正常登录语雀，完成后**关闭该窗口**；
3. 插件立即读取该临时配置的 Cookie 数据库，用 Windows DPAPI + AES-GCM 解出 `_yuque_session`（和 `cookieToken`/`ctoken`）；
4. 调用 `GET /api/mine` 验证后保存进 DSH 凭据库，并把你登录的账号名发回对话。

> 平台限制说明：DSH 工作台的浏览器标签页无法内嵌语雀登录页（语雀返回 `X-Frame-Options: SAMEORIGIN`），所以改用「独立的 Edge 窗口」承载登录；登录完全发生在语雀官网，插件只读取它自己那个临时配置的本地 Cookie，不接触你日常浏览器里的数据。若没有安装 Edge，`/yuque-login` 会提示并退回下面的手动方式。

**方式二：手动粘贴 Cookie。**

1. 浏览器登录 <https://www.yuque.com>。
2. 按 F12 → Network，刷新页面，点任意一条 `yuque.com` 请求，在 Request Headers 里复制整行 `Cookie:`（含 `_yuque_session`，通常还有 `cookieToken` 或 `ctoken`）。
3. 执行：

```
/yuque-login _yuque_session=...; cookieToken=...
```

插件会立刻调用 `GET /api/mine` 验证，并显示账号名。Cookie 只保存进 DSH 凭据库。

真实测得的接口行为：

| 用途 | 接口 | 说明 |
|---|---|---|
| 当前账号 | `GET /api/mine` | 返回 `{ data: { id, login, name, avatar_url, ... } }` |
| 知识库列表 | `GET /api/mine/books` | 返回 `{ data: [{ id, name, slug, type }] }`；**没有** `namespace` 字段，文档地址用 `login/slug` 拼接 |
| 知识库目录 | `GET /api/books/{bookId}/toc` | 返回知识库的目录树；路由已实测存在（匿名 401），节点字段名**待确认真实账号回显**（见下） |
| 创建文档 | `POST /api/docs` | 需要 `Origin`/`Referer`；`x-csrf-token` 可选（`ctoken`/`cookieToken` 都可）。可带 `parent_id`（目录节点 id）把文档挂到指定目录。成功返回 200 + `{ data: { id, slug, ... } }` |
| 读取文档 | `GET /api/docs/{id}?book_id={bookId}` | `GET /api/docs/{slug}` 会 404 |
| 删除文档 | `DELETE /api/docs/{id}` | 200 即删除成功 |

正文用 `body_format: "markdown"` 提交后，语雀会把它转成 `format: "lake"` 的富文本（`content` 字段里能看到 `<h1>`、`<ul>`、`codeblock`、`table`），`origin_format` 仍记为 `markdown`。

> 待实测：目录写入依赖两个字段名——目录树端点 `GET /api/books/{bookId}/toc` 的**节点字段名**（`id/uuid/title/parent_id/depth` 之外语雀的真实命名），以及创建文档时挂目录用的 **`parent_id` 字段名**。前者路由已确认存在、后者与既有 `book_id` 命名风格一致；实现已按此写好并在 `lib/yuque-client.js` 的 `normalizeTocNodes`/`createSessionDoc` 集中处理，若真实账号回显不一致，改这两处即可。首次启用目录功能时请用 `/yuque-dir` 验证目录树、再 `/yuque-save` 验证落到指定目录。

> Cookie 等同于你的登录凭证。想撤销：先在任意命令里执行 `/yuque-login` 重新覆盖，或在语雀「退出登录」后它自动失效。

### B. 开放 API Token（需会员）

1. 打开 <https://www.yuque.com/settings/tokens>，新建 Token，权限勾选「知识库」读写。
2. 执行：

```
/yuque-token 你的Token
```

插件会调用 `GET /user` 验证并显示账号名。

## 使用

```
/yuque-save                     由模型拟标题，自动选知识库（写根目录或配置里的 catalog）
/yuque-save 部署复盘 2026-11    指定标题
/yuque-save 复盘 @工作/复盘     指定标题 + 保存到「工作/复盘」目录
/yuque-save @复盘               只指定目录，标题由模型拟
/yuque-save 复盘 --catalog 复盘 等价于 @复盘 写法（--dir / --目录 为别名）
/yuque-account                  查看当前语雀登录账号（昵称、login、ID、头像、凭据类型、知识库数）
/yuque-book                     查看凭据状态和默认知识库
/yuque-book list                列出账号下可用的知识库
/yuque-book 笔记                按关键词筛选知识库
/yuque-dir                      列出目标知识库的目录树（缩进表示层级）
/yuque-dir 复盘                按关键词筛选目录
```

选择保存目录（知识库内的分组/文件夹）：

- **保存时指定**：`/yuque-save 标题 @目录/路径`，或 `/yuque-save 标题 --catalog 目录/路径`（`--dir`、`--目录` 为别名；路径含空格时用引号，如 `--目录 "工作/复盘"`）。插件会**先校验目录存在**再让模型提炼，目录不存在会立即报错并提示 `/yuque-dir`，不会白跑一次提炼。
- 固定某个目录：插件配置 `catalog` 填目录名或路径（如 `复盘`、`工作/复盘`），之后 `/yuque-save` 自动写入该目录（保存时未显式指定目录时生效）。
- 对 agent 说「把这段结论存到语雀的『复盘』目录」，它会调用 `yuque_save` 时带上 `catalog: "复盘"`。
- 用 `/yuque-dir` 先列出目录名，再按名字指定；支持斜杠路径匹配子目录。
- 仅网页登录态（Cookie）支持写入指定目录；Token 模式下指定目录会立即明确报错（开放 API 限制），请改用 `/yuque-login`。

`/yuque-account` 的输出示例：

```
语雀登录账号：张三（zhangsan）
账号 ID：123456
头像：https://cdn.nlark.com/avatar/....
凭据类型：网页登录态（Cookie）
可用知识库：3 个，写入时自动使用第一个
```

上传完成后，模型会回复类似
`https://www.yuque.com/your-login/your-book/abc123` 的链接。

也可以直接对 agent 说「把刚才的结论整理成笔记存到语雀」，它会调用 `yuque_save`。

## 配置项（`cordis.patch.yml` 中 `yuque-notes` 行）

| 字段 | 默认值 | 说明 |
|---|---|---|
| `book` | `''` | 目标知识库，可写 namespace（`login/book-slug`）、slug 或知识库名称。留空 = 自动取账号下第一个知识库 |
| `catalog` | `''` | 目标知识库内的目录（目录名或路径，如 `复盘`、`工作/复盘`）。留空 = 写知识库根目录。仅网页登录态支持 |
| `apiBase` | `https://www.yuque.com/api/v2` | 仅 Token 模式生效；私有化部署时改这里 |
| `public` | `false` | 新文档是否公开；`false` 表示私密（仅自己可见） |
| `edgePath` | `''` | 自动登录用的 Edge 可执行文件；留空自动探测 |
| `loginTimeoutMs` | `180000` | 自动登录等待窗口关闭的毫秒数（默认 3 分钟） |
| `token` | 不推荐 | 直接写死 Token，会落进配置文件；优先用 `/yuque-token` |
| `cookie` | 不推荐 | 直接写死 Cookie，会落进配置文件；优先用 `/yuque-login` |

环境变量兜底：`YUQUE_TOKEN`、`YUQUE_COOKIE`、`YUQUE_BOOK`、`YUQUE_CATALOG`、`YUQUE_API_BASE`。

## 返回与错误

| 情况 | 表现 |
|---|---|
| Token 未配置 | `/yuque-save` 直接提示先执行 `/yuque-token`，不会触发模型调用 |
| Token 失效 | `/yuque-token` 保存后提示校验失败；`yuque_save` 返回 `401 AUTH` |
| 账号下没有知识库 | `NO_BOOK`：提示先在语雀建库，或填写 `book` |
| 目录不存在 | `NO_CATALOG`：提示运行 `/yuque-dir` 查看可用目录 |
| Token 模式指定目录 | `NO_CATALOG_TOKEN`：开放 API 不支持写目录，提示改用 `/yuque-login` |
| 网络 / 代理不通 | `NETWORK`：提示检查网络或代理 |
| 语雀限流 | `429 RATE_LIMIT`：稍后重试 |

## 自测

```powershell
& 'C:\Users\biu\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe' `
  --test 'D:\workspace\plugins\yuque-notes\test\*.test.js'
```

49 个用例覆盖：命令/工具注册与 schema 合规、Token 与 Cookie 存取、账号信息展示、提炼指令内容、两种上传体（v2 与网页接口）、目录树读取与目录解析、`parent_id`/`parent_uuid` 写入、cookie/ctoken 解析、namespace 解析、HTTP 错误映射，以及浏览器自动登录的纯函数链路（`v10` Cookie 加解密、`DPAPI` 密钥派生、Edge 139 的 `SHA-256(域名)` 绑定剥离、Cookie 拼接、Edge 探测、进程退出等待）。全部用 mock fetch，不访问真实语雀；自动登录的浏览器子进程部分未在单测里启动。

## 故障排查

| 现象 | 原因与处理 |
|---|---|
| 启用失败：`unsupported JSON schema: schema.properties.url.required is not supported on type "string"` | 工具 schema 用了 `{ type: 'string', required: true }` 写法。DSH 只接受对象级 `required: [...]`，属性级 `required` 会被拒绝。0.2.0 已修正 |
| 启用失败：`duplicate plugin id` | profile 的 `cordis.patch.yml` 又手写了一条 `- insert: - id: yuque-notes`；删掉，挂载条目由插件自带 patch 提供 |
| 启用失败：`Cannot find module 'dsh-plugin-yuque-notes'` | profile 里没有安装成功；重跑 `pnpm add --dir <profile> 'link:D:/workspace/plugins/yuque-notes'` 后重启 |
| 命令不出现 | 新包需要重启 DSH 才会重新加载模块（配置文件热更新不覆盖已加载的 JS） |
| `/yuque-login` 报 401 | Cookie 已过期或被登出；重新登录语雀并复制最新的整行 Cookie，或直接 `/yuque-login` 自动登录 |
| 自动登录提示「未找到 Edge」 | 机器上没装 Microsoft Edge，或装在非标准路径；在配置里设 `edgePath` 指向 `msedge.exe`，或改用手动粘贴 `<Cookie>` |
| 自动登录显示「等待浏览器登录超时」 | 打开窗口后一直没完成登录/关闭窗口；重新 `/yuque-login`，登录后**关闭窗口**即触发读取 |
| 自动登录显示「不是 v10 加密」 | 浏览器把 Cookie 写成 v20（app-bound）。当前机器实测为 v10，若触发此错误请改用手动粘贴 `<Cookie>` |
| 自动登录报「Cannot convert argument to a ByteString…65533 无法连接语雀」 | 早期版本把 Edge 139 新加的 **SHA-256(域名) 前缀**当成了密文，解出的值带 `U+FFFD` 被 fetch 拒绝。0.2.x 已自动剥离该 32 字节前缀并验证通过，重启加载新代码即可 |
| 报 `both ctoken and referer check error` | Cookie 里缺 `ctoken`；复制时要把 `ctoken=...` 一起带上（插件会自动加 `Origin/Referer`） |
| Token 页面提示需要会员 | 语雀开放 API 是会员功能；改用 `/yuque-login` 走网页登录态 |

## 安全与边界

- 插件只在**你主动执行命令或要求模型保存**时才访问语雀，不做后台同步。
- 每次 `/yuque-save` 创建**一篇新文档**，不会覆盖已有笔记（避免误删）。
- 文档默认私密；要公开需显式配置或在调用时传 `public: true`。
- 上传内容就是模型生成的 Markdown，发之前可以先在对话里看一眼；不满意可再 `/yuque-save` 一次并手动删除旧文档。