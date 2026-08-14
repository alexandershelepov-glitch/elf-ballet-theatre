'use strict';

const crypto = require('node:crypto');

const CAPTCHA_URL = 'https://smartcaptcha.cloud.yandex.ru/validate';
const POSTBOX_URL = 'https://postbox.cloud.yandex.net/v2/email/outbound-emails';
const MAX_BODY_BYTES = 10 * 1024;
const DIRECTIONS = Object.freeze({
  choreography: 'Хореография для детей',
  classical: 'Классический танец',
  plastic: 'Пластика',
  theatre: 'Театральная студия',
  'body-ballet': 'Body Ballet',
  consultation: 'Не знаю — нужна консультация'
});

function headersFor(origin, allowed) {
  const headers = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
    Vary: 'Origin'
  };
  if (allowed) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function response(statusCode, codeOrBody, origin, allowed) {
  const body = typeof codeOrBody === 'string' ? {ok: false, code: codeOrBody} : codeOrBody;
  return {statusCode, headers: {...headersFor(origin, allowed), 'Content-Type': 'application/json; charset=utf-8'}, body: JSON.stringify(body)};
}

function normalizedHeaders(headers = {}) {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
}

function methodOf(event) {
  return String(event.httpMethod || event.requestContext?.http?.method || event.requestContext?.httpMethod || 'GET').toUpperCase();
}

function parseAllowedOrigins() {
  return (process.env.ALLOWED_ORIGINS || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function parseBody(event) {
  const encoded = typeof event.body === 'string' ? event.body : '';
  const buffer = event.isBase64Encoded ? Buffer.from(encoded, 'base64') : Buffer.from(encoded, 'utf8');
  if (buffer.byteLength > MAX_BODY_BYTES) return {error: 'PAYLOAD_TOO_LARGE'};
  try {
    return {value: JSON.parse(buffer.toString('utf8'))};
  } catch {
    return {error: 'VALIDATION_ERROR'};
  }
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const data = {
    contactName: cleanString(input.contactName),
    phone: cleanString(input.phone),
    studentAge: cleanString(input.studentAge),
    direction: cleanString(input.direction),
    comment: cleanString(input.comment),
    sourcePage: cleanString(input.sourcePage),
    smartToken: cleanString(input.smartToken),
    website: cleanString(input.website),
    consent: input.consent
  };
  const digitCount = data.phone.replace(/\D/g, '').length;
  if (data.contactName.length < 1 || data.contactName.length > 80 ||
      data.phone.length < 1 || data.phone.length > 40 || digitCount < 7 || digitCount > 15 ||
      data.studentAge.length < 1 || data.studentAge.length > 20 ||
      !Object.hasOwn(DIRECTIONS, data.direction) || data.comment.length > 1000 ||
      data.sourcePage.length < 1 || data.sourcePage.length > 200 || !data.sourcePage.startsWith('/') ||
      data.smartToken.length < 1 || data.smartToken.length > 4096 || data.website.length > 200 ||
      data.consent !== true) return null;
  return data;
}

function configIsValid(context) {
  const telegramEnabled = process.env.TELEGRAM_ENABLED !== 'false';
  return Boolean(
    process.env.SMARTCAPTCHA_SERVER_KEY && process.env.POSTBOX_FROM_EMAIL &&
    process.env.POSTBOX_TO_EMAIL && process.env.CONSENT_VERSION && context?.token?.access_token &&
    (!telegramEnabled || (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID))
  );
}

function sourceIp(event, headers) {
  return event.requestContext?.identity?.sourceIp || event.requestContext?.http?.sourceIp || String(headers['x-forwarded-for'] || '').split(',')[0].trim();
}

async function validateCaptcha(token, ip) {
  const form = new URLSearchParams({secret: process.env.SMARTCAPTCHA_SERVER_KEY, token, ip: ip || ''});
  const result = await fetch(CAPTCHA_URL, {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: form.toString()
  });
  if (!result.ok) throw new Error('CAPTCHA_PROVIDER_ERROR');
  const body = await result.json();
  return body.status === 'ok';
}

function submissionId() {
  const date = new Intl.DateTimeFormat('en-CA', {timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit'}).format(new Date()).replaceAll('-', '');
  return `ELF-${date}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function moscowDate() {
  return new Intl.DateTimeFormat('ru-RU', {timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'}).format(new Date()).replace(',', ',');
}

function emailText(data, id, date) {
  return [
    'Новая заявка с сайта Детского театра балета «Эльф»', '',
    `Заявка: ${id}`, `Дата: ${date}`, `Направление: ${DIRECTIONS[data.direction]}`, '',
    `Как обращаться: ${data.contactName}`, `Телефон: ${data.phone}`, `Возраст занимающегося: ${data.studentAge}`, '',
    'Комментарий:', data.comment || '—', '', `Источник: ${data.sourcePage}`, '',
    'Согласие на обработку персональных данных: получено', `Версия согласия: ${process.env.CONSENT_VERSION}`
  ].join('\n');
}

async function sendEmail(data, id, date, iamToken) {
  const payload = {
    fromAddress: process.env.POSTBOX_FROM_EMAIL,
    destination: {toAddresses: [process.env.POSTBOX_TO_EMAIL]},
    content: {simple: {
      subject: {data: `[Эльф] Новая заявка — ${DIRECTIONS[data.direction]}`, charset: 'UTF-8'},
      body: {text: {data: emailText(data, id, date), charset: 'UTF-8'}}
    }}
  };
  const result = await fetch(POSTBOX_URL, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'X-YaCloud-SubjectToken': iamToken},
    body: JSON.stringify(payload)
  });
  if (!result.ok) throw new Error('EMAIL_DELIVERY_FAILED');
}

async function sendTelegram(data, id, date) {
  if (process.env.TELEGRAM_ENABLED === 'false') return;
  const text = ['🔔 Новая заявка с сайта «Эльф»', '', `Заявка: ${id}`, `Направление: ${DIRECTIONS[data.direction]}`, `Источник: ${data.sourcePage}`, `Время: ${date}`, '', 'Полная заявка отправлена на почту.'].join('\n');
  const result = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({chat_id: process.env.TELEGRAM_CHAT_ID, text})
  });
  if (!result.ok) throw new Error('TELEGRAM_DELIVERY_FAILED');
}

module.exports.handler = async function handler(event = {}, context = {}) {
  const headers = normalizedHeaders(event.headers);
  const origin = String(headers.origin || '');
  const allowed = parseAllowedOrigins().includes(origin);
  const method = methodOf(event);

  if (!allowed) return response(403, 'ORIGIN_NOT_ALLOWED', origin, false);
  if (method === 'OPTIONS') return {statusCode: 204, headers: headersFor(origin, true), body: ''};
  if (method !== 'POST') return response(405, 'METHOD_NOT_ALLOWED', origin, true);
  if (!String(headers['content-type'] || '').toLowerCase().startsWith('application/json')) return response(400, 'VALIDATION_ERROR', origin, true);

  const parsed = parseBody(event);
  if (parsed.error) return response(parsed.error === 'PAYLOAD_TOO_LARGE' ? 413 : 400, parsed.error, origin, true);
  const data = validate(parsed.value);
  if (!data) return response(400, 'VALIDATION_ERROR', origin, true);
  if (data.website) return response(200, {ok: true}, origin, true);
  if (!configIsValid(context)) return response(500, 'SERVER_CONFIG_ERROR', origin, true);

  let captchaOk;
  try {
    captchaOk = await validateCaptcha(data.smartToken, sourceIp(event, headers));
  } catch {
    return response(500, 'INTERNAL_ERROR', origin, true);
  }
  if (!captchaOk) return response(400, 'CAPTCHA_FAILED', origin, true);

  const id = submissionId();
  const date = moscowDate();
  try {
    await sendEmail(data, id, date, context.token.access_token);
    console.info(`submission ${id} email sent`);
  } catch {
    console.error(`submission ${id} email delivery failed`);
    return response(502, 'EMAIL_DELIVERY_FAILED', origin, true);
  }
  try {
    await sendTelegram(data, id, date);
  } catch {
    console.error(`submission ${id} telegram notification failed`);
  }
  return response(200, {ok: true, submissionId: id}, origin, true);
};

module.exports._internals = {DIRECTIONS, validate, parseBody, emailText};
