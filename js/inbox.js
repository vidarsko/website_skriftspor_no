/* ==========================================================================
   inbox.js — the front page as the teacher's (and student's) desk.

   The page's views: start (drop zone), write (js/write.js), overview,
   detail. This file switches between them.

   Drop one or more .spor files anywhere on the window:
     one file   → straight to that submission: replay first, then numbers,
                  comparison with the handed-in text, and the checks
     several    → an overview table of all of them; click a row for the
                  same detail view, and Back returns to the table

   Which columns the overview shows is not settled (Vidar, 2026-10-18:
   "Vi kan komme tilbake til hva som skal vises"). They are defined in one
   list, COLUMNS, below — change them there.

   Nothing is sent anywhere. The files live in this page's memory only and
   are gone on reload.
   ========================================================================== */
(function () {
  'use strict';

  var S = window.Skriftspor;
  var $ = function (id) { return document.getElementById(id); };

  var files = [];        /* { id, name, report, submitted } */
  var current = null;    /* the file shown in detail, or null */
  var player = null;
  var sortKey = 'name', sortDir = 1;
  var nextId = 1;

  /* ---- Formatting ------------------------------------------------------- */

  var MONTHS = ['jan.', 'feb.', 'mars', 'april', 'mai', 'juni', 'juli', 'aug.', 'sep.', 'okt.', 'nov.', 'des.'];
  function pad(n) { return String(n).padStart(2, '0'); }
  function date(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    return d.getDate() + '. ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear() + ', ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function minutes(m) {
    if (m == null) return '—';
    if (m < 60) return m + ' min';
    return Math.floor(m / 60) + ' t ' + (m % 60) + ' min';
  }
  /* Calendar span from first to last keystroke. */
  function span(s) {
    if (!s.first_event) return null;
    return Math.round((Date.parse(s.last_event) - Date.parse(s.first_event)) / 60000);
  }
  function spanText(m) {
    if (m == null) return '—';
    if (m < 60 * 24) return minutes(m);
    var d = Math.round(m / (60 * 24));
    return d + ' døgn';
  }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  function showError(msg) {
    var e = $('inbox-error');
    e.textContent = msg || '';
    e.hidden = !msg;
  }

  /* ---- The overview's columns ---------------------------------------------
     value: what is sorted on; html: what is shown. */
  var COLUMNS = [
    { key: 'name', label: 'Innlevering', value: function (f) { return (f.report.file.title || f.name).toLowerCase(); },
      html: function (f) {
        return '<span class="ov__title">' + esc(f.report.file.title || 'Uten tittel') + '</span>' +
               '<span class="ov__file">' + esc(f.name) + '</span>';
      } },
    { key: 'first', label: 'Første tastetrykk', value: function (f) { return f.report.summary.first_event || ''; },
      html: function (f) { return date(f.report.summary.first_event); } },
    { key: 'last', label: 'Siste tastetrykk', value: function (f) { return f.report.summary.last_event || ''; },
      html: function (f) { return date(f.report.summary.last_event); } },
    { key: 'span', label: 'Tid totalt', num: true, title: 'Fra første til siste tastetrykk',
      value: function (f) { return span(f.report.summary) || 0; }, html: function (f) { return spanText(span(f.report.summary)); } },
    { key: 'active', label: 'Aktiv tid', num: true, title: 'Tid med skriving; pauser over to minutter teller som to minutter',
      value: function (f) { return f.report.summary.active_minutes; }, html: function (f) { return minutes(f.report.summary.active_minutes); } },
    { key: 'sessions', label: 'Økter', num: true, value: function (f) { return f.report.summary.sessions; },
      html: function (f) { return f.report.summary.sessions; } },
    { key: 'words', label: 'Ord', num: true, value: function (f) { return f.report.summary.final_words; },
      html: function (f) { return f.report.summary.final_words; } },
    { key: 'pasted', label: 'Innlimt', num: true, title: 'Andel av slutteksten som ble limt inn',
      value: function (f) { return f.report.summary.final_pasted_percent; }, html: function (f) { return S.fmtPct(f.report.summary.final_pasted_percent); } },
    { key: 'ok', label: 'Kontroll', value: function (f) { return f.report.ok ? 1 : 0; },
      html: function (f) {
        return f.report.ok ? '<span class="badge badge--ok">OK</span>' : '<span class="badge badge--bad">Avvik</span>';
      } }
  ];

  /* ---- Loading ---------------------------------------------------------- */

  function isSpor(f) { return /\.(spor|json)$/i.test(f.name); }

  function addFiles(list) {
    showError('');
    var spor = [], docs = [];
    [].forEach.call(list, function (f) { (isSpor(f) ? spor : docs).push(f); });

    if (docs.length) {
      if (current && docs.length === 1 && !spor.length) { loadDocument(docs[0]); return; }
      showError(current ? 'Slipp én tekst om gangen.' : 'Bare spor-filer (.spor) kan slippes her.');
      if (!spor.length) return;
    }

    Promise.all(spor.map(function (f) {
      return f.text().then(function (t) {
        var parsed;
        try { parsed = JSON.parse(t); } catch (e) { return { name: f.name, error: 'er ikke en spor-fil' }; }
        return S.verifyFile(parsed).then(function (rep) {
          if (!rep.replay) return { name: f.name, error: rep.checks.map(function (c) { return c.label; }).join(' ') };
          return { name: f.name, report: rep };
        });
      });
    })).then(function (results) {
      var errors = [];
      results.forEach(function (r) {
        if (r.error) { errors.push(r.name + ' ' + r.error); return; }
        var key = r.report.file.head + r.report.file.text_sha256;
        if (files.some(function (f) { return f.key === key; })) return;   /* same file twice */
        files.push({ id: nextId++, key: key, name: r.name, report: r.report, submitted: null });
      });
      if (errors.length) showError('Kunne ikke leses: ' + errors.join('; ') + '.');
      if (!files.length) return;
      if (files.length === 1) openDetail(files[0], 'replace');
      else showOverview('push');
    });
  }

  function loadLocal() {
    var doc = S.local.load();
    if (!doc || !doc.sessions || !doc.sessions.length) {
      showError('Ingen tekst i denne nettleseren ennå.');
      return;
    }
    S.fileFromLocal(doc).then(function (file) {
      return S.verifyFile(JSON.parse(JSON.stringify(file)));
    }).then(function (rep) {
      var f = { id: nextId++, key: 'lokal', name: 'teksten i denne nettleseren', report: rep, submitted: null };
      files = files.filter(function (x) { return x.key !== 'lokal'; }).concat([f]);
      openDetail(f, 'push');
    }).catch(function (e) { showError('Teksten i nettleseren kunne ikke leses: ' + e.message); });
  }

  /* ---- Views ------------------------------------------------------------ */

  function setView(view) {
    document.body.setAttribute('data-view', view);
    $('overview').hidden = view !== 'overview';
    $('detail').hidden = view !== 'detail';
    $('write').hidden = view !== 'write';
    $('dropband').hidden = view === 'write';
    document.body.classList.toggle('has-files', view === 'overview' || view === 'detail');
    if (view !== 'detail' && player) { player.pause(); }
    if (view === 'start') syncStart();
  }

  /* «Fortsett teksten din» only when there is a text in this browser. */
  function syncStart() {
    var w = window.SkriftsporWriter;
    var has = !!(w && w.hasText());
    $('continue-local').hidden = !has;
    if (has) $('continue-local').textContent = w.title() ? 'Fortsett «' + w.title() + '»' : 'Fortsett teksten din';
  }

  function showWrite(how) {
    current = null;
    if (how === 'push') history.pushState({ view: 'write' }, '', '#skriv');
    setView('write');
    window.SkriftsporWriter.show();
  }

  function showOverview(how) {
    current = null;
    if (how === 'push') history.pushState({ view: 'overview' }, '');
    setView('overview');
    $('overview-title').textContent = files.length + (files.length === 1 ? ' innlevering' : ' innleveringer');
    renderTable();
  }

  function renderTable() {
    var t = $('overview-table');
    t.tHead.innerHTML = '<tr>' + COLUMNS.map(function (c) {
      var arrow = c.key === sortKey ? (sortDir > 0 ? ' ↑' : ' ↓') : '';
      var aria = c.key === sortKey ? (sortDir > 0 ? 'ascending' : 'descending') : 'none';
      return '<th scope="col" aria-sort="' + aria + '"' + (c.num ? ' class="num"' : '') + '>' +
        '<button type="button" data-sort="' + c.key + '"' + (c.title ? ' title="' + esc(c.title) + '"' : '') + '>' + c.label + arrow + '</button></th>';
    }).join('') + '</tr>';

    var col = COLUMNS.filter(function (c) { return c.key === sortKey; })[0];
    var rows = files.slice().sort(function (a, b) {
      var x = col.value(a), y = col.value(b);
      return (x < y ? -1 : x > y ? 1 : 0) * sortDir;
    });
    t.tBodies[0].innerHTML = rows.map(function (f) {
      return '<tr data-id="' + f.id + '" tabindex="0">' + COLUMNS.map(function (c) {
        return '<td' + (c.num ? ' class="num"' : '') + ' data-label="' + esc(c.label) + '">' + c.html(f) + '</td>';
      }).join('') + '</tr>';
    }).join('');
  }

  $('overview-table').addEventListener('click', function (e) {
    var sortBtn = e.target.closest('[data-sort]');
    if (sortBtn) {
      var k = sortBtn.getAttribute('data-sort');
      sortDir = k === sortKey ? -sortDir : 1;
      sortKey = k;
      renderTable();
      return;
    }
    var tr = e.target.closest('tr[data-id]');
    if (tr) openDetail(byId(+tr.getAttribute('data-id')), 'push');
  });
  $('overview-table').addEventListener('keydown', function (e) {
    var tr = e.target.closest('tr[data-id]');
    if (tr && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openDetail(byId(+tr.getAttribute('data-id')), 'push'); }
  });

  function byId(id) { return files.filter(function (f) { return f.id === id; })[0]; }

  function openDetail(f, how) {
    current = f;
    if (how === 'push') history.pushState({ view: 'detail', id: f.id }, '');
    else if (how === 'replace') history.replaceState({ view: 'detail', id: f.id }, '');
    setView('detail');
    var rep = f.report, s = rep.summary;

    $('back').hidden = files.length < 2 && f.key !== 'lokal';
    $('back').innerHTML = f.key === 'lokal' ? '&larr; Tilbake til teksten' : '&larr; Oversikt';
    $('detail-file').textContent = f.name;
    $('detail-title').textContent = rep.file.title || 'Uten tittel';

    if (player) player.pause();
    player = new window.SkriftsporReplay($('player'), rep.replay.sessions, { controls: true, speed: 30 });

    var facts = [
      ['Første tastetrykk', date(s.first_event)],
      ['Siste tastetrykk', date(s.last_event)],
      ['Tid totalt', spanText(span(s))],
      ['Aktiv tid', minutes(s.active_minutes)],
      ['Økter', String(s.sessions)],
      ['Ord', String(s.final_words)],
      ['Innlimt', s.pastes + (s.pastes === 1 ? ' gang' : ' ganger')],
      ['Slettet underveis', s.deleted_chars_total + ' tegn']
    ];
    $('detail-facts').innerHTML = facts.map(function (x) {
      return '<div class="facts__item"><dt>' + x[0] + '</dt><dd>' + x[1] + '</dd></div>';
    }).join('');
    shareBar($('detail-share'), [
      { cls: 'typed', pct: s.final_typed_percent, label: 'skrevet her' },
      { cls: 'pasted', pct: s.final_pasted_percent, label: 'limt inn' },
      { cls: 'unknown', pct: s.final_unknown_chars ? Math.round(1000 * s.final_unknown_chars / Math.max(1, s.final_chars)) / 10 : 0, label: 'ukjent (skadd logg)' }
    ], 'Andel av slutteksten');

    $('detail-checks').innerHTML = rep.checks.map(function (c) {
      var state = c.ok === true ? 'ok' : c.ok === false ? 'bad' : 'none';
      var word = c.ok === true ? 'OK' : c.ok === false ? 'Avvik' : 'Mangler';
      return '<li class="checks__item checks__item--' + state + '"><span class="checks__badge">' + word + '</span>' +
        '<span class="checks__text"><strong>' + esc(c.label) + '</strong>' +
        (c.detail ? '<span class="checks__detail">' + esc(c.detail) + '</span>' : '') + '</span></li>';
    }).join('');
    $('drand-confirm').hidden = !(s.drand_checkpoints > 0);
    $('drand-result').textContent = '';

    renderCompare();
    window.scrollTo({ top: 0 });
  }

  /* A bar whose parts are labelled in words beside it — never colour alone. */
  function shareBar(host, parts, caption) {
    parts = parts.filter(function (p) { return p.pct > 0; });
    host.innerHTML =
      '<p class="share__caption">' + caption + '</p>' +
      '<div class="share__bar" aria-hidden="true">' + parts.map(function (p) {
        return '<span class="share__part share__part--' + p.cls + '" style="width:' + p.pct + '%"></span>';
      }).join('') + '</div>' +
      '<ul class="share__legend">' + parts.map(function (p) {
        return '<li><span class="share__swatch share__part--' + p.cls + '" aria-hidden="true"></span>' + S.fmtPct(p.pct) + ' ' + p.label + '</li>';
      }).join('') + '</ul>';
  }

  /* ---- Comparison with the handed-in text -------------------------------- */

  function loadDocument(file) {
    showError('');
    var f = current;
    window.SkriftsporExtract(file).then(function (r) {
      r.name = file.name;
      f.submitted = r;
      if (current === f) renderCompare();
    }).catch(function (e) {
      showError('Dokumentet kunne ikke leses: ' + e.message + '.');
    });
  }

  function renderCompare() {
    var f = current, sub = f && f.submitted;
    $('compare-empty').hidden = !!sub;
    $('compare-result').hidden = !sub;
    if (!sub) return;
    var st = f.report.replay.state;
    var c = S.compare(st.text, st.spans.flags(), sub.text);
    $('cmp-head').textContent = S.fmtPct(c.percent) + ' av den innleverte teksten finnes i spor-fila';
    shareBar($('cmp-share'), [
      { cls: 'typed', pct: c.percentTyped, label: 'skrevet i Skriftspor' },
      { cls: 'pasted', pct: c.percentPasted, label: 'limt inn i Skriftspor' },
      { cls: 'missing', pct: Math.round((100 - c.percent) * 10) / 10, label: 'ikke i spor-fila' }
    ], 'Andel av den innleverte teksten');

    var t = sub.text, html = '', at = 0;
    c.marks.forEach(function (m) {
      html += esc(t.slice(at, m.a));
      var cls = m.kind === 'missing' ? 'mark-missing' : m.kind === 'pasted' ? 'mark-pasted' : 'mark-typed';
      html += '<span class="' + cls + '">' + esc(t.slice(m.a, m.b)) + '</span>';
      at = m.b;
    });
    $('cmp-text').innerHTML = html + esc(t.slice(at));
  }

  /* ---- Wiring ----------------------------------------------------------- */

  $('pick-files').addEventListener('click', function () { $('file-input').click(); });
  $('add-files').addEventListener('click', function () { $('file-input').click(); });
  $('file-input').addEventListener('change', function () { addFiles(this.files); this.value = ''; });
  $('clear-files').addEventListener('click', function () {
    files = []; current = null;
    history.pushState({ view: 'start' }, '');
    setView('start');
  });
  $('back').addEventListener('click', function () { history.back(); });
  $('pick-doc').addEventListener('click', function () { $('file-doc').click(); });
  $('file-doc').addEventListener('change', function () { if (this.files[0]) loadDocument(this.files[0]); this.value = ''; });
  $('paste-compare').addEventListener('click', function () {
    var t = $('paste-doc').value;
    if (!t.trim() || !current) return;
    current.submitted = { text: t, kind: 'innlimt tekst', note: '', name: 'teksten du limte inn' };
    renderCompare();
  });

  $('drand-confirm').addEventListener('click', function () {
    var btn = this;
    btn.disabled = true;
    $('drand-result').textContent = '…';
    S.drand.confirm(current.report.replay.sessions).then(function (r) {
      btn.disabled = false;
      if (r.offline === r.checked) { $('drand-result').textContent = 'Fikk ikke kontakt med drand.'; return; }
      $('drand-result').textContent = r.failed.length
        ? 'Avvik: ' + r.failed.length + ' av ' + r.checked + ' tidsstempler finnes ikke hos drand.'
        : 'Bekreftet: ' + r.matched + ' av ' + r.checked + ' tidsstempler er ekte.';
    });
  });

  window.addEventListener('popstate', function (e) {
    var st = e.state || { view: location.hash === '#skriv' ? 'write' : 'start' };
    if (st.view === 'detail' && byId(st.id)) openDetail(byId(st.id));
    else if (st.view === 'overview' && files.length) showOverview();
    else if (st.view === 'write') showWrite();
    else setView('start');
  });

  $('start-new').addEventListener('click', function () {
    if (window.SkriftsporWriter.startNew()) showWrite('push');
  });
  $('continue-local').addEventListener('click', function () { showWrite('push'); });
  $('home').addEventListener('click', function (e) {
    e.preventDefault();
    files = []; current = null;
    history.pushState({ view: 'start' }, '', '/');
    setView('start');
  });

  /* «Om siden» — a dialog, so the page stays one page. */
  $('about-open').addEventListener('click', function () { $('about').showModal(); });
  $('about-close').addEventListener('click', function () { $('about').close(); });
  $('about').addEventListener('click', function (e) { if (e.target === this) this.close(); });

  /* The whole window takes a drop. A cover says so while dragging. */
  var depth = 0;
  function hasFiles(e) { return e.dataTransfer && [].indexOf.call(e.dataTransfer.types || [], 'Files') !== -1; }
  window.addEventListener('dragenter', function (e) { if (!hasFiles(e) || document.body.getAttribute('data-view') === 'write') return; depth++; $('dragcover').hidden = false; });
  window.addEventListener('dragleave', function () { if (--depth <= 0) { depth = 0; $('dragcover').hidden = true; } });
  window.addEventListener('dragover', function (e) { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', function (e) {
    if (!hasFiles(e)) return;
    if (document.body.getAttribute('data-view') === 'write') { e.preventDefault(); depth = 0; $('dragcover').hidden = true; return; }
    e.preventDefault();
    depth = 0;
    $('dragcover').hidden = true;
    addFiles(e.dataTransfer.files);
  });

  window.SkriftsporInbox = { loadLocal: loadLocal };

  /* Old addresses (/skriv/ etc.) redirect here with a hash. */
  function boot() {
    if (location.hash === '#skriv') { history.replaceState({ view: 'write' }, '', '#skriv'); showWrite(); }
    else if (location.hash === '#lokal') { history.replaceState({ view: 'start' }, '', '/'); setView('start'); loadLocal(); }
    else { history.replaceState({ view: 'start' }, ''); setView('start'); }
  }
  if (window.SkriftsporWriter && window.SkriftsporWriter.ready()) boot();
  else document.addEventListener('skriftspor:writer-ready', boot, { once: true });
})();
