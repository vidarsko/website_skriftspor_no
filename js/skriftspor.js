/* ==========================================================================
   skriftspor.js — the core. Everything the file format IS lives here, and
   both pages use it: /skriv/ to write a file, the front page to read them back.

   Nothing in this file talks to a server, with one exception: the drand
   helpers at the bottom FETCH a public random number (a GET with no body).
   No text, no hash and nothing about the writer is ever sent anywhere.

   The format is documented for humans at /format/. If you change anything
   here that changes what goes into a file, change that page in the same
   commit — other people are meant to be able to build their own readers.

   Runs in a browser and in Node 18+ (tools_private/test-core.mjs), so it
   uses only globals both have: crypto.subtle, CompressionStream,
   TextEncoder, btoa/atob.
   ========================================================================== */
(function (root) {
  'use strict';

  var FORMAT = 'skriftspor';
  var VERSION = 1;
  var SPEC_URL = 'https://skriftspor.no/om/#filformat';
  var ZERO_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

  /* A gap longer than this between two edits starts a new session (økt).
     Also the cap used when adding up "active writing time": a pause longer
     than ACTIVE_GAP is counted as ACTIVE_GAP, not as writing. */
  var SESSION_IDLE_MS = 30 * 60 * 1000;
  var ACTIVE_GAP_MS = 2 * 60 * 1000;

  var enc = new TextEncoder();
  var dec = new TextDecoder();

  /* ------------------------------------------------------------------ */
  /* Bytes, hashes, compression                                          */
  /* ------------------------------------------------------------------ */

  function toBytes(x) { return typeof x === 'string' ? enc.encode(x) : x; }

  function hex(buf) {
    var b = new Uint8Array(buf), s = '';
    for (var i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16);
    return s;
  }

  function sha256(x) {
    return crypto.subtle.digest('SHA-256', toBytes(x)).then(hex);
  }

  function pipe(bytes, stream) {
    var s = new Blob([bytes]).stream().pipeThrough(stream);
    return new Response(s).arrayBuffer().then(function (b) { return new Uint8Array(b); });
  }
  function gzip(bytes) { return pipe(bytes, new CompressionStream('gzip')); }
  function gunzip(bytes) { return pipe(bytes, new DecompressionStream('gzip')); }

  function b64encode(bytes) {
    var s = '', CH = 0x8000;
    for (var i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return btoa(s);
  }
  function b64decode(str) {
    var s = atob(str), b = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
    return b;
  }

  /* ------------------------------------------------------------------ */
  /* Origin spans — which characters of the current text were typed and  */
  /* which were pasted, and in which session. Run-length encoded, so an   */
  /* insert costs O(number of runs), not O(length of text).               */
  /*   run = { n: length, p: 0 typed | 1 pasted | 2 unknown, s: session, */
  /*           f: formatting bits — 1 bold, 2 italic, 4 underline,        */
  /*              8 heading (set on every character of a heading line) } */
  /* ------------------------------------------------------------------ */

  function Spans(runs) { this.runs = runs || []; }

  Spans.prototype.clone = function () {
    return new Spans(this.runs.map(function (r) { return { n: r.n, p: r.p, s: r.s, f: r.f || 0 }; }));
  };

  Spans.prototype.length = function () {
    var n = 0;
    for (var i = 0; i < this.runs.length; i++) n += this.runs[i].n;
    return n;
  };

  /* Split so that a run boundary falls exactly at pos; returns the index of
     the first run at or after pos. */
  Spans.prototype._split = function (pos) {
    var runs = this.runs, at = 0;
    for (var i = 0; i < runs.length; i++) {
      if (pos === at) return i;
      if (pos < at + runs[i].n) {
        var r = runs[i], left = pos - at;
        runs.splice(i, 1, { n: left, p: r.p, s: r.s, f: r.f || 0 }, { n: r.n - left, p: r.p, s: r.s, f: r.f || 0 });
        return i + 1;
      }
      at += runs[i].n;
    }
    return runs.length;
  };

  Spans.prototype._merge = function () {
    var out = [];
    for (var i = 0; i < this.runs.length; i++) {
      var r = this.runs[i];
      if (!r.n) continue;
      var last = out[out.length - 1];
      if (last && last.p === r.p && last.s === r.s && (last.f || 0) === (r.f || 0)) last.n += r.n;
      else out.push(r);
    }
    this.runs = out;
  };

  Spans.prototype.insert = function (pos, n, p, s, f) {
    if (!n) return;
    var i = this._split(pos);
    this.runs.splice(i, 0, { n: n, p: p, s: s, f: f || 0 });
    this._merge();
  };

  Spans.prototype.remove = function (pos, n) {
    if (!n) return;
    var i = this._split(pos), j = this._split(pos + n);
    this.runs.splice(i, j - i);
    this._merge();
  };

  /* Turns formatting bit(s) on or off for [a, b). */
  Spans.prototype.setFormat = function (a, b, bits, on) {
    if (b <= a) return;
    var i = this._split(a), j = this._split(b);
    for (var k = i; k < j; k++) {
      var r = this.runs[k];
      r.f = on ? ((r.f || 0) | bits) : ((r.f || 0) & ~bits);
    }
    this._merge();
  };

  /* The runs covering [a, b), cut to fit. For undo. */
  Spans.prototype.slice = function (a, b) {
    var out = [], at = 0;
    for (var i = 0; i < this.runs.length && at < b; i++) {
      var r = this.runs[i], ra = at, rb = at + r.n;
      at = rb;
      var x = Math.max(a, ra), y = Math.min(b, rb);
      if (y > x) out.push({ n: y - x, p: r.p, s: r.s, f: r.f || 0 });
    }
    return out;
  };

  /* Formatting bits of the character at pos (0 outside the text). */
  Spans.prototype.formatAt = function (pos) {
    var at = 0;
    for (var i = 0; i < this.runs.length; i++) {
      if (pos < at + this.runs[i].n) return this.runs[i].f || 0;
      at += this.runs[i].n;
    }
    return 0;
  };

  /* Characters per origin: { typed, pasted, unknown }. */
  Spans.prototype.counts = function () {
    var c = { typed: 0, pasted: 0, unknown: 0 };
    for (var i = 0; i < this.runs.length; i++) {
      var r = this.runs[i];
      if (r.p === 0) c.typed += r.n; else if (r.p === 1) c.pasted += r.n; else c.unknown += r.n;
    }
    return c;
  };

  /* Origin of each character as a Uint8Array (0/1/2). For comparison only. */
  Spans.prototype.flags = function () {
    var out = new Uint8Array(this.length()), at = 0;
    for (var i = 0; i < this.runs.length; i++) {
      out.fill(this.runs[i].p, at, at + this.runs[i].n);
      at += this.runs[i].n;
    }
    return out;
  };

  /* ------------------------------------------------------------------ */
  /* Events                                                               */
  /*                                                                      */
  /* An event is a short array. The first element is ALWAYS the number of */
  /* milliseconds since the previous event in the same session (0 for the */
  /* first). Deltas rather than timestamps because they compress better. */
  /*                                                                      */
  /*   [dt, "i", pos, "text", fmt]  typed text inserted at pos           */
  /*   [dt, "p", pos, "text", fmt]  pasted or dropped text inserted      */
  /*        fmt is optional: formatting bits of the new text (see Spans) */
  /*   [dt, "f", a, b, bits, on]    formatting turned on (1) or off (0)  */
  /*                                for [a, b) — the text is unchanged   */
  /*   [dt, "d", pos, "text"]       "text" deleted, starting at pos      */
  /*   [dt, "c", start, end]        cursor moved / selection changed     */
  /*   [dt, "r", round, randomness, signature]   drand checkpoint        */
  /*                                                                      */
  /* Positions count UTF-16 code units, which is what JavaScript strings  */
  /* and a browser textarea use. A reader in another language must do the */
  /* same, or an emoji will shift every position after it by one.         */
  /* ------------------------------------------------------------------ */

  function State(text, spans) {
    this.text = text || '';
    this.spans = spans || new Spans(this.text ? [{ n: this.text.length, p: 2, s: -1 }] : []);
    this.caret = 0;
    this.sel = 0;
  }

  State.prototype.clone = function () {
    var s = new State(this.text, this.spans.clone());
    s.caret = this.caret; s.sel = this.sel;
    return s;
  };

  /* Applies one event. Throws if the event does not fit the text — a
     deletion of text that is not there means the log is damaged or edited. */
  State.prototype.apply = function (ev, session) {
    var type = ev[1], pos = ev[2];
    if (type === 'i' || type === 'p') {
      if (pos < 0 || pos > this.text.length) throw new Error('innsetting utenfor teksten');
      this.text = this.text.slice(0, pos) + ev[3] + this.text.slice(pos);
      this.spans.insert(pos, ev[3].length, type === 'p' ? 1 : 0, session, ev[4] || 0);
      this.caret = this.sel = pos + ev[3].length;
    } else if (type === 'd') {
      if (this.text.substr(pos, ev[3].length) !== ev[3]) throw new Error('sletting av tekst som ikke finnes');
      this.text = this.text.slice(0, pos) + this.text.slice(pos + ev[3].length);
      this.spans.remove(pos, ev[3].length);
      this.caret = this.sel = pos;
    } else if (type === 'c') {
      this.caret = pos; this.sel = ev[3];
    } else if (type === 'f') {
      if (pos < 0 || ev[3] > this.text.length || ev[3] < pos) throw new Error('formatering utenfor teksten');
      this.spans.setFormat(pos, ev[3], ev[4], !!ev[5]);
    }
  };

  /* The reverse: from the text AFTER an event to the text before it. Used
     to rebuild a session's starting text from the end when an EARLIER
     session is damaged — that is what keeps damage local. Origins of text
     brought back this way are unknown (p: 2). */
  State.prototype.unapply = function (ev) {
    var type = ev[1], pos = ev[2];
    if (type === 'i' || type === 'p') {
      if (this.text.substr(pos, ev[3].length) !== ev[3]) throw new Error('teksten stemmer ikke bakover');
      this.text = this.text.slice(0, pos) + this.text.slice(pos + ev[3].length);
      this.spans.remove(pos, ev[3].length);
    } else if (type === 'd') {
      if (pos < 0 || pos > this.text.length) throw new Error('teksten stemmer ikke bakover');
      this.text = this.text.slice(0, pos) + ev[3] + this.text.slice(pos);
      this.spans.insert(pos, ev[3].length, 2, -1);
    }
  };

  /* ------------------------------------------------------------------ */
  /* Sessions and the hash chain                                          */
  /* ------------------------------------------------------------------ */

  /* The chain hash of one session. Every field that says WHAT happened is
     in it; the compressed bytes are not, since two correct gzip encoders
     may produce different bytes for the same log. */
  function sessionHash(s) {
    return sha256([
      FORMAT + '/' + VERSION, s.n, s.start, s.end, s.events,
      s.prev, s.log_sha256, s.text_end_sha256
    ].join('\n'));
  }

  /* An open (in-memory) session → the object stored in the file.
     open = { n, start (ms), prev, events: [...] }, textEnd = the text after it. */
  function encodeSession(open, textEnd) {
    var json = JSON.stringify(open.events);
    var total = 0;
    for (var i = 0; i < open.events.length; i++) total += open.events[i][0];
    var s = {
      n: open.n,
      start: new Date(open.start).toISOString(),
      end: new Date(open.start + total).toISOString(),
      events: open.events.length,
      prev: open.prev,
      log_sha256: null,
      text_end_sha256: null,
      hash: null,
      data_sha256: null,
      data: null
    };
    return Promise.all([sha256(json), sha256(textEnd), gzip(enc.encode(json))]).then(function (r) {
      s.log_sha256 = r[0];
      s.text_end_sha256 = r[1];
      s.data = b64encode(r[2]);
      return Promise.all([sha256(r[2]), sessionHash(s)]);
    }).then(function (r) {
      s.data_sha256 = r[0];
      s.hash = r[1];
      return s;
    });
  }

  /* Stored session → its events, checking both checksums on the way.
     Resolves { events } or { error }. Never throws: one bad session must
     not stop the others from being read. */
  function decodeSession(s) {
    var bytes;
    try { bytes = b64decode(s.data || ''); } catch (e) { return Promise.resolve({ error: 'dataene er ikke gyldig base64' }); }
    return sha256(bytes).then(function (h) {
      if (h !== s.data_sha256) return { error: 'sjekksummen for de komprimerte dataene stemmer ikke' };
      return gunzip(bytes).then(function (raw) {
        var json = dec.decode(raw);
        return sha256(json).then(function (h2) {
          if (h2 !== s.log_sha256) return { error: 'sjekksummen for loggen stemmer ikke' };
          var events = JSON.parse(json);
          if (!Array.isArray(events) || events.length !== s.events) return { error: 'antall hendelser stemmer ikke' };
          return { events: events };
        });
      }, function () { return { error: 'dataene kan ikke pakkes ut' }; });
    }).catch(function (e) { return { error: 'kunne ikke leses (' + e.message + ')' }; });
  }

  /* ------------------------------------------------------------------ */
  /* Summary — the short, human-readable part at the top of a file.      */
  /* Computed from the replay, never trusted when read: the reader always */
  /* recomputes it and says so if the stored one differs.                 */
  /* ------------------------------------------------------------------ */

  /* sessions: [{ start (ms), events }] fully decoded; final: State. */
  function summarize(sessions, final) {
    var first = null, last = null, active = 0, n = 0, pastes = 0, pastedChars = 0,
        typedChars = 0, deletedChars = 0, checkpoints = 0;
    sessions.forEach(function (s) {
      if (!s.events) return;
      var t = s.start;
      if (first === null) first = t;
      s.events.forEach(function (ev, i) {
        if (i > 0) active += Math.min(ev[0], ACTIVE_GAP_MS);
        t += ev[0];
        n++;
        if (ev[1] === 'i') typedChars += ev[3].length;
        else if (ev[1] === 'p') { pastes++; pastedChars += ev[3].length; }
        else if (ev[1] === 'd') deletedChars += ev[3].length;
        else if (ev[1] === 'r') checkpoints++;
      });
      last = t;
    });
    var c = final.spans.counts();
    var len = final.text.length || 1;
    var shareTyped = Math.round(1000 * c.typed / len) / 10;
    var sharePasted = Math.round(1000 * c.pasted / len) / 10;
    var out = {
      first_event: first === null ? null : new Date(first).toISOString(),
      last_event: last === null ? null : new Date(last).toISOString(),
      sessions: sessions.length,
      active_minutes: Math.round(active / 60000),
      events: n,
      final_chars: final.text.length,
      final_words: countWords(final.text),
      final_typed_chars: c.typed,
      final_pasted_chars: c.pasted,
      final_unknown_chars: c.unknown,
      final_typed_percent: final.text.length ? shareTyped : 0,
      final_pasted_percent: final.text.length ? sharePasted : 0,
      typed_chars_total: typedChars,
      pasted_chars_total: pastedChars,
      deleted_chars_total: deletedChars,
      pastes: pastes,
      drand_checkpoints: checkpoints
    };
    out.description = describe(out);
    return out;
  }

  function countWords(text) {
    var m = text.match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu);
    return m ? m.length : 0;
  }

  var MONTHS = ['januar', 'februar', 'mars', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'desember'];
  function day(iso) {
    var d = new Date(iso);
    return d.getDate() + '. ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear();
  }

  /* One Norwegian sentence. It is written into the file, so it is what a
     teacher sees if they open the file in Notepad. */
  function describe(s) {
    if (!s.first_event) return 'Ingen skriving er registrert ennå.';
    var span = day(s.first_event) === day(s.last_event)
      ? day(s.first_event)
      : day(s.first_event) + ' til ' + day(s.last_event);
    return 'Skrevet ' + span + ' i ' + s.sessions + (s.sessions === 1 ? ' økt' : ' økter') +
      ', omtrent ' + s.active_minutes + ' minutter aktiv skriving. Av slutteksten på ' +
      s.final_words + ' ord er ' + fmtPct(s.final_typed_percent) + ' skrevet her og ' +
      fmtPct(s.final_pasted_percent) + ' limt inn.';
  }

  function fmtPct(x) { return String(x).replace('.', ',') + ' %'; }

  /* ------------------------------------------------------------------ */
  /* Writing a file                                                       */
  /* ------------------------------------------------------------------ */

  /* doc = { title, closed: [stored sessions], open: open session | null,
             text, startText? }
     Resolves the file object. Re-encodes the open session (a snapshot) and
     recomputes the summary from a full replay, so the summary can never
     disagree with the log it sits on top of. */
  function buildFile(doc) {
    var p = doc.open && doc.open.events.length
      ? encodeSession(doc.open, doc.text).then(function (s) { return doc.closed.concat([s]); })
      : Promise.resolve(doc.closed.slice());
    return p.then(function (stored) {
      return replay(stored).then(function (rp) {
        return sha256(doc.text).then(function (th) {
          var summary = summarize(rp.sessions, rp.state);
          return {
            format: FORMAT,
            version: VERSION,
            spec: SPEC_URL,
            readme: 'Dette er en spor-fil fra skriftspor.no. Den viser hvordan en tekst ble skrevet: ' +
              'hver innsetting, sletting og innliming med tidspunkt. Sammendraget og hele slutteksten ' +
              'står i klartekst her. Selve loggen er komprimert, én økt om gangen, og kan spilles av på ' +
              'skriftspor.no ved å slippe fila der. Formatet er beskrevet på ' + SPEC_URL,
            title: doc.title || '',
            summary: summary,
            text: doc.text,
            text_sha256: th,
            head: stored.length ? stored[stored.length - 1].hash : ZERO_HASH,
            sessions: stored
          };
        });
      });
    });
  }

  /* ------------------------------------------------------------------ */
  /* Reading a file back — replay with damage kept local                  */
  /* ------------------------------------------------------------------ */

  /* stored: the file's sessions array. finalText: the file's `text`, used
     to rebuild sessions after a damaged one from the end.
     Resolves {
       sessions: [{ n, start (ms), events | null, error, startText, endOk }],
       state: the final State (forward replay where possible),
       problems: [strings]
     } */
  function replay(stored, finalText) {
    return Promise.all(stored.map(decodeSession)).then(function (decoded) {
      var problems = [];
      var sessions = stored.map(function (s, i) {
        var d = decoded[i];
        if (d.error) problems.push('Økt ' + (i + 1) + ': ' + d.error + '.');
        return { n: s.n, start: Date.parse(s.start), stored: s, events: d.events || null, error: d.error || null };
      });

      /* Backward pass: the starting text of every session after the last
         damaged one can be rebuilt from the final text alone. */
      var lastBad = -1;
      sessions.forEach(function (s, i) { if (!s.events) lastBad = i; });
      var backStart = {};
      if (lastBad >= 0 && typeof finalText === 'string') {
        var b = new State(finalText);
        try {
          for (var k = sessions.length - 1; k > lastBad; k--) {
            for (var e = sessions[k].events.length - 1; e >= 0; e--) b.unapply(sessions[k].events[e]);
            backStart[k] = b.text;
          }
        } catch (err) {
          problems.push('Øktene etter den skadde økta passer ikke med slutteksten.');
          backStart = {};
        }
      }

      /* Forward pass. */
      var state = new State('');
      var chain = Promise.resolve();
      sessions.forEach(function (s, i) {
        chain = chain.then(function () {
          if (!s.events) { state = null; return; }
          if (!state) {
            if (backStart[i] === undefined) return;
            state = new State(backStart[i]);
            s.rebuiltFromEnd = true;
          }
          s.startText = state.text;
          try {
            for (var j = 0; j < s.events.length; j++) state.apply(s.events[j], i);
          } catch (err) {
            problems.push('Økt ' + (i + 1) + ': hendelse ' + (j + 1) + ' passer ikke med teksten (' + err.message + ').');
            s.events = s.events.slice(0, j);
            s.error = 'loggen passer ikke med teksten';
            state = null;
            return;
          }
          return sha256(state.text).then(function (h) {
            s.endOk = h === s.stored.text_end_sha256;
            if (!s.endOk) problems.push('Økt ' + (i + 1) + ': teksten etter økta stemmer ikke med sjekksummen.');
          });
        });
      });
      return chain.then(function () {
        return { sessions: sessions, state: state || new State(finalText || ''), complete: !!state, problems: problems };
      });
    });
  }

  /* Full check of a parsed file. Resolves a report the UI can render
     directly: { ok, checks: [{ ok, label, detail }], replay, summary, file }. */
  function verifyFile(file) {
    var checks = [];
    function check(ok, label, detail) { checks.push({ ok: ok, label: label, detail: detail || '' }); return ok; }

    if (!file || file.format !== FORMAT) {
      check(false, 'Dette er ikke en spor-fil fra Skriftspor.');
      return Promise.resolve({ ok: false, checks: checks, file: file });
    }
    if (file.version !== VERSION) {
      check(false, 'Ukjent versjon av formatet', 'Fila har versjon ' + file.version + '; denne siden leser versjon ' + VERSION + '.');
      return Promise.resolve({ ok: false, checks: checks, file: file });
    }
    var stored = Array.isArray(file.sessions) ? file.sessions : [];

    return replay(stored, file.text).then(function (rp) {
      var damaged = rp.sessions.filter(function (s) { return s.error; }).length;
      check(damaged === 0, damaged === 0
        ? (stored.length === 1 ? 'Økta kan leses' : 'Alle ' + stored.length + ' øktene kan leses')
        : damaged + ' av ' + stored.length + ' økter er skadd',
        rp.problems.join(' '));

      /* The chain: each session's hash recomputed, and each prev pointing
         at the hash before it. */
      return Promise.all(stored.map(sessionHash)).then(function (hashes) {
        var broken = [];
        stored.forEach(function (s, i) {
          var prev = i === 0 ? ZERO_HASH : stored[i - 1].hash;
          if (hashes[i] !== s.hash || s.prev !== prev || s.n !== i + 1) broken.push(i + 1);
        });
        var headOk = file.head === (stored.length ? stored[stored.length - 1].hash : ZERO_HASH);
        check(!broken.length && headOk,
          !broken.length && headOk ? 'Hash-kjeden henger sammen' : 'Hash-kjeden er brutt',
          broken.length ? 'Gjelder økt ' + broken.join(', ') + '. Noe er endret etter at økta ble lagret.' : (headOk ? '' : 'Fila peker på en annen siste økt enn den som ligger i den.'));

        /* Times: sessions in order and not overlapping. */
        var order = true;
        for (var i = 1; i < stored.length; i++) if (Date.parse(stored[i].start) < Date.parse(stored[i - 1].end)) order = false;
        check(order, order ? 'Øktene kommer i riktig rekkefølge i tid' : 'Øktene overlapper i tid');

        return sha256(file.text || '').then(function (th) {
          var textOk = rp.complete && rp.state.text === file.text && th === file.text_sha256;
          check(textOk, textOk ? 'Avspillingen gir nøyaktig slutteksten i fila' : 'Avspillingen gir ikke slutteksten i fila',
            textOk ? '' : (th !== file.text_sha256 ? 'Slutteksten er endret etter at fila ble laget.' : 'Loggen og teksten stemmer ikke overens.'));

          var dr = drandChecks(rp.sessions);
          if (dr.count) check(dr.ok, dr.ok
            ? (dr.count === 1 ? 'Tidsstempelet fra drand stemmer med klokkeslettet' : dr.count + ' tidsstempler fra drand stemmer med klokkeslettene')
            : 'Tidsstemplene fra drand stemmer ikke med klokkeslettene', dr.detail);
          else checks.push({ ok: null, label: 'Ingen tidsstempler fra drand', detail: 'Nettleseren var trolig uten nett mens teksten ble skrevet. Det er ikke et tegn på juks, bare at denne kontrollen mangler.' });

          var summary = summarize(rp.sessions, rp.state);
          var stale = file.summary && file.summary.description !== summary.description;
          if (stale) checks.push({ ok: false, label: 'Sammendraget øverst i fila stemmer ikke med loggen', detail: 'Tallene på denne siden er regnet ut på nytt fra loggen.' });

          return {
            ok: checks.every(function (c) { return c.ok !== false; }),
            checks: checks, replay: rp, summary: summary, file: file
          };
        });
      });
    });
  }

  /* ------------------------------------------------------------------ */
  /* drand — public randomness as proof of "not before"                   */
  /*                                                                      */
  /* drand publishes a new unpredictable value every 3 seconds. A value   */
  /* cannot be known before its time, so a log that contains it cannot   */
  /* have been made before that time. It proves "not before", and nothing */
  /* else: it says nothing about who typed, or how.                        */
  /* ------------------------------------------------------------------ */

  var DRAND = {
    chain: '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971',   /* quicknet */
    genesis: 1692803367,
    period: 3,
    hosts: ['https://api.drand.sh', 'https://api2.drand.sh', 'https://drand.cloudflare.com']
  };

  function roundTime(round) { return (DRAND.genesis + (round - 1) * DRAND.period) * 1000; }

  function fetchWithTimeout(url, ms) {
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, ms);
    return fetch(url, { cache: 'no-store', signal: ctl && ctl.signal, credentials: 'omit', referrerPolicy: 'no-referrer' })
      .then(function (r) { clearTimeout(timer); if (!r.ok) throw new Error(r.status); return r.json(); });
  }

  /* Latest round, from the first host that answers. Resolves null offline. */
  function drandLatest() { return drandGet('latest'); }
  function drandRound(round) { return drandGet(String(round)); }

  function drandGet(which) {
    var i = 0;
    function next() {
      if (i >= DRAND.hosts.length) return Promise.resolve(null);
      var url = DRAND.hosts[i++] + '/' + DRAND.chain + '/public/' + which;
      return fetchWithTimeout(url, 4000).then(function (j) {
        if (!j || typeof j.round !== 'number' || !/^[0-9a-f]{64}$/.test(j.randomness)) throw new Error('bad');
        return { round: j.round, randomness: j.randomness, signature: j.signature || '' };
      }).catch(next);
    }
    return next();
  }

  /* Offline consistency: a checkpoint's clock time must be at or after its
     round's publication time, and not long after (it was fetched as
     "latest"). Online confirmation that the values are real is a separate,
     explicit step on the front page (drandConfirm). */
  function drandChecks(sessions) {
    var count = 0, bad = [];
    sessions.forEach(function (s, si) {
      if (!s.events) return;
      var t = s.start;
      s.events.forEach(function (ev) {
        t += ev[0];
        if (ev[1] !== 'r') return;
        count++;
        var rt = roundTime(ev[2]);
        if (t < rt - 30000) bad.push('økt ' + (si + 1) + ': klokkeslettet er før runden fantes');
        else if (t > rt + 10 * 60000) bad.push('økt ' + (si + 1) + ': runden er mye eldre enn klokkeslettet');
      });
    });
    return { count: count, ok: !bad.length, detail: bad.join('; ') };
  }

  /* Asks drand for every round in the log and compares. Resolves
     { checked, matched, failed: [round] , offline }. Sends round NUMBERS only. */
  function drandConfirm(sessions) {
    var rounds = [];
    sessions.forEach(function (s) {
      (s.events || []).forEach(function (ev) { if (ev[1] === 'r') rounds.push(ev); });
    });
    return Promise.all(rounds.map(function (ev) {
      return drandRound(ev[2]).then(function (r) { return r ? (r.randomness === ev[3]) : null; });
    })).then(function (res) {
      var failed = [], matched = 0, offline = 0;
      res.forEach(function (ok, i) { if (ok === true) matched++; else if (ok === false) failed.push(rounds[i][2]); else offline++; });
      return { checked: rounds.length, matched: matched, failed: failed, offline: offline };
    });
  }

  /* ------------------------------------------------------------------ */
  /* Comparing the documented text with the text that was handed in.     */
  /*                                                                      */
  /* Tolerant on purpose: case, punctuation, quote style, dashes, line    */
  /* breaks and hyphenation are ignored — Word and PDF change all of      */
  /* those. Only the WORDS are compared, in runs of SHINGLE words, so a   */
  /* paragraph moved in Word still counts as documented.                  */
  /* ------------------------------------------------------------------ */

  var SHINGLE = 4;

  /* Words with their character ranges in the ORIGINAL string, so the
     submitted text can be shown with its own formatting intact. */
  function tokens(text) {
    var out = [], re = /[\p{L}\p{N}]+/gu, m;
    while ((m = re.exec(text))) out.push({ w: m[0].normalize('NFKC').toLowerCase(), a: m.index, b: m.index + m[0].length });
    return out;
  }

  /* PDF text extraction keeps the hyphen at a line break ("skrive-\nprosess"). */
  function joinHyphenation(text) {
    return text.replace(/(\p{L})[\-­]\s*\n\s*(\p{Ll})/gu, '$1$2');
  }

  /* documented: the final text in the file; flags: its origin per char
     (Spans.flags()); submitted: the handed-in text.
     Resolves synchronously to {
       words, covered, coveredTyped, coveredPasted, percent, ...,
       marks: [{ a, b, kind: 'typed' | 'pasted' | 'missing' }] over submitted } */
  function compare(documented, flags, submitted) {
    var D = tokens(documented), S = tokens(submitted);
    var k = Math.max(1, Math.min(SHINGLE, D.length, S.length));
    var index = new Map();
    for (var i = 0; i + k <= D.length; i++) {
      var key = D.slice(i, i + k).map(function (t) { return t.w; }).join(' ');
      if (!index.has(key)) index.set(key, i);
    }
    var match = new Int32Array(S.length).fill(-1);   /* index into D, or -1 */
    var docUsed = new Uint8Array(D.length);
    for (var j = 0; j + k <= S.length; j++) {
      var key2 = S.slice(j, j + k).map(function (t) { return t.w; }).join(' ');
      var at = index.get(key2);
      if (at === undefined) continue;
      for (var x = 0; x < k; x++) {
        if (match[j + x] === -1) match[j + x] = at + x;
        docUsed[at + x] = 1;
      }
    }

    function originOf(d) {
      var t = D[d], pasted = 0, typed = 0;
      for (var c = t.a; c < t.b; c++) { if (flags[c] === 1) pasted++; else typed++; }
      return pasted > typed ? 'pasted' : 'typed';
    }

    var covered = 0, cTyped = 0, cPasted = 0, marks = [];
    for (var s = 0; s < S.length; s++) {
      var kind = match[s] === -1 ? 'missing' : originOf(match[s]);
      if (kind !== 'missing') { covered++; if (kind === 'pasted') cPasted++; else cTyped++; }
      var last = marks[marks.length - 1];
      if (last && last.kind === kind) last.b = S[s].b;
      else marks.push({ a: S[s].a, b: S[s].b, kind: kind });
    }
    var used = 0;
    for (var u = 0; u < docUsed.length; u++) used += docUsed[u];
    function pct(a, b) { return b ? Math.round(1000 * a / b) / 10 : 0; }
    return {
      words: S.length,
      covered: covered,
      coveredTyped: cTyped,
      coveredPasted: cPasted,
      percent: pct(covered, S.length),
      percentTyped: pct(cTyped, S.length),
      percentPasted: pct(cPasted, S.length),
      docWords: D.length,
      docPercentUsed: pct(used, D.length),
      marks: marks
    };
  }

  /* ------------------------------------------------------------------ */
  /* The writer's working copy, in this browser only                     */
  /*                                                                      */
  /* While writing, a session is kept RAW (plain events) so that every    */
  /* keystroke is synchronous. Sessions that came from an uploaded file   */
  /* are kept exactly as they were STORED, hashes and all. finalize()     */
  /* turns the mixed list into stored sessions for a file.                */
  /*   list entry = { stored: <session as in a file> }                    */
  /*              | { raw: { start (ms), last (ms), events: [...] } }     */
  /* ------------------------------------------------------------------ */

  function finalize(list) {
    var state = new State(''), out = [], chain = Promise.resolve();
    list.forEach(function (item, i) {
      chain = chain.then(function () {
        if (item.stored) {
          return decodeSession(item.stored).then(function (d) {
            if (d.error) throw new Error('Økt ' + (i + 1) + ': ' + d.error);
            d.events.forEach(function (ev) { state.apply(ev, i); });
            out.push(item.stored);
          });
        }
        item.raw.events.forEach(function (ev) { state.apply(ev, i); });
        var prev = out.length ? out[out.length - 1].hash : ZERO_HASH;
        return encodeSession({ n: i + 1, start: item.raw.start, prev: prev, events: item.raw.events }, state.text)
          .then(function (s) { out.push(s); });
      });
    });
    return chain.then(function () { return { sessions: out, state: state }; });
  }

  /* One document at a time, under one key. localStorage, so it never
     leaves this browser — and is gone if the browser's data is cleared,
     which is why /skriv/ keeps asking for a download. */
  var LOCAL_KEY = 'skriftspor/v1/dokument';
  var local = {
    key: LOCAL_KEY,
    load: function () {
      try { var j = localStorage.getItem(LOCAL_KEY); return j ? JSON.parse(j) : null; } catch (e) { return null; }
    },
    save: function (doc) {
      try { localStorage.setItem(LOCAL_KEY, JSON.stringify(doc)); return true; } catch (e) { return false; }
    },
    clear: function () { try { localStorage.removeItem(LOCAL_KEY); } catch (e) {} }
  };

  /* The local working copy → a complete file object. */
  function fileFromLocal(doc) {
    return finalize(doc.sessions || []).then(function (f) {
      return buildFile({ title: doc.title, closed: f.sessions, open: null, text: f.state.text });
    });
  }

  function fileName(title) {
    var base = (title || 'tekst').toLowerCase()
      .replace(/[æ]/g, 'ae').replace(/[øö]/g, 'o').replace(/[åä]/g, 'a')
      .normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'tekst';
    return base + '.spor';
  }

  /* ------------------------------------------------------------------ */

  var api = {
    FORMAT: FORMAT, VERSION: VERSION, SPEC_URL: SPEC_URL, ZERO_HASH: ZERO_HASH,
    SESSION_IDLE_MS: SESSION_IDLE_MS, ACTIVE_GAP_MS: ACTIVE_GAP_MS,
    sha256: sha256, gzip: gzip, gunzip: gunzip, b64encode: b64encode, b64decode: b64decode,
    Spans: Spans, State: State,
    encodeSession: encodeSession, decodeSession: decodeSession, sessionHash: sessionHash,
    buildFile: buildFile, replay: replay, verifyFile: verifyFile, summarize: summarize,
    countWords: countWords, fmtPct: fmtPct,
    drand: { info: DRAND, roundTime: roundTime, latest: drandLatest, round: drandRound, confirm: drandConfirm },
    compare: compare, tokens: tokens, joinHyphenation: joinHyphenation,
    finalize: finalize, local: local, fileFromLocal: fileFromLocal, fileName: fileName
  };

  root.Skriftspor = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
