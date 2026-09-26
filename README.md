# Motion Transfer Studio

一个简洁的 LiblibAI 动作模仿前端：上传角色图片和参考动作视频，调用 LiblibAI 工作流 API，轮询并展示生成视频。

## 工作方式

应用使用 LiblibAI 文档中的三个接口：

- `POST /api/generate/upload/signature`：获取 OSS 上传签名
- `POST /api/generate/comfyui/app`：提交已开通 API 的动作模仿工作流
- `POST /api/generate/comfy/status`：轮询任务并取得 `videos[].videoUrl`

AccessKey 与 SecretKey 只在 Node 服务端使用，不会发送给浏览器。角色图和动作视频先发送到本机 Node 服务，再由服务端使用官方签名上传到 LiblibAI OSS，从而避开 OSS 对本地网页的跨域限制；素材不会保存在本地磁盘。

## 配置

1. 复制 `.env.example` 为 `.env`，填入 LiblibAI 开放平台的密钥：

```env
LIBLIB_ACCESS_KEY=你的_AccessKey
LIBLIB_SECRET_KEY=你的_SecretKey
PORT=3000
```

2. 在 LiblibAI 中打开要使用的动作模仿工作流，开通 API 服务并复制页面给出的完整“参数示例”。

3. 用该 JSON 覆盖 `workflow.payload.json`，保留真实的 `templateUuid`、`workflowUuid`、节点 ID、`class_type` 和其他参数，只把两个素材 URL 改为：

```json
"{{CHARACTER_URL}}"
"{{ACTION_VIDEO_URL}}"
```

示意：

```json
{
  "templateUuid": "4df2efa0f18d46dc9758803e478eb51c",
  "generateParams": {
    "workflowUuid": "你的动作模仿工作流 UUID",
    "角色图片节点 ID": {
      "class_type": "工作流参数示例中的原值",
      "inputs": { "工作流中的图片字段": "{{CHARACTER_URL}}" }
    },
    "动作视频节点 ID": {
      "class_type": "工作流参数示例中的原值",
      "inputs": { "工作流中的视频字段": "{{ACTION_VIDEO_URL}}" }
    }
  }
}
```

不要猜节点 ID 或 `class_type`；不同动作模仿工作流的参数不同，必须以该工作流 API 页面生成的 JSON 为准。`workflow.payload.json` 本身通常不含密钥，可以保存在服务器，但仍建议按你的工作流许可要求管理。

## 运行

无需安装第三方依赖，要求 Node.js 20 或更高版本：

```bash
npm start
```

浏览器打开 `http://localhost:3000`。右上角显示“API 已连接”后即可上传角色图片和动作视频。

开发模式：

```bash
npm run dev
```

测试：

```bash
npm test
```

## 部署注意

- 生产环境请使用 HTTPS，并把 `.env` 作为服务器环境变量管理。
- 若部署为公网服务，建议在 Node 服务前增加登录、速率限制和调用额度控制，避免 API 积分被滥用。
- LiblibAI 返回的视频地址有时效性，重要结果应及时下载归档。
- 仅上传已获授权的人物和视频素材，遵守肖像权、版权及 LiblibAI 内容规范。
