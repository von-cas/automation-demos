// vondemo.pages.dev: theme toggle, live ops feed + stats (polling the Worker), tabs, video facade.
(function () {
  'use strict';

  var API = (document.querySelector('meta[name="demo-api"]') || {}).content || '';
  var POLL_MS = 15000;
  var DEMO_LABELS = {
    'speed-to-lead': 'Speed-to-Lead',
    booking: 'Booking',
    invoice: 'Invoice',
    fixlink: 'FixLink',
    livedesk: 'LiveDesk',
  };

  // ---------- theme ----------
  var root = document.documentElement;
  function currentTheme() {
    var set = root.getAttribute('data-theme');
    if (set) return set;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function paintToggle(btn) {
    var dark = currentTheme() === 'dark';
    btn.setAttribute('aria-pressed', String(dark));
    btn.textContent = dark ? 'Theme: dark' : 'Theme: light';
  }
  document.querySelectorAll('[data-theme-toggle]').forEach(function (btn) {
    paintToggle(btn);
    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      var repaint = function () { paintToggle(btn); };
      if (mq.addEventListener) mq.addEventListener('change', repaint);
      else if (mq.addListener) mq.addListener(repaint);
    }
    btn.addEventListener('click', function () {
      var next = currentTheme() === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem('vondemo-theme', next); } catch (e) { /* not saved */ }
      paintToggle(btn);
    });
  });

  // ---------- formatting ----------
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function secs(ms) {
    if (ms == null) return '–';
    if (ms < 1000) return ms + ' ms';
    if (ms < 60000) return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + ' s';
    return Math.round(ms / 60000) + ' min';
  }
  function ago(t) {
    var s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return s + ' s ago';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return Math.round(s / 86400) + ' d ago';
  }
  function setText(sel, scope, value) {
    scope.querySelectorAll(sel).forEach(function (n) { n.textContent = value; });
  }

  // ---------- ops feed ----------
  function renderRuns(list, runs, emptyText) {
    list.textContent = '';
    if (!runs.length) {
      var li = el('li', 'empty', emptyText);
      list.appendChild(li);
      return;
    }
    runs.forEach(function (r) {
      var li = el('li', 'feed-row');
      li.appendChild(el('span', 'feed-demo', DEMO_LABELS[r.demo] || r.demo));
      var out = el('span', 'feed-outcome');
      var badge = el('span', 'badge', r.status === 'success' ? 'ok' : r.status);
      badge.setAttribute('data-status', r.status);
      out.appendChild(badge);
      out.appendChild(document.createTextNode(r.outcome || (r.status === 'running' ? 'Running…' : 'No outcome')));
      li.appendChild(out);
      li.appendChild(el('span', 'feed-meta', secs(r.duration_ms) + ' · ' + ago(r.started_at)));
      if (r.steps && r.steps.length) {
        var steps = el('ul', 'feed-steps');
        steps.setAttribute('aria-label', 'Steps');
        r.steps.forEach(function (s) {
          var chip = el('li', 'step-chip', s.name + ' ' + (s.status === 'skipped' ? 'skipped' : secs(s.ms)));
          chip.setAttribute('data-status', s.status);
          steps.appendChild(chip);
        });
        li.appendChild(steps);
      }
      list.appendChild(li);
    });
  }

  function renderStats(scope, s, demo) {
    var d = demo ? (s.demos || []).filter(function (x) { return x.demo === demo; })[0] : null;
    var runs24 = demo ? (d ? d.runs_24h : 0) : s.runs_24h;
    var rate = demo ? (d ? d.success_rate_7d : null) : s.success_rate_7d;
    var med = demo && d ? d.median_metric_ms_7d || d.median_duration_ms_7d : null;
    if (!demo) {
      var all = (s.demos || []).map(function (x) { return x.median_metric_ms_7d; }).filter(function (v) { return v != null; });
      med = all.length ? all.sort(function (a, b) { return a - b; })[Math.floor(all.length / 2)] : null;
    }
    setText('[data-stat="runs_24h"]', scope, String(runs24));
    setText('[data-stat="success_rate_7d"]', scope, rate == null ? '–' : rate + '%');
    setText('[data-stat="median"]', scope, secs(med));
    setText('[data-stat="emails_today"]', scope, String((s.today && s.today.emails_sent) || 0));
    setText('[data-stat="reminders_today"]', scope, String((s.today && s.today.reminders_sent) || 0));
  }

  function getJson(path) {
    return fetch(API + path, { headers: { accept: 'application/json' } }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  document.querySelectorAll('[data-ops-feed]').forEach(function (scope) {
    var demo = scope.getAttribute('data-demo') || '';
    var list = scope.querySelector('[data-feed-list]');
    var status = scope.querySelector('[data-feed-status]');
    var statusText = status && status.querySelector('[data-feed-status-text]');
    var emptyText = scope.getAttribute('data-empty') || 'No runs yet. The feed fills in as the demos run.';
    var timer = null;

    function setStatus(state, text) {
      if (!status) return;
      status.setAttribute('data-state', state);
      if (statusText) statusText.textContent = text;
    }

    function tick() {
      if (!API) return setStatus('error', 'Feed not configured');
      var q = '/api/runs?limit=' + (scope.getAttribute('data-limit') || '12') + (demo ? '&demo=' + encodeURIComponent(demo) : '');
      Promise.all([getJson(q), getJson('/api/stats')])
        .then(function (res) {
          if (list) renderRuns(list, res[0].runs || [], emptyText);
          renderStats(scope, res[1], demo);
          setStatus('live', 'Live · updated ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
        })
        .catch(function () {
          setStatus('error', 'Feed offline · retrying');
        });
    }
    function start() { if (!timer) { tick(); timer = setInterval(tick, POLL_MS); } }
    function stop() { clearInterval(timer); timer = null; }
    document.addEventListener('visibilitychange', function () { (document.hidden ? stop : start)(); });
    start();
  });

  // ---------- tabs (WAI-ARIA tabs pattern) ----------
  document.querySelectorAll('[role="tablist"]').forEach(function (tablist) {
    var tabs = Array.prototype.slice.call(tablist.querySelectorAll('[role="tab"]'));
    function select(tab, focus) {
      tabs.forEach(function (t) {
        var on = t === tab;
        t.setAttribute('aria-selected', String(on));
        t.tabIndex = on ? 0 : -1;
        var panel = document.getElementById(t.getAttribute('aria-controls'));
        if (panel) panel.hidden = !on;
      });
      if (focus) tab.focus();
    }
    tabs.forEach(function (tab, i) {
      tab.addEventListener('click', function () { select(tab, false); });
      tab.addEventListener('keydown', function (e) {
        var j = null;
        if (e.key === 'ArrowRight') j = (i + 1) % tabs.length;
        if (e.key === 'ArrowLeft') j = (i - 1 + tabs.length) % tabs.length;
        if (e.key === 'Home') j = 0;
        if (e.key === 'End') j = tabs.length - 1;
        if (j != null) { e.preventDefault(); select(tabs[j], true); }
      });
    });
  });

  // ---------- video facade: loads YouTube only on click ----------
  document.querySelectorAll('[data-youtube]').forEach(function (box) {
    var id = box.getAttribute('data-youtube');
    if (!/^[\w-]{11}$/.test(id || '')) return;
    var btn = box.querySelector('.video-play');
    if (!btn) return;
    box.classList.add('ready');
    btn.style.backgroundImage = 'url(https://i.ytimg.com/vi/' + id + '/hqdefault.jpg)';
    btn.addEventListener('click', function () {
      var f = document.createElement('iframe');
      f.src = 'https://www.youtube-nocookie.com/embed/' + id + '?autoplay=1&rel=0';
      f.title = box.getAttribute('data-title') || 'Demo video';
      f.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
      f.allowFullscreen = true;
      box.textContent = '';
      box.appendChild(f);
    });
  });

  // ---------- index: highlight the section in view ----------
  var links = document.querySelectorAll('.index-list a[href^="#"]');
  if (links.length && 'IntersectionObserver' in window) {
    var byId = {};
    links.forEach(function (a) { byId[a.getAttribute('href').slice(1)] = a; });
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        links.forEach(function (a) { a.classList.remove('active'); });
        var a = byId[en.target.id];
        if (a) a.classList.add('active');
      });
    }, { rootMargin: '-30% 0px -60% 0px' });
    Object.keys(byId).forEach(function (id) { var s = document.getElementById(id); if (s) io.observe(s); });
  }
})();
