# 个人工作台 · 架构分析

> 分析对象：资料库在线页「个人工作台」（`https://www.workbuddy.cn/space/d/dXHb92MXAOT34dJjdTN82B`）
> 分析时间：2026-09-30 · 源码 `index.html`，944,276 字符 / 2,806 行

## 1. 技术形态：单文件静态应用（无构建工具链）

| 维度 | 现状 |
| --- | --- |
| 交付形态 | 单个 `index.html`，CSS/JS/图标全内联 |
| 运行时 | 浏览器直接打开，ES5 兼容写法（`var` + 普通函数），无框架、无打包器 |
| 外部依赖 | **0 个**。无 CDN、无字体、无图表库，图表用内联 SVG 手写，图标用内联 SVG path |
| 平台依赖 | 1 个：`<script src="/page/page_comm/inject.js">`（资料库运行时注入数据 SDK） |
| 代码规模 | 94 个顶层函数，集中在 1 个 `<script>` 块（约 11 万字符） |

**结论**：这是一个「零运维」形态的产物——优点是离线可用、双击即开；代价是没有模块边界、没有构建期保护，任何一处语法/逻辑错误都会直接白屏。

## 2. 视图结构：4 个业务模块 + 顶部今日区

| Tab | 模块 | 数据 |
| --- | --- | --- |
| `todo` | 待办 | 待办表（按截止日期升序） |
| `fit` | 健身 | 健身记录表 + 健身计划表 + 动作库 |
| `diet` | 饮食 | 饮食记录表 + 食物成分库 + AI 识别（视觉/大模型） |
| `finance` | 财务 | 财务流水表，支持 CSV 导入、分类统计 |

顶部「今天要处理」区由 `collectToday()` 聚合各模块的逾期与今日项，渲染由 `renderToday()` 承担。

## 3. 数据层：云端 SDK 为主，本地降级兜底

```
window.__SMART_PAGE__.database (资料库 SDK)   ←── 6 张数据表，分页拉取（pagedLoad，pageSize 200）
        │  缺失时降级
        ▼
localStorage / IndexedDB                      ←── 偏好设置、AI 配置、照片缓存
```

- **资料库表（6 张）**：待办、健身、财务、饮食、资讯、健身计划，分别对应 `databaseId` 常量；
- **SDK 调用面**：`query / addRecord / updateRecord / deleteRecord / getSchema / uploadImage / onUpdated`；
- **localStorage 键**：`wb_goal`、`wb_ai_sk`、`wb_ai_ep`、`wb_ai_mdl`、`wb_ai_vmdl`、`wb_vision`、`wb_nutsrc`、`wb_usda_api`、`wb_baidu_dish_at`、`wb_custom_vision_url`、`wb_workbench_forms`；
- **IndexedDB**：照片缓存（`IDB.get/put/clear`）；
- **同步状态**：`setSync('ok'|'off'|'', '已同步'|'同步中'|'本地预览')`，`loadAll()` 6 路并发完成后统一回写。

## 4. 代码分层与调用关系

```
数据层   loadAll / sdkWrite / deleteRecord / saveOpts / pagedLoad
   ↓
计算层   collectToday / todayStr / dstr / finCatOf / parsePlan / csvParse
   ↓
渲染层   renderToday / renderTodo / renderFit / renderDiet / renderFinance / renderKb ...
   ↑
统一入口 refreshAll()  ←── 所有交互（afterWrite / switchTab / onTodayAction）改完数据只调它
```

- 已确认 `refreshAll()` 是唯一统一刷新入口，符合单向调用原则；
- **已验证无调用环**（测试中用 DFS 检测渲染函数图）；
- ⚠️ 发现 2 处渲染函数之间的单向耦合：`renderPhotoItems → renderPhotoSum`、`renderNutrition → renderTrend`。当前不构成环、不会栈溢出，但建议后续收敛到 `refreshAll()`，否则任一侧反向调用就会立刻变成死循环。

## 5. 主要风险

| 风险 | 说明 | 建议 |
| --- | --- | --- |
| 单文件 942 KB | 全量在一个 `<script>` 里，改一处影响全局，diff 难读 | 已加 3MB 体积门禁；后续按模块拆分时同步拆文件 |
| 无版本/无回滚 | 原先只是在线编辑覆盖发布，出问题无法回退 | 构建注入 `build:version`（Git SHA），产物可归档回滚 |
| 外网部署降级 | 平台 SDK 脚本在非 WorkBuddy 环境 404，页面退化为本地存储 | 构建按 `DEPLOY_TARGET` 自动剥离该脚本，README 已说明 |
| AI Key 存 localStorage | 明文存在浏览器本地，换机不迁移、共用设备有泄漏面 | 测试已扫描明文凭据拦截；Key 只在本机填写，不入库 |
| 无自动化质量门禁 | 之前靠肉眼检查 | 本次补齐 7 项源码测试 + 9 项冒烟，进 CI 强门禁 |

## 6. CI/CD 设计（本次落地）

```
push / PR ──▶ CI：构建 → 源码测试 → 冒烟 → 产物归档
main 合并 ──▶ 测试门禁 → 构建 → GitHub Pages 发布 → 上线轮询健康检查
手动触发 ──▶ 自建服务器 rsync 发布（备用通道）
```

- 构建：`scripts/build.mjs`（校验结构 → 按目标处理平台脚本 → 注入版本元信息 → 产出 `dist/`，含 `.nojekyll`）；
- 测试：`tests/validate.test.mjs`（单文件完整性、零外链、JS 语法可编译、移动端规范、调用图无环、密钥扫描、体积阈值）；
- 冒烟：`scripts/smoke.mjs`（起 HTTP 服务真实请求首页，验证 200 / 标题 / 结构 / 无外链 / 404）；
- 部署：`deploy.yml`（GitHub Pages，OIDC 免密钥）+ `deploy-selfhosted.yml`（VPS）。
