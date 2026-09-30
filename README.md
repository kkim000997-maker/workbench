# 个人工作台 · 源码仓库

单文件 HTML 工作台（待办 / 健身 / 饮食 / 财务 四个模块）的 Git 仓库与 CI/CD 配置。
应用本体 `index.html` 全内联、零外部依赖，**没有打包器、没有后端、没有容器**——
所以「构建」只做校验 + 元信息注入 + 产出 `dist/`。

## 目录结构

```
.
├── index.html                     # 应用本体（单文件，942 KB，不要手工改业务逻辑）
├── scripts/
│   ├── lint.mjs                   # Lint：零外链 / 安全 / 结构 / 移动端规范
│   ├── typecheck.mjs              # 类型检查：引用完整性 + 契约 + 渲染调用图无环
│   ├── build.mjs                  # 构建：校验 → 剥离平台脚本 → 注入版本 → 产出 dist/
│   ├── smoke.mjs                  # 冒烟：起本地静态服务真实取页
│   └── healthcheck.mjs            # 部署后健康检查：状态码 + 标题 + 版本号
├── tests/validate.test.mjs        # 单元测试（零依赖，node:test）
├── docs/CI-CD.md                  # CI/CD 设计、Secrets 清单、风险点
├── .github/workflows/
│   ├── ci.yml                     # PR：lint → 类型检查 → 单元测试 → 构建 → 冒烟
│   ├── staging.yml                # develop：部署 staging + 健康检查
│   └── production.yml             # main：部署 production + 健康检查 + 失败通知
└── dist/                          # 构建产物（已 gitignore）
```

## 本地命令

```bash
npm run lint        # 静态规范与安全检查
npm run typecheck   # 引用完整性 / 契约 / 调用环
npm test            # 单元测试（7 项）
npm run build       # 生成 dist/
npm run smoke       # 冒烟测试（9 项）
npm run ci          # 以上全部，与 PR 门禁完全一致
```

## 流水线

| 工作流 | 触发 | 动作 |
| --- | --- | --- |
| `ci.yml` | PR → main/develop、手动 | Node 20/22 矩阵跑 lint → typecheck → test，再构建 + 冒烟 + 上传产物 |
| `staging.yml` | push `develop` | 门禁 → 构建 → 部署到 Environment `staging` → 健康检查 |
| `production.yml` | push `main`、手动 | 门禁 → 构建 → 部署到 Environment `production` → 健康检查 → 失败通知 |

部署目标由 Environment 变量 `DEPLOY_TARGET` 决定：`pages`（GitHub Pages，OIDC 免密钥）或 `rsync`（自建服务器）。
完整的 Secrets / Variables 清单、环境搭建步骤与风险点见 **[docs/CI-CD.md](docs/CI-CD.md)**。

## 首次启用（GitHub Pages）

1. 仓库 **Settings → Pages → Source** 选 `GitHub Actions`；
2. 建 `staging`、`production` 两个 Environment（生产建议开 Required reviewers）；
3. 推 `develop` 走预发、合 `main` 走生产，工作流输出里给出线上地址。

## 注意事项

- **不要改 `index.html` 的业务逻辑与数据读写**：CI 只做校验与发布，不改业务代码。
- **外网部署后数据存本地**：资料库数据 SDK 只在 WorkBuddy 平台内注入，构建时自动剥离该脚本，页面降级为本地存储（代码已有兜底分支）；需要云同步请继续使用资料库里的原页面。
- **零外链是硬约束**：lint 会拦截任何 CDN / 外部资源引用，避免「保存了 HTML、库却 404」。
- **不要提交密钥**：AI Key 只存在浏览器 localStorage，lint 会扫描 `sk-` / `AKIA` / `Bearer` 明文并阻断。
- **体积阈值 3MB**：当前 942 KB，超出即失败并提示拆分模块。
