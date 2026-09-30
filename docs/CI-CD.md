# CI/CD 设计与配置手册

> 基于 2026-09-30 对仓库的实测扫描编写。所有结论来自当前代码，不假设技术栈。

## 一、当前项目架构（实测）

| 维度 | 实测结果 |
| --- | --- |
| 前端 | 单个 `index.html`（942 KB / 2,806 行），CSS/JS/图标全内联，ES5 写法，94 个顶层函数，4 个 Tab（待办/健身/饮食/财务），无框架、无打包器 |
| 后端 | **无**。没有任何服务端代码、无 serverless 函数、无 BFF |
| 数据库 | **无自建库**。业务数据在 WorkBuddy 资料库的 6 张托管数据表里，通过 `window.__SMART_PAGE__.database` SDK 读写；SDK 缺失时降级 localStorage（11 个 `wb_*` 键）+ IndexedDB（照片缓存） |
| AI / Agent | 前端直连 OpenAI 兼容协议（默认 `https://api.deepseek.com`，可换 OpenAI / 硅基流动），用于饮食与健身分析；配置项存 localStorage（`wb_ai_sk` / `wb_ai_ep` / `wb_ai_mdl`） |
| MCP | **无**。未发现 MCP server / client 配置或依赖 |
| 外部 API | 3 个，均浏览器直连：DeepSeek（AI 对话）、百度菜品识别 `aip.baidubce.com`、USDA 营养 `api.nal.usda.gov` |
| 环境变量 | **无 `.env`、无 CI 变量**。所有配置在页面 UI 里填，落 localStorage |
| Docker | **无** Dockerfile / compose / 镜像。纯静态站点，不需要容器化 |
| 测试 | 本轮补齐前为零；现在有 `npm test`（7 项源码测试）+ `npm run smoke`（9 项冒烟）+ lint + typecheck |
| 部署方式 | 原先只有「资料库在线页」一条通道；本轮补了 GitHub Actions 三件套 |

**一句话**：这是一个零后端、零容器的静态单文件应用 + 托管数据表，CI/CD 的重心应该是「静态质量门禁 + 产物可回滚 + 部署后真校验」，而不是容器构建。

## 二、推荐的 CI/CD 架构

```
PR → main/develop
        │
        ▼
   ci.yml：Lint → 类型检查 → 单元测试（Node 20/22 矩阵）
        │               └→ 构建 → 冒烟 → 上传产物
        │
push develop ──▶ staging.yml：门禁 → 构建 → 冒烟 → 部署(Environment: staging) → 健康检查
        │
push main ─────▶ production.yml：门禁 → 构建 → 冒烟 → 部署(Environment: production) → 健康检查 → 失败通知
```

- **分支策略**：`develop` = 预发，`main` = 生产，功能分支只能通过 PR 合入（PR 必须过 CI）。
- **环境隔离**：部署目标与凭据全部挂在 GitHub Environment 上，workflow 代码不含任何主机地址或密钥。
- **同一份 workflow 代码，两种部署目标**：由 Environment 变量 `DEPLOY_TARGET` 决定走 `pages`（GitHub Pages，OIDC 免密钥）还是 `rsync`（自建服务器 / Nginx）。

## 三、需要配置的 Secrets 与 Variables

在 **Settings → Environments** 里建两个环境：`staging`、`production`（生产建议勾 Required reviewers）。

### Environment `staging`

| 类型 | 名称 | 说明 |
| --- | --- | --- |
| Variable | `DEPLOY_TARGET` | `pages` 或 `rsync`；**留空默认 `rsync`**（一个仓库只有一个 Pages 站点，预发默认走 Pages 会直接覆盖生产） |
| Variable | `HEALTH_URL` | 健康检查地址（rsync 模式必填） |
| Variable | `DEPLOY_PATH` | rsync 模式：服务器目录，如 `/var/www/staging` |
| Variable | `SSH_PORT` | 可选，默认 22 |
| Secret | `SSH_HOST` | rsync 模式：目标主机 |
| Secret | `SSH_USER` | rsync 模式：登录用户 |
| Secret | `SSH_KEY` | rsync 模式：ed25519 私钥全文 |

### Environment `production`

同上（`DEPLOY_TARGET` 留空默认 `pages`），另加：

| 类型 | 名称 | 说明 |
| --- | --- | --- |
| Secret | `NOTIFY_WEBHOOK` | 可选，部署失败时推送（企微/飞书/Slack 机器人地址） |
| Variable | `NOTIFY_ENABLED` | 可选，填 `true` 才会发失败通知（**if 条件里不能引用 secrets**，所以用变量做开关） |

> `pages` 模式**不需要任何 Secret**：GitHub Pages 用 OIDC（`id-token: write`）自动换取部署令牌。
> 仓库级（Settings → Secrets and variables → Actions）当前**无需配置任何值**。

## 四、部署目标

| 目标 | 适用场景 | 配置方式 |
| --- | --- | --- |
| **GitHub Pages**（默认） | 只想拿到一个公网链接，零运维 | Pages → Source 选 `GitHub Actions`；环境里 `DEPLOY_TARGET=pages` |
| **自建服务器 / Nginx**（rsync） | 内网、自定义域名、需要灰度或回滚目录 | 环境里 `DEPLOY_TARGET=rsync` + SSH 三件套 + `DEPLOY_PATH` + `HEALTH_URL` |

构建产物 `dist/` 含 `index.html`、`.nojekyll`（绕过 Jekyll）、`build-info.json`（版本/时间/体积）。

## 五、风险点

| # | 风险 | 影响 | 缓解措施 |
| --- | --- | --- | --- |
| 1 | 单文件 942 KB，全部逻辑在一个 `<script>` | 一处写错整页白屏，diff 难审 | lint + typecheck + 冒烟三重门禁；体积超 3MB 直接 fail |
| 2 | 无 TypeScript，静态检查覆盖有限 | 类型错误只能靠运行发现 | typecheck 做引用完整性/契约/DOM id/调用环检查；引入 TS 后可平滑替换为 `tsc --noEmit` |
| 3 | 外网部署后无资料库 SDK | 页面降级为本地存储，多设备不同步 | 构建按 `DEPLOY_TARGET` 自动剥离平台注入脚本；云同步仍走资料库原页 |
| 4 | AI Key 明文存 localStorage，浏览器直连第三方 API | Key 泄漏、配额被盗刷 | lint 扫描 `sk-`/`AKIA`/`Bearer` 明文并阻断；Key 只在本机填，不入库 |
| 5 | Pages 单站点，staging 与 production 容易混 | 预发覆盖了生产 | 两套环境各自的变量隔离；生产环境开启 Required reviewers；两 workflow 各自 concurrency 组 |
| 6 | 部署后只查状态码会「假绿灯」 | 200 但内容旧/白屏 | 健康检查同时校验标题与 `build:version`，版本不符会告警 |
| 7 | 无回滚机制 | 线上坏了只能重新改代码 | 生产产物保留 30 天；部署摘要给出回滚步骤 |
| 8 | develop / main 并行推送 | 部署互相踩踏 | 两条 workflow 各自 `concurrency`，`cancel-in-progress: false`（部署不可中断） |
| 9 | 页面里 36 处 `alert()` 弹窗、第三方 API 无服务端代理 | 体验与可用性依赖第三方配额 | 后续可加服务端代理层，把 API Key 移到服务端；当前为纯前端形态，CI 不做额外约束 |

## 六、GitHub 首次配置 Checklist（全部在网页端人工完成）

> 按顺序做。仓库里不存任何密钥，下面的 Secrets 只在 GitHub 上填。

### 步骤 0 · 建仓库并推分支（本地命令行）

```bash
git remote add origin https://github.com/<你的账号>/<仓库名>.git
git push -u origin main
git push -u origin develop
```
GitHub 网页端新建仓库时**不要**勾选 README / .gitignore / license（保持空仓库）。

### 步骤 1 · Settings → Environments → New environment

建两个环境：**`staging`**、**`production`**。

**`staging`**

| 位置 | 名称 | 填什么 |
| --- | --- | --- |
| Secrets | `SSH_HOST` | staging 服务器域名或 IP |
| Secrets | `SSH_USER` | SSH 登录用户 |
| Secrets | `SSH_KEY` | ed25519 **私钥全文**（含 BEGIN/END 行） |
| Variables | `DEPLOY_TARGET` | `rsync`（推荐） |
| Variables | `DEPLOY_PATH` | 如 `/var/www/staging` |
| Variables | `HEALTH_URL` | 如 `https://staging.example.com` |
| Variables | `SSH_PORT` | 可选，默认 22 |

**`production`**

| 位置 | 名称 | 填什么 |
| --- | --- | --- |
| Secrets | `SSH_HOST` / `SSH_USER` / `SSH_KEY` | 同左（rsync 模式才需要） |
| Secrets | `NOTIFY_WEBHOOK` | 可选，飞书/企微/Slack 机器人地址 |
| Variables | `DEPLOY_TARGET` | `pages`（推荐）或 `rsync` |
| Variables | `DEPLOY_PATH` | rsync 模式必填，如 `/var/www/workbench` |
| Variables | `HEALTH_URL` | rsync 模式必填；pages 模式留空也能跑（工作流会自己拿地址） |
| Variables | `SSH_PORT` | 可选，默认 22 |

- 点 **Add secret / Add variable** 逐个添加；改完可再点编辑修改。
- `production` 建议勾选 **Required reviewers**（生产发布前人工确认一次）。

### 步骤 2 · Settings → Pages

- **Build and deployment → Source** 选 **GitHub Actions**（不是 "Deploy from a branch"）。
- 自定义域名：在 Custom domain 填域名 → 去 DNS 加一条 `CNAME` 指向 `<账号>.github.io` → 勾选 **Enforce HTTPS**。
- 权限不用额外改：工作流已在 job 级别声明 `pages: write` + `id-token: write`（OIDC，不需要任何 token 型 Secret）。

### 步骤 3 · Settings → Environments → 每个环境的保护规则

- `staging` → **Deployment branches**：选 *Selected branches*，只允许 `develop`。
- `production` → **Deployment branches**：选 *Selected branches*，只允许 `main`；并勾 **Required reviewers**。

### 步骤 4 · Settings → Branches（分支保护）

- `main`：勾 **Require a pull request before merging** + **Require status checks to pass**，勾选状态检查 `Lint / 类型检查 / 单元测试 (Node 20)`、`Lint / 类型检查 / 单元测试 (Node 22)`、`构建 + 冒烟`。
- `develop`：同样勾 **Require status checks to pass**（可选但推荐）。

### 步骤 5 · 首次验证顺序

1. 推一个空提交到 `develop` → Actions 里 `Deploy Staging` 跑绿 → 看健康检查日志出现「通过」。
2. 开 PR `develop → main` → `CI` 跑绿。
3. 合并 PR → `Deploy Production` 自动跑 → 输出里给出线上地址。

### Pages 模式的环境冲突（重要）

一个仓库**只有一个 Pages 站点**。若 `staging` 与 `production` 同时设为 `DEPLOY_TARGET=pages`，
预发部署会直接覆盖生产。因此本仓库把 **staging 默认设为 `rsync`、production 默认设为 `pages`**，
staging 走 pages 必须显式配置，且要自己承担覆盖风险。

另外：`actions/deploy-pages` 官方推荐把 job 环境命名为 `github-pages`；本仓库用的是 `production`
（官方允许，只是不推荐）。如果之后 Pages 部署报环境相关错误，把 production.yml 里 deploy job 的
`environment.name` 改成 `github-pages` 即可，其余不用动。

## 七、本地等价命令

```bash
npm run ci          # lint → typecheck → test → build → smoke，与 PR 门禁完全一致
npm run healthcheck -- --url https://your-site --expect <版本>
```
