import assert from 'node:assert/strict';
import test from 'node:test';
import { generateGptImage, resolveImageConfig, resolveImageEndpoint } from '../src/services/imageGenerationService.js';

const png = Buffer.from('89504e470d0a1a0a0000000049454e44ae426082', 'hex');

test('image endpoint accepts a gateway base URL or a chat URL', () => {
  assert.equal(resolveImageEndpoint('https://gateway.example:7689'), 'https://gateway.example:7689/v1/images/generations');
  assert.equal(resolveImageEndpoint('https://gateway.example/v1/chat/completions'), 'https://gateway.example/v1/images/generations');
});

test('image generation does not send the server LLM key to a browser-selected endpoint', () => {
  const env = {
    SCIENCEPRISM_LLM_ENDPOINT: 'https://trusted.example/v1/chat/completions',
    SCIENCEPRISM_LLM_API_KEY: 'server-secret'
  };
  assert.deepEqual(resolveImageConfig({ endpoint: 'https://other.example/v1', apiKey: '' }, env), {
    endpoint: 'https://other.example/v1/images/generations', apiKey: ''
  });
});

test('image generation reuses the server key only when provider endpoints match', () => {
  const env = {
    SCIENCEPRISM_LLM_ENDPOINT: 'https://trusted.example/v1/chat/completions',
    SCIENCEPRISM_LLM_API_KEY: 'server-secret'
  };
  assert.deepEqual(resolveImageConfig({ endpoint: 'https://trusted.example/v1' }, env), {
    endpoint: 'https://trusted.example/v1/images/generations', apiKey: 'server-secret'
  });
});

test('image-specific endpoint and key take precedence as a pair', () => {
  const env = {
    SCIENCEPRISM_IMAGE_ENDPOINT: 'https://images.example/v1',
    SCIENCEPRISM_IMAGE_API_KEY: 'image-secret',
    SCIENCEPRISM_LLM_ENDPOINT: 'https://trusted.example/v1',
    SCIENCEPRISM_LLM_API_KEY: 'server-secret'
  };
  assert.deepEqual(resolveImageConfig({ endpoint: 'https://other.example/v1' }, env), {
    endpoint: 'https://images.example/v1/images/generations', apiKey: 'image-secret'
  });
});

test('GPT Image 2 request uses the image generation endpoint and decodes PNG output', async () => {
  const config = { endpoint: 'https://gateway.example/v1/images/generations', apiKey: 'test-key' };
  const result = await generateGptImage({
    prompt: 'a graph neural network diagram',
    config,
    fetchImpl: async (url, options) => {
      assert.equal(url, config.endpoint);
      assert.equal(options.headers.Authorization, 'Bearer test-key');
      assert.deepEqual(JSON.parse(options.body), {
        model: 'gpt-image-2', prompt: 'a graph neural network diagram', size: '1536x1024',
        quality: 'medium', output_format: 'png', n: 1
      });
      return new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }), { status: 200 });
    }
  });
  assert.deepEqual(result, png);
});

test('image generation rejects missing keys and invalid provider images', async () => {
  await assert.rejects(generateGptImage({ prompt: 'graph', config: { endpoint: 'https://example.com', apiKey: '' } }), /IMAGE_API_KEY/);
  await assert.rejects(generateGptImage({
    prompt: 'graph', config: { endpoint: 'https://example.com', apiKey: 'test-key' },
    fetchImpl: async () => new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('not png').toString('base64') }] }), { status: 200 })
  }), /invalid PNG/);
  await assert.rejects(generateGptImage({
    prompt: 'graph', config: { endpoint: 'https://example.com', apiKey: 'test-key' },
    fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'secret token' } }), { status: 401 })
  }), /HTTP 401/);
});
