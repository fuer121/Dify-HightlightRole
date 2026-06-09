# Dify Excel 批量工作流网站

> 功能基线、接口契约、数据模型和运行方式以本文档为准；项目状态、任务看板、决策、线程索引、Git 边界和风险清单见 `docs/project-control.md`。

本项目是一个本地单机 Web 工具：上传 Excel/CSV，将每行映射为 Dify 工作流任务，按队列串行执行，实时展示进度、日志、图片和输出结果，并支持导出到飞书多维表格。

## 当前基线

- 日期：2026-06-07
- 当前分支：`codex/picture-control`
- 当前已提交基线：`462ef1b Merge pull request #5 from fuer121/codex/redesign02`
- 当前已提交目标：批量生图、书籍管理与质量判断的主线能力已经合并；进行中的优化与治理状态见 `docs/project-control.md`。
- 当前持久化策略：后端 SQLite 保存书籍、任务、批次和执行记录；默认路径 `data/dify-batch.sqlite`。
- 当前部署边界：只面向本机运行，监听 `127.0.0.1`，不做公网账号体系。

## 已有能力

- 上传 Excel/CSV，默认解析首个工作表，也支持在界面切换工作表。
- 自动识别中英文表头并映射到 Dify 必填输入。
- 可在创建批次前指定入队行数，只把当前工作表前 N 条非空数据编译进生图队列。
- 每行编译为一个批次任务，字段校验失败的行会进入失败状态且不可直接重试。
- 串行执行 Dify 工作流，默认 `streaming` 模式。
- SSE 实时推送批次、任务、日志、输出、错误和图片预览。
- 支持批次级开始、暂停、失败重试。
- 支持任务级暂停、重试、删除。
- 支持任务进度展示，记录 `dify_task_id`，运行中任务可调用 Dify stop API。
- 提取 Dify 中间产物：`is_valid` 原值、生成段落描述环节的 `text`。
- 图片结果经后端缓存/代理展示，避免前端直接暴露 Dify Key。
- 导出飞书 Base，失败任务也会写入，方便复盘。
- 书籍管理页按 `book_id` 聚合历史任务，可查询任务、手动新增、追加 Excel、查看执行记录并继续未完成任务。

## 当前分支增量

以下能力来自已合并分支增量：

- 新增顶层“书籍管理”页面，与“批量生图”“质量判断”同级。
- SQLite 表包含 `books`、`tasks`、`task_runs`、`batches`、`batch_tasks` 和 `batch_events`。
- 创建批次、任务状态变更、任务结果、删除、导出都会同步持久化。
- 服务启动会恢复历史批次；重启前处于 `running` 的任务恢复为可继续的暂停态。
- “继续未完成”默认执行 `queued`、`paused`、非字段校验失败的 `failed`，不会重跑已成功任务。

## 运行

```bash
npm install
npm run dev
```

打开前端：

```text
http://127.0.0.1:5173/
```

后端监听：

```text
http://127.0.0.1:5175/
```

健康检查：

```text
GET http://127.0.0.1:5175/api/health
```

## 环境变量

复制 `.env.example` 为 `.env.local`，再填入真实 Dify API Key：

```env
DIFY_API_BASE=http://dify.qmniu.com/v1
DIFY_API_KEY=replace-with-your-dify-api-key
DIFY_RESPONSE_MODE=streaming
DIFY_WORKFLOW_NAME=线上工作流
DIFY_COMPARE_API_BASE=http://dify.qmniu.com/v1
DIFY_COMPARE_API_KEY=replace-with-your-compare-dify-api-key
DIFY_COMPARE_RESPONSE_MODE=streaming
DIFY_COMPARE_WORKFLOW_NAME=对照工作流
QUALITY_DIFY_API_BASE=http://dify.qmniu.com/v1
QUALITY_DIFY_API_KEY=replace-with-your-quality-workflow-api-key
QUALITY_DIFY_RESPONSE_MODE=blocking
BATCH_STORE_PATH=data/dify-batch.sqlite
LARK_CLI_AS=user
PORT=5175
```

`.env.local` 已加入 `.gitignore`。真实密钥只允许存在于本机 `.env.local`，不能写入前端代码、README、提交记录或导出文件。

## Excel 输入

必填输入：

- `book_id` / `书籍id` / `书籍编号`
- `paragraph_content` / `段落内容` / `高光段落`
- `chapter_sort` / `章节序号` / `章节`

校验规则：

- `book_id` 必填且必须能转为数字。
- `chapter_sort` 必填且必须能转为数字。
- `paragraph_content` 必填，最大 100000 字符。
- 空行会被过滤。
- `入队行数` 为空时默认全部；填写 N 时只取当前工作表前 N 条非空数据。
- 字段校验失败的任务状态为 `failed`，错误以 `字段校验失败` 开头。

## 任务模型

任务输入：

- `row_no`
- `book_id`
- `paragraph_content`
- `chapter_sort`

任务状态：

- `queued`
- `running`
- `succeeded`
- `failed`
- `paused`

任务输出：

- `workflow_run_id`
- `dify_task_id`
- `progress_percent`
- `progress_label`
- `is_valid`
- `paragraph_description`
- `role`
- `title`
- `result_files`
- `workflow_results`
- `result_text`
- `raw_outputs`
- `error`
- `attempts`
- `started_at`
- `finished_at`
- `elapsed_seconds`

## Dify 契约

运行主工作流：

```text
POST /workflows/run
Authorization: Bearer ${DIFY_API_KEY}
```

如配置 `DIFY_COMPARE_API_KEY`，同一任务会并行运行对照工作流：

```text
POST /workflows/run
Authorization: Bearer ${DIFY_COMPARE_API_KEY}
```

请求体：

```json
{
  "inputs": {
    "book_id": 1,
    "paragraph_content": "段落内容",
    "chapter_sort": 1
  },
  "response_mode": "streaming",
  "user": "local-batch-<batchId>"
}
```

停止运行中任务：

```text
POST /workflows/tasks/{task_id}/stop
Authorization: Bearer ${DIFY_API_KEY}
```

停止请求体必须使用同一个 `user`：

```json
{
  "user": "local-batch-<batchId>"
}
```

输出读取：

- 最终输出从 `data.outputs` 读取。
- 图片优先从输出字段 `result` 解析，支持远程 URL、Dify 文件对象、base64 图片。
- 双工作流结果保存到 `workflow_results`，每个元素包含 workflow 名称、状态、运行 ID、任务 ID、图片、文本、原始 outputs、错误与耗时。
- 至少一个 workflow 成功时任务整体成功；两个 workflow 都失败时任务失败。失败侧会在右侧对比卡片中展示错误。
- `is_valid` 从节点 `1778480914080` 或标题 `is_valid赋值` 的 `outputs.is_valid` 读取，保留原值。
- `paragraph_description` 从节点 `1778480918522` 或标题 `生成段落描述` 的 `outputs.text` 读取。
- 5xx、408、429、超时、服务繁忙等错误默认可重试。
- 4xx 与字段校验错误默认不可重试。

## 后端接口

- `GET /api/health`：查看服务与环境变量状态。
- `POST /api/workbooks`：上传 Excel/CSV，返回工作表、表头、自动映射和预览。
- `POST /api/batches`：用列映射创建批次任务。
- `GET /api/batches/:id`：获取批次。
- `POST /api/batches/:id/start`：执行全部 `queued` 任务。
- `POST /api/batches/:id/start-selected`：只执行请求体中的任务范围。
- `POST /api/batches/:id/pause`：批次级暂停，当前任务结束后暂停。
- `POST /api/batches/:id/retry-failed`：批次级重试失败任务。
- `POST /api/batches/:batchId/tasks/:taskId/pause`：暂停指定任务。
- `POST /api/batches/:batchId/tasks/:taskId/retry`：重试指定任务。
- `DELETE /api/batches/:batchId/tasks/:taskId`：删除指定任务。
- `GET /api/batches/:id/events`：SSE 推送批次状态。
- `GET /api/files/:id`：代理/缓存图片文件。
- `POST /api/batches/:id/export/lark`：新建飞书 Base 并导出当前批次全部剩余任务。
- `GET /api/books`：书籍列表，支持 `q` 搜索，返回任务统计。
- `GET /api/books/:bookId`：书籍详情。
- `GET /api/books/:bookId/tasks`：查询书籍任务，支持 `status` 和 `q`。
- `POST /api/books/:bookId/tasks`：给书籍手动新增单条任务。
- `POST /api/books/:bookId/import-tasks`：向书籍追加 Excel/CSV 任务。
- `POST /api/books/:bookId/continue`：继续该书籍未完成任务。
- `GET /api/tasks/:taskId/runs`：查看任务执行记录。
- `POST /api/tasks/:taskId/pause`：暂停历史任务。
- `POST /api/tasks/:taskId/retry`：重试历史任务。
- `DELETE /api/tasks/:taskId`：删除历史任务。

`POST /api/batches` 请求体：

```json
{
  "workbookId": "workbook-id",
  "sheetName": "Sheet1",
  "mapping": {
    "book_id": "书籍id",
    "paragraph_content": "段落内容",
    "chapter_sort": "章节序号"
  },
  "rowLimit": 10
}
```

`rowLimit` 可省略；省略时编译当前工作表全部非空数据行。

`POST /api/batches/:id/start-selected` 请求体：

```json
{
  "taskIds": ["task-id-1", "task-id-2"]
}
```

行为：

- `queued` 任务直接纳入本轮生成。
- `failed`、`paused`、`succeeded` 且非字段校验失败的任务会 reset 后纳入生成。
- `running`、字段校验失败、已不存在的任务会跳过。
- 本轮生成完成后，如果 scope 外仍有未执行任务，批次状态回到 `idle`。

## 前端布局

第一屏就是批量工具，不做落地页：

- 上传区
- 字段映射区
- 执行控制区
- 任务筛选/批量选择工具条
- 任务表格
- 右侧悬浮结果预览
- 运行日志，默认只展示最近少量日志
- 飞书导出入口

## 质量判断 Prompt 优化

页面入口：

```text
http://127.0.0.1:5173/?page=quality
```

用途：

- 上传 Excel/CSV，字段映射只需要选择“段落内容”。
- 创建质量判断测试记录，并调用独立 Dify 质量判断工作流。
- 支持人工标注每条结果应为“有价值 / 无价值”。
- 提交校准后生成新的 Prompt 版本，自动设为当前版本，并同步写回本机 Skill：
  `/Users/staff/.codex/skills/novel-storyboard-value/references/production-prompt.md`
- 本地保留测试记录和 Prompt 版本，默认存储在 `tmp/quality-store.json`。
- 可勾选多个 Prompt 版本，对同一批段落重复执行并对比判断结果。

质量判断工作流环境变量：

- `QUALITY_DIFY_API_BASE`：质量判断工作流 API 服务器。
- `QUALITY_DIFY_API_KEY`：质量判断工作流 API Key。
- `QUALITY_DIFY_RESPONSE_MODE`：默认 `blocking`。
- `QUALITY_STORE_PATH`：可选，质量测试记录存储路径。
- `QUALITY_SKILL_PROMPT_PATH`：可选，Skill production prompt 路径。

质量判断后端接口：

- `GET /api/quality/state`：Prompt 版本和历史测试摘要。
- `POST /api/quality/experiments`：用工作簿、工作表和段落列创建测试记录。
- `GET /api/quality/experiments/:id`：获取完整测试记录。
- `GET /api/quality/experiments/:id/events`：SSE 推送质量判断进度。
- `POST /api/quality/experiments/:id/run`：对指定 Prompt 版本执行质量判断。
- `POST /api/quality/experiments/:experimentId/records/:recordId/annotation`：提交人工标注。
- `POST /api/quality/experiments/:id/calibrate`：根据误判标注生成并启用新 Prompt 版本。
- `POST /api/quality/prompt-versions/:id/activate`：手动切换当前 Prompt 版本。

## 飞书导出

导出按钮调用本机 `lark-cli`：

- 新建一个带时间戳的飞书 Base。
- 新建“批量结果”数据表。
- 创建字段：行号、状态、书籍 ID、章节序号、段落内容、`is_valid`、段落描述、角色、标题、结果图片、结果文本/JSON、workflow run id、耗时、错误。
- 先批量创建记录，再上传图片附件。
- 失败任务也写入。
- 导出不受页面筛选影响，导出当前批次所有剩余任务。

如果未登录或缺少权限，界面会显示 `lark-cli` 返回的错误。可先在终端完成飞书 CLI 认证。

## DSL 文件

当前参考 DSL：

- `LL-段落高光生图-效果测试.yml`
- `LL-段落高光生图-效果测试2.yml`
- `LL-段落高光生图-效果测试2-优化版.yml`

`LL-段落高光生图-效果测试2-优化版.yml` 修复点：

- 修正图片生成 HTTP 请求体里的 JSON 逗号问题。
- 移除非法片段 `"gen_user": "system", 60`。
- 为 `获取base64` 节点增加 `images_b64` 空值保护，避免 `IndexError: list index out of range`。

## 验证

```bash
npm test
npm run lint
npm run build
```

手工验收：

- 上传多本书、多状态样例，确认 `book_id` 和状态筛选组合生效。
- 不勾选时点击生成，只执行当前筛选下可生成任务。
- 勾选部分任务后，只执行勾选任务。
- 已成功任务被选中生成时旧结果会清空并重新执行。
- 未选中任务保持原状态。
- 右侧结果预览图片完整露出。
- 导出飞书后确认图片附件、`is_valid`、段落描述字段可见。

## 后续升级边界

- 需要断点续跑、历史批次检索或多人使用时，再引入 SQLite。
- 需要公网部署时，再补账号体系、权限隔离和服务端密钥管理。
- 需要追加到已有飞书 Base 时，再增加 Base 选择与表结构兼容检查。
