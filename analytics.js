/* Yandex.Metrika goals — counter 111728847.
   All events are delegated here, fired in the background and never block
   navigation, calls or messengers. */
(function () {
  'use strict';

  var COUNTER_ID = 111728847;

  function sendMetrikaGoal(goal, params) {
    try {
      if (typeof window.ym === 'function') {
        if (params) {
          window.ym(COUNTER_ID, 'reachGoal', goal, params);
        } else {
          window.ym(COUNTER_ID, 'reachGoal', goal);
        }
      }
    } catch (error) {
      /* analytics must never interfere with the user action */
    }
  }

  var DIRECTIONS = {
    'horeografiya-dlya-detej': 'choreography',
    'klassicheskij-tanec-dlya-detej': 'classical',
    'plastika-dlya-detej': 'plastic',
    'teatralnaya-studiya-dlya-detej': 'theatre',
    'body-ballet-dlya-vzroslyh': 'body_ballet'
  };

  var PERFORMANCES = {
    'shchelkunchik': 'nutcracker',
    'spyashchaya-krasavitsa': 'sleeping_beauty',
    'zhar-ptitsa': 'firebird'
  };

  document.addEventListener('click', function (event) {
    // Trial-lesson CTA (may also be a tel: link — both goals are sent then)
    if (event.target.closest('[data-trial-form-open]')) {
      sendMetrikaGoal('click_trial');
    }

    var link = event.target.closest('a');
    if (!link) return;

    var href = link.getAttribute('href') || '';

    if (href.indexOf('tel:') === 0) {
      sendMetrikaGoal('click_phone');
      return;
    }

    var url;
    try {
      url = new URL(href, window.location.href);
    } catch (error) {
      return;
    }

    var host = url.hostname.toLowerCase();
    if (host === 't.me' || host.slice(-5) === '.t.me') {
      sendMetrikaGoal('click_telegram');
      return;
    }
    if (host === 'wa.me' || host.slice(-6) === '.wa.me') {
      sendMetrikaGoal('click_whatsapp');
      return;
    }

    var path = url.pathname;

    var directionSlug = path.split('/')[1];
    if (directionSlug && Object.prototype.hasOwnProperty.call(DIRECTIONS, directionSlug)) {
      sendMetrikaGoal('open_direction', { direction: DIRECTIONS[directionSlug] });
      return;
    }

    if (path.indexOf('/spektakli/') === 0) {
      var performanceSlug = path.split('/')[2];
      if (performanceSlug && Object.prototype.hasOwnProperty.call(PERFORMANCES, performanceSlug)) {
        sendMetrikaGoal('open_performance', { performance: PERFORMANCES[performanceSlug] });
        return;
      }
    }

    if (path === '/o-teatre-govoryat/' || path === '/o-teatre-govoryat') {
      sendMetrikaGoal('open_archive');
    }
  });
})();
