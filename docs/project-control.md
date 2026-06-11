# 项目总控主文档

更新时间：2026-06-11
负责人：项目总控 Agent

## 项目总览

- 项目：Dify Excel 批量工作流网站
- 目标：把 Excel/CSV 中的高光段落编译为 Dify 工作流任务，串行执行，沉淀结果、历史记录和导出能力。
- 当前阶段：主线功能已完成，进入优化与可控性增强阶段。
- 功能基线信源：`README.md`
- 治理信源：本文档

## 当前状态

- Git 基线：`3863d4b Merge pull request #16 from fuer121/codex/feishu`
- 当前分支：`codex/multiply-workflow`
- 工作区状态：已把固定 `primary/compare` 双工作流升级为 Workflow 分组；已新增 `workflow_groups`、`workflow_group_configs`、`/api/workflow-groups`，并让书籍库执行任务绑定选中的 active 分组。
- 已验证项：本轮 `npm test` 通过 15 个测试文件 120 个用例；`npm run build` 通过；`npm run lint` 通过；`curl --max-time 5 http://127.0.0.1:5175/api/health` 与 Vite 代理 `http://localhost:5173/api/health` 均快速返回。
- PR #10 已合并功能主题：
  - 继续执行支持按筛选范围重跑已成功任务，并把真实执行 scope 写入批次日志
  - 书籍任务历史新增运行记录图片预览与双记录对比
  - 质量判断记录分页边界修正
  - 新增“角色形象提取”工作台、独立任务模型、角色 Dify workflow 接入与排查修复
  - 角色任务列表筛选与左侧历史任务紧凑化展示
  - 角色执行模块左移，并把执行范围绑定到当前筛选命中列表
  - 角色排除筛选改为候选下拉多选
  - 角色排除下拉支持候选搜索且保留多选状态
  - 角色任务支持单条发起、勾选批量发起、整体暂停
  - 角色立绘生成结果缓存到本地，避免 Dify 临时图片 URL 过期后预览不可读
  - 角色立绘 Prompt 升级为“重绘设定图”语义，并支持更新当前历史任务 Prompt
  - 角色队列取消默认小样本上限，后续批量执行数量由筛选/勾选范围决定
- 真实运行快照（2026-06-10 14:13 CST）：角色 job `wRMQnhciToy_-bP5D7GXl` 仍为 `running`，文件 `首批700张生图.xlsx`，计数为 `175 succeeded / 1 running / 524 queued / 0 failed`；另有历史 job `AE6uKzan5i1zsbpyQD4k3` 为 `paused`，计数 `25 succeeded / 531 failed / 144 queued`。
- Prompt/效果核查：当前 job 持久化 `promptText` 为 `测试 prompt`；最近成功任务的 `raw_outputs.description` 已包含“参考原图人物特征重绘、纯白背景、全身立绘、不要原场景”等语义，抽样 `/api/files/caVX41cbKmKIJVsz1JosD` 返回 200 且本地缓存可读。
- 新发现风险：多角色 `角色名` 字段（如 `钟离无渊,燕沉`）可能生成双人白底立绘，即使描述里包含“单人”。这不是“抠图”证据，但属于后续需要确认的多角色输入策略。
- 存量回填结果（2026-06-10 14:13 CST 查询）：角色形象提取历史成功立绘已沉淀到角色底图管理。当前 SQLite 有 153 条有效记录，其中 72 条 `active`、71 条 `draft`、10 条 `disabled`；章节画像 `role_asset_profiles` 当前为 0 条。若管理页继续启用/删除候选，该计数会随真实数据变化。
- 角色底图调用边界：当前网站已提供 `/api/workflow/role-context`，但不会自动注入书籍库生图请求；只有 Dify workflow 内部节点主动 HTTP 调用该接口时，角色底图管理数据才会参与生图。若 Dify 仍使用旧「获取底图、画像」Python 节点，则继续按旧 CDN 底图路径和 role txt 逻辑执行。
- 本轮新增目标：Workflow 管理支持多分组；书籍库执行生图时选择 active 分组并绑定到本次任务范围，后续双工作流调用、停止、详情与运行记录均按任务绑定分组展示。
- P0 稳定性修复：`5175` 后端监听但 API 超时的根因按同步 SQLite 写放大处理；队列进度更新改为轻量保存批次元信息与变更任务。`running` 超过 10 分钟的任务视为卡死，自动暂停为可重试，不标失败、不自动重试。

## 本轮目标

- 将现有固定 `primary/compare` 配置迁移为默认 Workflow 分组 `default`。
- 新增 Workflow 分组管理：每个分组固定包含 `primary/compare` 两个槽位，支持新增、编辑、禁用，不物理删除。
- 书籍库「执行生图」支持选择 active 分组，并把该分组写入当前已查询范围内的 runnable tasks。
- Dify 双工作流调用、暂停/取消 stop、任务详情和运行记录按任务绑定的 `workflow_group_id/workflow_group_name` 读取和展示，避免不同分组结果混淆。
- 保留 `/api/workflows` 默认分组兼容接口，新增 `/api/workflow-groups` 作为新管理接口。

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
| IMPL-CHAR-02 | 增加角色队列限速、自动重试与可选小样本执行上限 | 已验证 | 实现型 Agent | `BUG-CHAR-01` 连续 `fetch failed` 证据 | `server/characters.ts`、`server/characters.test.ts`、`.env.example` | 网络类错误可自动重试；任务间可限速；如显式设置 `CHARACTER_DIFY_MAX_TASKS_PER_RUN` 可按样本上限自动暂停；默认不限量 | 是 | 与角色功能同提交 |
| IMPL-CHAR-03 | 优化角色任务列表筛选与历史任务展示 | 已验证 | 实现型 Agent | 用户浏览器批注、角色工作台现有任务表 | `src/CharacterExtractionPage.tsx`、`src/styles.css`、`src/App.characters.test.tsx` | 历史任务只展示最新 3 个；任务列表支持筛选角色、排除角色、书籍、立绘生成状态；命中数可见；`npm test && npm run build && npm run lint` 通过 | 是 | 与角色功能同提交 |
| IMPL-CHAR-04 | 角色执行模块左移并绑定筛选范围执行 | 已验证 | 实现型 Agent | 用户浏览器批注、`/api/character-jobs/:id/start`、当前筛选列表 | `src/CharacterExtractionPage.tsx`、`server/characters.ts`、`server/characterRoutes.ts`、相关测试 | 执行模块位于「上传与映射」下方；前端向 `/start` 发送当前筛选命中的 `taskIds`；后端只执行这些任务；`npm test && npm run build && npm run lint` 通过 | 是 | 与角色功能同提交 |
| IMPL-CHAR-05 | 排除角色改为候选下拉多选 | 已验证 | 实现型 Agent | 用户浏览器批注、当前角色任务列表 | `src/CharacterExtractionPage.tsx`、`src/styles.css`、`src/App.characters.test.tsx` | 排除角色候选从列表角色字段拆分生成；支持多选；多选后列表与 `/start` 执行范围同步排除对应任务；`npm test && npm run build && npm run lint` 通过 | 是 | 与角色功能同提交 |
| IMPL-CHAR-06 | 排除角色下拉支持输入搜索并保留已选项 | 已验证 | 实现型 Agent | 用户浏览器批注、角色候选多选下拉 | `src/CharacterExtractionPage.tsx`、`src/styles.css`、`src/App.characters.test.tsx` | 输入搜索只过滤候选展示；多次输入后已选排除角色保留；列表与 `/start` 执行范围继续同步；`npm test && npm run build && npm run lint` 通过 | 是 | 与角色功能同提交 |
| IMPL-CHAR-07 | 支持角色任务单条执行、批量选择执行与整体暂停 | 已验证 | 实现型 Agent | 当前角色任务列表、`/api/character-jobs/:id/start`、运行队列状态 | `server/characters.ts`、`server/characterRoutes.ts`、`src/CharacterExtractionPage.tsx`、相关测试 | 单条详情可只发起该行；勾选多行后 `/start` 只提交已选 `taskIds`；整体暂停会把 queued 任务置为 paused，当前 running 行完成后不再取下一行；`npm test && npm run build && npm run lint` 通过 | 是 | 当前分支独立提交 |
| IMPL-CHAR-08 | 修复角色立绘生成成功但预览图片不可读 | 已验证 | 排查型 Agent -> 实现型 Agent | 真实任务 `wRMQnhciToy_-bP5D7GXl`、`portrait_files_json`、`/api/files/:id` | `server/characterDify.ts`、`server/fileStore.ts`、`server/characterDify.test.ts`、`server/characters.test.ts`、历史数据修复 | 新生成立绘在结果标准化时尽量落本地缓存；Dify 返回错误 MIME 时按图片字节识别真实类型；历史成功行可从 `markdown_output` base64 回填本地文件；`npm test && npm run build && npm run lint` 通过 | 是 | 当前分支独立提交 |
| IMPL-CHAR-09 | 将角色立绘 Prompt 从“提取人物”升级为“重绘设定图” | 已验证 | 实现型 Agent | 用户反馈：当前立绘像从原图抠出人物，不符合设定图目标 | `src/CharacterExtractionPage.tsx`、`Dify-DSL/LL-角色形象提取-白底立绘.yml`、`server/characters.ts`、`server/characterRoutes.ts`、相关测试 | 新建任务默认 Prompt 明确“参考原图重绘，非抠图/裁切/复刻原场景”；历史 job 可更新当前 Prompt；执行前未保存 Prompt 会自动保存；Dify DSL 可解析；`npm test && npm run build && npm run lint` 通过 | 是 | 当前分支独立提交 |
| CHAR-HANDOFF-01 | 接手后核查 PR #10、稳定服务与真实角色 job 状态 | 已完成 | 接手子线程 Agent | `main` 最新代码、`/api/health`、`/api/character-jobs`、真实 job 详情 | 本文档、运行态快照、样图核查结论 | 确认 PR #10 已合并；服务进程命中当前仓库；真实 job 计数、Prompt、最近成功 outputs 与图片缓存可查 | 是 | 文档同步，不纳入本地产物 |
| IMPL-BOOK-DUAL-01 | 书籍库生图扩展双工作流执行与右侧对比展示 | 已验证 | 实现型 Agent | 线上 workflow key 与对照 workflow key 已配置于本机 `.env.local`、现有书籍库队列和 run 记录 | `server/dify.ts`、`server/queue.ts`、`server/store.ts`、`server/types.ts`、`server/index.ts`、`src/App.tsx`、`src/styles.css`、测试与文档 | 同一任务并行调用已配置 workflow；至少一侧成功则任务成功，两侧失败才失败；`workflow_results_json` 保存两侧结果；旧 run 自动合成单主工作流结果；右侧详情与执行记录展示 workflow 名称/图片/错误；`npm test && npm run build && npm run lint` 通过 | 是 | 当前分支独立提交 |
| IMPL-UI-01 | 侧边栏抽屉支持手动收起和展开 | 已验证 | 实现型 Agent | 用户浏览器批注、`WorkspaceSidebar`、书籍库/质量判断/角色三页容器 | `src/App.tsx`、`src/styles.css`、`src/App.books-scope.test.tsx` | 顶层侧栏按钮可在展开/收起间切换；收起时保留图标导航并隐藏书籍列表/说明/工作流信息；三页共享状态；`npm test && npm run build && npm run lint` 通过 | 是 | 当前分支小 UI 提交 |
| IMPL-UI-02 | 双工作流结果卡并排展示并隐藏调试字段 | 已验证 | 实现型 Agent | 用户浏览器批注、右侧任务详情 workflow cards | `src/App.tsx`、`src/styles.css`、`src/App.books-scope.test.tsx` | 主/对照 workflow 在任务详情中优先并排展示；隐藏 `workflow_run_id/dify_task_id` 对应的“运行/任务”字段；保留 workflow 名称、状态、图片/生成中、标题、描述和错误；`npm test && npm run build && npm run lint` 通过 | 是 | 当前分支小 UI 提交 |
| IMPL-UI-03 | 书籍库任务列表与详情模块支持拖拽调宽 | 已验证 | 实现型 Agent | 用户浏览器批注、书籍库中栏任务列表与右侧任务详情 | `src/App.tsx`、`src/styles.css`、`src/App.books-scope.test.tsx` | 中栏与右栏之间提供拖拽分隔条；拖拽后右侧详情宽度持久化；窄屏自动回退单列布局；`npm test && npm run build && npm run lint` 通过 | 是 | 当前分支小 UI 提交 |
| IMPL-CHAR-10 | 角色形象提取按当前筛选范围导出飞书 Base | 已验证 | 实现型 Agent | 用户确认导出范围为当前筛选，图片字段为立绘附件 + 原图附件 | `server/lark.ts`、`server/characterRoutes.ts`、`src/CharacterExtractionPage.tsx`、相关测试 | `/api/character-jobs/:id/export/lark` 只导出传入 `taskIds`；前端导出按钮提交当前筛选命中任务；飞书表包含角色字段并上传生成立绘与原段落图片附件；`npm test && npm run build && npm run lint` 通过 | 是 | 当前分支角色导出提交 |
| IMPL-CHAR-11 | 修正角色任务筛选跑完后仍有 queued 造成的“假中断”感知 | 已验证 | 排查型 Agent -> 实现型 Agent | 真实 job `wRMQnhciToy_-bP5D7GXl`、`/api/character-jobs`、SQLite 队列状态、前端执行范围规则 | `src/CharacterExtractionPage.tsx`、`server/characters.ts`、相关测试 | 保留“执行提取=当前筛选命中 `taskIds`”规则；新增“继续全部未生成”按钮显式提交全部 `queued/paused` 任务；后端结束日志区分筛选范围完成、手动暂停和样本上限；`npm test && npm run build && npm run lint` 通过 | 是 | 当前分支小修复提交 |
| IMPL-ROLE-ASSET-01 | 新增角色底图管理与 Dify 节点数据服务 | 已验证 | 实现型 Agent | Dify 节点「获取底图、画像」输入输出契约、当前角色提取任务与文件缓存 | `server/roleAssets.ts`、`server/roleAssetRoutes.ts`、`src/RoleAssetManagementPage.tsx`、`src/App.tsx`、`src/styles.css`、测试与文档 | 角色底图可新增/编辑/禁用/软删；章节画像可维护；workflow 接口鉴权后返回旧节点兼容字段；角色提取成功结果自动沉淀 draft 候选；存量成功立绘可一键回填；`npm test && npm run build && npm run lint` 通过 | 是 | 当前分支独立提交 |
| IMPL-ROLE-ASSET-02 | 角色底图管理按当前筛选列表导出飞书 Base | 已验证 | 实现型 Agent | 用户确认导出字段为小说名称、角色立绘图、实际提取的角色名称、启用状态 | `server/lark.ts`、`server/roleAssetRoutes.ts`、`src/RoleAssetManagementPage.tsx`、相关测试 | `/api/role-assets/export/lark` 只导出前端传入的当前列表 `assetIds`；飞书表包含 `小说名称`、`角色立绘图`、`实际提取的角色名称`、`启用状态`；角色立绘图作为附件上传；空范围和非法 ID 安全失败；`npm test && npm run build && npm run lint` 通过 | 是 | 当前分支角色底图导出提交 |
| BUG-LARK-01 | 飞书导出遇到 lark-cli TLS handshake timeout | 已验证 | 排查型 Agent -> 实现型 Agent | 用户报错 `network.timeout / TLS handshake timeout`、`server/lark.ts` | `server/lark.ts`、`server/characters.test.ts`、`.env.example` | lark-cli 网络/超时类错误自动重试；权限/参数类错误不重试；`npm test && npm run build && npm run lint` 通过 | 是 | 当前分支小修复提交 |
| IMPL-WORKFLOW-MGMT-01 | 新增书籍库双 Workflow 管理页面 | 已验证 | 实现型 Agent | 现有 `DIFY_*` / `DIFY_COMPARE_*` 环境变量、书籍库双工作流执行链路 | `workflow_configs` SQLite 表、`/api/workflows`、左侧「Workflow 管理」页面、测试与文档 | 页面可编辑 primary/compare 名称、API key、Dify 控制台地址、备注；保存后后续书籍库生图使用 SQLite 中的名称/API key；`npm test && npm run build && npm run lint` 通过 | 是 | 当前分支独立提交 |
| IMPL-BOOK-GEN-CONTROL-01 | 书籍库生图新增总体暂停与取消 | 已验证 | 实现型 Agent | 当前书籍库 `continueBook` 范围语义、双工作流 stop 逻辑、用户确认的暂停/取消语义 | `server/queue.ts`、`server/index.ts`、`src/App.tsx`、相关测试与文档 | 暂停/取消均按当前已查询范围执行；暂停会停止 running 双工作流并暂停 queued；取消移除 queued/running/paused 且保留 succeeded/failed；`npm test && npm run build && npm run lint` 通过 | 是 | 当前分支独立提交 |
| IMPL-WORKFLOW-GROUP-01 | Workflow 管理升级为分组并支持书籍库执行绑定 | 已验证 | 实现型 Agent | `IMPL-WORKFLOW-MGMT-01`、书籍库双工作流执行链路、暂停/取消 stop 逻辑 | `workflow_groups`、`workflow_group_configs`、`/api/workflow-groups`、书籍库分组选择、任务/run/result 分组字段、测试与文档 | 默认分组从旧配置/环境变量 seed；新分组可新增/编辑/禁用；书籍库执行绑定 active 分组；Dify 调用与 stop 按任务绑定分组；详情/运行记录展示分组；全量 `npm test && npm run build && npm run lint` 通过 | 是 | 当前分支独立提交 |
| IMPL-WORKFLOW-RESULT-COLUMNS | 书籍库列表与飞书导出保留双 Workflow 生图结果 | 已验证 | 实现型 Agent | 书籍库任务 `workflow_results` 已保存 primary/compare 输出 | `src/App.tsx`、`src/styles.css`、`server/lark.ts`、相关测试 | 任务列表新增两个 workflow 结果列，列名取 workflow 名称并用 hover 保留完整名；飞书导出按实际 workflow 名称创建附件字段并上传对应图片；`npm test && npm run build && npm run lint` 通过 | 是 | 当前分支小功能 |
| BUG-LARK-SCOPE-01 | 书籍库飞书导出误导出整批任务清单 | 已验证 | 排查型 Agent -> 实现型 Agent | 用户反馈导出结果不像当前筛选表格内容 | `src/App.tsx`、`server/index.ts`、`src/App.books-scope.test.tsx` | 书籍库页导出飞书带上当前已查询筛选条件和 `bookId`；后端有 `bookId` 时按同一套任务列表过滤导出，筛选导出不复用整批 `batch.export` 缓存；`npm test && npm run build && npm run lint` 通过 | 是 | 当前分支小修复 |
| BUG-WORKFLOW-BINDING-01 | Workflow 分组执行时覆盖其他任务绑定 | 已验证 | 排查型 Agent -> 实现型 Agent | 用户反馈一个任务选择分组后会强制传递给其他任务 | `server/queue.ts`、`src/App.tsx`、相关测试 | `continueBook` 仅给未绑定任务填入当前默认分组，已绑定任务保留自己的 `workflow_group_id/name`；页面文案改为“默认 Workflow 分组”；`npm test -- server/queue.test.ts`、`npm test -- src/App.books-scope.test.tsx` 通过 | 是 | 当前分支小修复 |
| BUG-BOOK-RUNNING-SCOPE-01 | 执行一本书时影响另一本书的执行中状态展示 | 已验证 | 排查型 Agent -> 实现型 Agent | 用户反馈同一上传任务清单下不同书籍状态隔离不干净 | `src/App.tsx`、`src/App.books-scope.test.tsx`、`server/queue.test.ts` | 书籍库页面执行中判断改为当前书籍维度 `running_count` 或当前列表 running task，不再使用全局 batch.status；队列层补测确认执行 book=1 不会改变 book=2 任务状态；相关测试通过 | 是 | 当前分支小修复 |
| BUG-P0-SERVICE-01 | 修复 5175 API 无响应与 running 任务卡死 | 已验证 | 排查型 Agent -> 实现型 Agent | `5175` 监听但 `/api/health` 超时、SQLite 同步写放大采样、长期 running 任务 | `server/queue.ts`、`server/store.ts`、`server/index.ts`、`.env.example`、相关测试与文档 | 队列 emit 不再全量保存整批任务；hydrate 不再全量写回；health 不读 workflow DB 配置并返回队列快照；running 超过 10 分钟自动暂停可重试；`npm test && npm run build && npm run lint` 通过；本机 health 与 Vite 代理均快速返回 | 是 | 当前分支 P0 稳定性提交 |
| P1-1 | Workflow 名称展示与真实配置一致 | 已验证 | 实现型 Agent | `/api/health` 已轻量化、`/api/workflow-groups` 为真实配置源 | `src/App.tsx`、`src/App.workflows.test.tsx` | 侧栏 Dify 工作流名称优先读取默认 active Workflow 分组；管理页修改默认分组 workflow 名称后侧栏同步；health 不重新读取 workflow DB；目标测试通过 | 是 | 当前分支 P1 小修复 |
| P1-4 | 书籍任务表列宽防 NaN 与旧缓存兼容 | 已验证 | 实现型 Agent | 书籍库任务列表新增 workflow 结果列后存在旧 localStorage 缓存 | `src/App.tsx`、`src/App.books-scope.test.tsx` | 列宽读取、保存、最小宽度计算、`col` 渲染和拖拽起点统一走安全 getter；非法旧缓存不会向 React style 写入 `NaN`；目标测试通过 | 是 | 当前分支 P1 小修复 |

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
| CHAR-DIFY-TRACE | 排查角色 Dify 真实调用与队列恢复 | 排查线程 | 排查型 Agent | `AE6uKzan5i1zsbpyQD4k3`、角色 Dify key 已配置于本机 `.env.local`、`LL-角色形象提取-白底立绘` | 明确失败层级并保护队列状态 | 已完成；队列保护性暂停，等待是否继续重试 |
| IMPL-CHAR-LIST-FILTER | 优化角色任务列表筛选与左侧任务展示 | 实现线程 | 实现型 Agent | 用户浏览器批注、`src/CharacterExtractionPage.tsx`、`src/styles.css` | 角色列表筛选可用且自动化验证通过 | 已完成 |
| IMPL-CHAR-SCOPED-START | 角色执行按钮绑定筛选范围 | 实现线程 | 实现型 Agent | 当前筛选任务列表、角色 start API | 前端/后端执行范围一致并有测试覆盖 | 已完成 |
| IMPL-CHAR-EXCLUDE-MULTISELECT | 排除角色候选多选 | 实现线程 | 实现型 Agent | 当前任务列表角色字段、筛选/执行范围逻辑 | 排除角色候选下拉多选可用，且执行范围同步 | 已完成 |
| IMPL-CHAR-EXCLUDE-SEARCH | 排除角色候选搜索 | 实现线程 | 实现型 Agent | 角色候选多选下拉、`filteredTasks` | 搜索候选不清空已选项，执行范围同步 | 已完成 |
| IMPL-CHAR-TASK-CONTROL | 角色任务单条/批量/暂停控制 | 实现线程 | 实现型 Agent | 当前角色任务列表、`taskIds` 执行范围、角色队列运行状态 | 三类控制入口可用且不会误跑未选择队列 | 已完成 |
| BUG-CHAR-FILE-CACHE | 排查角色立绘预览图片不可读 | 排查线程 | 排查型 Agent | 真实成功行、`portrait_files_json`、Dify file URL、`/api/files/:id` | 区分生成失败、临时 URL 过期、MIME 错误或本地缓存缺失，并完成最小修复 | 已完成 |
| IMPL-CHAR-PROMPT-REDRAW | 角色立绘 Prompt 升级为设定图重绘 | 实现线程 | 实现型 Agent | 当前角色 Dify workflow、前端默认 Prompt、历史 job promptText | 新建与历史任务都能使用新版重绘 Prompt | 已完成 |
| IMPL-BOOK-DUAL-WORKFLOW | 书籍库双工作流执行与对比展示 | 实现线程 | 实现型 Agent | `server/dify.ts`、`server/queue.ts`、`server/store.ts`、`src/App.tsx`、两个 Dify API key | 自动化验证通过，文档同步，提交边界明确 | 已完成 |
| IMPL-SIDEBAR-COLLAPSE | 侧边栏抽屉手动收起/展开 | 实现线程 | 实现型 Agent | 用户浏览器批注、`WorkspaceSidebar` | 手动切换可用，自动化测试覆盖 | 已完成 |
| IMPL-WORKFLOW-CARD-COMPARE | 双工作流结果卡展示优化 | 实现线程 | 实现型 Agent | 用户浏览器批注、`WorkflowResultCards` | 右侧详情按双列对比展示，隐藏调试 ID | 已完成 |
| IMPL-BOOK-PANEL-RESIZE | 书籍库中栏/右栏拖拽调宽 | 实现线程 | 实现型 Agent | 用户浏览器批注、`book-main-grid`、右侧任务详情宽度 | 拖拽分隔条可调整并持久化详情宽度，窄屏不破版 | 已完成 |
| IMPL-ROLE-ASSET-MANAGER | 角色底图管理与 workflow 数据服务 | 实现线程 | 实现型 Agent | Dify 节点输入输出、角色任务成功结果、`/api/files` 文件服务 | 管理页/API/只读 workflow 接口实现并通过测试，文档同步 | 已完成 |
| DATA-ROLE-ASSET-BACKFILL | 回填存量角色立绘到角色底图管理 | 数据迁移线程 | 总控 Agent | `character_job_tasks` 成功任务、`role_assets`、用户确认书籍别名 | 成功立绘进入 `draft` 候选，书籍 ID 映射正确，无 `book_id=0` 有效记录 | 已完成 |
| IMPL-WORKFLOW-MGMT | 书籍库双 Workflow 配置管理 | 实现线程 | 实现型 Agent | `server/dify.ts`、`/api/health`、侧边栏工作流展示 | 配置持久化、管理页、真实调用链路读取配置并通过测试 | 已完成 |
| IMPL-BOOK-GEN-CONTROL | 书籍库总体暂停与取消 | 实现线程 | 实现型 Agent | 当前书籍库筛选范围、`continueBook`、双工作流 stop refs | 暂停/取消接口与按钮可用，范围一致，自动化验证通过 | 已完成 |

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
10. 已增加角色队列执行策略：`CHARACTER_DIFY_AUTO_RETRIES`、`CHARACTER_DIFY_RETRY_DELAY_MS`、`CHARACTER_DIFY_TASK_DELAY_MS`，并保留可选的 `CHARACTER_DIFY_MAX_TASKS_PER_RUN`。当前本机策略为自动重试 2 次、重试间隔 15 秒、任务间隔 45 秒、默认不限量。
11. 小样本重试已执行：第 555、556、557 行全部成功生成立绘；达到样本上限后任务自动暂停。当前计数为 `succeeded=25`、`failed=531`、`queued=144`。
12. 角色任务列表筛选采用前端视图过滤，不改变后端任务状态和全量统计口径；页面用“命中 N 条”单独表达当前筛选结果。立绘状态映射为：未生成=`queued/paused`，失败=`failed`，生成中=`running`，已生成=`succeeded`。
13. 角色页浏览器核验通过：历史任务仅展示最新 3 个；选中任务后筛选条显示“筛选角色 / 排除角色 / 书籍 / 立绘状态”；输入“云筝”后命中数从 700 变为 316，清空后恢复 700。
14. 角色执行范围决策：`执行提取` 只作用于当前筛选命中的任务行。前端提交 `taskIds`，后端只重置/执行这些任务；若筛选命中已成功任务，也视为用户选择的重跑范围。
15. 角色执行模块已从中栏任务 toolbar 移到左栏「上传与映射」下方；中栏只保留筛选和列表，降低执行按钮与列表范围不一致的误解风险。
16. 排除角色筛选改为候选下拉多选；候选来自当前任务列表 `role_name`，并兼容 `容烁,云筝` 这类多角色字段拆分。多选排除后，列表命中范围和 `/start` 提交的 `taskIds` 保持一致。
17. 排除角色下拉增加输入搜索；搜索词只影响候选展示，不清空 `excludedRoleFilters`。已验证先搜索并勾选“容烁”，再搜索并勾选“萧燃”后，两个排除项继续保留，最终执行范围只剩未排除任务。
18. 角色执行控制统一使用 `taskIds` 作为后端执行范围：筛选范围执行、已选批量执行、单条执行都调用同一个 `/start` 入口，避免不同入口产生不同队列语义。
19. 角色整体暂停新增 `/api/character-jobs/:id/pause`：暂停请求会把未开始的 `queued` 行置为 `paused`，当前 `running` 行完成后队列不再取下一条。
20. 本轮未触发真实生图任务；浏览器插件未提供可调用 DOM 工具，因此 UI 侧验收采用自动化交互测试、代码可见性检查与稳定地址 HTTP 200 可达性检查。
21. 角色任务 `wRMQnhciToy_-bP5D7GXl` 本轮执行已核验：第 13、14、15 行均成功生成立绘，`/api/files` 返回 200；任务随后因 `CHARACTER_DIFY_MAX_TASKS_PER_RUN=3` 自动暂停。用户感知“未正常生成”的主因是页面未显式展示本轮执行上限和 45 秒任务间隔。
22. “图片暂不可读”根因已确认：部分成功行只持久化了 Dify 签名临时文件 URL，用户稍后查看时远端返回 403，后端无法再代理图片。修复策略是新结果标准化时尽量立即缓存到 `tmp/dify-files`，并为历史成功行从已保存的 `markdown_output` base64 回填本地文件；样本 `PyMJh6MF47hbSTPgtOhVN`、`Fm-4II0PkPenqNstC1yb9` 等已验证 `/api/files` 返回 200 且 MIME 为 `image/jpeg`。
23. 角色立绘生成目标从“提取/保留原图人物”改为“参考原图可识别特征重新绘制设定图”。Prompt 必须明确：非抠图、非裁切、非复刻原场景；保留性别年龄感、发型、五官气质、服饰结构、配饰和角色状态；输出纯白背景单人全身或大半身设定立绘。
24. 现有历史 job 默认不会自动吃到前端新默认 Prompt，因为 `promptText` 已在创建 job 时持久化。因此新增当前任务 Prompt 编辑与保存能力，并在执行前自动保存未提交 Prompt 草稿。
25. 本地 `Dify-DSL/LL-角色形象提取-白底立绘.yml` 已同步新版重绘语义，但 Dify 平台真实 workflow 不会因本地文件变化自动更新；如需平台系统节点也生效，必须重新导入该 DSL 或在 Dify 控制台手动同步对应节点。
26. 角色队列默认小样本上限已取消：`.env.local` 和 `.env.example` 不再设置 `CHARACTER_DIFY_MAX_TASKS_PER_RUN`，后续批量执行会按当前筛选/勾选范围持续执行到范围完成、手动暂停或外部失败。若需要临时灰度，可手动设置该环境变量。
27. PR #10 已合并到 `main`，接手分支从最新 `main` 切出；未跟踪本地产物 `.playwright-cli/`、`测试文本/` 继续保持不纳入 Git。
28. 2026-06-09 18:08:51 CST 重新查询 `/api/character-jobs`：`wRMQnhciToy_-bP5D7GXl` 为 `running`，计数 `43 succeeded / 1 running / 656 queued / 0 failed`，不能继续沿用接手消息里的旧数字。
29. 当前 5175 后端进程 PID `27461` 的 cwd 为本仓库，并通过 `tsx` 启动 `server/index.ts`；可认为稳定服务正在运行同一份当前代码。
30. 当前 job 的 `promptText` 是 `测试 prompt`，不是完整版默认重绘 Prompt；但最近成功任务的 Dify outputs 已包含重绘白底立绘语义，说明平台 workflow 输出层当前不像旧“抠图/提取原图人物”链路。
31. 抽样样图 `caVX41cbKmKIJVsz1JosD` 为 768x1024 白底重绘立绘且 `/api/files` 返回 200；但因原 `角色名` 为 `钟离无渊,燕沉`，结果为双人立绘。后续若严格要求“每张只出现一个角色”，应先决定是拆分多角色行、选择主角色，还是允许多角色字段生成多人设定图。
32. 书籍库双工作流采用“部分成功”策略：主/对照任一 workflow 成功则任务整体 `succeeded`，失败侧错误写入 `workflow_results_json` 并在对比卡片中展示；两个 workflow 都失败时任务才 `failed`。
33. 双工作流执行采用并行调用，不改变书籍库当前筛选/勾选执行范围语义；本轮只扩展单个任务内部的 Dify 调用与结果展示。
34. 存储兼容策略：`tasks` 和 `task_runs` 新增 `workflow_results_json`；旧记录没有该字段时由现有 `result_files/result_text/workflow_run_id/dify_task_id/error` 合成一个主工作流结果。
35. `.env.example` 只允许提交对照 workflow 的占位 key；真实 `DIFY_COMPARE_API_KEY` 仅写入 ignored 的本机 `.env.local`。
36. 侧边栏折叠状态放在顶层 `App`，书籍库、质量判断、角色形象提取三页共享；折叠只影响导航展示和布局宽度，不改变当前书籍/任务/筛选/执行状态。
37. 右侧双工作流结果卡的用户视图不展示 `workflow_run_id` 和 `dify_task_id`；这些字段保留在持久化数据中用于排查，但默认 UI 只展示 workflow 名称、状态、返图/生成中、标题、描述和错误。
38. 书籍库任务列表与右侧任务详情之间新增拖拽分隔条；右侧宽度写入浏览器本地存储，刷新后保留；窄屏下隐藏分隔条并强制单列布局。
39. 角色形象提取的「导出飞书」与「执行提取」共享同一范围语义：前端只提交当前筛选命中的 `taskIds`，后端校验这些任务必须属于当前 job，禁止偷偷导出全量。
40. 角色导出飞书每次新建 Base，不追加旧 Base；生成立绘和原段落图片都走附件字段上传，queued/running/failed 行也会按当前状态写入，缺图不阻塞记录导出。
41. 角色底图管理采用独立数据模型，不复用书籍库任务、质量判断任务或角色形象提取任务表；workflow 查询只读取 `active` 记录。
42. 角色形象提取成功结果自动沉淀为 `draft` 候选；由于角色提取 Excel 目前没有 `book_id`，候选必须经人工确认/补齐书籍 ID 并启用后才会被 workflow 命中。
43. Dify 专用接口 `/api/workflow/role-context` 保持旧节点字段兼容，鉴权使用 `ROLE_ASSET_API_TOKEN`；Dify HTTP 节点必须通过 `Authorization: Bearer <token>` 调用。
44. 本期 workflow 图片 URL 生成规则：优先返回原始 CDN URL；本地上传/缓存文件必须配置 `ROLE_ASSET_PUBLIC_BASE_URL` 后才能生成 Dify 可访问的绝对 URL，不能使用 `localhost`。
45. 用户确认《废材又怎么样？照样吊打你！》与《废材那又怎样》为同一本书，统一按 `book_id=1721648` 映射；该别名已写入角色底图回填逻辑。
46. 「角色底图管理」与 Dify 原工作流角色底图逻辑解耦：网站只提供可选数据服务，Dify 未主动调用 `/api/workflow/role-context` 时，不影响原 Dify 节点按旧逻辑查角色底图。

### 2026-06-10

1. 角色底图管理新增「导出飞书」能力，导出范围固定为页面当前筛选/查询后的角色底图列表；前端提交当前列表 `assetIds`，后端校验 ID 必须存在且未删除，禁止静默扩大为全量。
2. 角色底图导出每次新建 Base，表名为 `角色底图`，字段为 `小说名称`、`角色立绘图`、`实际提取的角色名称`、`启用状态`；`角色立绘图` 作为附件上传，状态以中文展示：`active=已启用`、`draft=待确认`、`disabled=已禁用`。
3. 角色形象提取导出飞书时，`角色名` 列优先使用本次立绘实际提取出的 `extracted_role_name`；只有缺失时才回退 Excel 原始 `角色名` 字段，避免多角色原图字段污染导出表。
4. 飞书导出中的 `lark-cli` 调用增加网络类错误自动重试，默认 `LARK_CLI_RETRIES=2`、`LARK_CLI_RETRY_DELAY_MS=1500`；仅匹配 `network/timeout/TLS handshake timeout/ECONNRESET/ETIMEDOUT/EAI_AGAIN` 等临时网络错误，不对权限、字段、参数错误重试。
5. 飞书导出记录创建成功后，附件上传采用尽力策略：单个图片附件在重试后仍失败时不再中断整次导出，返回 `attachmentsFailed` 供前端提示；Base、表、记录创建失败仍然按失败处理。
6. 角色任务 `wRMQnhciToy_-bP5D7GXl` 当前排查结果：`/api/character-jobs` 显示 `paused`，计数为 `171 succeeded / 529 queued / 0 running / 0 failed`；最近一次事件为“本轮完成 59 条后暂停”，不是正在后台执行。根因不是队列仍在跑，而是用户按筛选范围执行后，未命中的 queued 行仍留在 job 中，页面容易被理解为“排队但不执行”。
7. 角色页新增“继续全部未生成”按钮：只收集当前 job 的 `queued/paused` 任务 ID 并显式提交 `/api/character-jobs/:id/start`，不会包含已成功或失败行，也不会改变“执行提取/导出飞书按当前筛选范围”的既有规则。
8. 角色队列结束日志已细分：手动暂停记录“已按暂停请求停止”，显式样本上限记录“已达到本轮样本上限”，筛选范围跑完但仍有未筛选任务时记录“本次筛选范围已执行完成”，避免后续继续把范围完成误判为限流中断。
9. Workflow 管理本期只管理书籍库双工作流 `primary/compare`；质量判断、角色形象提取、角色底图 role-context 不纳入本页。
10. Workflow 管理页面保存后的名称和 API key 写入 SQLite `workflow_configs`，后续书籍库生图调用优先读取 SQLite；`.env.local` 中 `DIFY_*` / `DIFY_COMPARE_*` 只作为首次 seed 和 API Base/responseMode 兜底来源。
11. Workflow 管理的“工作流地址”字段定义为 Dify 控制台地址，只用于记录和跳转，不参与后端 `/workflows/run` API 请求。
12. 书籍库总体暂停/取消的控制范围固定为当前已点击“查询”后生效的任务列表范围，与“执行生图”一致，不使用未查询的筛选草稿。
13. 书籍库总体取消不新增 `canceled` 状态；取消仅停止并移除当前范围内 `queued/running/paused` 任务，保留 `succeeded/failed` 任务和历史运行记录。
14. 角色底图管理导出飞书排查结论：飞书 Base/表/记录/附件链路可用；历史一次失败对应服务重启导致 `/api/role-assets/export/lark` 代理 `socket hang up`，不是字段或鉴权错误。
15. 角色底图导出附件上传由串行改为受控并发，默认 `LARK_ATTACHMENT_CONCURRENCY=4`；单个附件失败仍按既有尽力策略计入 `attachmentsFailed`，不打断已创建的 Base/记录。
16. 角色底图导出按钮在导出中展示当前导出条数，并提示“创建飞书 Base 并上传附件期间需保持服务运行”，避免长导出被误判为无响应。
17. 书籍库执行中轮询刷新任务列表时，不再复用“查询”按钮的 loading 状态；查询按钮只反映用户手动查询/分页/切换范围触发的任务加载，不与任务执行状态绑定。

### 2026-06-11

1. Workflow 管理从固定 `primary/compare` 升级为分组模型；默认分组 ID 固定为 `default`，首次启动时从旧 `workflow_configs` 或环境变量 seed 主/对照配置。
2. 分组 ID 创建后不可修改；如需变更 ID，应新建分组并禁用旧分组，避免历史任务引用失效。
3. 禁用分组只阻止新的书籍库执行绑定，不影响历史任务、历史 run 和已绑定 queued/running 任务读取该分组配置。
4. 书籍库执行生图的范围仍以当前已点击“查询”后的任务列表为准；`workflowGroupId` 只通过 POST body 表达分组绑定，不改变 query 中的筛选 scope 语义。
5. `tasks`、`task_runs` 和 `workflow_results_json` 均保存 `workflow_group_id/workflow_group_name`；右侧详情和执行记录以这些快照字段展示，后续 Workflow 管理页改名不会改写历史结果含义。
6. 暂停/取消 running 任务时，优先从任务的 `workflow_results` 读取每个 Dify task 所属 `workflow_group_id + workflow_id`，避免使用当前默认分组误停其他 API key 下的任务。
7. 书籍库任务列表和飞书导出都以 `workflow_results.workflow_name` 作为双工作流结果的展示/导出字段名；列表列头使用缩略名并通过 hover 展示完整名，飞书导出继续保留旧 `结果图片` 聚合字段，同时新增两个 workflow 命名附件字段。
8. 书籍库页「导出飞书」范围固定为当前已点击“查询”后生效的任务列表范围，与“执行生图/暂停/取消”一致；筛选导出每次新建 Base，不复用整批任务清单的 `batch.export` 缓存。
9. 书籍库页的 Workflow 下拉定义为“未绑定任务的默认 Workflow 分组”；任务一旦已有 `workflow_group_id/name`，后续同范围执行必须保留该任务绑定，允许不同任务在同一队列中按不同分组同步执行。
10. 书籍库页的“当前任务清单正在执行”状态按当前书籍隔离；同一上传任务清单中其他书籍有 running 任务时，不应让当前书籍页进入执行中提示或禁用执行入口。
11. P0 后端稳定性策略固定为：单条书籍库生图任务 `running` 超过 `TASK_RUNNING_TIMEOUT_MS`，默认 600000ms，视为卡死并自动置为 `paused` 可重试；不标记 `failed`，不自动重试，避免重复调用 Dify。
12. 队列健康检查必须轻量化：`/api/health` 不再读取 SQLite workflow 分组/配置表，只返回环境变量级 Dify 配置摘要和内存队列快照，保证 DB 写压力下仍可用于判断进程存活。
13. 队列进度持久化边界改为只保存批次元信息、事件和变更任务；只有创建/导入等结构性操作继续使用整批 `saveBatch`，避免每次进度事件遍历数千条任务。
14. 服务启动恢复继续把 DB 中遗留 `running` 任务改为 `paused`；运行期新增 watchdog 每 60 秒扫描一次 stale running，尽力停止 Dify task 后暂停任务。
15. 侧边栏“Dify 工作流”展示不再依赖 `/api/health` 的环境变量摘要；真实展示源改为 `/api/workflow-groups` 的默认 active 分组，只有分组接口不可用或缺少 workflow 名称时才回退 health。
16. 书籍库任务表列宽必须对旧缓存和异常运行态做兜底；所有列宽读取、持久化、最小宽度计算、`col` 渲染和拖拽起点统一走安全 getter，禁止把 `NaN` 写入 React style。

## Git 记录

- HEAD：`3863d4b Merge pull request #16 from fuer121/codex/feishu`
- 主线基线：`origin/main` 已到 `3863d4b Merge pull request #16 from fuer121/codex/feishu`
- 当前分支：`codex/multiply-workflow`
- 推送状态：未推送
- PR：未创建
- 本轮功能提交：待定
- 本轮提交范围：Workflow 分组数据模型、管理接口、书籍库执行分组绑定、任务/run/result 分组展示、暂停/取消按绑定分组 stop、书籍库列表/飞书导出双 workflow 结果列、书籍库飞书导出按当前筛选范围导出、任务级 workflow 分组绑定保留、跨书籍执行中状态隔离修复、5175 API 响应恢复、running 卡死任务 watchdog、侧栏 workflow 名称读取真实分组配置、书籍任务表列宽安全兜底、测试与文档同步。
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
| R-15 | 角色立绘远端签名 URL 会过期 | 中 | 成功任务稍后回看可能显示“图片暂不可读” | 新结果会尽量立即缓存到本地；已从历史 `markdown_output` base64 回填可修复的成功行。若远端 URL 已过期且历史 raw 中无 base64，则无法无损回填，只能重跑该行 |
| R-16 | Workflow 分组配置在任务排队后仍可能被管理页编辑 | 中 | 已绑定 queued 任务启动时会读取该分组最新 API key/名称；若运营在执行中改 key，后续行可能使用新配置 | 本期只快照 group id/name 与 result workflow name，不快照 API key；执行大批量前应冻结分组配置，后续如需强隔离再引入 run 级配置快照 |
| R-17 | 禁用分组不影响历史任务执行 | 低 | 如果用户禁用分组后仍有已绑定 queued 任务，它们继续可执行，可能与“禁用”直觉不同 | 已记录为产品边界：禁用只阻止新绑定，不破坏历史引用和停任务能力 |
| R-16 | 本地 DSL 修改不会自动更新 Dify 平台 workflow | 中 | 只改仓库文件时，平台系统 Prompt 仍可能沿用旧“提取人物”语义 | 前端和当前 job Prompt 已可生效；平台侧如需彻底一致，需要重新导入 DSL 或手动同步 Dify 节点 |
| R-17 | 取消默认小样本上限后，大批量执行会长时间占用队列并持续调用 Dify | 中 | 极大批量任务如果筛选范围过大，会持续运行直到完成或手动暂停 | 默认按用户选择范围执行；页面已有暂停整体任务入口；如需跑完所有未生成行，必须显式点击“继续全部未生成”，并先确认 Prompt 与 45 秒限速 |
| R-18 | 当前运行 job 的 `promptText` 是 `测试 prompt` | 中 | 继续跑完 700 条会把测试文本叠加进部分描述，可能影响一致性 | 已记录事实；是否暂停并保存正式 Prompt 属于 Prompt 策略变化，需用户确认后再执行 |
| R-19 | 多角色 `角色名` 字段可能生成多人立绘 | 中 | 若目标是“一张图只出一个角色”，多角色行会产生不符合预期的双人或多人结果 | 已通过样图确认；后续应先确认拆分/主角色/允许多人三选一策略，再改执行逻辑 |
| R-20 | 双 workflow 并行调用会把单任务 Dify 请求量翻倍 | 中 | 大批量书籍任务会同时消耗两个 workflow 的额度与上游并发能力 | 当前按用户要求并行执行；如出现限流，再切为可配置串行或工作流级限速 |
| R-21 | 对照 workflow 输出字段若不符合既有图片字段契约 | 中 | 对照侧可能显示失败卡，但主侧成功仍会让任务继续 | 已支持 `result/result_files/files/file/image/images/image_url/image_urls/url`；失败侧保留 `raw_outputs/error` 便于追踪 |
| R-22 | 角色导出原段落图片附件依赖 CDN 链接仍可下载 | 中 | 若原图 CDN 过期或拒绝访问，对应导出请求可能在附件上传前失败 | 当前按用户要求上传原图附件；后续如遇过期问题，可改为记录继续导出并把失败原图写入错误列 |
| R-23 | 角色提取任务缺少 `book_id` 字段 | 中 | 自动沉淀候选无法直接参与 `book_id + role_name` workflow 匹配 | 已通过书籍库 `books.name` 和确认别名映射修复现有存量；新增未知书名仍默认沉淀为 `draft`，需在角色底图管理页确认 |
| R-24 | Dify workflow 不能访问本地相对图片 URL 或 `localhost` | 高 | 如果 `ROLE_ASSET_PUBLIC_BASE_URL` 未配置，本地上传底图不会被 Dify 成功读取 | workflow 接口优先返回 CDN URL；本地文件参与 workflow 前必须配置可被 Dify 访问的公网/局域网稳定地址 |
| R-25 | 飞书 OpenAPI 或本机网络偶发 TLS handshake timeout | 中 | 导出到飞书多维表格时可能中断在表字段、记录写入或附件上传阶段 | 已对 lark-cli 网络类错误增加可配置重试；若持续失败，需检查代理/网络或升级 lark-cli |
| R-26 | 角色底图全量导出附件较多，导出期间服务重启会中断 HTTP 请求 | 中 | 已创建的飞书 Base 可能存在，但前端会显示导出失败 | 已把附件上传改为默认 4 并发并增强前端导出中提示；导出期间仍需避免重启服务 |
| R-27 | 书籍库执行中后台轮询可能被误认为用户点击了“查询” | 低 | 用户会误判查询按钮和任务执行状态存在绑定 | 已拆分后台刷新与手动查询 loading；轮询继续更新列表，但不禁用/转动查询按钮 |
| R-28 | 同一上传任务清单跨书籍并发执行仍受 batch 级队列模型约束 | 中 | 页面状态已按书籍隔离，但若同一个 batch 内另一本书正在真实 running，后端仍以 batch 级队列保护避免同批次并发竞态 | 当前修复范围限定为状态展示与任务状态不污染；如需同 batch 多书并发执行，需要后续引入书籍级队列锁 |
| R-29 | DB 同步写压力导致 Node event loop 饥饿 | 高 | 会表现为端口监听但 API 不响应，Vite 代理超时或 ECONNRESET | 已把队列 emit 从全量保存整批任务改为轻量保存变更任务；health 已通过本机与 Vite 代理验证 |
| R-30 | 长期 running 任务阻塞后续执行 | 高 | 会让任务清单长期显示执行中，且用户无法继续当前范围 | 已新增 10 分钟 stale running 自动暂停和 60 秒 watchdog；自动暂停不失败、不自动重试，需用户显式继续或重试 |

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
