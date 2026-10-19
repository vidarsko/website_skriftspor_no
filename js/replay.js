/* ==========================================================================
   replay.js — plays a writing process back. The core function of the site.

   Used on the front page (js/inbox.js) when a submission is opened:
   play/pause, a scrubber, speed, and a session timeline that can be
   scrubbed with the mouse wheel. `controls: false` gives a bare, looping
   player, which nothing uses at the moment.

   new SkriftsporReplay(container, sessions, options)
     sessions: [{ start (ms), events: [...] | null, startText?, rebuiltFromEnd? }]
               — the `sessions` of Skriftspor.replay(), or hand-made ones.
     options:  { controls: true, loop: false, speed: 10, autoplay: false }

   Pauses are shortened by default ("Korte ned pauser"): any gap longer than
   PAUSE_CAP_MS plays as PAUSE_CAP_MS, and the meta line says how long the
   real pause was. Without it, replaying a week of writing at 10× takes
   most of a day.
   ========================================================================== */
(function () {
  'use strict';

  var S = window.Skriftspor;
  var KEYFRAME_EVERY = 250;
  var PAUSE_CAP_MS = 1200;
  var NEW_TEXT_MS = 700;     /* how long fresh text stays highlighted (process time) */
  var SHOW_PAUSE_FROM_MS = 60 * 1000;

  var DAYS = ['søndag', 'mandag', 'tirsdag', 'onsdag', 'torsdag', 'fredag', 'lørdag'];
  var MONTHS = ['jan.', 'feb.', 'mars', 'april', 'mai', 'juni', 'juli', 'aug.', 'sep.', 'okt.', 'nov.', 'des.'];

  function pad(n) { return String(n).padStart(2, '0'); }
  function when(ms) {
    var d = new Date(ms);
    return DAYS[d.getDay()] + ' ' + d.getDate() + '. ' + MONTHS[d.getMonth()] + ' kl. ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function duration(ms) {
    var m = Math.round(ms / 60000);
    if (m < 60) return m + ' min';
    var h = Math.floor(m / 60);
    if (h < 48) return h + ' t ' + (m % 60) + ' min';
    return Math.round(h / 24) + ' døgn';
  }
  function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }

  function Replay(container, sessions, options) {
    this.opt = Object.assign({ controls: true, loop: false, speed: 10, autoplay: false, compress: true }, options || {});
    this.container = container;
    this.items = [];
    this.sessionStarts = [];
    this.build(sessions);
    this.k = 0;
    this.state = this.frames[0].clone();
    this.acc = 0;
    this.playing = false;
    this.speed = this.opt.speed;
    this.compress = this.opt.compress;
    this.dom();
    this.render();
    if (this.opt.autoplay) this.play();
  }

  /* Flatten every session into one list of items with absolute times, and
     keep a snapshot every KEYFRAME_EVERY items so scrubbing backwards is
     cheap. A session rebuilt from the end after a damaged one starts with
     a reset item: its text appears all at once, which is the honest
     picture — what happened in the damaged session is unknown. */
  Replay.prototype.build = function (sessions) {
    var items = this.items, sessionStarts = this.sessionStarts;
    var state = new S.State('');
    var frames = [state.clone()];
    var self = this;
    this.sessionCount = sessions.length;
    sessions.forEach(function (s, si) {
      if (!s.events) return;
      var t = s.start;
      sessionStarts.push({ k: items.length, s: si, t: t, n: s.events.length });
      if (s.startText != null && s.startText !== state.text) {
        items.push({ abs: t, s: si, reset: s.startText });
        push();
      }
      s.events.forEach(function (ev) {
        t += ev[0];
        items.push({ abs: t, s: si, ev: ev });
        push();
      });
    });
    function push() {
      self.applyTo(state, items[items.length - 1]);
      if (items.length % KEYFRAME_EVERY === 0) frames.push(state.clone());
    }
    this.frames = frames;
    this.finalText = state.text;
  };

  Replay.prototype.applyTo = function (state, item) {
    if (item.reset != null) {
      var fresh = new S.State(item.reset);
      state.text = fresh.text; state.spans = fresh.spans; state.caret = state.sel = 0;
    } else {
      state.apply(item.ev, item.s);
    }
  };

  Replay.prototype.seek = function (k) {
    k = Math.max(0, Math.min(this.items.length, k));
    if (k < this.k || k - this.k > KEYFRAME_EVERY) {
      var f = Math.floor(k / KEYFRAME_EVERY);
      this.state = this.frames[f].clone();
      this.k = f * KEYFRAME_EVERY;
    }
    while (this.k < k) this.applyTo(this.state, this.items[this.k++]);
    this.acc = 0;
    this.render();
  };

  /* The gap BEFORE item k, as it is played. */
  Replay.prototype.gap = function (k) {
    if (k === 0) return 0;
    var g = this.items[k].abs - this.items[k - 1].abs;
    if (this.items[k].s !== this.items[k - 1].s) g = Math.max(g, PAUSE_CAP_MS);
    return this.compress ? Math.min(g, PAUSE_CAP_MS) : g;
  };

  Replay.prototype.play = function () {
    if (this.playing) return;
    if (this.k >= this.items.length) this.seek(0);
    this.playing = true;
    this.last = performance.now();
    var self = this;
    function frame(now) {
      if (!self.playing) return;
      self.acc += (now - self.last) * self.speed;
      self.last = now;
      var steps = 0;
      while (self.k < self.items.length && self.acc >= self.gap(self.k) && steps < 3000) {
        self.acc -= self.gap(self.k);
        self.applyTo(self.state, self.items[self.k++]);
        steps++;
      }
      if (self.k >= self.items.length) {
        if (self.opt.loop) {
          self.render();
          self.playing = false;
          setTimeout(function () { self.seek(0); self.play(); }, 4000);
          return;
        }
        self.pause();
      }
      self.render();
      if (self.playing) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
    this.syncButton();
  };

  Replay.prototype.pause = function () {
    this.playing = false;
    this.syncButton();
  };

  /* ---- DOM ------------------------------------------------------------- */

  Replay.prototype.dom = function () {
    var c = this.container, self = this;
    c.innerHTML = '';
    c.classList.add('player');

    if (this.opt.controls) {
      var bar = el('div', 'player__bar');
      this.btn = el('button', 'btn btn--primary player__play', 'Spill av');
      this.btn.type = 'button';
      this.btn.addEventListener('click', function () { self.playing ? self.pause() : self.play(); });
      bar.appendChild(this.btn);

      this.range = el('input', 'player__range');
      this.range.type = 'range';
      this.range.min = 0;
      this.range.max = this.items.length;
      this.range.step = 1;
      this.range.value = 0;
      this.range.setAttribute('aria-label', 'Posisjon i skriveprosessen');
      this.range.addEventListener('input', function () { self.seek(+self.range.value); });
      bar.appendChild(this.range);

      var speedWrap = el('label', 'player__opt');
      speedWrap.appendChild(document.createTextNode('Fart '));
      this.speedSel = el('select', 'player__select');
      [1, 3, 10, 30, 100, 300].forEach(function (v) {
        var o = el('option', null, v + '×');
        o.value = v;
        if (v === self.speed) o.selected = true;
        self.speedSel.appendChild(o);
      });
      this.speedSel.addEventListener('change', function () { self.speed = +self.speedSel.value; });
      speedWrap.appendChild(this.speedSel);
      bar.appendChild(speedWrap);

      var pauseWrap = el('label', 'player__opt');
      var cb = el('input');
      cb.type = 'checkbox';
      cb.checked = this.compress;
      cb.addEventListener('change', function () { self.compress = cb.checked; });
      pauseWrap.appendChild(cb);
      pauseWrap.appendChild(document.createTextNode(' Korte ned pauser'));
      bar.appendChild(pauseWrap);

      c.appendChild(bar);

      /* Timeline: one segment per session, width by number of events.
         Pastes are ticks. Click a segment to jump to that session. */
      var tl = el('div', 'player__timeline');
      tl.setAttribute('aria-hidden', 'true');
      var total = this.items.length || 1;
      this.sessionStarts.forEach(function (ss, i) {
        var seg = el('button', 'player__seg');
        seg.type = 'button';
        seg.tabIndex = -1;
        seg.style.left = (100 * ss.k / total) + '%';
        var next = self.sessionStarts[i + 1];
        seg.style.width = (100 * ((next ? next.k : total) - ss.k) / total) + '%';
        seg.title = 'Økt ' + (ss.s + 1) + ' — ' + when(ss.t);
        seg.textContent = ss.s + 1;
        seg.addEventListener('click', function () { self.seek(ss.k); });
        tl.appendChild(seg);
      });
      this.items.forEach(function (it, k) {
        if (it.ev && it.ev[1] === 'p') {
          var tick = el('span', 'player__tick');
          tick.style.left = (100 * k / total) + '%';
          tl.appendChild(tick);
        }
      });
      this.head = el('span', 'player__head');
      tl.appendChild(this.head);
      c.appendChild(tl);

      /* Scroll to scrub: the mouse wheel over the timeline or the slider
         moves through the process, about 1/150 of it per notch. */
      var onWheel = function (e) {
        e.preventDefault();
        var step = Math.max(1, Math.round(self.items.length / 150));
        var d = (Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX) > 0 ? step : -step;
        self.seek(self.k + d);
      };
      tl.addEventListener('wheel', onWheel, { passive: false });
      this.range.addEventListener('wheel', onWheel, { passive: false });
    }

    this.meta = el('p', 'player__meta');
    this.meta.setAttribute('aria-live', 'off');
    c.appendChild(this.meta);

    this.text = el('div', 'player__text');
    c.appendChild(this.text);
  };

  Replay.prototype.syncButton = function () {
    if (this.btn) this.btn.textContent = this.playing ? 'Pause' : (this.k >= this.items.length ? 'Spill av igjen' : 'Spill av');
  };

  /* ---- Rendering ------------------------------------------------------- */

  Replay.prototype.render = function () {
    var st = this.state, k = this.k, items = this.items;
    var cur = items[k - 1];

    /* Fresh text: the insertions of the last NEW_TEXT_MS of process time,
       when they are adjacent (a typed run). One range is enough. */
    var fresh = null, del = null;
    if (cur && cur.ev) {
      var e = cur.ev;
      if (e[1] === 'i' || e[1] === 'p') {
        var a = e[2], b = e[2] + e[3].length;
        for (var j = k - 2; j >= 0 && j >= k - 400; j--) {
          var p = items[j];
          if (!p.ev || cur.abs - p.abs > NEW_TEXT_MS) break;
          if ((p.ev[1] === 'i' || p.ev[1] === 'p') && p.ev[2] + p.ev[3].length === a) a = p.ev[2];
          else break;
        }
        fresh = [a, b];
      } else if (e[1] === 'd' && this.acc < 900) {
        del = { at: e[2], text: e[3] };
      }
    }

    /* Cut points: run boundaries, caret, fresh range. */
    var cuts = {}, at = 0;
    cuts[0] = 1; cuts[st.text.length] = 1;
    st.spans.runs.forEach(function (r) { at += r.n; cuts[at] = 1; });
    cuts[st.caret] = 1;
    if (fresh) { cuts[fresh[0]] = 1; cuts[fresh[1]] = 1; }
    var points = Object.keys(cuts).map(Number).filter(function (x) { return x <= st.text.length; }).sort(function (a, b) { return a - b; });

    var flags = runFlag(st.spans.runs, 'p');
    var fmts = runFlag(st.spans.runs, 'f');
    var html = '';
    for (var i = 0; i < points.length; i++) {
      var from = points[i], to = points[i + 1];
      if (from === st.caret) {
        if (del) html += '<del class="player__del">' + esc(del.text) + '</del>';
        html += '<span class="player__caret" aria-hidden="true"></span>';
      }
      if (to === undefined || to === from) continue;
      var cls = [];
      if (flags(from) === 1) cls.push('mark-pasted');
      if (flags(from) === 2) cls.push('mark-unknown');
      if (fresh && from >= fresh[0] && to <= fresh[1]) cls.push('player__fresh');
      var f = fmts(from);
      if (f & 1) cls.push('f-b');
      if (f & 2) cls.push('f-i');
      if (f & 4) cls.push('f-u');
      if (f & 8) cls.push('f-h1');
      if (f & 16) cls.push('f-h2');
      if (f & 32) cls.push('f-h3');
      var seg = esc(st.text.slice(from, to));
      html += cls.length ? '<span class="' + cls.join(' ') + '">' + seg + '</span>' : seg;
    }
    this.text.innerHTML = html + ' ';

    /* Keep the caret in view, inside the text box only — never the page. */
    var caret = this.text.querySelector('.player__caret');
    if (caret) {
      var top = caret.offsetTop, box = this.text;
      if (top < box.scrollTop + 20 || top > box.scrollTop + box.clientHeight - 40) box.scrollTop = Math.max(0, top - box.clientHeight / 2);
    }

    /* Meta line. */
    var ref = cur || items[0];
    var meta = '';
    if (ref) {
      meta = 'Økt ' + (ref.s + 1) + ' av ' + this.sessionCount + ' · ' + when(ref.abs);
      var next = items[k];
      if (this.playing && next && cur && next.abs - cur.abs >= SHOW_PAUSE_FROM_MS) {
        meta += next.s !== cur.s ? ' · ny økt etter ' + duration(next.abs - cur.abs) : ' · pause på ' + duration(next.abs - cur.abs);
      }
      if (cur && cur.ev && cur.ev[1] === 'p') meta += ' · limte inn ' + cur.ev[3].length + ' tegn';
    } else meta = 'Ingen skriving å spille av.';
    this.meta.textContent = meta;

    if (this.range) {
      this.range.value = k;
      var total = items.length || 1;
      this.head.style.left = (100 * k / total) + '%';
    }
    this.syncButton();
  };

  /* Origin lookup by character position, for a sorted run list. */
  function runFlag(runs, key) {
    var starts = [], at = 0;
    runs.forEach(function (r) { starts.push(at); at += r.n; });
    return function (pos) {
      var lo = 0, hi = runs.length - 1;
      while (lo <= hi) {
        var mid = (lo + hi) >> 1;
        if (starts[mid] > pos) hi = mid - 1;
        else if (starts[mid] + runs[mid].n <= pos) lo = mid + 1;
        else return runs[mid][key] || 0;
      }
      return 0;
    };
  }

  window.SkriftsporReplay = Replay;
})();
