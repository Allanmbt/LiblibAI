const crypto = require('node:crypto');

const TERMINAL_STATUSES = new Set([5, 6, 7]);

class LiblibError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'LiblibError';
    this.status = options.status;
    this.details = options.details;
  }
}

function createSignedPath(pathname, accessKey, secretKey, options = {}) {
  const timestamp = String(options.timestamp ?? Date.now());
  const nonce = options.nonce ?? crypto.randomBytes(12).toString('hex');
  const source = `${pathname}&${timestamp}&${nonce}`;
  const signature = crypto
    .createHmac('sha1', secretKey)
    .update(source)
    .digest('base64url');

  const params = new URLSearchParams({
    AccessKey: accessKey,
    Signature: signature,
    Timestamp: timestamp,
    SignatureNonce: nonce,
  });

  return `${pathname}?${params}`;
}

function replacePlaceholders(value, replacements) {
  if (Array.isArray(value)) {
    return value.map((item) => replacePlaceholders(item, replacements));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        replacePlaceholders(item, replacements),
      ]),
    );
  }

  if (typeof value !== 'string') return value;

  if (Object.prototype.hasOwnProperty.call(replacements, value)) {
    return replacements[value];
  }

  return Object.entries(replacements).reduce(
    (result, [placeholder, replacement]) =>
      result.replaceAll(placeholder, String(replacement)),
    value,
  );
}

function validateWorkflowPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('workflow.payload.json 必须是 JSON 对象');
  }

  if (!payload.templateUuid || !payload.generateParams?.workflowUuid) {
    throw new Error('工作流配置缺少 templateUuid 或 generateParams.workflowUuid');
  }

  const serialized = JSON.stringify(payload);
  if (/REPLACE_WITH_|CHARACTER_NODE_ID|VIDEO_NODE_ID/.test(serialized)) {
    throw new Error('工作流配置仍包含待替换项');
  }

  const requiredPlaceholders = [
    '{{CHARACTER_URL}}',
    '{{ACTION_VIDEO_URL}}',
    '{{DURATION_SECONDS}}',
    '{{VIDEO_DESCRIPTION}}',
  ];
  for (const placeholder of requiredPlaceholders) {
    if (!serialized.includes(placeholder)) {
      throw new Error(`工作流配置缺少占位符 ${placeholder}`);
    }
  }

  return payload;
}

class LiblibClient {
  constructor({ accessKey, secretKey, baseUrl = 'https://openapi.liblibai.cloud' }) {
    if (!accessKey || !secretKey) {
      throw new Error('LiblibAI AccessKey 和 SecretKey 尚未配置');
    }
    this.accessKey = accessKey;
    this.secretKey = secretKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async request(pathname, body) {
    const signedPath = createSignedPath(
      pathname,
      this.accessKey,
      this.secretKey,
    );
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45_000);

    try {
      const response = await fetch(`${this.baseUrl}${signedPath}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'liblib-motion-transfer/1.0',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const raw = await response.text();
      let result;
      try {
        result = raw ? JSON.parse(raw) : {};
      } catch {
        throw new LiblibError('LiblibAI 返回了无法解析的响应', {
          status: response.status,
          details: raw.slice(0, 500),
        });
      }

      if (!response.ok || (typeof result.code === 'number' && result.code !== 0)) {
        throw new LiblibError(result.msg || `LiblibAI 请求失败 (${response.status})`, {
          status: response.status,
          details: result,
        });
      }

      return result.data;
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new LiblibError('LiblibAI 请求超时，请稍后重试');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  getUploadSignature(filename) {
    const dot = filename.lastIndexOf('.');
    if (dot <= 0 || dot === filename.length - 1) {
      throw new Error('文件名必须包含扩展名');
    }

    const rawName = filename.slice(0, dot);
    const extension = filename.slice(dot + 1).toLowerCase();
    const name = rawName
      .normalize('NFKC')
      .replace(/[^\p{L}\p{N}._-]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'upload';

    return this.request('/api/generate/upload/signature', { name, extension });
  }

  submitWorkflow(payload) {
    return this.request('/api/generate/comfyui/app', payload);
  }

  getWorkflowStatus(generateUuid) {
    return this.request('/api/generate/comfy/status', { generateUuid });
  }
}

module.exports = {
  LiblibClient,
  LiblibError,
  TERMINAL_STATUSES,
  createSignedPath,
  replacePlaceholders,
  validateWorkflowPayload,
};
