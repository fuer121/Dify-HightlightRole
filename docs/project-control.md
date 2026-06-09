# 项目总控主文档

更新时间：2026-06-09
负责人：项目总控 Agent

## 项目总览

- 项目：Dify Excel 批量工作流网站
- 目标：把 Excel/CSV 中的高光段落编译为 Dify 工作流任务，串行执行，沉淀结果、历史记录和导出能力。
- 当前阶段：主线功能已完成，进入优化与可控性增强阶段。
- 功能基线信源：`README.md`
- 治理信源：本文档

## 当前状态

- Git 基线：`e8d8ca6 Merge pull request #8 from fuer121/codex/bug-fix`
- 当前分支：`codex/add-newtab`
- 工作区状态：准备提交 `codex/add-newtab`
- 已验证项：`npm test` 通过，`npm run build` 通过，`npm run lint` 通过，角色页浏览器核验通过
- 当前未提交优化主题：
  - 继续执行支持按筛选范围重跑已成功任务，并把真实执行 scope 写入批次日志
  - 书籍任务历史新增运行记录图片预览与双记录对比
  - 质量判断记录分页边界修正
  - 新增“角色形象提取”工作台、独立任务模型、角色 Dify workflow 接入与排查修复
  - 角色任务列表筛选与左侧历史任务紧凑化展示
  - 角色执行模块左移，并把执行范围绑定到当前筛选命中列表
  - 角色排除筛选改为候选下拉多选
  - 角色排除下拉支持候选搜索且保留多选状态

## 本轮目标

- 补齐项目治理真实信源，避免代码、任务、线程、文档和 Git 状态继续脱节
- 给当前未提交优化建立清晰边界，决定哪些任务串行、哪些验证后才能提交

## 任务看板

| ID | 任务 | 状态 | 负责人 | 依赖 | 产出 | 验收标准 | 文档同步 | Git 边界 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CTRL-01 | 建立总控主文档并修正 README 信源声明 | 已完成 | 总控 Agent | 无 | `docs/project-control.md`、`README.md` | 主文档包含总览/决策/任务/线程/Git/风险；README 不再冒充唯一真实信源 | 是 | 不单独提交，等待实现边界收口 |
| IMPL-01 | 收口“继续执行范围透明化 + 成功任务重跑”行为 | 已通过最终 QA | 实现型 Agent | CTRL-01 | `server/index.ts`、`server/queue.ts`、`server/queue.test.ts`、`src/App.tsx` | 可按筛选范围继续执行；已成功任务可重跑并保留历史；日志写出范围；执行 scope 必须与用户已查询结果一致；自动化测试通过 | 是 | 倾向独立提交 |
| IMPL-02 | 收口“运行记录图片预览与双记录对比”体验 | 已通过最终 QA | 实现型 Agent | IMPL-01 冻结 UI 文案后 | `src/App.tsx`、`src/styles.css` | 执行记录可看标题、图片、`is_valid`、耗时；最多选择两条记录对比；移动端不破版 | 是 | 倾向独立提交 |
| IMPL-03 | 修正质量判断分页边界 | 已验证 | 实现型 Agent | 无 | `src/App.tsx` | 页码显示、上一页/下一页、页大小切换均不越界 | 否 | 可与同主题小修复合并，或单独提交 |
| QA-01 | 做一轮功能验证与回归记录 | 已通过最终复核 | 验证型 Agent | IMPL-01、IMPL-02、IMPL-03 代码冻结 | 验证结论、截图或操作记录 | 覆盖继续执行 scope、成功任务重跑、运行记录对比、质量分页回归 | 是 | 提交前必做 |
| BUG-IMG-01 | 排查历史 run 对比卡片里的图片资源空内容问题 | 待开始 | 排查型 Agent | QA-RUN-COMPARE 浏览器证据 | 根因结论、影响范围、是否需要修复 | 能解释 `/api/files/<id>` 为什么对个别历史 run 返回空图片；区分代码问题还是历史数据问题 | 是 | 独立于本轮优化提交 |
| IMPL-04 | 修复历史 `task_runs` 图片未注册到 `/api/files` 的缺陷 | 已通过最终 QA | 实现型 Agent | BUG-IMG-01 根因结论 | `server/store.ts`、相关测试 | 历史 run 图片在访问执行记录时可注册到文件表；样本 `isTFe_EGc763zRD4v2MSX` 不再返回 404 | 是 | 独立提交 |
| IMPL-01B | 修复“未查询草稿筛选影响当前页列表与执行按钮”页面级漂移 | 已通过最终 QA | 分析型 Agent -> 实现型 Agent | QA-01 失败证据 | 根因结论、最小修复方案、回归测试 | 在未点“查询”前，草稿筛选不改变当前页列表、计数和执行按钮可用性 | 是 | 与 IMPL-01 同提交 |
| BUG-RERUN-403 | 排查已成功任务重跑触发 Dify `403 RBAC: access denied` | 待开始 | 排查型 Agent | 最终 QA 失败证据 | 根因结论、影响范围、是否需要代码修复或环境修复 | 能解释为什么 `/continue` 触发的新 run 立刻 403 失败 | 是 | 阻塞提交 |
| BUG-ISVALID-01 | 排查执行记录对比里 `is_valid` 显示为 `-` 的问题 | 待开始 | 排查型 Agent | 最终 QA 失败证据、真实 runs 数据 | 根因结论、影响范围、修复建议 | 能解释为什么多条成功历史 run 在记录视图里没有稳定展示 `is_valid` | 是 | 阻塞提交 |
| IMPL-05 | 为 `task_runs` 增加 run 级 `is_valid` 存储并修正历史记录展示 | 已通过最终 QA | 实现型 Agent | BUG-ISVALID-01 根因结论 | `server/store.ts`、持久化/读取逻辑、前端展示、相关测试 | 新 run 写入 run 级 `is_valid`；列表/对比优先展示 run 级值；不串改历史 run | 是 | 独立提交 |
| IMPL-CHAR-01 | 新增角色形象提取工作台与独立任务链路 | 已实现并通过自动化验证 | 实现型 Agent | 用户计划、参考 Excel、角色 Dify API key | `src/CharacterExtractionPage.tsx`、`server/characters.ts`、`server/characterDify.ts`、角色 SQLite 表 | Excel 六列解析、任务创建、立绘结果持久化、历史 run、单条重试可用；`npm test && npm run build && npm run lint` 通过 | 是 | 待本分支统一提交 |
| BUG-CHAR-01 | 排查角色任务重启后 stuck running 与失败不可观测 | 已修复并验证 | 排查型 Agent -> 实现型 Agent | 真实任务 `AE6uKzan5i1zsbpyQD4k3`、SQLite、Dify 单点探针 | worker 恢复逻辑、失败时保留 Dify outputs、fetch cause 诊断 | 第 495 行重试成功；running job 可在 worker 丢失后恢复；失败 run 记录保留 Dify 输出或网络 cause | 是 | 与角色功能同提交 |
| IMPL-CHAR-02 | 增加角色队列限速、自动重试与小样本执行上限 | 已验证 | 实现型 Agent | `BUG-CHAR-01` 连续 `fetch failed` 证据 | `server/characters.ts`、`server/characters.test.ts`、`.env.example` | 网络类错误可自动重试；任务间可限速；本轮达到样本上限后自动暂停；真实样本 555-557 成功 | 是 | 与角色功能同提交 |
| IMPL-CHAR-03 | 优化角色任务列表筛选与历史任务展示 | 已验证 | 实现型 Agent | 用户浏览器批注、角色工作台现有任务表 | `src/CharacterExtractionPage.tsx`、`src/styles.css`、`src/App.characters.test.tsx` | 历史任务只展示最新 3 个；任务列表支持筛选角色、排除角色、书籍、立绘生成状态；命中数可见；`npm test && npm run build && npm run lint` 通过 | 是 | 与角色功能同提交 |
| IMPL-CHAR-04 | 角色执行模块左移并绑定筛选范围执行 | 已验证 | 实现型 Agent | 用户浏览器批注、`/api/character-jobs/:id/start`、当前筛选列表 | `src/CharacterExtractionPage.tsx`、`server/characters.ts`、`server/characterRoutes.ts`、相关测试 | 执行模块位于「上传与映射」下方；前端向 `/start` 发送当前筛选命中的 `taskIds`；后端只执行这些任务；`npm test && npm run build && npm run lint` 通过 | 是 | 与角色功能同提交 |
| IMPL-CHAR-05 | 排除角色改为候选下拉多选 | 已验证 | 实现型 Agent | 用户浏览器批注、当前角色任务列表 | `src/CharacterExtractionPage.tsx`、`src/styles.css`、`src/App.characters.test.tsx` | 排除角色候选从列表角色字段拆分生成；支持多选；多选后列表与 `/start` 执行范围同步排除对应任务；`npm test && npm run build && npm run lint` 通过 | 是 | 与角色功能同提交 |
| IMPL-CHAR-06 | 排除角色下拉支持输入搜索并保留已选项 | 已验证 | 实现型 Agent | 用户浏览器批注、角色候选多选下拉 | `src/CharacterExtractionPage.tsx`、`src/styles.css`、`src/App.characters.test.tsx` | 输入搜索只过滤候选展示；多次输入后已选排除角色保留；列表与 `/start` 执行范围继续同步；`npm test && npm run build && npm run lint` 通过 | 是 | 与角色功能同提交 |

## 线程索引

| 线程 ID | 目标 | 类型 | 负责人 | 必要上下文 | 结束条件 | 当前状态 |
| --- | --- | --- | --- | --- | --- | --- |
| CTRL-2026-06-07 | 审计现状、补治理文档、给出拆解与 Git 决策 | 总控线程 | 总控 Agent | `README.md`、Git 状态、当前 diff、验证结果 | 主文档落地，任务与风险清单可追踪 | 已完成 |
| IMPL-BOOK-RERUN | 收口书籍页“继续执行”策略与范围透明化 | 实现线程 | 实现型 Agent | 当前 dirty diff、`server/queue.ts`、`server/index.ts`、`src/App.tsx` | 行为、文案、测试一致，且不会出现“页面显示旧列表、实际执行新 scope” | 已完成，待 QA |
| QA-RUN-COMPARE | 核验运行记录对比 UI 与质量分页边界 | 验证线程 | 验证型 Agent | 本地 dev server、真实 SQLite 数据、浏览器验证路径 | 输出浏览器核验结论、截图证据、残余风险 | 已完成 |
| BUG-FILE-ASSET | 排查个别历史 run 图片资源空内容 | 排查线程 | 排查型 Agent | `/api/files` 真实数据、历史 run 对比卡片、SQLite 与文件缓存路径 | 明确是接口、缓存文件还是历史数据问题 | 已完成 |
| IMPL-RUN-ASSET-REGISTER | 修复历史 run 文件注册缺失 | 实现线程 | 实现型 Agent | `BUG-IMG-01` 证据链、`server/store.ts`、`server/fileStore.ts` | 历史 run 的 `result_files` 在读取时完成注册，并有回归测试 | 已完成，待最终 QA |
| QA-FULL-CYCLE | 运行 `QA-01` 整体验收 | 验证线程 | 验证型 Agent | QA-01 脚本、真实数据、稳定本地服务 | 给出通过/不通过结论 | 已完成，结论失败 |
| ANALYZE-DRAFT-DRIFT | 定位未查询草稿筛选导致页面列表/按钮漂移的根因 | 分析线程 | 分析型 Agent | QA-01 复现路径、`src/App.tsx`、真实页面状态 | 给出具体根因与修复建议，不直接改代码 | 已完成 |
| BUG-RERUN-403-TRACE | 定位成功任务重跑时的 Dify 403 根因 | 排查线程 | 排查型 Agent | 稳定环境、`server/dify.ts`、相关任务样本 | 分清是 `user`、workflow key、RBAC、还是 stop/retry 语义问题 | 已完成 |
| BUG-ISVALID-DISPLAY | 定位历史 run 里 `is_valid` 显示缺失的根因 | 排查线程 | 排查型 Agent | `task_runs.raw_outputs/result_files`、`src/App.tsx` 显示逻辑 | 明确是历史数据缺字段还是展示读取逻辑问题 | 已完成 |
| IMPL-RUN-ISVALID | 修复 run 级 `is_valid` 缺失与展示不稳 | 实现线程 | 实现型 Agent | `BUG-ISVALID-01` 证据链、`server/store.ts`、`src/App.tsx` | 明确 run 级存储/读取策略，并有测试覆盖 | 待启动 |
| IMPL-RUN-COMPARE | 收口运行记录对比 UI | 实现线程 | 实现型 Agent | `src/App.tsx`、`src/styles.css`、执行记录数据结构 | 对比交互与样式稳定，准备交 QA | 建议在 IMPL-BOOK-RERUN 之后启动 |
| QA-BOOK-QUALITY | 独立验证本轮优化闭环 | 验证线程 | 验证型 Agent | 冻结后的代码、测试命令、手工验证路径 | 输出通过/失败结论、风险、回归建议 | 待启动 |
| CHAR-DIFY-TRACE | 排查角色 Dify 真实调用与队列恢复 | 排查线程 | 排查型 Agent | `AE6uKzan5i1zsbpyQD4k3`、`app-pXvrR01xoLRtxL44wMkbDrPY`、`LL-角色形象提取-白底立绘` | 明确失败层级并保护队列状态 | 已完成；队列保护性暂停，等待是否继续重试 |
| IMPL-CHAR-LIST-FILTER | 优化角色任务列表筛选与左侧任务展示 | 实现线程 | 实现型 Agent | 用户浏览器批注、`src/CharacterExtractionPage.tsx`、`src/styles.css` | 角色列表筛选可用且自动化验证通过 | 已完成 |
| IMPL-CHAR-SCOPED-START | 角色执行按钮绑定筛选范围 | 实现线程 | 实现型 Agent | 当前筛选任务列表、角色 start API | 前端/后端执行范围一致并有测试覆盖 | 已完成 |
| IMPL-CHAR-EXCLUDE-MULTISELECT | 排除角色候选多选 | 实现线程 | 实现型 Agent | 当前任务列表角色字段、筛选/执行范围逻辑 | 排除角色候选下拉多选可用，且执行范围同步 | 已完成 |
| IMPL-CHAR-EXCLUDE-SEARCH | 排除角色候选搜索 | 实现线程 | 实现型 Agent | 角色候选多选下拉、`filteredTasks` | 搜索候选不清空已选项，执行范围同步 | 已完成 |

## 决策记录

### 2026-06-07

1. `README.md` 改为功能基线信源，治理状态迁移到 `docs/project-control.md`。
2. 当前未提交改动虽然测试与 lint 已通过，但仍属于边界混合状态，暂不提交 Git。
3. 因为三个进行中的优化都触及 `src/App.tsx`，不建议并行开多个实现线程直接改代码，优先串行收口，再开独立 QA 线程。
4. “继续执行”必须显式展示真实范围，避免把筛选视图误当作全量执行，这是当前项目的硬规则。
5. “执行生图”只能基于用户已经查询并看到的任务范围执行，不能偷偷读取尚未应用的筛选控件值。
6. 对这条 scope 规则的修复不能只覆盖手动点击执行路径，自动刷新、轮询刷新、切书/切批次后的首次加载也必须遵守同一套已应用范围语义。
7. 2026-06-07 的返工版本通过了实现复审与 reviewer 复审；`loadBookTasks` 默认沿用 scope 已应用范围，切书/切批次首次加载显式传入目标 scope 的查询态。
8. 运行记录对比 UI 与质量分页边界已完成浏览器侧核验，可进入 `QA-01`；当前剩余问题不是交互边界，而是个别历史 run 图片资源本身加载失败。
9. `BUG-IMG-01` 已确认主因是 `listTaskRuns()` 未把历史 `result_files` 注册到内存文件表；这是独立后端缺陷，可单独修复，不阻塞当前优化验收。
10. `QA-01` 已失败，失败点集中在 `IMPL-01`：未点“查询”时，草稿筛选仍会改变当前页列表、计数和执行按钮可用性，因此不能进入提交前阶段。
11. `IMPL-01B` 根因已确认：范围弹层的 `Enter` 会隐式触发 `applyRangeFilterSearch()`，且该链路会把当前整套草稿筛选一起应用；返工应同时关闭这条隐式提交，并把“应用范围”限制为只应用范围字段。
12. `IMPL-01B` 完成后，稳定环境仲裁验证未再复现页面级漂移；上一版 QA 失败结论已不再视为最终状态，需要以稳定环境复核结果为准。
13. 最终稳定环境 QA 说明页面级漂移已修复，但提交仍被两个独立问题阻塞：成功任务重跑触发 Dify `403 RBAC: access denied`，以及执行记录里的 `is_valid` 展示不稳定。
14. `403 RBAC` 已确认是外部 Dify 网关/权限问题，不作为当前仓库代码返工项；`is_valid` 缺失则是本仓库的 run 历史存储模型问题，应继续实现修复。
15. `IMPL-05` 已完成并通过 fresh `npm test`、`npm run build`、`npm run lint`；当前仓库内代码问题已收敛，剩余主阻塞是外部 Dify `403 RBAC`。
16. 2026-06-08 在开启代理后，真实任务 `K4prgJkZrOCaOJ0SsLnFT` 已经重新跑通，新增 run `Kyv1PARgy7LJ965OER7rk` 成功落库，说明外部 `403` 阻塞已解除。
17. 重启稳定后端并应用最新代码后，后续新增 run 已能写入 run 级 `is_valid`；样本 run `Kyv1PARgy7LJ965OER7rk` 返回 `is_valid=1`，说明 `IMPL-05` 主链路已闭环。
18. 最终稳定环境 QA 已通过。当前只剩一个非阻塞残余风险：成功任务在 `status=succeeded + valueStatus=valuable` 过滤视图里重跑期间会短暂从列表消失，重新查询后恢复一致。

### 2026-06-09

1. `codex/add-newtab` 新增“角色形象提取”工作台，使用独立任务模型、独立 SQLite 表和独立 Dify 配置，不复用书籍库/质量判断任务模型。
2. 角色 Dify 配置已在本机验证：`CHARACTER_DIFY_API_BASE=http://dify.qmniu.com/v1`，`CHARACTER_DIFY_RESPONSE_MODE=blocking`，workflow 名称 `LL-角色形象提取-白底立绘`。
3. 真实任务 `AE6uKzan5i1zsbpyQD4k3` 的第 495 行单点探针已确认 workflow 可返回 `character_name / description / result / markdown_output`，后端可把 `result` 中的 Dify file 标准化为立绘预览文件。
4. 根因之一：服务重启后数据库 job/task 仍为 `running`，但当前进程 worker 已丢失；旧逻辑看到 `job.status=running` 会直接返回，导致继续/重试无法恢复。已改为用进程级 active worker 集合判断真实执行状态。
5. 根因之二：workflow 返回了 outputs 但图片字段解析失败时，旧逻辑只保存“未返回立绘图片”，丢失 `workflow_run_id/task_id/raw_outputs`。已改为解析前先保存诊断字段。
6. 新增 HTTP 层诊断：角色 Dify `fetch()` 失败时错误信息包含底层 cause，避免只记录裸 `fetch failed`。
7. 真实队列恢复后，第 495、521、522、523 行生成成功；随后第 524 至后续多行连续出现 `fetch failed`，判断为后端到 Dify HTTP 调用层网络/上游连接问题，不是前端展示或结果字段识别问题。
8. 为避免继续污染队列，真实任务 `AE6uKzan5i1zsbpyQD4k3` 已保护性暂停：当前计数为 `succeeded=22`、`failed=531`、`queued=146`、`paused=1`。
9. 本轮验证通过：`npm test` 10 个测试文件 60 个用例通过，`npm run build` 通过，`npm run lint` 通过。
10. 已增加角色队列执行策略：`CHARACTER_DIFY_AUTO_RETRIES`、`CHARACTER_DIFY_RETRY_DELAY_MS`、`CHARACTER_DIFY_TASK_DELAY_MS`、`CHARACTER_DIFY_MAX_TASKS_PER_RUN`。本机当前策略为自动重试 2 次、重试间隔 15 秒、任务间隔 45 秒、本轮最多 3 条。
11. 小样本重试已执行：第 555、556、557 行全部成功生成立绘；达到样本上限后任务自动暂停。当前计数为 `succeeded=25`、`failed=531`、`queued=144`。
12. 角色任务列表筛选采用前端视图过滤，不改变后端任务状态和全量统计口径；页面用“命中 N 条”单独表达当前筛选结果。立绘状态映射为：未生成=`queued/paused`，失败=`failed`，生成中=`running`，已生成=`succeeded`。
13. 角色页浏览器核验通过：历史任务仅展示最新 3 个；选中任务后筛选条显示“筛选角色 / 排除角色 / 书籍 / 立绘状态”；输入“云筝”后命中数从 700 变为 316，清空后恢复 700。
14. 角色执行范围决策：`执行提取` 只作用于当前筛选命中的任务行。前端提交 `taskIds`，后端只重置/执行这些任务；若筛选命中已成功任务，也视为用户选择的重跑范围。
15. 角色执行模块已从中栏任务 toolbar 移到左栏「上传与映射」下方；中栏只保留筛选和列表，降低执行按钮与列表范围不一致的误解风险。
16. 排除角色筛选改为候选下拉多选；候选来自当前任务列表 `role_name`，并兼容 `容烁,云筝` 这类多角色字段拆分。多选排除后，列表命中范围和 `/start` 提交的 `taskIds` 保持一致。
17. 排除角色下拉增加输入搜索；搜索词只影响候选展示，不清空 `excludedRoleFilters`。已验证先搜索并勾选“容烁”，再搜索并勾选“萧燃”后，两个排除项继续保留，最终执行范围只剩未排除任务。

## Git 记录

- HEAD：`ae01928 Add character extraction workspace`
- 当前分支：`codex/add-newtab`
- 推送状态：已推送到 `origin/codex/add-newtab`
- PR：`https://github.com/fuer121/Dify-HightlightRole/pull/9`，draft，base=`main`
- 本轮功能提交：`ae01928 Add character extraction workspace`
- 本轮提交范围：角色工作台、角色 Dify workflow、队列恢复/限速修复、列表筛选优化与主文档同步。
- 未纳入 Git 的本地产物：`.playwright-cli/`、`测试文本/`。

## 风险与阻塞清单

| ID | 风险或阻塞 | 等级 | 影响 | 当前处理 |
| --- | --- | --- | --- | --- |
| R-01 | `README.md` 之前将自己标成唯一真实信源，但分支与状态已过期 | 中 | 容易误判当前基线和进行中改动 | 已通过 CTRL-01 修正 |
| R-02 | 当前 dirty diff 混合三个优化主题，直接提交会降低可回滚性 | 高 | 提交粒度不清，后续定位和回退困难 | 暂不提交，先按主题收口 |
| R-03 | 三个优化都落在 `src/App.tsx`，并行实现线程会高冲突 | 高 | 容易互相覆盖或造成 rebase 成本 | 改为串行实现，独立 QA 并行 |
| R-04 | “允许重跑已成功任务”是行为变更，需确认和导出/复盘预期一致 | 中 | 可能影响用户对历史结果的理解 | 纳入 QA-01 验收，必要时补产品确认 |
| R-05 | 当前只有自动化验证，没有本轮 UI 手工验证记录 | 中 | 可能存在交互或样式回归未被发现 | QA-01 必须补手工验证 |
| R-06 | 当前筛选控件需要点“查询”才刷新列表，但“执行生图”直接读取控件值，可能导致所见 scope 与实际执行 scope 不一致 | 低 | 若回归会直接影响执行可信度 | 已由 IMPL-01 返工修复，待 QA-01 手工复核 |
| R-07 | 第一版前端修复只堵住了手动点击执行路径，`loadBookTasks` 仍会把草稿筛选通过自动刷新/轮询/切 scope 首次加载偷偷升格为已应用范围 | 低 | 若回归会导致 scope 漂移 | 已经完成返工并通过 reviewer 复审，待 QA-01 复核 |
| R-08 | 运行记录对比卡片里个别历史图片资源返回空内容，表现为图片框内显示文件名/空图 | 中 | 会影响部分历史 run 的对比观感，但不阻塞对比交互本身 | 根因已锁定为历史 run 文件注册缺失 + 少量早期资产缺失，进入 IMPL-04 |
| R-09 | 未点“查询”时，草稿筛选仍会改变当前页列表、计数和执行按钮可用性 | 低 | 若回归会再次破坏“所见即所执行” | `IMPL-01B` 已修复并经稳定环境仲裁验证通过 |
| R-10 | 已成功任务重跑在稳定环境下触发 Dify `403 RBAC: access denied` | 低 | 若代理/网络再次失效会重新阻塞重跑验收 | 代理开启后已用真实任务重跑验证通过 |
| R-11 | 执行记录里的 `is_valid` 在多条成功历史 run 上显示为 `-` | 低 | 历史旧 run 若本来无字段仍会保守显示 `-` | 新 run 级链路已验证通过，历史旧 run 显示 `-` 为保守设计 |
| R-12 | 成功任务在 `status=succeeded + valueStatus=valuable` 过滤视图里重跑期间会短暂从列表消失 | 低 | 可能让用户短暂误以为任务丢失，但重新查询后即恢复一致 | 记录为后续体验优化项，不阻塞提交 |
| R-13 | 角色队列连续出现 Dify HTTP 层 `fetch failed` | 中 | 若直接继续执行，会把剩余 queued 行快速打成失败 | 已增加限速/自动重试/小样本上限；真实样本 555-557 成功，建议继续按小批次推进 |
| R-14 | 角色任务存在历史失败 run 缺少 raw outputs | 中 | 老失败记录只能看到“未返回立绘图片”，无法回溯 workflow 输出 | 新代码已保存失败诊断字段；旧 run 不回填 |

## QA-01 验收脚本

1. 选择一个具体任务清单，先点“查询”，确认当前列表与 `可执行` 计数正常。
2. 修改状态/图片/价值/章节或行号筛选，但不要点“查询”，直接点“执行生图”。
   预期：执行 scope 仍然基于上一次已查询结果，而不是偷偷使用未应用的新控件值。
3. 修改相同筛选后点“查询”，再点“执行生图”。
   预期：执行 scope 与当前页面列表一致，批次日志里能看到对应范围摘要。
4. 选择一个已成功任务范围重新执行。
   预期：任务可以重跑，历史 `task_runs` 保留两次及以上记录。
5. 打开同一任务的执行记录。
   预期：能看到标题、图片、`is_valid`、耗时；最多允许两条记录进入对比。
6. 切到质量判断页，调整页码与每页数量。
   预期：页码不会越界，上一页/下一页按钮状态正确。
7. 命令行验证：
   预期：`npm test` 通过，`npm run lint` 通过。

## 下次更新规则

- 目标变更、范围变更、任务拆分、线程启动/结束、风险升级、阻塞解除、Git 提交后，必须先更新本文档，再对外宣称状态变更。
