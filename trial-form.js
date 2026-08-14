(function () {
  'use strict';

  const config = window.ELF_TRIAL_FORM_CONFIG || {};
  const testMode = new URLSearchParams(window.location.search).get('trial-form-test') === '1';
  if (config.enabled !== true && !testMode) return;

  const requiredConfig = ['endpoint', 'captchaSiteKey'];
  if (requiredConfig.some((key) => typeof config[key] !== 'string' || !config[key].trim())) {
    console.warn('Форма пробного занятия не активирована: публичная конфигурация неполная.');
    return;
  }

  const directions = {
    choreography: 'Хореография для детей',
    classical: 'Классический танец',
    plastic: 'Пластика',
    theatre: 'Театральная студия',
    'body-ballet': 'Body Ballet',
    consultation: 'Не знаю — нужна консультация'
  };
  const pathnameDirections = {
    '/horeografiya-dlya-detej/': 'choreography',
    '/klassicheskij-tanec-dlya-detej/': 'classical',
    '/plastika-dlya-detej/': 'plastic',
    '/teatralnaya-studiya-dlya-detej/': 'theatre',
    '/body-ballet-dlya-vzroslyh/': 'body-ballet'
  };
  const phoneDisplay = '+7 905 513-53-11';
  let opener = null;
  let submitting = false;
  let captchaLoader = null;
  let captchaWidgetId = null;
  let captchaResolve = null;
  let captchaReject = null;

  const dialog = document.createElement('dialog');
  dialog.className = 'trial-form-dialog';
  dialog.setAttribute('aria-labelledby', 'trial-form-title');
  dialog.innerHTML = `
    <div class="trial-form-dialog__panel">
      <button class="trial-form-dialog__close" type="button" aria-label="Закрыть форму" data-trial-close>&times;</button>
      <div class="trial-form-dialog__heading">
        <p class="eyebrow">Пробное занятие</p>
        <h2 id="trial-form-title">Записаться на пробное занятие</h2>
        <p>Оставьте контакты — мы свяжемся с вами и поможем подобрать подходящее направление.</p>
      </div>
      <form class="trial-form" novalidate>
        <div class="trial-form__field">
          <label for="trial-contact-name">Как к вам обращаться?</label>
          <input id="trial-contact-name" name="contactName" type="text" autocomplete="name" maxlength="80" aria-describedby="trial-contact-name-error" required>
          <span class="trial-form__error" id="trial-contact-name-error"></span>
        </div>
        <div class="trial-form__row">
          <div class="trial-form__field">
            <label for="trial-phone">Телефон</label>
            <input id="trial-phone" name="phone" type="tel" autocomplete="tel" inputmode="tel" maxlength="40" aria-describedby="trial-phone-error" required>
            <span class="trial-form__error" id="trial-phone-error"></span>
          </div>
          <div class="trial-form__field">
            <label for="trial-student-age">Возраст занимающегося</label>
            <input id="trial-student-age" name="studentAge" type="text" inputmode="decimal" maxlength="20" aria-describedby="trial-student-age-error" required>
            <span class="trial-form__error" id="trial-student-age-error"></span>
          </div>
        </div>
        <div class="trial-form__field">
          <label for="trial-direction">Направление</label>
          <select id="trial-direction" name="direction" aria-describedby="trial-direction-error" required>
            <option value="">Выберите направление</option>
            ${Object.entries(directions).map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}
          </select>
          <span class="trial-form__error" id="trial-direction-error"></span>
        </div>
        <div class="trial-form__field">
          <label for="trial-comment">Комментарий <span>(необязательно)</span></label>
          <textarea id="trial-comment" name="comment" maxlength="1000" rows="3" placeholder="Например, расскажите об опыте занятий или задайте вопрос" aria-describedby="trial-comment-error"></textarea>
          <span class="trial-form__error" id="trial-comment-error"></span>
        </div>
        <div class="trial-form__honeypot" aria-hidden="true">
          <label for="trial-website">Сайт</label>
          <input id="trial-website" name="website" type="text" tabindex="-1" autocomplete="off">
        </div>
        <div class="trial-form__consent">
          <input id="trial-consent" name="consent" type="checkbox" aria-describedby="trial-consent-error" required>
          <label for="trial-consent">Я даю <a href="${config.consentUrl}" target="_blank" rel="noopener">согласие на обработку персональных данных</a>. <a href="${config.privacyUrl}" target="_blank" rel="noopener">Политика обработки персональных данных</a></label>
        </div>
        <span class="trial-form__error" id="trial-consent-error"></span>
        <div id="trial-smart-captcha"></div>
        <div class="trial-form__status" role="status" aria-live="polite"></div>
        <div class="trial-form__actions">
          <button class="button button--dark" type="submit">Отправить заявку</button>
          <button class="button trial-form__success-close" type="button" data-trial-close hidden>Закрыть</button>
        </div>
      </form>
    </div>`;
  document.body.append(dialog);

  const form = dialog.querySelector('form');
  const status = dialog.querySelector('.trial-form__status');
  const submitButton = form.querySelector('[type="submit"]');
  const successCloseButton = form.querySelector('.trial-form__success-close');
  const direction = form.elements.direction;

  function clearError(field) {
    field.removeAttribute('aria-invalid');
    const error = document.getElementById(`${field.id}-error`);
    if (error) error.textContent = '';
  }

  function setError(field, message) {
    field.setAttribute('aria-invalid', 'true');
    const error = document.getElementById(`${field.id}-error`);
    if (error) error.textContent = message;
  }

  function validate() {
    const values = Object.fromEntries(new FormData(form));
    const checks = [
      [form.elements.contactName, values.contactName && values.contactName.trim(), 'Укажите, как к вам обращаться.'],
      [form.elements.phone, values.phone && values.phone.replace(/\D/g, '').length >= 7 && values.phone.replace(/\D/g, '').length <= 15, 'Укажите корректный телефон.'],
      [form.elements.studentAge, values.studentAge && values.studentAge.trim(), 'Укажите возраст занимающегося.'],
      [direction, Object.hasOwn(directions, values.direction), 'Выберите направление.'],
      [form.elements.consent, form.elements.consent.checked, 'Необходимо дать согласие на обработку данных.']
    ];
    form.querySelectorAll('[aria-invalid="true"]').forEach(clearError);
    let firstInvalid = null;
    checks.forEach(([field, valid, message]) => {
      if (!valid) {
        setError(field, message);
        firstInvalid ||= field;
      }
    });
    if (firstInvalid) firstInvalid.focus();
    return !firstInvalid;
  }

  function resetCaptcha() {
    if (captchaWidgetId !== null && window.smartCaptcha) window.smartCaptcha.reset(captchaWidgetId);
    captchaResolve = null;
    captchaReject = null;
  }

  function loadCaptcha() {
    if (window.smartCaptcha) return Promise.resolve();
    if (captchaLoader) return captchaLoader;
    captchaLoader = new Promise((resolve, reject) => {
      const callbackName = `elfTrialCaptchaReady${Date.now()}`;
      window[callbackName] = () => {
        delete window[callbackName];
        window.smartCaptcha ? resolve() : reject(new Error('CAPTCHA_UNAVAILABLE'));
      };
      const script = document.createElement('script');
      script.src = `https://smartcaptcha.cloud.yandex.ru/captcha.js?render=onload&onload=${callbackName}`;
      script.async = true;
      script.defer = true;
      script.onerror = () => {
        delete window[callbackName];
        captchaLoader = null;
        reject(new Error('CAPTCHA_LOAD_FAILED'));
      };
      document.head.append(script);
    });
    return captchaLoader;
  }

  async function getCaptchaToken() {
    await loadCaptcha();
    if (captchaWidgetId === null) {
      captchaWidgetId = window.smartCaptcha.render('trial-smart-captcha', {
        sitekey: config.captchaSiteKey,
        invisible: true,
        callback: (token) => captchaResolve && captchaResolve(token),
        'error-callback': () => captchaReject && captchaReject(new Error('CAPTCHA_FAILED')),
        'expired-callback': () => captchaReject && captchaReject(new Error('CAPTCHA_EXPIRED'))
      });
    }
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error('CAPTCHA_TIMEOUT')), 20000);
      captchaResolve = (token) => {
        window.clearTimeout(timeout);
        resolve(token);
      };
      captchaReject = (error) => {
        window.clearTimeout(timeout);
        reject(error);
      };
      window.smartCaptcha.execute(captchaWidgetId);
    });
  }

  function showTechnicalError() {
    status.className = 'trial-form__status trial-form__status--error';
    status.innerHTML = `Не удалось отправить заявку. Попробуйте ещё раз или позвоните нам: <a href="tel:${config.phoneFallback}">${phoneDisplay}</a>.`;
  }

  function setBusy(busy) {
    submitting = busy;
    form.setAttribute('aria-busy', String(busy));
    submitButton.disabled = busy;
    submitButton.textContent = busy ? 'Отправляем…' : 'Отправить заявку';
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submitting) return;
    status.textContent = '';
    status.className = 'trial-form__status';
    if (!validate()) {
      status.textContent = 'Проверьте заполненные поля.';
      status.classList.add('trial-form__status--error');
      return;
    }
    setBusy(true);
    const controller = new AbortController();
    let timeout = null;
    try {
      const smartToken = await getCaptchaToken();
      timeout = window.setTimeout(() => controller.abort(), 20000);
      const data = Object.fromEntries(new FormData(form));
      const response = await fetch(config.endpoint, {
        method: 'POST',
        mode: 'cors',
        credentials: 'omit',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({...data, consent: form.elements.consent.checked, sourcePage: window.location.pathname, smartToken}),
        signal: controller.signal
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) {
        if (result.code === 'CAPTCHA_FAILED') throw new Error('CAPTCHA_FAILED');
        throw new Error('SUBMISSION_FAILED');
      }
      form.reset();
      direction.value = pathnameDirections[window.location.pathname] || '';
      status.textContent = 'Спасибо! Заявка отправлена. Мы свяжемся с вами.';
      status.className = 'trial-form__status trial-form__status--success';
      submitButton.hidden = true;
      successCloseButton.hidden = false;
      successCloseButton.focus();
    } catch (error) {
      if (String(error.message).startsWith('CAPTCHA_')) {
        status.textContent = 'Не удалось подтвердить отправку. Попробуйте ещё раз.';
        status.className = 'trial-form__status trial-form__status--error';
      } else {
        showTechnicalError();
      }
    } finally {
      if (timeout !== null) window.clearTimeout(timeout);
      resetCaptcha();
      setBusy(false);
    }
  });

  dialog.querySelectorAll('[data-trial-close]').forEach((button) => button.addEventListener('click', () => dialog.close()));
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog && !submitting) dialog.close();
  });
  dialog.addEventListener('cancel', (event) => {
    if (submitting) event.preventDefault();
  });
  dialog.addEventListener('close', () => {
    document.body.classList.remove('trial-form-is-open');
    opener?.focus();
  });

  document.querySelectorAll('[data-trial-form-open]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      opener = button;
      direction.value = pathnameDirections[window.location.pathname] || '';
      status.textContent = '';
      status.className = 'trial-form__status';
      submitButton.hidden = false;
      successCloseButton.hidden = true;
      document.body.classList.add('trial-form-is-open');
      dialog.showModal();
      loadCaptcha().catch(() => console.warn('Не удалось загрузить SmartCaptcha для формы пробного занятия.'));
      form.elements.contactName.focus();
    });
  });
}());
