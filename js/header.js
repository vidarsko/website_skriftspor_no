/* ==========================================================================
   header.js — the site header bar, rendered for every page.

   The same component as on aiskilltrees.com (wordmark, nav, a drawer below
   768px), minus the language dropdown: the site is Norwegian only for now.
   When Swedish arrives, the dropdown and js/i18n.js come over from
   aiskilltrees.com as they are — the labels below are already keyed by
   language so that nothing here has to be rewritten.

   A page needs only <header class="siteheader" data-site-header></header>.
   ========================================================================== */
(function () {
  'use strict';

  var LANG = 'nb';

  /* The site's pages. Adding one is a line here — nothing else. */
  var NAV = [
    { href: '/skriv/',  label: { nb: 'Skriv',          sv: 'Skriv' } },
    { href: '/om/',     label: { nb: 'Slik virker det', sv: 'Så fungerar det' } },
    { href: '/format/', label: { nb: 'Filformatet',    sv: 'Filformatet' } }
  ];

  var UI = {
    menu: { nb: 'Meny',      sv: 'Meny' },
    main: { nb: 'Hovedmeny', sv: 'Huvudmeny' }
  };

  var host = document.querySelector('[data-site-header]');
  if (!host) return;

  function txt(entry) { return entry[LANG] || entry.nb; }

  function isCurrent(href) {
    return location.pathname.indexOf(href) === 0;
  }

  function el(tag, cls) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    return n;
  }

  var inner = el('div', 'siteheader__inner');

  var mark = el('a', 'wordmark');
  mark.href = '/';
  mark.innerHTML = '<span class="wordmark__mark" aria-hidden="true">&#9679;</span>Skriftspor';
  inner.appendChild(mark);

  var toggle = el('button', 'navtoggle');
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', 'sitenav-panel');
  toggle.setAttribute('aria-label', txt(UI.menu));
  toggle.innerHTML = '<span class="navtoggle__bars" aria-hidden="true"></span>';
  inner.appendChild(toggle);

  var panel = el('div', 'sitenav-panel');
  panel.id = 'sitenav-panel';
  var nav = el('nav', 'sitenav');
  nav.setAttribute('aria-label', txt(UI.main));
  NAV.forEach(function (item) {
    var a = el('a');
    a.href = item.href;
    a.textContent = txt(item.label);
    if (isCurrent(item.href)) {
      a.classList.add('is-current');
      a.setAttribute('aria-current', 'page');
    }
    nav.appendChild(a);
  });
  panel.appendChild(nav);
  inner.appendChild(panel);
  host.appendChild(inner);

  function setDrawer(open) {
    host.setAttribute('data-open', open ? 'true' : 'false');
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  toggle.addEventListener('click', function () {
    setDrawer(host.getAttribute('data-open') !== 'true');
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && host.getAttribute('data-open') === 'true') { setDrawer(false); toggle.focus(); }
  });
  document.addEventListener('click', function (e) {
    if (!host.contains(e.target)) setDrawer(false);
  });
})();
