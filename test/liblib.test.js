const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createSignedPath,
  replacePlaceholders,
  validateWorkflowPayload,
} = require('../lib/liblib');

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
  const source = { generateParams: { 1: { inputs: { image: '{{CHARACTER_URL}}' } } } };
  const result = replacePlaceholders(source, { '{{CHARACTER_URL}}': 'https://cdn.test/a.png' });
  assert.equal(result.generateParams[1].inputs.image, 'https://cdn.test/a.png');
  assert.equal(source.generateParams[1].inputs.image, '{{CHARACTER_URL}}');
});

test('validateWorkflowPayload requires both media placeholders', () => {
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
    },
  }));
});
