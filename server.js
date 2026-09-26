const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const {
  LiblibClient,
  LiblibError,
  replacePlaceholders,
  validateWorkflowPayload,
} = require('./lib/liblib');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const MAX_JSON_BYTES = 128 * 1024;
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
const WORKFLOWS = Object.freeze({
  legacy: {
    id: 'legacy',
    name: '动作迁移 v1.1（原 API）',
    pathEnv: 'WORKFLOW_PAYLOAD_PATH',
    defaultPath: 'workflow.payload.json',
  },
  'wan-animate-v5': {
    id: 'wan-animate-v5',
    name: 'WanAnimate v5（新 API）',
    pathEnv: 'NEW_WORKFLOW_PAYLOAD_PATH',
    defaultPath: 'workflow.new.payload.json',
  },
});

function loadEnv(filePath = path.join(ROOT, '.env')) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const equalAt = trimmed.indexOf('=');
    if (equalAt < 1) continue;
    const key = trimmed.slice(0, equalAt).trim();
    let value = trimmed.slice(equalAt + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnv();

function getClient() {
  return new LiblibClient({
    accessKey: process.env.LIBLIB_ACCESS_KEY,
    secretKey: process.env.LIBLIB_SECRET_KEY,
    baseUrl: process.env.LIBLIB_BASE_URL,
  });
}

function getWorkflow(workflowId = 'legacy') {
  const workflow = WORKFLOWS[workflowId];
  if (!workflow) throw new Error('所选工作流不存在');
  return workflow;
}

function workflowPath(workflowId = 'legacy') {
  const workflow = getWorkflow(workflowId);
  return path.resolve(ROOT, process.env[workflow.pathEnv] || workflow.defaultPath);
}

function readWorkflowPayload(workflowId = 'legacy') {
  const filePath = workflowPath(workflowId);
  if (!fs.existsSync(filePath)) {
    throw new Error(`找不到工作流配置：${path.basename(filePath)}`);
  }
  return validateWorkflowPayload(JSON.parse(fs.readFileSync(filePath, 'utf8')));
}

function json(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

async function readBuffer(req, maxBytes, tooLargeMessage) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error(tooLargeMessage);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const buffer = await readBuffer(req, MAX_JSON_BYTES, '请求内容过大');
  if (!buffer.length) return {};
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new Error('请求 JSON 格式错误');
  }
}

async function uploadToLiblib(req, filename) {
  if (typeof filename !== 'string' || !filename || filename.length > 180) {
    throw new Error('文件名无效');
  }

  const declaredSize = Number(req.headers['content-length']);
  if (Number.isFinite(declaredSize) && declaredSize > MAX_UPLOAD_BYTES) {
    throw new Error('单个素材不能超过 200 MB');
  }

  const file = await readBuffer(req, MAX_UPLOAD_BYTES, '单个素材不能超过 200 MB');
  if (!file.length) throw new Error('上传文件为空');

  const signature = await getClient().getUploadSignature(filename);
  const requiredFields = [
    'key', 'policy', 'postUrl', 'xOssDate', 'xOssExpires',
    'xOssSignature', 'xOssCredential', 'xOssSignatureVersion',
  ];
  for (const field of requiredFields) {
    if (signature[field] === undefined || signature[field] === null) {
      throw new Error(`LiblibAI 上传签名缺少字段 ${field}`);
    }
  }

  const form = new FormData();
  form.append('x-oss-signature', String(signature.xOssSignature));
  form.append('x-oss-date', String(signature.xOssDate));
  form.append('x-oss-signature-version', String(signature.xOssSignatureVersion));
  form.append('policy', String(signature.policy));
  form.append('key', String(signature.key));
  form.append('x-oss-credential', String(signature.xOssCredential));
  form.append('x-oss-expires', String(signature.xOssExpires));
  form.append(
    'file',
    new Blob([file], { type: req.headers['content-type'] || 'application/octet-stream' }),
    filename,
  );

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  let response;
  try {
    response = await fetch(signature.postUrl, {
      method: 'POST',
      body: form,
      signal: controller.signal,
    });
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('上传 LiblibAI 超时，请重试');
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const details = (await response.text()).slice(0, 500);
    throw new LiblibError(`上传 LiblibAI 失败 (${response.status})`, {
      status: response.status,
      details,
    });
  }

  const base = signature.postUrl.endsWith('/') ? signature.postUrl : `${signature.postUrl}/`;
  return new URL(signature.key, base).toString();
}

function validateHttpsUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label}上传地址无效`);
  }
  if (url.protocol !== 'https:') throw new Error(`${label}上传地址必须使用 HTTPS`);
  return url.toString();
}

function configState() {
  const hasCredentials = Boolean(
    process.env.LIBLIB_ACCESS_KEY && process.env.LIBLIB_SECRET_KEY,
  );
  const workflows = Object.values(WORKFLOWS).map((workflow) => {
    try {
      readWorkflowPayload(workflow.id);
      return { id: workflow.id, name: workflow.name, ready: true, error: '' };
    } catch (error) {
      return { id: workflow.id, name: workflow.name, ready: false, error: error.message };
    }
  });
  const hasWorkflow = workflows.every((workflow) => workflow.ready);
  const workflowError = workflows
    .filter((workflow) => !workflow.ready)
    .map((workflow) => `${workflow.name}：${workflow.error}`)
    .join('；');
  return {
    ready: hasCredentials && hasWorkflow,
    hasCredentials,
    hasWorkflow,
    workflowError,
    workflows,
  };
}

function validateTaskOptions(body) {
  const durationSeconds = Number(body.durationSeconds);
  if (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 60) {
    throw new Error('视频时长必须是 1 到 60 之间的整数秒');
  }
  if (typeof body.description !== 'string') {
    throw new Error('请填写视频描述');
  }
  const description = body.description.trim();
  if (description.length > 1000) throw new Error('视频描述不能超过 1000 个字符');
  return { durationSeconds, description };
}

function buildWorkflowPayload(workflowId, values) {
  const template = readWorkflowPayload(workflowId);
  return replacePlaceholders(template, {
    '{{CHARACTER_URL}}': values.characterUrl,
    '{{ACTION_VIDEO_URL}}': values.actionVideoUrl,
    '{{DURATION_SECONDS}}': values.durationSeconds,
    '{{VIDEO_DESCRIPTION}}': values.description,
  });
}

async function handleApi(req, res, pathname, searchParams) {
  if (req.method === 'GET' && pathname === '/api/config') {
    return json(res, 200, configState());
  }

  if (req.method === 'POST' && pathname === '/api/upload-signature') {
    const { filename } = await readJson(req);
    if (typeof filename !== 'string' || filename.length > 180) {
      throw new Error('文件名无效');
    }
    const signature = await getClient().getUploadSignature(filename);
    return json(res, 200, signature);
  }

  if (req.method === 'POST' && pathname === '/api/uploads') {
    const url = await uploadToLiblib(req, searchParams.get('filename'));
    return json(res, 201, { url });
  }

  if (req.method === 'POST' && pathname === '/api/tasks') {
    const body = await readJson(req);
    if (body.confirmedRights !== true) {
      throw new Error('请先确认你拥有素材使用权和人物授权');
    }
    const characterUrl = validateHttpsUrl(body.characterUrl, '角色图片');
    const actionVideoUrl = validateHttpsUrl(body.actionVideoUrl, '动作视频');
    const workflowId = body.workflowId || 'legacy';
    const { durationSeconds, description } = validateTaskOptions(body);
    const payload = buildWorkflowPayload(workflowId, {
      characterUrl,
      actionVideoUrl,
      durationSeconds,
      description,
    });
    const result = await getClient().submitWorkflow(payload);
    if (!result?.generateUuid) throw new Error('LiblibAI 未返回任务 UUID');
    return json(res, 202, result);
  }

  const statusMatch = pathname.match(/^\/api\/tasks\/([a-fA-F0-9-]{16,80})$/);
  if (req.method === 'GET' && statusMatch) {
    const result = await getClient().getWorkflowStatus(statusMatch[1]);
    return json(res, 200, result);
  }

  return json(res, 404, { error: '接口不存在' });
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, pathname) {
  const requested = pathname === '/' ? 'index.html' : pathname.slice(1);
  const filePath = path.resolve(PUBLIC_DIR, requested);
  if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`) && filePath !== PUBLIC_DIR) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404).end('Not found');
    return;
  }
  const stat = fs.statSync(filePath);
  res.writeHead(200, {
    'Content-Type': CONTENT_TYPES[path.extname(filePath)] || 'application/octet-stream',
    'Content-Length': stat.size,
    // This is a local configuration UI; always revalidate assets so workflow fixes
    // and API response-field changes are visible immediately after refresh.
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  fs.createReadStream(filePath).pipe(res);
}

function createServer() {
  return http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url, 'http://localhost');
    try {
      if (requestUrl.pathname.startsWith('/api/')) {
        await handleApi(req, res, requestUrl.pathname, requestUrl.searchParams);
      } else if (req.method === 'GET' || req.method === 'HEAD') {
        serveStatic(req, res, requestUrl.pathname);
      } else {
        json(res, 405, { error: '不支持的请求方法' });
      }
    } catch (error) {
      const status = error instanceof LiblibError ? 502 : 400;
      console.error(error);
      json(res, status, {
        error: error.message || '服务器错误',
        ...(process.env.NODE_ENV === 'development' && error.details
          ? { details: error.details }
          : {}),
      });
    }
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  const server = createServer();
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`端口 ${port} 已被占用。请结束旧服务，或在 .env 中设置其他 PORT。`);
      process.exitCode = 1;
      return;
    }
    throw error;
  });
  server.listen(port, '127.0.0.1', () => {
    const state = configState();
    console.log(`Motion Transfer Studio: http://localhost:${port}`);
    if (!state.ready) {
      console.log('配置尚未完成：请检查 .env 与 workflow.payload.json');
    }
  });
}

module.exports = {
  WORKFLOWS,
  buildWorkflowPayload,
  createServer,
  readWorkflowPayload,
  validateTaskOptions,
};
