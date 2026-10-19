/* ==========================================================================
   write.js — the writing surface (the «write» view on the front page).

   A contenteditable sheet that SHOWS formatting (heading, bold, italic,
   underline) but is never the source of truth. The model is plain text
   plus formatting runs (js/skriftspor.js: State/Spans). Every change is an
   event in the open session, and the sheet is redrawn from the model.

   HOW A CHANGE IS RECORDED
   - Typing, Enter, deleting: `beforeinput` is cancelled and the change is
     applied to the model directly, from the event's own ranges.
   - Paste and drop: the plain text is taken from the clipboard / drag and
     logged as pasted ("p"). Formatting from outside is not kept.
   - Formatting buttons and Ctrl+B/I/U: an "f" event over the selection.
     With nothing selected, the next typed text gets the format instead.
   - Undo/redo: our own stack. The browser's would be wiped by every redraw.
   - Anything else that changes the sheet (IME composition, some spellcheck
     replacements): the sheet's text is diffed against the model afterwards
     and logged as typed. Text that arrives with no input event at all (an
     extension writing into the sheet) is logged as pasted.

   WHAT IS NOT RECORDED: focus, window switches, mouse movement, anything
   outside the sheet. The tool shows how the text was built, not what the
   writer did with the rest of their screen. Don't add it.
   ========================================================================== */
(function () {
  'use strict';

  var S = window.Skriftspor;
  var DRAND_EVERY_MS = 5 * 60 * 1000;
  var CURSOR_DEBOUNCE_MS = 400;
  var UNDO_MERGE_MS = 1000;

  var BOLD = 1, ITALIC = 2, UNDERLINE = 4, H1 = 8, H2 = 16, H3 = 32, HMASK = H1 | H2 | H3;
  var BITS = { bold: BOLD, italic: ITALIC, underline: UNDERLINE, h1: H1, h2: H2, h3: H3 };
  function level(f) { return f & H1 ? 1 : f & H2 ? 2 : f & H3 ? 3 : 0; }

  var ed = document.getElementById('write-input');
  var titleInput = document.getElementById('write-title');
  var authorInput = document.getElementById('write-author');
  var metaDialog = document.getElementById('meta');
  var tocEl = document.getElementById('toc');
  var statusEl = document.getElementById('write-status');
  var statsEl = document.getElementById('write-stats');
  var toast = document.getElementById('toast');
  var fileInput = document.getElementById('resume-file');

  /* ---- The model --------------------------------------------------------
     doc   = what is in localStorage: { v, title, sessions, savedAt,
             downloadedAt, changedAt }
     state = the replayed text, origin and formatting runs */
  var doc = null;
  var state = new S.State('');
  var ready = false;
  var lastDrand = 0;
  var locked = false;
  var composing = false;
  var pending = null;   /* formatting chosen with nothing selected: { at, f } */

  function current() { return doc.sessions[doc.sessions.length - 1]; }
  function openRaw() {
    var c = doc.sessions.length && current();
    return c && c.raw ? c.raw : null;
  }
  function emptyDoc() {
    return { v: 1, title: '', author: '', sessions: [], savedAt: 0, downloadedAt: 0, changedAt: 0 };
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
    now = now || Date.now();
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

  /* A drand checkpoint: fetched, never sent. Offline, it is simply skipped. */
  function checkpoint(now) {
    lastDrand = now;
    S.drand.latest().then(function (r) {
      if (!r || locked) return;
      record(['r', r.round, r.randomness, r.signature]);
    });
  }

  /* ---- Edits on the model, with undo ------------------------------------
     The inverse of each step is computed from the model BEFORE the step is
     applied, so undo restores origin and formatting exactly: a pasted
     quote that is deleted and undone comes back as pasted. */

  var undoStack = [], redoStack = [];
  var lastGroup = null;

  function inverseOf(ev) {
    var t = ev[0];
    if (t === 'i' || t === 'p') return [['d', ev[1], ev[2]]];
    if (t === 'd') {
      var out = [], at = ev[1];
      state.spans.slice(ev[1], ev[1] + ev[2].length).forEach(function (r) {
        out.push([r.p === 1 ? 'p' : 'i', at, ev[2].substr(at - ev[1], r.n), r.f || 0]);
        at += r.n;
      });
      return out;
    }
    if (t === 'f') {
      var res = [], a = ev[1];
      state.spans.slice(ev[1], ev[2]).forEach(function (r) {
        res.push(['f', a, a + r.n, ev[3], (r.f & ev[3]) ? 1 : 0]);
        a += r.n;
      });
      return res;
    }
    return [];
  }

  /* Applies steps as one undoable group. Returns the inverse steps. */
  function applySteps(steps, now) {
    var inv = [];
    steps.forEach(function (ev) {
      if ((ev[0] === 'd' || ev[0] === 'i' || ev[0] === 'p') && !ev[2]) return;
      inv = inverseOf(ev).reverse().concat(inv);
      record(ev, now);
    });
    return inv;
  }

  /* kind 'type' merges with the previous typing group if it was recent. */
  function edit(steps, kind) {
    var now = Date.now();
    var inv = applySteps(steps, now);
    if (!inv.length) return;
    if (kind === 'type' && lastGroup && lastGroup.kind === 'type' && now - lastGroup.t < UNDO_MERGE_MS) {
      lastGroup.inv = inv.concat(lastGroup.inv);
      lastGroup.t = now;
    } else {
      lastGroup = { kind: kind, inv: inv, t: now };
      undoStack.push(lastGroup);
      if (undoStack.length > 300) undoStack.shift();
    }
    redoStack = [];
  }

  function caretAfter(ev) {
    if (!ev) return [state.text.length, state.text.length];
    if (ev[0] === 'i' || ev[0] === 'p') return [ev[1] + ev[2].length, ev[1] + ev[2].length];
    if (ev[0] === 'd') return [ev[1], ev[1]];
    return [ev[1], ev[2]];
  }

  function undo() {
    var g = undoStack.pop();
    if (!g) return;
    lastGroup = null;
    redoStack.push({ inv: applySteps(g.inv, Date.now()) });
    render(caretAfter(g.inv[g.inv.length - 1]));
  }
  function redo() {
    var g = redoStack.pop();
    if (!g) return;
    lastGroup = null;
    undoStack.push({ kind: 'redo', inv: applySteps(g.inv, Date.now()) });
    render(caretAfter(g.inv[g.inv.length - 1]));
  }

  /* ---- Formatting -------------------------------------------------------- */

  function lineStart(pos) { return state.text.lastIndexOf('\n', pos - 1) + 1; }
  function lineEnd(pos) { var e = state.text.indexOf('\n', pos); return e === -1 ? state.text.length : e; }

  /* Formatting for new text at pos: the character before it on the same
     line, or after it at the start of a line. A pending choice wins. */
  function formatFor(pos) {
    if (pending && pending.at === pos) return pending.f;
    var ls = lineStart(pos);
    if (pos > ls) return state.spans.formatAt(pos - 1);
    return pos < lineEnd(pos) ? state.spans.formatAt(pos) : 0;
  }

  function toggle(kind) {
    if (!ready || locked) return;
    var sel = getSel();
    var bit = BITS[kind];
    if (bit & HMASK) {
      var a = lineStart(sel[0]), b = lineEnd(sel[1]);
      if (a === b) {   /* empty line: the heading applies to what is typed next */
        var pf = formatFor(a);
        pending = { at: a, f: (pf & ~HMASK) | ((pf & bit) ? 0 : bit) };
        render(sel);
        return;
      }
      var cur = state.spans.formatAt(a) & HMASK;
      var steps = [];
      if (cur) steps.push(['f', a, b, cur, 0]);
      if (cur !== bit) steps.push(['f', a, b, bit, 1]);
      edit(steps, 'format');
      render(sel);
      return;
    }
    if (sel[0] === sel[1]) {
      pending = { at: sel[0], f: formatFor(sel[0]) ^ bit };
      syncButtons();
      return;
    }
    var all = state.spans.slice(sel[0], sel[1]).every(function (r) { return r.f & bit; });
    edit([['f', sel[0], sel[1], bit, all ? 0 : 1]], 'format');
    render(sel);
  }

  /* ---- Rendering: model → sheet ------------------------------------------ */

  function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  function render(sel) {
    var text = state.text, runs = state.spans.runs;
    var lines = text.split('\n');
    var html = '', at = 0, ri = 0, rOff = 0;
    for (var li = 0; li < lines.length; li++) {
      var end = at + lines[li].length, inner = '';
      var lvl = level(end > at ? state.spans.formatAt(at) : (pending && pending.at === at ? pending.f : 0));
      var pos = at;
      while (pos < end) {
        while (ri < runs.length && rOff + runs[ri].n <= pos) { rOff += runs[ri].n; ri++; }
        var r = runs[ri], stop = Math.min(end, rOff + r.n);
        var cls = [];
        if (r.p === 1) cls.push('mark-pasted');
        if (r.f & BOLD) cls.push('f-b');
        if (r.f & ITALIC) cls.push('f-i');
        if (r.f & UNDERLINE) cls.push('f-u');
        inner += '<span' + (cls.length ? ' class="' + cls.join(' ') + '"' : '') + '>' + esc(text.slice(pos, stop)) + '</span>';
        pos = stop;
      }
      html += '<div class="ln' + (lvl ? ' ln--h' + lvl : '') + '">' + (inner || '<br>') + '</div>';
      at = end + 1;
    }
    var top = ed.scrollTop;
    ed.innerHTML = html;
    ed.scrollTop = top;
    if (sel && document.activeElement === ed) { setSel(sel[0], sel[1]); caretIntoView(); }
    stats();
    syncButtons();
    buildToc();
  }

  /* ---- Positions: sheet ↔ model ------------------------------------------ */

  function lineStarts() {
    var out = [0], t = state.text;
    for (var i = 0; i < t.length; i++) if (t.charCodeAt(i) === 10) out.push(i + 1);
    return out;
  }
  function textLen(n) { return n.nodeType === 3 ? n.data.length : (n.textContent || '').length; }

  /* (node, offset) in the sheet → model offset. */
  function toModel(node, offset) {
    var starts = lineStarts();
    if (node === ed) {
      if (offset >= ed.childNodes.length) return state.text.length;
      return starts[Math.min(offset, starts.length - 1)] || 0;
    }
    var line = node;
    while (line && line.parentNode !== ed) line = line.parentNode;
    if (!line) return 0;
    var base = starts[Array.prototype.indexOf.call(ed.childNodes, line)] || 0;
    var count = 0, done = false;
    (function walk(n) {
      if (done) return;
      if (n === node) {
        if (n.nodeType === 3) count += offset;
        else for (var i = 0; i < offset && i < n.childNodes.length; i++) count += textLen(n.childNodes[i]);
        done = true;
        return;
      }
      if (n.nodeType === 3) { count += n.data.length; return; }
      for (var c = n.firstChild; c; c = c.nextSibling) walk(c);
    })(line);
    return Math.min(base + count, state.text.length);
  }

  /* Model offset → (node, offset) in the sheet. */
  function toDom(pos) {
    var starts = lineStarts(), li = starts.length - 1;
    while (li > 0 && starts[li] > pos) li--;
    var line = ed.childNodes[li];
    if (!line) return { node: ed, offset: ed.childNodes.length };
    var rem = pos - starts[li];
    var walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    var t, last = null;
    while ((t = walker.nextNode())) {
      last = t;
      if (rem <= t.data.length) return { node: t, offset: rem };
      rem -= t.data.length;
    }
    return last ? { node: last, offset: last.data.length } : { node: line, offset: 0 };
  }

  function getSel() {
    var s = window.getSelection();
    if (!s.rangeCount || !ed.contains(s.anchorNode)) {
      return [Math.min(state.caret, state.sel), Math.max(state.caret, state.sel)];
    }
    var a = toModel(s.anchorNode, s.anchorOffset), b = toModel(s.focusNode, s.focusOffset);
    return a <= b ? [a, b] : [b, a];
  }
  function setSel(a, b) {
    if (b == null) b = a;
    var s = window.getSelection(), r = document.createRange();
    var x = toDom(a), y = toDom(b);
    try { r.setStart(x.node, x.offset); r.setEnd(y.node, y.offset); } catch (e) { return; }
    s.removeAllRanges();
    s.addRange(r);
    state.caret = a; state.sel = b;
  }

  /* The sheet's text as the model would have it: one line per block. */
  function sheetText() {
    var lines = [], cur = null;
    for (var c = ed.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 1 && /^(DIV|P|H\d|LI)$/.test(c.nodeName)) { lines.push(blockText(c)); cur = null; }
      else {
        var t = c.nodeType === 3 ? c.data : (c.nodeName === 'BR' ? '' : c.textContent);
        if (cur === null) { lines.push(t); cur = lines.length - 1; } else lines[cur] += t;
      }
    }
    return lines.join('\n').replace(/ /g, ' ');
  }
  function blockText(el) {
    var out = '';
    (function walk(n) {
      for (var c = n.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) out += c.data;
        else if (c.nodeName === 'BR') { if (c.nextSibling) out += '\n'; }
        else if (/^(DIV|P)$/.test(c.nodeName)) { if (out) out += '\n'; walk(c); }
        else walk(c);
      }
    })(el);
    return out;
  }

  /* Old text → new text as one deletion and/or one insertion. */
  function diff(ov, nv) {
    var a = 0, max = Math.min(ov.length, nv.length);
    while (a < max && ov.charCodeAt(a) === nv.charCodeAt(a)) a++;
    var b = 0;
    while (b < max - a && ov.charCodeAt(ov.length - 1 - b) === nv.charCodeAt(nv.length - 1 - b)) b++;
    return { pos: a, del: ov.slice(a, ov.length - b), ins: nv.slice(a, nv.length - b) };
  }

  /* The sheet changed by itself: bring the model in line, then redraw. */
  function syncFromSheet(kind) {
    var nv = sheetText();
    if (nv === state.text) return false;
    var d = diff(state.text, nv);
    var steps = [];
    if (d.del) steps.push(['d', d.pos, d.del]);
    if (d.ins) steps.push([kind, d.pos, d.ins, formatFor(d.pos)]);
    edit(steps, kind === 'i' ? 'type' : 'paste');
    render([d.pos + d.ins.length, d.pos + d.ins.length]);
    return true;
  }

  /* ---- Input -------------------------------------------------------------- */

  function insertText(str, kind) {
    var sel = getSel();
    var f = formatFor(sel[0]);
    if (str === '\n') f = 0;                 /* Enter: the new line starts plain */
    else if (kind === 'p') f &= ~HMASK;
    var steps = [];
    if (sel[1] > sel[0]) steps.push(['d', sel[0], state.text.slice(sel[0], sel[1])]);
    steps.push([kind, sel[0], str, f]);
    pending = null;
    edit(steps, kind === 'i' && str !== '\n' ? 'type' : 'other');
    render([sel[0] + str.length, sel[0] + str.length]);
  }

  function deleteRange(a, b) {
    if (b <= a) return;
    pending = null;
    edit([['d', a, state.text.slice(a, b)]], 'type');
    render([a, a]);
  }

  ed.addEventListener('beforeinput', function (e) {
    if (!ready || locked) { e.preventDefault(); return; }
    var t = e.inputType;
    if (t === 'insertCompositionText' || e.isComposing) return;   /* let the IME work; synced after */
    if (t === 'historyUndo') { e.preventDefault(); undo(); return; }
    if (t === 'historyRedo') { e.preventDefault(); redo(); return; }
    if (t === 'formatBold' || t === 'formatItalic' || t === 'formatUnderline') {
      e.preventDefault();
      toggle({ formatBold: 'bold', formatItalic: 'italic', formatUnderline: 'underline' }[t]);
      return;
    }
    if (t === 'insertText' || t === 'insertReplacementText') {
      var data = e.data != null ? e.data : (e.dataTransfer && e.dataTransfer.getData('text/plain'));
      if (data == null) return;   /* unknown: let it happen, then sync */
      e.preventDefault();
      insertText(data, 'i');
      return;
    }
    if (t === 'insertParagraph' || t === 'insertLineBreak') { e.preventDefault(); insertText('\n', 'i'); return; }
    if (t === 'insertFromPaste' || t === 'insertFromDrop' || t === 'insertFromPasteAsQuotation') {
      var txt = e.dataTransfer && e.dataTransfer.getData('text/plain');
      if (txt == null) return;
      e.preventDefault();
      insertText(txt.replace(/\r\n?/g, '\n'), 'p');
      return;
    }
    if (t.indexOf('delete') === 0) {
      e.preventDefault();
      var ranges = e.getTargetRanges ? e.getTargetRanges() : [];
      if (ranges.length) {
        var a = toModel(ranges[0].startContainer, ranges[0].startOffset);
        var b = toModel(ranges[0].endContainer, ranges[0].endOffset);
        if (b > a) { deleteRange(a, b); return; }
      }
      var sel = getSel();
      if (sel[1] > sel[0]) deleteRange(sel[0], sel[1]);
      else if (t.indexOf('Backward') !== -1 && sel[0] > 0) deleteRange(sel[0] - 1, sel[0]);
      else if (t.indexOf('Forward') !== -1 && sel[0] < state.text.length) deleteRange(sel[0], sel[0] + 1);
      return;
    }
    if (t.indexOf('format') === 0) e.preventDefault();   /* no other formatting */
  });

  /* Whatever got past beforeinput. */
  ed.addEventListener('input', function (e) {
    if (!ready || locked || composing) return;
    syncFromSheet(e.inputType && e.inputType.indexOf('insertFrom') === 0 ? 'p' : 'i');
  });
  ed.addEventListener('compositionstart', function () { composing = true; });
  ed.addEventListener('compositionend', function () {
    composing = false;
    setTimeout(function () { syncFromSheet('i'); }, 0);
  });

  /* Paste and drop are taken as plain text and logged as pasted. */
  ed.addEventListener('paste', function (e) {
    e.preventDefault();
    if (!ready || locked) return;
    var t = (e.clipboardData || window.clipboardData).getData('text/plain');
    if (t) insertText(t.replace(/\r\n?/g, '\n'), 'p');
  });
  ed.addEventListener('drop', function (e) {
    var t = e.dataTransfer && e.dataTransfer.getData('text/plain');
    e.preventDefault();
    if (!t || !ready || locked) return;
    if (document.caretRangeFromPoint) {
      var r = document.caretRangeFromPoint(e.clientX, e.clientY);
      if (r) { var p = toModel(r.startContainer, r.startOffset); setSel(p, p); }
    }
    insertText(t.replace(/\r\n?/g, '\n'), 'p');
  });

  /* Something wrote into the sheet without any event (rare): pasted. */
  function syncExternal() {
    if (ready && !locked && !composing && document.activeElement !== ed) syncFromSheet('p');
  }

  /* Copying out of the sheet: the model's own text and formatting. */
  function copySelection(e, cut) {
    var sel = getSel();
    if (sel[1] <= sel[0]) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', state.text.slice(sel[0], sel[1]));
    e.clipboardData.setData('text/html', toHtml(sel[0], sel[1]));
    if (cut && !locked) deleteRange(sel[0], sel[1]);
  }
  ed.addEventListener('copy', function (e) { copySelection(e, false); });
  ed.addEventListener('cut', function (e) { copySelection(e, true); });

  ed.addEventListener('keydown', function (e) {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    var k = e.key.toLowerCase();
    var fmt = { b: 'bold', i: 'italic', u: 'underline' }[k];
    if (fmt) { e.preventDefault(); toggle(fmt); return; }
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); redo(); }
  });

  /* Cursor jumps: logged when the selection settles somewhere the last
     edit did not leave it. Debounced, so holding an arrow key is one event. */
  var cursorTimer = null;
  document.addEventListener('selectionchange', function () {
    if (!ready || locked || document.activeElement !== ed) return;
    syncButtons();
    clearTimeout(cursorTimer);
    cursorTimer = setTimeout(function () {
      if (composing || !state.text) return;
      var s = getSel();
      if (pending && pending.at !== s[0]) { pending = null; syncButtons(); }
      if (s[0] === Math.min(state.caret, state.sel) && s[1] === Math.max(state.caret, state.sel)) return;
      record(['c', s[0], s[1]]);
    }, CURSOR_DEBOUNCE_MS);
  });

  /* The buttons show the format at the caret: aria-pressed and a fill. */
  function syncButtons() {
    var sel = getSel(), f;
    if (sel[1] > sel[0]) {
      f = 63;
      state.spans.slice(sel[0], sel[1]).forEach(function (r) { f &= r.f || 0; });
    } else f = formatFor(sel[0]);
    if (sel[1] === sel[0]) {
      var ls = lineStart(sel[0]);
      if (ls < lineEnd(sel[0])) f = (f & ~HMASK) | (state.spans.formatAt(ls) & HMASK);
    }
    [].forEach.call(document.querySelectorAll('[data-format]'), function (btn) {
      btn.setAttribute('aria-pressed', f & BITS[btn.getAttribute('data-format')] ? 'true' : 'false');
    });
  }

  [].forEach.call(document.querySelectorAll('[data-format]'), function (btn) {
    btn.addEventListener('mousedown', function (e) { e.preventDefault(); });   /* keep the selection */
    btn.addEventListener('click', function () {
      if (document.activeElement !== ed) { ed.focus(); setSel(state.caret, state.sel); }
      toggle(btn.getAttribute('data-format'));
    });
  });

  /* ---- Copy all, as formatted HTML + plain text -------------------------- */

  function toHtml(a, b) {
    var text = state.text, out = '', pos = a;
    text.slice(a, b).split('\n').forEach(function (line) {
      var end = pos + line.length, inner = '', at = pos;
      state.spans.slice(pos, end).forEach(function (r) {
        var seg = esc(text.substr(at, r.n));
        if (r.f & UNDERLINE) seg = '<u>' + seg + '</u>';
        if (r.f & ITALIC) seg = '<i>' + seg + '</i>';
        if (r.f & BOLD) seg = '<b>' + seg + '</b>';
        inner += seg;
        at += r.n;
      });
      var h = line.length ? level(state.spans.formatAt(pos)) : 0;
      out += h ? '<h' + h + '>' + inner + '</h' + h + '>' : '<p>' + (inner || '<br>') + '</p>';
      pos = end + 1;
    });
    return out;
  }

  /* The model as paragraphs for js/docx.js. */
  function paragraphs() {
    var text = state.text, pos = 0, out = [];
    text.split('\n').forEach(function (line) {
      var end = pos + line.length, at = pos, runs = [];
      state.spans.slice(pos, end).forEach(function (r) {
        runs.push({ text: text.substr(at, r.n), b: !!(r.f & BOLD), i: !!(r.f & ITALIC), u: !!(r.f & UNDERLINE) });
        at += r.n;
      });
      out.push({ level: line.length ? level(state.spans.formatAt(pos)) : 0, runs: runs });
      pos = end + 1;
    });
    return out;
  }

  function saveBlob(blob, name) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  }

  function downloadDocx() {
    save();
    saveBlob(window.SkriftsporDocx.build({ title: doc.title, author: doc.author, paragraphs: paragraphs() }),
      S.fileName(doc.author, doc.title, '.docx'));
  }

  /* ---- Scrolling: the sheet scrolls inside itself ------------------------ */

  function caretIntoView() {
    var s = window.getSelection();
    if (!s.rangeCount) return;
    var r = s.getRangeAt(0).getClientRects()[0] || (s.focusNode && s.focusNode.nodeType === 1 ? s.focusNode.getBoundingClientRect() : null);
    if (!r) return;
    var box = ed.getBoundingClientRect();
    if (r.bottom > box.bottom - 24) ed.scrollTop += r.bottom - box.bottom + 48;
    else if (r.top < box.top + 24) ed.scrollTop -= box.top - r.top + 48;
  }

  /* ---- Table of contents, shown while scrolling ------------------------- */

  var tocTimer = null, tocHover = false;
  function buildToc() {
    var items = [], lines = ed.childNodes;
    for (var i = 0; i < lines.length; i++) {
      var m = /ln--h(\d)/.exec(lines[i].className);
      if (m) items.push('<li class="toc__item toc__item--' + m[1] + '"><button type="button" data-line="' + i + '">' + esc(lines[i].textContent) + '</button></li>');
    }
    tocEl.innerHTML = items.length ? '<ol>' + items.join('') + '</ol>' : '';
    if (!items.length) tocEl.classList.remove('is-visible');
  }
  function showToc() {
    if (!tocEl.innerHTML || ed.scrollHeight <= ed.clientHeight + 40) return;
    tocEl.classList.add('is-visible');
    clearTimeout(tocTimer);
    tocTimer = setTimeout(function () { if (!tocHover) tocEl.classList.remove('is-visible'); }, 1500);
  }
  ed.addEventListener('scroll', showToc);
  tocEl.addEventListener('mouseenter', function () { tocHover = true; clearTimeout(tocTimer); });
  tocEl.addEventListener('mouseleave', function () { tocHover = false; showToc(); });
  tocEl.addEventListener('mousedown', function (e) { e.preventDefault(); });
  tocEl.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-line]');
    if (!btn) return;
    var line = ed.childNodes[+btn.getAttribute('data-line')];
    if (line) ed.scrollTop = line.offsetTop - 16;
  });

  /* ---- Name and title, asked for when a new text is started ------------- */

  function askMeta(done) {
    var name = document.getElementById('meta-author'), title = document.getElementById('meta-title');
    name.value = doc.author || '';
    title.value = doc.title || '';
    metaDialog.returnValue = '';
    metaDialog.showModal();
    metaDialog.addEventListener('close', function onClose() {
      metaDialog.removeEventListener('close', onClose);
      if (metaDialog.returnValue !== 'ok') return;
      doc.author = name.value.trim();
      doc.title = title.value.trim();
      authorInput.value = doc.author;
      titleInput.value = doc.title;
      save();
      done();
    });
  }

  function copyText() {
    var html = toHtml(0, state.text.length), txt = state.text;
    var onCopy = function (e) {
      e.clipboardData.setData('text/html', html);
      e.clipboardData.setData('text/plain', txt);
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    document.addEventListener('copy', onCopy, true);
    var ok = document.execCommand('copy');
    document.removeEventListener('copy', onCopy, true);
    if (!ok && navigator.clipboard) navigator.clipboard.writeText(txt);
    showToast('Kopiert');
  }

  /* ---- Status and saving ------------------------------------------------- */

  function stats() {
    var c = state.spans.counts();
    var len = state.text.length;
    var pct = len ? Math.round(1000 * c.pasted / len) / 10 : 0;
    statsEl.textContent = S.countWords(state.text) + ' ord · ' + S.fmtPct(pct) + ' innlimt · økt ' + Math.max(1, doc.sessions.length);
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

  var saveTimer = null;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 400);
  }
  function save() {
    if (locked) return;
    doc.title = titleInput.value;
    doc.author = authorInput.value;
    doc.savedAt = Date.now();
    if (!S.local.save(doc)) {
      statusEl.textContent = 'Kan ikke lagre i nettleseren. Last ned spor-fila ofte.';
      statusEl.classList.add('is-warn');
      return;
    }
    status();
  }

  /* Two tabs on the same document would overwrite each other's log. */
  window.addEventListener('storage', function (e) {
    if (e.key !== S.local.key || locked) return;
    locked = true;
    ed.contentEditable = 'false';
    titleInput.readOnly = true;
    statusEl.textContent = 'Åpnet i en annen fane. Last siden på nytt for å fortsette her.';
    statusEl.classList.add('is-warn');
  });

  /* ---- Actions ----------------------------------------------------------- */

  function download() {
    save();
    S.fileFromLocal(doc).then(function (file) {
      saveBlob(new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }), S.fileName(doc.author, doc.title));
      doc.downloadedAt = Date.now();
      save();
    }).catch(function (e) {
      alert('Spor-fila kunne ikke lages: ' + e.message);
    });
  }

  function reset() {
    S.local.clear();
    doc = emptyDoc();
    state = new S.State('');
    undoStack = []; redoStack = []; lastGroup = null; pending = null;
    titleInput.value = '';
    authorInput.value = '';
    render();
    status();
  }

  function confirmDiscard() {
    return !state.text || confirm('Starte på en ny tekst? Teksten du har nå blir slettet fra denne nettleseren.' +
      (doc.changedAt > doc.downloadedAt ? '\n\nDu har ikke lastet ned spor-fila etter siste endring.' : ''));
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
        doc.author = parsed.author || '';
        doc.sessions = parsed.sessions.map(function (s) { return { stored: s }; });
        doc.downloadedAt = doc.changedAt = Date.now();
        state = rep.replay.state;
        undoStack = []; redoStack = []; lastGroup = null; pending = null;
        titleInput.value = doc.title;
        authorInput.value = doc.author;
        save();
        ed.focus();
        render([state.text.length, state.text.length]);
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

  /* ---- Wiring ------------------------------------------------------------ */

  titleInput.addEventListener('input', scheduleSave);
  authorInput.addEventListener('input', scheduleSave);
  document.getElementById('btn-docx').addEventListener('click', downloadDocx);
  document.getElementById('btn-download').addEventListener('click', download);
  document.getElementById('btn-copy').addEventListener('click', copyText);
  document.getElementById('btn-new').addEventListener('click', function () {
    if (!confirmDiscard()) return;
    reset();
    askMeta(function () { ed.focus(); });
  });
  document.getElementById('btn-resume').addEventListener('click', function () { fileInput.click(); });
  fileInput.addEventListener('change', function () { if (fileInput.files[0]) resume(fileInput.files[0]); fileInput.value = ''; });
  document.getElementById('btn-play').addEventListener('click', function () {
    save();
    if (window.SkriftsporInbox) window.SkriftsporInbox.loadLocal();
  });

  /* Leaving with changes that are not in a downloaded spor-file: the
     browser asks first, in its own words. */
  window.addEventListener('beforeunload', function (e) {
    if (locked || !state.text || doc.changedAt <= doc.downloadedAt) return;
    save();
    e.preventDefault();
    e.returnValue = '';
  });

  /* Ctrl/Cmd+S downloads the file rather than saving the web page. */
  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && document.body.getAttribute('data-view') === 'write') {
      e.preventDefault();
      download();
    }
  });

  /* ---- Start: rebuild the text from the stored log ----------------------- */

  doc = S.local.load() || emptyDoc();
  titleInput.value = doc.title || '';
  authorInput.value = doc.author || '';
  ed.contentEditable = 'false';
  S.finalize(doc.sessions).then(function (f) {
    state = f.state;
  }).catch(function (e) {
    console.error(e);
    alert('Teksten i nettleseren kunne ikke leses inn igjen (' + e.message + '). Har du en nedlastet spor-fil, kan du fortsette fra den.');
    doc = emptyDoc();
    state = new S.State('');
  }).then(function () {
    ed.contentEditable = 'true';
    ready = true;
    state.caret = state.sel = state.text.length;
    render();
    status();
    document.dispatchEvent(new CustomEvent('skriftspor:writer-ready'));
  });

  /* For js/inbox.js, which owns the views. */
  window.SkriftsporWriter = {
    ready: function () { return ready; },
    hasText: function () { return !!state.text; },
    title: function () { return doc.title || ''; },
    show: function () {
      ed.focus();
      render([state.text.length, state.text.length]);
    },
    /* Confirms discarding the current text, asks for name and title,
       then calls done(). Cancelling the questions keeps everything as it was
       only if there was no text; a discarded text is gone either way. */
    startNew: function (done) {
      if (!confirmDiscard()) return;
      if (state.text || doc.sessions.length) reset();
      askMeta(done);
    }
  };

  setInterval(status, 30000);
  setInterval(syncExternal, 2000);
})();
