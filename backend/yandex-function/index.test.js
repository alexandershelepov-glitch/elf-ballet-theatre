'use strict';

const {test, beforeEach, afterEach} = require('node:test');
const assert = require('node:assert/strict');
const {handler} = require('./index');

const originalFetch = global.fetch;
const originalEnv = {...process.env};
const validBody = {
  contactName: 'Александра', phone: '+7 (999) 123-45-67', studentAge: '6', direction: 'classical',
  comment: 'Есть опыт занятий', consent: true, sourcePage: '/klassicheskij-tanec-dlya-detej/', smartToken: 'captcha-token', website: ''
};

function event(overrides = {}, body = validBody) {
  return {
    httpMethod: 'POST', headers: {origin: 'https://elfballet.ru', 'content-type': 'application/json'},
    body: JSON.stringify(body), requestContext: {identity: {sourceIp: '192.0.2.1'}}, ...overrides
  };
}

function mockFetch(sequence) {
  const calls = [];
  global.fetch = async (...args) => {
    calls.push(args);
    const next = sequence.shift();
    if (next instanceof Error) throw next;
    return {ok: next.ok, status: next.status || (next.ok ? 200 : 500), json: async () => next.json || {}};
  };
  return calls;
}

beforeEach(() => {
  Object.assign(process.env, {
    ALLOWED_ORIGINS: 'https://elfballet.ru,https://www.elfballet.ru', SMARTCAPTCHA_SERVER_KEY: 'test-server-key',
    POSTBOX_FROM_EMAIL: 'sender@example.test', POSTBOX_TO_EMAIL: 'recipient@example.test',
    TELEGRAM_BOT_TOKEN: 'test-bot-token', TELEGRAM_CHAT_ID: 'test-chat-id', TELEGRAM_ENABLED: 'true', CONSENT_VERSION: 'test-v1'
  });
});

afterEach(() => {
  global.fetch = originalFetch;
  process.env = {...originalEnv};
});

test('OPTIONS returns preflight for allowed origin', async () => {
  const result = await handler(event({httpMethod: 'OPTIONS'}), {});
  assert.equal(result.statusCode, 204);
  assert.equal(result.headers['Access-Control-Allow-Origin'], 'https://elfballet.ru');
});

test('rejects an unknown origin without reflecting it', async () => {
  const result = await handler(event({headers: {origin: 'https://evil.example', 'content-type': 'application/json'}}), {});
  assert.equal(result.statusCode, 403);
  assert.equal(result.headers['Access-Control-Allow-Origin'], undefined);
});

test('rejects GET with 405', async () => {
  const result = await handler(event({httpMethod: 'GET'}), {});
  assert.equal(result.statusCode, 405);
  assert.equal(JSON.parse(result.body).code, 'METHOD_NOT_ALLOWED');
});

test('rejects non-JSON content type', async () => {
  const result = await handler(event({headers: {origin: 'https://elfballet.ru', 'content-type': 'text/plain'}}), {});
  assert.equal(JSON.parse(result.body).code, 'VALIDATION_ERROR');
});

test('rejects malformed JSON', async () => {
  const result = await handler(event({body: '{broken'}), {});
  assert.equal(result.statusCode, 400);
});

test('decodes a base64 body', async () => {
  const calls = mockFetch([{ok: true, json: {status: 'ok'}}, {ok: true}, {ok: true}]);
  const body = Buffer.from(JSON.stringify(validBody)).toString('base64');
  const result = await handler(event({body, isBase64Encoded: true}), {token: 'iam'});
  assert.equal(result.statusCode, 200);
  assert.equal(calls.length, 3);
});

test('rejects oversized payload', async () => {
  const result = await handler(event({body: JSON.stringify({...validBody, comment: 'x'.repeat(11000)})}), {});
  assert.equal(result.statusCode, 413);
  assert.equal(JSON.parse(result.body).code, 'PAYLOAD_TOO_LARGE');
});

test('rejects a missing required field', async () => {
  const result = await handler(event({}, {...validBody, contactName: ''}), {});
  assert.equal(JSON.parse(result.body).code, 'VALIDATION_ERROR');
});

test('requires consent to be strictly true', async () => {
  const result = await handler(event({}, {...validBody, consent: 'true'}), {});
  assert.equal(JSON.parse(result.body).code, 'VALIDATION_ERROR');
});

test('rejects an unknown direction', async () => {
  const result = await handler(event({}, {...validBody, direction: 'unknown'}), {});
  assert.equal(JSON.parse(result.body).code, 'VALIDATION_ERROR');
});

test('honeypot returns fake success without external calls', async () => {
  const calls = mockFetch([]);
  const result = await handler(event({}, {...validBody, website: 'spam.example'}), {});
  assert.deepEqual(JSON.parse(result.body), {ok: true});
  assert.equal(calls.length, 0);
});

test('rejects failed CAPTCHA and sends nothing else', async () => {
  const calls = mockFetch([{ok: true, json: {status: 'failed'}}]);
  const result = await handler(event(), {token: 'iam'});
  assert.equal(JSON.parse(result.body).code, 'CAPTCHA_FAILED');
  assert.equal(calls.length, 1);
});

test('successful delivery sends email and Telegram', async () => {
  const calls = mockFetch([{ok: true, json: {status: 'ok'}}, {ok: true}, {ok: true}]);
  const result = await handler(event(), {token: 'iam'});
  assert.equal(result.statusCode, 200);
  assert.equal(calls.length, 3);
  assert.match(calls[1][0], /postbox/);
  assert.match(calls[2][0], /api\.telegram\.org/);
});

test('email failure prevents Telegram and returns stable error', async () => {
  const calls = mockFetch([{ok: true, json: {status: 'ok'}}, {ok: false}]);
  const result = await handler(event(), {token: 'iam'});
  assert.equal(JSON.parse(result.body).code, 'EMAIL_DELIVERY_FAILED');
  assert.equal(calls.length, 2);
});

test('Telegram failure after email still returns success', async () => {
  mockFetch([{ok: true, json: {status: 'ok'}}, {ok: true}, {ok: false}]);
  const result = await handler(event(), {token: 'iam'});
  assert.equal(JSON.parse(result.body).ok, true);
});

test('Telegram notification contains no personal form fields', async () => {
  const calls = mockFetch([{ok: true, json: {status: 'ok'}}, {ok: true}, {ok: true}]);
  await handler(event(), {token: 'iam'});
  const telegram = JSON.parse(calls[2][1].body).text;
  assert.doesNotMatch(telegram, /Александра|999|Есть опыт|Возраст/);
  assert.match(telegram, /Классический танец/);
});

test('success response contains a safe submission ID', async () => {
  mockFetch([{ok: true, json: {status: 'ok'}}, {ok: true}, {ok: true}]);
  const result = await handler(event(), {token: 'iam'});
  assert.match(JSON.parse(result.body).submissionId, /^ELF-\d{8}-[A-F0-9]{6}$/);
});

test('missing backend configuration returns SERVER_CONFIG_ERROR', async () => {
  delete process.env.SMARTCAPTCHA_SERVER_KEY;
  const result = await handler(event(), {token: 'iam'});
  assert.equal(JSON.parse(result.body).code, 'SERVER_CONFIG_ERROR');
});
