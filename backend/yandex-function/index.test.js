'use strict';

const {test, beforeEach, afterEach} = require('node:test');
const assert = require('node:assert/strict');
const {handler} = require('./index');

const originalFetch = global.fetch;
const originalEnv = {...process.env};
const originalConsole = {info: console.info, warn: console.warn, error: console.error};
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

function captureLogs() {
  const logs = [];
  for (const level of ['info', 'warn', 'error']) {
    console[level] = (...args) => logs.push(args.join(' '));
  }
  return logs;
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
  Object.assign(console, originalConsole);
});

test('OPTIONS returns preflight for allowed origin', async () => {
  const result = await handler(event({httpMethod: 'OPTIONS'}), {});
  assert.equal(result.statusCode, 204);
  assert.equal(result.headers['Access-Control-Allow-Origin'], 'https://elfballet.ru');
});

test('rejects an unknown origin without reflecting it', async () => {
  const logs = captureLogs();
  const result = await handler(event({headers: {origin: 'https://evil.example', 'content-type': 'application/json'}}), {});
  assert.equal(result.statusCode, 403);
  assert.equal(result.headers['Access-Control-Allow-Origin'], undefined);
  assert.deepEqual(logs, ['trial request received', 'trial rejected: origin']);
});

test('rejects GET with 405', async () => {
  const logs = captureLogs();
  const result = await handler(event({httpMethod: 'GET'}), {});
  assert.equal(result.statusCode, 405);
  assert.equal(JSON.parse(result.body).code, 'METHOD_NOT_ALLOWED');
  assert.deepEqual(logs, ['trial request received', 'trial rejected: validation']);
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
  const result = await handler(event({body, isBase64Encoded: true}), {token: {access_token: 'iam'}});
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
  const logs = captureLogs();
  const calls = mockFetch([{ok: true, json: {status: 'failed'}}]);
  const result = await handler(event(), {token: {access_token: 'iam'}});
  assert.equal(JSON.parse(result.body).code, 'CAPTCHA_FAILED');
  assert.equal(calls.length, 1);
  assert.ok(logs.includes('trial captcha validation started'));
  assert.ok(logs.includes('trial rejected: captcha'));
});

test('logs a CAPTCHA provider error without provider details', async () => {
  const logs = captureLogs();
  mockFetch([new Error('provider detail must not be logged')]);
  const result = await handler(event(), {token: {access_token: 'iam'}});
  assert.equal(JSON.parse(result.body).code, 'INTERNAL_ERROR');
  assert.ok(logs.includes('trial captcha provider error'));
  assert.doesNotMatch(logs.join('\n'), /provider detail must not be logged/);
});

test('successful delivery sends email and Telegram', async () => {
  const logs = captureLogs();
  const calls = mockFetch([{ok: true, json: {status: 'ok'}}, {ok: true}, {ok: true}]);
  const result = await handler(event(), {token: {access_token: 'iam'}});
  assert.equal(result.statusCode, 200);
  assert.equal(calls.length, 3);
  assert.match(calls[1][0], /postbox/);
  assert.equal(calls[1][1].headers['X-YaCloud-SubjectToken'], 'iam');
  const postboxPayload = JSON.parse(calls[1][1].body);
  assert.deepEqual(postboxPayload, {
    FromEmailAddress: 'sender@example.test',
    Destination: {ToAddresses: ['recipient@example.test']},
    Content: {Simple: {
      Subject: {Data: '[Эльф] Новая заявка — Классический танец', Charset: 'UTF-8'},
      Body: {Text: {Data: postboxPayload.Content.Simple.Body.Text.Data, Charset: 'UTF-8'}}
    }}
  });
  assert.match(postboxPayload.Content.Simple.Body.Text.Data, /Новая заявка с сайта Детского театра балета «Эльф»/);
  assert.equal(postboxPayload.fromAddress, undefined);
  assert.equal(postboxPayload.destination, undefined);
  assert.equal(postboxPayload.content, undefined);
  assert.match(calls[2][0], /api\.telegram\.org/);
  for (const message of [
    'trial request received', 'trial captcha validation started', 'trial captcha passed',
    'trial email sending started', 'trial email sent', 'trial telegram sending started', 'trial telegram sent'
  ]) assert.ok(logs.includes(message));
  assert.doesNotMatch(logs.join('\n'), /Александра|999|Есть опыт|captcha-token|test-server-key|test-bot-token|sender@example\.test/);
});

test('email failure prevents Telegram and returns stable error', async () => {
  const logs = captureLogs();
  const calls = mockFetch([{ok: true, json: {status: 'ok'}}, {ok: false, status: 503}]);
  const result = await handler(event(), {token: {access_token: 'iam'}});
  assert.equal(JSON.parse(result.body).code, 'EMAIL_DELIVERY_FAILED');
  assert.equal(calls.length, 2);
  assert.ok(logs.includes('trial email provider failed status=503'));
});

test('Telegram failure after email still returns success', async () => {
  const logs = captureLogs();
  mockFetch([{ok: true, json: {status: 'ok'}}, {ok: true}, {ok: false, status: 502}]);
  const result = await handler(event(), {token: {access_token: 'iam'}});
  assert.equal(JSON.parse(result.body).ok, true);
  assert.ok(logs.includes('trial telegram failed status=502'));
});

test('Telegram notification contains no personal form fields', async () => {
  const calls = mockFetch([{ok: true, json: {status: 'ok'}}, {ok: true}, {ok: true}]);
  await handler(event(), {token: {access_token: 'iam'}});
  const telegram = JSON.parse(calls[2][1].body).text;
  assert.doesNotMatch(telegram, /Александра|999|Есть опыт|Возраст/);
  assert.match(telegram, /Классический танец/);
});

test('success response contains a safe submission ID', async () => {
  mockFetch([{ok: true, json: {status: 'ok'}}, {ok: true}, {ok: true}]);
  const result = await handler(event(), {token: {access_token: 'iam'}});
  assert.match(JSON.parse(result.body).submissionId, /^ELF-\d{8}-[A-F0-9]{6}$/);
});

test('missing backend configuration returns SERVER_CONFIG_ERROR', async () => {
  const logs = captureLogs();
  delete process.env.SMARTCAPTCHA_SERVER_KEY;
  const result = await handler(event(), {token: {access_token: 'iam'}});
  assert.equal(JSON.parse(result.body).code, 'SERVER_CONFIG_ERROR');
  assert.ok(logs.includes('trial rejected: config'));
});

test('requires access_token in the Yandex Cloud context', async () => {
  const result = await handler(event(), {token: {}});
  assert.equal(JSON.parse(result.body).code, 'SERVER_CONFIG_ERROR');
});
