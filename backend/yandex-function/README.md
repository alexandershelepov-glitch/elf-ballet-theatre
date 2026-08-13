# Backend формы пробного занятия

HTTP-функция для первого этапа формы сайта «Эльф». Она проверяет Origin, JSON и поля, отсекает honeypot, валидирует одноразовый SmartCaptcha token, отправляет полную заявку через Yandex Cloud Postbox и затем — обезличенное уведомление через Telegram. Функция не использует базу данных и не сохраняет заявки.

## Локальная проверка

Требуется Node.js 22. В каталоге функции выполните:

```sh
npm test
```

Тесты используют только `node:test` и замоканные HTTP-вызовы. Сетевых запросов к Yandex или Telegram они не выполняют.

## Переменные окружения

Список находится в `.env.example`. `ALLOWED_ORIGINS` принимает перечень точных Origin через запятую. `TELEGRAM_ENABLED=false` отключает дополнительное Telegram-уведомление. Секреты нужно задавать только в настройках функции или через штатное хранилище секретов, не в Git.

## Checklist второго этапа

1. Создать Yandex Cloud Function с runtime Node.js 22 и entrypoint `index.handler`.
2. Создать или выбрать service account и назначить ему необходимую роль отправителя Postbox.
3. Создать и подтвердить адрес отправителя в Yandex Cloud Postbox.
4. Прикрепить service account к функции: IAM token будет доступен как `context.token`.
5. Разрешить публичный HTTPS-вызов функции.
6. Задать `ALLOWED_ORIGINS` точными Origin боевого сайта.
7. Задать подтверждённый `POSTBOX_FROM_EMAIL` и адрес получателя `POSTBOX_TO_EMAIL`.
8. Задать версию юридического согласия в `CONSENT_VERSION`.
9. Создать SmartCaptcha для домена `elfballet.ru`, получить публичный client key и секретный server key.
10. Безопасно передать функции `SMARTCAPTCHA_SERVER_KEY`.
11. Создать/настроить Telegram-бота и безопасно передать `TELEGRAM_BOT_TOKEN` и `TELEGRAM_CHAT_ID` либо установить `TELEGRAM_ENABLED=false`.
12. Получить HTTPS URL функции.
13. В корневом `trial-form-config.js` добавить URL функции в `endpoint`, публичный SmartCaptcha client key в `captchaSiteKey`, реальные `privacyUrl` и `consentUrl`.
14. Проверить CORS preflight, успешную и ошибочную отправку, доставку письма и обезличенность Telegram-сообщения.
15. Проверить форму на desktop, tablet и мобильных ширинах 430, 390 и 360 px.
16. Только после успешной проверки установить `enabled: true` в `trial-form-config.js`.

На первом этапе внешние ресурсы Yandex Cloud не создаются, а production-конфигурация формы остаётся выключенной.
