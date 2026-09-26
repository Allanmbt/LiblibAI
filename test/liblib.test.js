const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createSignedPath,
  replacePlaceholders,
  validateWorkflowPayload,
} = require('../lib/liblib');
const {
  buildWorkflowPayload,
  readWorkflowPayload,
  validateTaskOptions,
} = require('../server');

test('createSignedPath follows the documented HMAC-SHA1 scheme', () => {
  const signed = createSignedPath('/api/test', 'access', 'secret', {
    timestamp: 1725458584000,
    nonce: 'nonce-1',
  });
  const url = new URL(signed, 'https://example.test');
  const expected = require('node:crypto')
    .createHmac('sha1', 'secret')
    .update('/api/test&1725458584000&nonce-1')
    .digest('base64url');
  assert.equal(url.searchParams.get('Signature'), expected);
  assert.equal(url.searchParams.get('AccessKey'), 'access');
});

test('replacePlaceholders handles nested workflow objects without mutation', () => {
  const source = {
    generateParams: {
      1: { inputs: { image: '{{CHARACTER_URL}}', duration: '{{DURATION_SECONDS}}' } },
    },
  };
  const result = replacePlaceholders(source, {
    '{{CHARACTER_URL}}': 'https://cdn.test/a.png',
    '{{DURATION_SECONDS}}': 9,
  });
  assert.equal(result.generateParams[1].inputs.image, 'https://cdn.test/a.png');
  assert.equal(result.generateParams[1].inputs.duration, 9);
  assert.equal(source.generateParams[1].inputs.image, '{{CHARACTER_URL}}');
});

test('validateWorkflowPayload requires all shared control placeholders', () => {
  assert.throws(() => validateWorkflowPayload({
    templateUuid: 'template',
    generateParams: { workflowUuid: 'workflow' },
  }), /CHARACTER_URL/);

  assert.doesNotThrow(() => validateWorkflowPayload({
    templateUuid: 'template',
    generateParams: {
      workflowUuid: 'workflow',
      1: { inputs: { image: '{{CHARACTER_URL}}' } },
      2: { inputs: { video: '{{ACTION_VIDEO_URL}}' } },
      3: { inputs: { duration: '{{DURATION_SECONDS}}' } },
      4: { inputs: { description: '{{VIDEO_DESCRIPTION}}' } },
    },
  }));
});

test('both bundled workflows expose media, duration and description placeholders', () => {
  assert.doesNotThrow(() => readWorkflowPayload('legacy'));
  assert.doesNotThrow(() => readWorkflowPayload('wan-animate-v5'));
});

test('validateTaskOptions keeps typed duration and trims description', () => {
  assert.deepEqual(validateTaskOptions({ durationSeconds: '9', description: '  女孩跳舞  ' }), {
    durationSeconds: 9,
    description: '女孩跳舞',
  });
  assert.throws(
    () => validateTaskOptions({ durationSeconds: 0, description: '' }),
    /1 到 60/,
  );
});

test('shared controls map to the correct nodes in both workflow payloads', () => {
  const values = {
    characterUrl: 'https://cdn.test/character.png',
    actionVideoUrl: 'https://cdn.test/action.mp4',
    durationSeconds: 9,
    description: '女孩跳舞',
  };
  const legacy = buildWorkflowPayload('legacy', values).generateParams;
  assert.equal(legacy['172'].inputs.value, 9);
  assert.equal(legacy['189'].inputs.value, '女孩跳舞');
  assert.equal(legacy['209'].inputs.video, values.actionVideoUrl);
  assert.equal(legacy['210'].inputs.image, values.characterUrl);

  const modern = buildWorkflowPayload('wan-animate-v5', values).generateParams;
  assert.equal(modern['117'].inputs.int, 9);
  assert.equal(modern['194'].inputs.text, '女孩跳舞');
  assert.equal(modern['154'].inputs.video, values.actionVideoUrl);
  assert.equal(modern['131'].inputs.image, values.characterUrl);
});
