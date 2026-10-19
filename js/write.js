/* ==========================================================================
   write.js — the writing surface on /skriv/.

   A plain <textarea> with a highlight layer behind it. Every change to the
   text is turned into one or two events (a deletion and/or an insertion)
   and appended to the open session; see js/skriftspor.js for the format.

   HOW A CHANGE IS RECORDED. The textarea is the source of nothing: on every
   `input` the new value is diffed against the model's own text, never
   against the textarea's previous value. So a change that arrives without
   an input event — an extension writing into the field, say — is still
   caught on the next one, and is logged as pasted, since it was not typed.

   WHAT IS NOT RECORDED: focus, window switches, mouse movement, anything
   outside the textarea. The tool shows how the text was built, not what the
   writer did with the rest of their screen. Don't add it.
   ========================================================================== */
(function () {
  'use strict';

  var S = window.Skriftspor;
  var DRAND_EVERY_MS = 5 * 60 * 1000;
  var CURSOR_DEBOUNCE_MS = 400;

  var ta = document.getElementById('write-input');
  var mirror = document.getElementById('write-mirror');
  var titleInput = document.getElementById('write-title');
  var statusEl = document.getElementById('write-status');
  var statsEl = document.getElementById('write-stats');
  var toast = document.getElementById('toast');
  var fileInput = document.getElementById('resume-file');

  /* ---- The model --------------------------------------------------------
     doc   = what is in localStorage: { v, title, sessions, savedAt,
             downloadedAt, changedAt }
     state = the replayed text and its origin spans */
  var doc = null;
  var state = new S.State('');
  var ready = false;
  var lastDrand = 0;
  var pendingPaste = false;
  var lastInputType = '';
  var locked = false;

  function current() { return doc.sessions[doc.sessions.length - 1]; }
  function openRaw() {
    var c = doc.sessions.length && current();
    return c && c.raw ? c.raw : null;
  }

  function emptyDoc() {
    return { v: 1, title: '', sessions: [], savedAt: 0, downloadedAt: 0, changedAt: 0 };
  }

  /* ---- Recording ------------------------------------------------------- */

  function ensureSession(now) {
    var raw = openRaw();
    if (raw && now - raw.last <= S.SESSION_IDLE_MS) return;
    doc.sessions.push({ raw: { start: now, last: now, events: [] } });
    lastDrand = 0;
  }

  /* ev is an event WITHOUT its leading dt. */
  function record(ev, now) {
    ensureSession(now);
    var raw = openRaw();
    var dt = raw.events.length ? Math.max(0, now - raw.last) : Math.max(0, now - raw.start);
    var full = [dt].concat(ev);
    state.apply(full, doc.sessions.length - 1);
    raw.events.push(full);
    raw.last = now;
    if (ev[0] !== 'r' && ev[0] !== 'c') doc.changedAt = now;
    if (ev[0] !== 'r' && now - lastDrand > DRAND_EVERY_MS) checkpoint(now);
    scheduleSave();
  }

  /* A drand checkpoint: fetched, never sent. If offline, the writing is
     simply recorded without one — it is a bonus, not a requirement. */
  function checkpoint(now) {
    lastDrand = now;
    S.drand.latest().then(function (r) {
      if (!r || locked) return;
      record(['r', r.round, r.randomness, r.signature], Date.now());
    });
  }

  /* Old text → new text as one deletion and/or one insertion. The caret
     decides between equally valid answers: typing "l" after "l" could be
     an insertion at either position, and only the caret knows which. */
  function diff(ov, nv, caret) {
    var dl = nv.length - ov.length, p;
    if (dl > 0) {
      p = caret - dl;
      if (p >= 0 && nv.slice(0, p) === ov.slice(0, p) && nv.slice(caret) === ov.slice(p))
        return { pos: p, del: '', ins: nv.slice(p, caret) };
    } else if (dl < 0) {
      p = caret;
      if (nv.slice(0, p) === ov.slice(0, p) && nv.slice(p) === ov.slice(p - dl))
        return { pos: p, del: ov.slice(p, p - dl), ins: '' };
    }
    var a = 0, max = Math.min(ov.length, nv.length);
    while (a < max && ov.charCodeAt(a) === nv.charCodeAt(a)) a++;
    var b = 0;
    while (b < max - a && ov.charCodeAt(ov.length - 1 - b) === nv.charCodeAt(nv.length - 1 - b)) b++;
    return { pos: a, del: ov.slice(a, ov.length - b), ins: nv.slice(a, nv.length - b) };
  }

  var PASTE_TYPES = { insertFromPaste: 1, insertFromDrop: 1, insertFromPasteAsQuotation: 1, insertFromYank: 1 };

  /* Undo and redo can put text back. Text that comes back keeps the origin
     it had when it was deleted, so "paste, undo, redo" is still a paste.
     Anything longer than a character that comes back from history and was
     NOT deleted here recently is logged as pasted — the safe side. */
  var recentDeleted = [];
  function rememberDeleted(pos, text) {
    var flags = state.spans.flags().subarray(pos, pos + text.length);
    recentDeleted.push({ text: text, pasted: flags.indexOf(1) !== -1 });
    if (recentDeleted.length > 50) recentDeleted.shift();
  }
  function historyOrigin(text) {
    for (var i = recentDeleted.length - 1; i >= 0; i--) {
      if (recentDeleted[i].text === text) return recentDeleted[i].pasted ? 'p' : 'i';
    }
    return text.length > 1 ? 'p' : 'i';
  }

  function applyDiff(nv, kind, now) {
    var d = diff(state.text, nv, ta.selectionStart);
    if (d.del) { rememberDeleted(d.pos, d.del); record(['d', d.pos, d.del], now); }
    if (d.ins) {
      var k = kind === 'history' ? historyOrigin(d.ins) : kind;
      record([k, d.pos, d.ins], now);
    }
  }

  /* The field changed without telling us — something other than the
     keyboard wrote into it. Logged as pasted before the next real input. */
  function syncExternal() {
    if (!ready || locked || ta.value === state.text) return;
    applyDiff(ta.value, 'p', Date.now());
    render();
  }

  function onInput(e) {
    if (!ready || locked) return;
    var nv = ta.value;
    if (nv === state.text) return;
    var now = Date.now();
    var type = (e && e.inputType) || lastInputType || '';
    var kind = pendingPaste || PASTE_TYPES[type] ? 'p' : /^history/.test(type) ? 'history' : 'i';
    pendingPaste = false;
    lastInputType = '';
    applyDiff(nv, kind, now);
    if (state.text !== nv) {
      /* Should be impossible; if it ever happens, the model wins and the
         textarea is put back, rather than letting the two drift apart. */
      console.error('skriftspor: modellen og tekstfeltet er ulike — tekstfeltet tilbakestilles');
      ta.value = state.text;
    }
    state.caret = ta.selectionStart; state.sel = ta.selectionEnd;
    render();
  }

  /* Cursor jumps: logged when the selection ends up somewhere the last
     edit did not leave it. Debounced, so holding an arrow key is one
     event, not forty. */
  var cursorTimer = null;
  function onCursor() {
    if (!ready || locked) return;
    clearTimeout(cursorTimer);
    cursorTimer = setTimeout(function () {
      if (ta.value !== state.text || !openRaw() && !state.text) return;
      var a = ta.selectionStart, b = ta.selectionEnd;
      if (a === state.caret && b === state.sel) return;
      record(['c', a, b], Date.now());
    }, CURSOR_DEBOUNCE_MS);
  }

  /* ---- Rendering ------------------------------------------------------- */

  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  var raf = 0;
  function render() {
    if (raf) return;
    raf = requestAnimationFrame(function () {
      raf = 0;
      var html = '', at = 0, text = state.text;
      state.spans.runs.forEach(function (r) {
        var seg = esc(text.slice(at, at + r.n));
        html += r.p === 1 ? '<mark class="mark-pasted">' + seg + '</mark>' : seg;
        at += r.n;
      });
      /* A trailing newline only takes up a line if something follows it. */
      mirror.innerHTML = html + ' ';
      autosize();
      stats();
    });
  }

  function autosize() {
    ta.style.height = 'auto';
    ta.style.height = Math.max(ta.scrollHeight, mirror.scrollHeight) + 'px';
  }

  function stats() {
    var c = state.spans.counts();
    var len = state.text.length;
    var words = S.countWords(state.text);
    var pct = len ? Math.round(1000 * c.pasted / len) / 10 : 0;
    statsEl.textContent = words + (words === 1 ? ' ord' : ' ord') +
      ' · ' + S.fmtPct(pct) + ' innlimt' +
      ' · økt ' + Math.max(1, doc.sessions.length);
  }

  function clock(ms) {
    var d = new Date(ms);
    return 'kl. ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function status() {
    if (locked) return;
    var dirty = doc.changedAt > doc.downloadedAt;
    statusEl.textContent = !state.text ? '' :
      doc.downloadedAt && !dirty ? 'Lastet ned ' + clock(doc.downloadedAt) :
      doc.savedAt ? 'Lagret i nettleseren ' + clock(doc.savedAt) + ' · ikke lastet ned' : '';
    statusEl.classList.toggle('is-warn', !!state.text && dirty);
  }

  /* ---- Saving ---------------------------------------------------------- */

  var saveTimer = null;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 400);
  }
  function save() {
    if (locked) return;
    doc.title = titleInput.value;
    doc.savedAt = Date.now();
    if (!S.local.save(doc)) {
      statusEl.textContent = 'Kan ikke lagre i nettleseren. Last ned spor-fila ofte.';
      statusEl.classList.add('is-warn');
      return;
    }
    status();
  }

  /* Two tabs on the same document would overwrite each other's log. The
     second one to change it locks the first. */
  window.addEventListener('storage', function (e) {
    if (e.key !== S.local.key || locked) return;
    locked = true;
    ta.readOnly = true;
    titleInput.readOnly = true;
    statusEl.textContent = 'Åpnet i en annen fane. Last siden på nytt for å fortsette her.';
    statusEl.classList.add('is-warn');
  });

  /* ---- Actions --------------------------------------------------------- */

  function download() {
    save();
    S.fileFromLocal(doc).then(function (file) {
      var blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = S.fileName(doc.title);
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
      doc.downloadedAt = Date.now();
      save();
    }).catch(function (e) {
      alert('Spor-fila kunne ikke lages: ' + e.message);
    });
  }

  /* Copy as rich text as well as plain, so pasting into Word or Docs
     keeps headings, bold, italics and underline. Only the four forms the
     toolbar makes are converted; everything else is copied as written. */
  function inline(t) {
    return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/&lt;u&gt;([\s\S]+?)&lt;\/u&gt;/g, '<u>$1</u>')
      .replace(/\*\*([^*\n]+?)\*\*/g, '<b>$1</b>')
      .replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, '$1<i>$2</i>');
  }
  function toHtml(text) {
    return text.split(/\n{2,}/).map(function (block) {
      var h = block.match(/^(#{1,3})\s+(.*)$/);
      if (h && block.indexOf('\n') === -1) return '<h' + h[1].length + '>' + inline(h[2]) + '</h' + h[1].length + '>';
      return block.split('\n').map(function (line) {
        var hh = line.match(/^(#{1,3})\s+(.*)$/);
        return hh ? '<h' + hh[1].length + '>' + inline(hh[2]) + '</h' + hh[1].length + '>' : inline(line);
      }).join('<br>').replace(/^(?!<h)(.*)$/s, '<p>$1</p>');
    }).join('');
  }
  function plain(text) {
    return text.replace(/^#{1,3}\s+/gm, '').replace(/<\/?u>/g, '')
      .replace(/\*\*([^*\n]+?)\*\*/g, '$1').replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, '$1$2');
  }

  function copyText() {
    var html = toHtml(state.text), txt = plain(state.text);
    var onCopy = function (e) {
      e.clipboardData.setData('text/html', html);
      e.clipboardData.setData('text/plain', txt);
      e.preventDefault();
    };
    document.addEventListener('copy', onCopy);
    var ok = document.execCommand('copy');
    document.removeEventListener('copy', onCopy);
    if (!ok && navigator.clipboard) navigator.clipboard.writeText(txt);
    showToast('Kopiert');
  }

  function newText() {
    if (state.text && !confirm('Starte på en ny tekst? Teksten du har nå blir slettet fra denne nettleseren.' +
        (doc.changedAt > doc.downloadedAt ? '\n\nDu har ikke lastet ned spor-fila etter siste endring.' : ''))) return;
    S.local.clear();
    doc = emptyDoc();
    state = new S.State('');
    ta.value = '';
    titleInput.value = '';
    render(); status();
    ta.focus();
  }

  function resume(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var parsed;
      try { parsed = JSON.parse(reader.result); } catch (e) { return alert('Fila kunne ikke leses. Er det en spor-fil fra Skriftspor (.spor)?'); }
      S.verifyFile(parsed).then(function (rep) {
        if (!rep.replay || !rep.replay.complete || rep.replay.state.text !== parsed.text) {
          return alert('Denne spor-fila er skadd eller endret, så det går ikke å skrive videre i den.');
        }
        if (state.text && doc.changedAt > doc.downloadedAt &&
            !confirm('Du har en tekst i nettleseren som ikke er lastet ned. Vil du erstatte den med teksten fra fila?')) return;
        doc = emptyDoc();
        doc.title = parsed.title || '';
        doc.sessions = parsed.sessions.map(function (s) { return { stored: s }; });
        doc.downloadedAt = doc.changedAt = Date.now();
        state = rep.replay.state;
        ta.value = state.text;
        titleInput.value = doc.title;
        save(); render();
        ta.focus();
        ta.setSelectionRange(state.text.length, state.text.length);
        state.caret = state.sel = state.text.length;
      });
    };
    reader.readAsText(file);
  }

  var toastTimer = null;
  function showToast(msg) {
    toast.textContent = msg;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.hidden = true; }, 2500);
  }

  /* ---- Formatting ------------------------------------------------------
     Markdown, written into the text itself: "# " for a heading, **bold**,
     *italic*, and <u>underline</u> (Markdown has no underline; inline
     HTML is what Markdown readers accept for it). Each marker is inserted
     with execCommand('insertText'), so it goes through the normal input
     path: it is logged as typed, undo works, and the selected text keeps
     its own origin (a pasted quote made bold stays pasted). */

  function insertAt(pos, str) {
    ta.focus();
    ta.setSelectionRange(pos, pos);
    if (!document.execCommand('insertText', false, str)) {
      ta.setRangeText(str, pos, pos, 'end');
      onInput({ inputType: 'insertText' });
    }
  }

  var WRAP = { bold: ['**', '**'], italic: ['*', '*'], underline: ['<u>', '</u>'] };

  function format(kind) {
    if (!ready || locked) return;
    var a = ta.selectionStart, b = ta.selectionEnd, v = ta.value;
    if (kind === 'heading') {
      var ls = v.lastIndexOf('\n', a - 1) + 1;
      if (v.slice(ls, ls + 2) === '# ') {
        ta.focus(); ta.setSelectionRange(ls, ls + 2);
        document.execCommand('delete');
        ta.setSelectionRange(Math.max(ls, a - 2), Math.max(ls, b - 2));
      } else {
        insertAt(ls, '# ');
        ta.setSelectionRange(a + 2, b + 2);
      }
      return;
    }
    var w = WRAP[kind];
    insertAt(b, w[1]);          /* the end first, so a is still valid */
    insertAt(a, w[0]);
    if (a === b) ta.setSelectionRange(a + w[0].length, a + w[0].length);
    else ta.setSelectionRange(a + w[0].length, b + w[0].length);
  }

  [].forEach.call(document.querySelectorAll('[data-format]'), function (btn) {
    btn.addEventListener('mousedown', function (e) { e.preventDefault(); });   /* keep the selection */
    btn.addEventListener('click', function () { format(btn.getAttribute('data-format')); });
  });
  ta.addEventListener('keydown', function (e) {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    var k = { b: 'bold', i: 'italic', u: 'underline' }[e.key.toLowerCase()];
    if (k) { e.preventDefault(); format(k); }
  });

  /* ---- Wiring ---------------------------------------------------------- */

  ta.addEventListener('beforeinput', function (e) { syncExternal(); lastInputType = e.inputType || ''; });
  ta.addEventListener('paste', function () { pendingPaste = true; });
  ta.addEventListener('drop', function () { pendingPaste = true; });
  ta.addEventListener('input', onInput);
  ['keyup', 'mouseup', 'select', 'focus'].forEach(function (t) { ta.addEventListener(t, onCursor); });
  document.addEventListener('selectionchange', function () { if (document.activeElement === ta) onCursor(); });
  titleInput.addEventListener('input', scheduleSave);
  window.addEventListener('resize', function () { render(); });

  document.getElementById('btn-download').addEventListener('click', download);
  document.getElementById('btn-copy').addEventListener('click', copyText);
  document.getElementById('btn-new').addEventListener('click', newText);
  document.getElementById('btn-resume').addEventListener('click', function () { fileInput.click(); });
  fileInput.addEventListener('change', function () { if (fileInput.files[0]) resume(fileInput.files[0]); fileInput.value = ''; });
  document.getElementById('btn-play').addEventListener('click', function () {
    save();
    if (window.SkriftsporInbox) window.SkriftsporInbox.loadLocal();
  });

  /* Ctrl/Cmd+S downloads the file rather than saving the web page. */
  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && document.body.getAttribute('data-view') === 'write') { e.preventDefault(); download(); }
  });

  /* ---- Start: rebuild the text from the stored log ---------------------- */

  doc = S.local.load() || emptyDoc();
  titleInput.value = doc.title || '';
  ta.readOnly = true;
  S.finalize(doc.sessions).then(function (f) {
    state = f.state;
  }).catch(function (e) {
    console.error(e);
    alert('Teksten i nettleseren kunne ikke leses inn igjen (' + e.message + '). Har du en nedlastet spor-fil, kan du fortsette fra den.');
    doc = emptyDoc();
    state = new S.State('');
  }).then(function () {
    ta.value = state.text;
    ta.readOnly = false;
    ready = true;
    state.caret = state.sel = state.text.length;
    render(); status();
    document.dispatchEvent(new CustomEvent('skriftspor:writer-ready'));
  });

  /* For js/inbox.js, which owns the views. */
  window.SkriftsporWriter = {
    hasText: function () { return !!state.text; },
    title: function () { return doc.title || ''; },
    show: function () {
      render();
      ta.focus();
      ta.setSelectionRange(state.text.length, state.text.length);
    },
    startNew: function () {
      if (state.text && !confirm('Starte på en ny tekst? Teksten du har nå blir slettet fra denne nettleseren.' +
          (doc.changedAt > doc.downloadedAt ? '\n\nDu har ikke lastet ned spor-fila etter siste endring.' : ''))) return false;
      if (state.text) {
        S.local.clear();
        doc = emptyDoc();
        state = new S.State('');
        ta.value = '';
        titleInput.value = '';
        status();
      }
      return true;
    }
  };

  setInterval(status, 30000);
  setInterval(syncExternal, 1000);
})();
