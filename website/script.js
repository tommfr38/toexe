/* toexe site: copy button + terminal replay. Everything works without JS (the terminal is fully visible by default). */
(function () {
  'use strict';

  // ---- Copy install command ----
  var btn = document.getElementById('copy-btn');
  var status = document.getElementById('copy-status');
  if (btn) {
    var label = btn.querySelector('.copy-label');
    var timer;
    var finish = function (ok) {
      if (label) label.textContent = ok ? 'Copied' : 'Press Ctrl+C';
      btn.classList.toggle('done', ok);
      if (status) status.textContent = ok ? 'Install command copied to clipboard' : 'Select the command and copy it manually';
      clearTimeout(timer);
      timer = setTimeout(function () {
        if (label) label.textContent = 'Copy';
        btn.classList.remove('done');
        if (status) status.textContent = '';
      }, 2000);
    };
    var fallback = function (text, el) {
      try {
        var range = document.createRange();
        range.selectNodeContents(el);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        var ok = document.execCommand && document.execCommand('copy');
        finish(!!ok);
      } catch (e) { finish(false); }
    };
    btn.addEventListener('click', function () {
      var el = document.getElementById(btn.getAttribute('data-target'));
      if (!el) return;
      var text = el.textContent.trim();
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(function () { finish(true); }, function () { fallback(text, el); });
      } else {
        fallback(text, el);
      }
    });
  }

  // ---- Terminal reveal ----
  var term = document.getElementById('term');
  var body = document.getElementById('term-body');
  var replay = document.getElementById('replay');
  if (!term || !body) return;

  var lines = Array.prototype.slice.call(body.querySelectorAll('.ln'));
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var timers = [];
  var played = false;

  function clearTimers() { timers.forEach(clearTimeout); timers = []; }
  function showAll() {
    clearTimers();
    lines.forEach(function (l) { l.classList.remove('pending'); });
    term.classList.remove('typing');
  }
  function play() {
    clearTimers();
    lines.forEach(function (l) { l.classList.add('pending'); });
    term.classList.add('typing');
    if (replay) replay.hidden = true;
    var t = 0;
    lines.forEach(function (l, i) {
      var text = l.textContent;
      // pause longer after prompts and before results to feel like a real session
      t += /\$ toexe|Which app\?/.test(text) ? 650 : /Inspecting/.test(text) ? 550 : 170;
      timers.push(setTimeout(function () {
        l.classList.remove('pending');
        if (i === lines.length - 1) {
          term.classList.remove('typing');
          if (replay) replay.hidden = false;
        }
      }, t));
    });
  }

  if (replay) replay.addEventListener('click', play);

  if (reduce || !('IntersectionObserver' in window)) {
    showAll();
    return;
  }
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (e.isIntersecting && !played) {
        played = true;
        io.disconnect();
        play();
      }
    });
  }, { threshold: 0.35 });
  io.observe(term);
})();
