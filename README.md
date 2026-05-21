# Dify Excel 批量工作流网站

本地单机 Web 工具：上传 Excel/CSV，将每行映射为 Dify 工作流任务，串行执行并展示结果，可一键导出到飞书多维表格。

## 启动

```bash
npm install
npm run dev
```

打开：

```text
http://127.0.0.1:5173/
```

后端监听：

```text
http://127.0.0.1:5175/
```

## 环境变量

复制 `.env.example` 为 `.env.local`，再填入真实 Dify API Key：

```env
DIFY_API_BASE=http://dify.qmniu.com/v1
DIFY_API_KEY=replace-with-your-dify-api-key
DIFY_RESPONSE_MODE=streaming
LARK_CLI_AS=user
PORT=5175
```

`.env.local` 已加入 `.gitignore`，不要提交真实密钥。

## Excel 表头

必填输入：

- `book_id` / `书籍id`
- `paragraph_content` / `段落内容`
- `chapter_sort` / `章节序号`

上传后会自动映射；无法识别时可在界面手动选择列。

## 飞书导出

导出按钮会调用本机 `lark-cli`：

- 新建一个带时间戳的飞书 Base。
- 新建“批量结果”数据表。
- 批量写入输入项、状态、角色、标题、文本/JSON、workflow run id、耗时、错误。
- 对成功生成的图片上传到“结果图片”附件字段。

如果未登录或缺少权限，界面会显示 `lark-cli` 返回的错误。可先在终端完成飞书 CLI 认证。

## 验证

```bash
npm test
npm run build
```
