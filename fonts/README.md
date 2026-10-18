# Fonts

Self-hosted since 2026-09-26, so that loading a page no longer sends the visitor's IP address to
Google. The files are the latin and latin-ext subsets Google Fonts serves, copied once and not
modified. `css/fonts.css` declares them.

| Files | Typeface | Licence |
|---|---|---|
| `inter-*.woff2` | Inter (variable, weights 400–700 used) | SIL OFL 1.1 — [OFL-Inter.txt](OFL-Inter.txt) |
| `charis-sil-*.woff2` | Charis SIL 400, 400 italic, 700 | SIL OFL 1.1 — [OFL-CharisSIL.txt](OFL-CharisSIL.txt) |

To add a weight: fetch the Google Fonts CSS for it with a modern browser user agent, download the
latin and latin-ext `.woff2` files it points at, and add matching `@font-face` blocks to
`css/fonts.css`. Don't import from fonts.googleapis.com again — `/personvern/` says the site doesn't.
