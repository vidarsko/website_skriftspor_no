# Spor-fila — filformat, versjon 1

Spor-fila fra [skriftspor.no](https://skriftspor.no) er åpen og dokumentert, slik at hvem som helst kan lese den og lage sin egen verifikator. Referanseimplementasjonen er [`js/skriftspor.js`](js/skriftspor.js), lesbar JavaScript uten avhengigheter. Der koden og denne beskrivelsen er uenige, er det en feil.

## Oversikt

Fila er UTF-8-kodet JSON, og navnet slutter på `.spor`. Øverst står et kort sammendrag og hele slutteksten i klartekst, så teksten overlever selv om loggen skades. Selve loggen er delt i økter. Hver økt er komprimert for seg og har egne sjekksummer, så skade i én økt ikke ødelegger de andre.

```json
{
  "format": "skriftspor",
  "version": 1,
  "spec": "https://skriftspor.no/om/#filformat",
  "readme": "Dette er en spor-fil fra skriftspor.no …",
  "title": "Min tekst",
  "summary": { "…": "…" },
  "text": "Hele slutteksten …",
  "text_sha256": "…",
  "head": "<hash for siste økt>",
  "sessions": [ { "…": "…" } ]
}
```

## Sammendraget (`summary`)

Ment for mennesker som åpner fila i et tekstprogram. Det regnes ut fra loggen når fila lages, men en leser skal ikke stole på det: regn det ut på nytt fra loggen.

Feltene er `first_event`, `last_event`, `sessions`, `active_minutes` (pauser over to minutter teller som to minutter), `events`, `final_chars`, `final_words`, `final_typed_chars`, `final_pasted_chars`, `final_unknown_chars`, `final_typed_percent`, `final_pasted_percent`, `typed_chars_total`, `pasted_chars_total`, `deleted_chars_total`, `pastes`, `drand_checkpoints` og `description`, som er én setning på norsk.

## En økt (`sessions[i]`)

```json
{
  "n": 1,
  "start": "2026-10-18T10:00:00.000Z",
  "end": "2026-10-18T10:42:13.512Z",
  "events": 1834,
  "prev": "000…000",
  "log_sha256": "…",
  "text_end_sha256": "…",
  "hash": "…",
  "data_sha256": "…",
  "data": "H4sIAAAAAAAA…"
}
```

| Felt | Betydning |
|---|---|
| `n` | Øktnummer, fra 1. |
| `start`, `end` | Tidspunkt for første og siste hendelse (ISO 8601, UTC). |
| `events` | Antall hendelser i loggen. |
| `data` | Loggen: en JSON-liste med hendelser, gzip-komprimert og base64-kodet. |
| `data_sha256` | SHA-256 av de komprimerte bytene. Fanger opp skade før utpakking. |
| `log_sha256` | SHA-256 av den utpakkede JSON-teksten. |
| `text_end_sha256` | SHA-256 av hele teksten slik den var etter økta. |
| `prev` | Forrige økts `hash`. For den første økta: 64 nuller. |
| `hash` | Øktas lenke i hash-kjeden. |

En ny økt begynner etter mer enn 30 minutters pause, eller når fila lastes opp igjen for å skrive videre.

### Hash-kjeden

`hash` er SHA-256 (heksadesimalt, små bokstaver) av disse åtte verdiene, skilt med linjeskift (`\n`):

```
skriftspor/1
<n>
<start>
<end>
<events>
<prev>
<log_sha256>
<text_end_sha256>
```

De komprimerte bytene er ikke med, fordi to riktige gzip-programmer kan gi ulike bytes for samme logg. Feltet `head` øverst i fila er den siste øktas `hash`.

Kjeden gjør det synlig hvis en tidligere økt endres uten at alt etter den regnes ut på nytt. Den kan ikke hindre at noen lager en helt ny, falsk fil, fordi det ikke finnes noen hemmelig nøkkel. Det er et bevisst valg: alt skjer hos brukeren.

## Hendelsene

En hendelse er en kort liste. Første element er alltid antall millisekunder siden forrige hendelse i samme økt (0 for den første). Tidspunktet for en hendelse er `start` pluss summen av alle tidsforskjellene fram til og med den.

| Hendelse | Betydning |
|---|---|
| `[dt, "i", pos, "tekst", fmt]` | Tekst skrevet inn ved posisjon `pos`. `fmt` er valgfri, se under. |
| `[dt, "p", pos, "tekst", fmt]` | Tekst limt inn eller dratt inn ved `pos`. Også tekst som kom inn i feltet uten å være tastet, for eksempel fra et nettlesertillegg. |
| `[dt, "d", pos, "tekst"]` | «tekst» ble slettet, fra posisjon `pos`. Den slettede teksten lagres, så loggen kan spilles både fram og tilbake. |
| `[dt, "c", start, slutt]` | Markøren ble flyttet eller tekst merket. Like tall betyr en markør uten merking. |
| `[dt, "f", a, b, bits, på]` | Formatering slått på (`på` = 1) eller av (0) for tegnene fra `a` til (ikke med) `b`. Teksten endres ikke. |
| `[dt, "r", runde, tilfeldighet, signatur]` | Et sjekkpunkt fra drand, se under. |

**Posisjoner teller UTF-16-kodeenheter**, slik JavaScript-strenger og nettleserens tekstfelt gjør. En leser i et annet språk må gjøre det samme, ellers vil for eksempel en emoji forskyve alle posisjoner etter den med én.

Å bytte ut merket tekst gir to hendelser med samme tidspunkt: en sletting, så en innsetting.

### Formatering

Formatering er ikke en del av teksten. Den er et sett biter per tegn: `1` fet, `2` kursiv, `4` understreket og `8` overskrift. Overskrift settes på alle tegnene i en linje, og en linje er en overskrift hvis det første tegnet har biten. Nye tegn får bitene i `fmt` på innsettingen (mangler den, er den 0). `"f"`-hendelser endrer bitene for et område.

En leser som bare trenger teksten, kan overse `fmt` og `"f"`-hendelser helt. `text` er alltid ren tekst uten formateringstegn.

### Å spille av

Start med tom tekst og bruk hendelsene i rekkefølge, økt for økt. Etter hver økt skal SHA-256 av teksten være lik `text_end_sha256`, og etter siste økt skal teksten være lik `text`. En sletting av tekst som ikke står der, betyr at loggen er skadd eller endret.

**Skade holdes lokal.** Kan en økt ikke leses, kan de neste likevel gjenskapes: start med `text` og spill de senere øktene baklengs (en innsetting fjernes, en sletting settes inn igjen). Da får du teksten slik den var i starten av hver økt etter den skadde.

## Sjekkpunkter fra drand

[drand](https://drand.love) publiserer et nytt, uforutsigbart tall hvert tredje sekund. Skriftspor bruker kjeden *quicknet*:

```
kjede:  52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971
start:  1692803367 (Unix-tid), periode 3 sekunder
runde r publiseres ved  1692803367 + (r − 1) · 3
```

Mens det skrives, henter siden siste runde ved starten av hver økt og deretter omtrent hvert femte minutt med skriving, og legger den inn som en `"r"`-hendelse. Fordi verdien er med i loggen, og loggen er med i hash-kjeden, kan økta ikke ha blitt laget før runden ble publisert.

En leser bør sjekke at hendelsens tidspunkt ikke er før rundens publiseringstid, og ikke mye senere (den ble hentet som «siste»). For å bekrefte at verdien er ekte, kan man hente `https://api.drand.sh/<kjede>/public/<runde>` og sammenligne `randomness`, eller verifisere BLS-signaturen.

Sjekkpunktene beviser «ikke før», og ingenting mer. De sier ingenting om hvem som skrev, eller hvordan.

## Sammenligning med innlevert tekst

Ikke en del av formatet, men slik gjør skriftspor.no det: begge tekstene deles i ord (bokstaver og tall, Unicode NFKC, små bokstaver), og et ord i den innleverte teksten regnes som dokumentert hvis det inngår i en sekvens på fire ord som også finnes i slutteksten. Tegnsetting, formatering og rekkefølgen på avsnittene teller ikke.

## Versjoner

Feltet `version` økes hvis formatet endres slik at en eldre leser ville misforstå fila. Nye felt som eldre lesere trygt kan overse, gir ikke ny versjon.
