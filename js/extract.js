/* ==========================================================================
   extract.js — plain text out of a handed-in document, in the browser.

     .docx / .odt   unzipped here (a ZIP reader in ~60 lines, using the
                    browser's own DecompressionStream) and the XML read
     .pdf           pdf.js, vendored under /vendor/pdfjs/ and loaded only
                    when a PDF is actually chosen (it is 1.7 MB)
     anything else  read as text

   The document never leaves the browser. Formatting is thrown away on
   purpose: the comparison is of words only (Skriftspor.compare).

   SkriftsporExtract(file) → Promise<{ text, kind, note }>
   ========================================================================== */
(function () {
  'use strict';

  /* ---- ZIP ------------------------------------------------------------- */

  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

  /* Returns { name → () => Promise<Uint8Array> }. Reads the central
     directory, so sizes are right even when local headers use data
     descriptors (Word does). */
  function unzip(bytes) {
    var eocd = -1;
    for (var i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
      if (u32(bytes, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('ikke en zip-fil');
    var count = u16(bytes, eocd + 10), at = u32(bytes, eocd + 16);
    var files = {}, utf8 = new TextDecoder();
    for (var n = 0; n < count; n++) {
      if (u32(bytes, at) !== 0x02014b50) throw new Error('skadd zip-katalog');
      var method = u16(bytes, at + 10), csize = u32(bytes, at + 20);
      var nlen = u16(bytes, at + 28), xlen = u16(bytes, at + 30), clen = u16(bytes, at + 32);
      var local = u32(bytes, at + 42);
      var name = utf8.decode(bytes.subarray(at + 46, at + 46 + nlen));
      files[name] = entry(bytes, local, method, csize);
      at += 46 + nlen + xlen + clen;
    }
    return files;
  }

  function entry(bytes, local, method, csize) {
    return function () {
      var start = local + 30 + u16(bytes, local + 26) + u16(bytes, local + 28);
      var data = bytes.subarray(start, start + csize);
      if (method === 0) return Promise.resolve(data);
      if (method !== 8) return Promise.reject(new Error('ukjent komprimering'));
      var s = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Response(s).arrayBuffer().then(function (b) { return new Uint8Array(b); });
    };
  }

  function xml(bytes) {
    var doc = new DOMParser().parseFromString(new TextDecoder().decode(bytes), 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('XML-en kan ikke leses');
    return doc;
  }

  /* ---- Word ------------------------------------------------------------- */

  var W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

  /* Paragraphs → lines. Inside a paragraph: text runs, tabs and breaks.
     Tracked deletions (w:delText) and field codes (w:instrText) are not
     text the reader sees, so they are skipped. */
  function docxText(doc) {
    var out = [];
    var paras = doc.getElementsByTagNameNS(W, 'p');
    for (var i = 0; i < paras.length; i++) {
      var line = '';
      walk(paras[i]);
      out.push(line);
    }
    return out.join('\n');

    function walk(node) {
      for (var c = node.firstChild; c; c = c.nextSibling) {
        if (c.nodeType !== 1) continue;
        if (c.namespaceURI === W) {
          if (c.localName === 't') { line += c.textContent; continue; }
          if (c.localName === 'tab') { line += '\t'; continue; }
          if (c.localName === 'br' || c.localName === 'cr') { line += '\n'; continue; }
          if (c.localName === 'p') continue;          /* nested (text box) — counted on its own */
          if (c.localName === 'delText' || c.localName === 'instrText') continue;
        }
        walk(c);
      }
    }
  }

  function fromDocx(bytes) {
    var files = unzip(bytes);
    if (!files['word/document.xml']) throw new Error('fant ikke selve dokumentet i fila');
    return files['word/document.xml']().then(function (b) {
      return { text: docxText(xml(b)), kind: 'Word-dokument', note: 'Fotnoter, topptekst og bunntekst er ikke med.' };
    });
  }

  /* ---- OpenDocument ----------------------------------------------------- */

  var TEXT_NS = 'urn:oasis:names:tc:opendocument:xmlns:text:1.0';
  function fromOdt(bytes) {
    var files = unzip(bytes);
    if (!files['content.xml']) throw new Error('fant ikke content.xml');
    return files['content.xml']().then(function (b) {
      var doc = xml(b), out = [];
      var nodes = doc.querySelectorAll('*');
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        if (n.namespaceURI === TEXT_NS && (n.localName === 'p' || n.localName === 'h')) out.push(n.textContent);
      }
      return { text: out.join('\n'), kind: 'OpenDocument-tekst', note: '' };
    });
  }

  /* ---- PDF -------------------------------------------------------------- */

  function fromPdf(bytes) {
    return import('/vendor/pdfjs/pdf.min.mjs').then(function (pdfjs) {
      pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
      return pdfjs.getDocument({ data: bytes, isEvalSupported: false }).promise;
    }).then(function (pdf) {
      var pages = [];
      for (var p = 1; p <= pdf.numPages; p++) pages.push(p);
      return Promise.all(pages.map(function (n) {
        return pdf.getPage(n).then(function (page) { return page.getTextContent(); }).then(function (tc) {
          return tc.items.map(function (it) { return it.str + (it.hasEOL ? '\n' : ''); }).join('');
        });
      })).then(function (texts) {
        return {
          text: window.Skriftspor.joinHyphenation(texts.join('\n')),
          kind: 'PDF',
          note: 'Tekst fra PDF kan få med sidetall og topptekst. De vises som udokumentert.'
        };
      });
    });
  }

  /* ---- Plain text ------------------------------------------------------- */

  function fromText(bytes) {
    var text = new TextDecoder('utf-8').decode(bytes);
    if (text.indexOf('�') !== -1) text = new TextDecoder('windows-1252').decode(bytes);
    return Promise.resolve({ text: text.replace(/^﻿/, ''), kind: 'tekstfil', note: '' });
  }

  function extract(file) {
    return file.arrayBuffer().then(function (buf) {
      var bytes = new Uint8Array(buf);
      var name = (file.name || '').toLowerCase();
      var isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
      var isPdf = bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
      if (isPdf) return fromPdf(bytes);
      if (isZip && /\.odt$/.test(name)) return fromOdt(bytes);
      if (isZip) return fromDocx(bytes);
      if (/\.doc$/.test(name)) throw new Error('det gamle Word-formatet (.doc) kan ikke leses. Lagre som .docx eller PDF');
      return fromText(bytes);
    });
  }

  window.SkriftsporExtract = extract;
})();
