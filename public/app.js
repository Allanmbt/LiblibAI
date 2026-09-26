const elements = {
  apiStatus: document.querySelector('#apiStatus'),
  apiLabel: document.querySelector('#apiStatus .status-label'),
  characterInput: document.querySelector('#characterInput'),
  actionInput: document.querySelector('#actionInput'),
  workflowSelect: document.querySelector('#workflowSelect'),
  durationInput: document.querySelector('#durationInput'),
  descriptionInput: document.querySelector('#descriptionInput'),
  rightsCheck: document.querySelector('#rightsCheck'),
  generateButton: document.querySelector('#generateButton'),
  progressSection: document.querySelector('#progressSection'),
  progressTitle: document.querySelector('#progressTitle'),
  progressPercent: document.querySelector('#progressPercent'),
  progressBar: document.querySelector('#progressBar'),
  progressMessage: document.querySelector('#progressMessage'),
  resultSection: document.querySelector('#resultSection'),
  resultVideo: document.querySelector('#resultVideo'),
  openResult: document.querySelector('#openResult'),
  costSummary: document.querySelector('#costSummary'),
  newTaskButton: document.querySelector('#newTaskButton'),
  toast: document.querySelector('#toast'),
};

const state = {
  configured: false,
  workflowReadiness: {},
  character: null,
  action: null,
  busy: false,
  previewUrls: { character: null, action: null },
};

const statusNames = {
  1: ['任务排队中', 42, 'generate'],
  2: ['正在生成视频', 58, 'generate'],
  3: ['视频已生成', 82, 'audit'],
  4: ['正在进行内容审核', 91, 'audit'],
  5: ['生成完成', 100, 'audit'],
  6: ['生成失败', 100, 'audit'],
  7: ['任务超时', 100, 'audit'],
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`);
  return data;
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { elements.toast.hidden = true; }, 6500);
}

async function checkConfig() {
  try {
    const config = await api('/api/config');
    state.workflowReadiness = Object.fromEntries(
      (config.workflows || []).map((workflow) => [workflow.id, workflow]),
    );
    state.configured = Boolean(
      config.hasCredentials && state.workflowReadiness[elements.workflowSelect.value]?.ready,
    );
    elements.apiStatus.classList.toggle('ready', config.ready);
    elements.apiStatus.classList.toggle('error', !config.ready);
    elements.apiLabel.textContent = config.ready ? '2 个 API 已连接' : '需要配置';
    elements.apiStatus.title = config.ready
      ? 'LiblibAI 密钥与两个视频工作流已配置'
      : [
          config.hasCredentials ? '' : '缺少 .env API 密钥',
          config.workflowError,
        ].filter(Boolean).join('；');
    updateButton();
  } catch (error) {
    elements.apiStatus.classList.add('error');
    elements.apiLabel.textContent = '服务异常';
    elements.apiStatus.title = error.message;
  }
}

function validateFile(kind, file) {
  const imageTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
  const videoTypes = new Set(['video/mp4', 'video/quicktime', 'video/webm']);
  if (kind === 'character' && !imageTypes.has(file.type)) {
    throw new Error('角色图片仅支持 JPG、PNG 或 WebP');
  }
  if (kind === 'action' && !videoTypes.has(file.type)) {
    throw new Error('动作视频仅支持 MP4、MOV 或 WebM');
  }
}

function setFile(kind, file) {
  validateFile(kind, file);
  const panel = document.querySelector(`[data-kind="${kind}"]`);
  const dropzone = panel.querySelector('.dropzone');
  const preview = panel.querySelector('.media-preview');
  const fileState = panel.querySelector('.file-state');

  if (state.previewUrls[kind]) URL.revokeObjectURL(state.previewUrls[kind]);
  state.previewUrls[kind] = URL.createObjectURL(file);
  state[kind] = file;
  preview.src = state.previewUrls[kind];
  if (kind === 'action') preview.controls = true;
  dropzone.classList.add('has-file');
  fileState.textContent = `${file.name} · ${formatBytes(file.size)}`;
  updateButton();
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function updateButton() {
  const duration = Number(elements.durationInput.value);
  const hasValidOptions = Number.isInteger(duration) && duration >= 1 && duration <= 60;
  elements.generateButton.disabled = !(
    state.configured && state.character && state.action &&
    elements.rightsCheck.checked && hasValidOptions && !state.busy
  );
}

function selectWorkflow() {
  const selected = state.workflowReadiness[elements.workflowSelect.value];
  state.configured = Boolean(selected?.ready);
  if (selected && !selected.ready) showToast(selected.error || '工作流配置不可用');
  updateButton();
}

function bindDropzone(kind, input) {
  const panel = document.querySelector(`[data-kind="${kind}"]`);
  const zone = panel.querySelector('.dropzone');
  input.addEventListener('change', () => {
    if (!input.files[0]) return;
    try { setFile(kind, input.files[0]); } catch (error) { showToast(error.message); }
  });
  panel.querySelector('.replace-file').addEventListener('click', (event) => {
    event.preventDefault();
    input.click();
  });
  for (const eventName of ['dragenter', 'dragover']) {
    zone.addEventListener(eventName, (event) => {
      event.preventDefault();
      zone.classList.add('dragging');
    });
  }
  for (const eventName of ['dragleave', 'drop']) {
    zone.addEventListener(eventName, (event) => {
      event.preventDefault();
      zone.classList.remove('dragging');
    });
  }
  zone.addEventListener('drop', (event) => {
    const file = event.dataTransfer.files[0];
    if (!file) return;
    try { setFile(kind, file); } catch (error) { showToast(error.message); }
  });
}

function setProgress(title, percent, stage, message) {
  elements.progressSection.hidden = false;
  elements.progressTitle.textContent = title;
  elements.progressPercent.textContent = `${Math.round(percent)}%`;
  elements.progressBar.style.width = `${Math.min(100, Math.max(0, percent))}%`;
  if (message) elements.progressMessage.textContent = message;
  const order = ['upload', 'submit', 'generate', 'audit'];
  const current = order.indexOf(stage);
  document.querySelectorAll('.progress-steps li').forEach((item, index) => {
    item.classList.toggle('done', index < current);
    item.classList.toggle('active', index === current);
  });
}

async function uploadFile(file, label) {
  setProgress(`正在上传${label}`, 9, 'upload', `${label}正在上传至 LiblibAI…`);
  const query = new URLSearchParams({ filename: file.name });
  const response = await fetch(`/api/uploads?${query}`, {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result.error || `${label}上传失败 (${response.status})`);
  }
  if (!result.url) throw new Error(`${label}上传完成，但未返回素材地址`);
  return result.url;
}

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function pollTask(generateUuid) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 60 * 60 * 1000) {
    const result = await api(`/api/tasks/${encodeURIComponent(generateUuid)}`);
    const [title, fallbackPercent, stage] = statusNames[result.generateStatus] || statusNames[2];
    const apiPercent = Number(result.percentCompleted);
    const percent = apiPercent > 0
      ? Math.max(fallbackPercent, Math.round(apiPercent * 100))
      : fallbackPercent;
    setProgress(title, percent, stage, result.generateMsg || '视频生成通常需要几分钟，请保持页面打开。');
    if ([5, 6, 7].includes(result.generateStatus)) return result;
    await wait(5000);
  }
  throw new Error('等待超过一小时，任务仍可能在 LiblibAI 后台继续执行');
}

async function generate() {
  if (state.busy) return;
  const taskOptions = {
    workflowId: elements.workflowSelect.value,
    durationSeconds: Number(elements.durationInput.value),
    description: elements.descriptionInput.value,
  };
  state.busy = true;
  elements.workflowSelect.disabled = true;
  elements.durationInput.disabled = true;
  elements.descriptionInput.disabled = true;
  updateButton();
  elements.resultSection.hidden = true;
  elements.generateButton.querySelector('span').textContent = '生成中…';
  try {
    const characterUrl = await uploadFile(state.character, '角色图片');
    setProgress('角色图片上传完成', 18, 'upload');
    const actionVideoUrl = await uploadFile(state.action, '动作视频');
    setProgress('正在提交生成任务', 32, 'submit');
    const task = await api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        workflowId: taskOptions.workflowId,
        characterUrl,
        actionVideoUrl,
        durationSeconds: taskOptions.durationSeconds,
        description: taskOptions.description,
        confirmedRights: elements.rightsCheck.checked,
      }),
    });
    const result = await pollTask(task.generateUuid);
    if (result.generateStatus !== 5) {
      throw new Error(result.generateMsg || (result.generateStatus === 7 ? '任务超时' : '视频生成失败'));
    }
    const video = (result.videos || []).find((item) => item.auditStatus === 3) || result.videos?.[0];
    if (!video?.videoUrl) throw new Error('任务已完成，但未返回可播放的视频');
    elements.resultVideo.src = video.videoUrl;
    elements.openResult.href = video.videoUrl;
    elements.costSummary.textContent = [
      Number.isFinite(result.pointsCost) ? `本次 ${result.pointsCost} 积分` : '',
      Number.isFinite(result.accountBalance) ? `余额 ${result.accountBalance}` : '',
    ].filter(Boolean).join(' · ');
    elements.resultSection.hidden = false;
    elements.resultSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    showToast(error.message);
    elements.progressMessage.textContent = error.message;
    elements.progressTitle.textContent = '任务未完成';
  } finally {
    state.busy = false;
    elements.workflowSelect.disabled = false;
    elements.durationInput.disabled = false;
    elements.descriptionInput.disabled = false;
    elements.generateButton.querySelector('span').textContent = '开始生成';
    updateButton();
  }
}

function resetTask() {
  elements.resultVideo.removeAttribute('src');
  elements.resultVideo.load();
  elements.resultSection.hidden = true;
  elements.progressSection.hidden = true;
  window.scrollTo({ top: document.querySelector('.studio').offsetTop - 28, behavior: 'smooth' });
}

bindDropzone('character', elements.characterInput);
bindDropzone('action', elements.actionInput);
elements.rightsCheck.addEventListener('change', updateButton);
elements.workflowSelect.addEventListener('change', selectWorkflow);
elements.durationInput.addEventListener('input', updateButton);
elements.generateButton.addEventListener('click', generate);
elements.newTaskButton.addEventListener('click', resetTask);
checkConfig();
