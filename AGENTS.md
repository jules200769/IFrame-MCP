# AGENTS.md — iframe-agent

Context voor agents die verder werken aan dit project. Houd dit bestand bij: zet nieuwe beslissingen, bevindingen en open punten erin. De gebruikersinstructies staan in `README.md`.

## Doel

Een agent (Claude Code) moet **elke app in een iframe** in Chrome kunnen **zien, bedienen en controleren**. Dat moet ook werken bij cross-origin iframes, bij iframes op volledig scherm en bij eigen players zoals Articulate Storyline. De app mag daarbij **niet sluiten of pauzeren**.

Dit is "probleem 1" van de gebruiker. "Probleem 2" — een agentvenster of overlay dat altijd boven een fullscreen-iframe beschikbaar is — valt bewust **buiten scope** van deze versie.

Het oorspronkelijke probleem werd gevonden in LearningBox (portal.learningbox.nl), met een SCORM-les van Storyline in een iframe:

- de snapshot van de vorige tool stopte bij de iframe-rand;
- scriptklikken (`isTrusted=false`) werkten niet;
- screenshots liepen vast;
- echte invoer via CDP was geblokkeerd.

## Grens die je moet aanhouden

LearningBox bevat **toetsen**. Laat de agent geen toetsantwoorden kiezen of indienen voor de gebruiker. Ook niet bij "kies het juiste antwoord".

- **Wel:** uitlezen, navigeren, uitleg geven, en een optie aanvinken die de gebruiker **zelf** noemt.
- **Testen** van het prototype: gebruik de demo-app, een les zonder toets, of een element dat geen antwoord is (zoals de knop "Theorie").
- Help ook niet met het omzeilen van focus- of toetsbeveiliging.

## Architectuur

Claude Code ↔ **MCP-server (stdio, `src/server.js`)** ↔ Playwright-core `connectOverCDP` ↔ **eigen Chrome** (poort 9222, gestart door `scripts/start-chrome.js`).

| Bestand | Rol |
|---|---|
| `scripts/start-chrome.js` | Start Chrome met CDP en flags tegen achtergrondvertraging. Profiel staat in `%LOCALAPPDATA%\iframe-agent\chrome-profile`, buiten OneDrive |
| `src/browser.js` | `Session`: koppelen, kiezen van tabs, stabiele frame-ids (`f0` = hoofdpagina), focus-emulatie per pagina en per OOPIF, injecteren van de helper, `call(frame, method)` |
| `src/injected.js` | Helper die in elk frame draait (`window.__iframeAgent`). Bevat: verzamelen van elementen, refs in een Map (zonder de DOM aan te passen), fingerprint, events, `attrHash`. Heeft een **versie** (hash van de broncode) |
| `src/snapshot.js` | Voegt alle frames samen tot één lijst met refs `fN:eM` en viewport-coördinaten. Hier zitten ook de formatters |
| `src/actions.js` | `act`, `clickXY`, `press`, `screenshot`. Elke actie loopt via `withOutcome`: baseline → actie → wachten tot de pagina stil is → diff, plus pauze-events en nieuwe tabs |
| `src/verify.js` | Fingerprints, `volatileKeys` (tekst en attributen die vanzelf veranderen), `diffFingerprints` (`changed` / `maybe`), `verify` met polling |
| `demo/` | Portaalpagina op `localhost:5173` met een weerapp van `127.0.0.1:5174` in een iframe. Doordat het twee verschillende sites zijn, draait de iframe in een eigen proces (OOPIF). De weerapp bootst lastige gevallen na (zie Tests) |
| `.mcp.json` | Registreert de server `iframe-agent` |

MCP-tools: `tabs` (select, front, close), `open`, `frames`, `snapshot` (frame, max, hidden), `act`, `click_xy`, `press`, `screenshot`, `verify` (text, textGone, ref+refHas/refLacks, url, noPause), `app_events` (reset).

## Commando's

```bash
npm install
npm test          # node --test, headless Chrome tegen de demo (19 tests)
npm run demo      # demo-servers 5173/5174
npm run chrome    # eigen Chrome met CDP 9222 (blijft draaien)
```

Een nieuwe of gewijzigde MCP-server is pas actief in een **nieuwe chat**. Een chat houdt de serverversie van het moment waarop hij startte. Code die in `src/` verandert, test je in deze chat dus alleen met `npm test`.

## Belangrijke beslissingen en waarom

- **Echte invoer via CDP.** Playwright-`click`, `page.mouse` en `keyboard` geven `isTrusted=true`. Players negeren `dispatchEvent` en het aanpassen van `.checked`.
- **Een onzichtbare of bedekte control krijgt direct een klik op zijn midden.** Zie `coveredOrInvisible` in `actions.js`. Playwright wacht anders 2,5 s op actionability en klikt pas daarna.
- **Onzichtbare laag:** semantische elementen met een echte afmeting en `opacity: 0` staan standaard in de snapshot als `(onzichtbare laag)`. Dat is Storyline's toegankelijkheidslaag over de getekende opties, en dat zijn de echte klikdoelen. Elementen die op een andere manier verborgen zijn, staan er alleen in met `hidden=true`, met de reden erbij (`geen afmeting`, `display`, `visibility` of `opacity`).
- **Uitkomstdetectie:**
  - verandering in tekst, URL, volledig scherm of formaat, of de status van **alle** checkboxen en radio's (ook zonder eerdere snapshot) → `VERANDERD`;
  - alleen attributen veranderd → `MOGELIJK VERANDERD (alleen visueel)`, met het advies een screenshot te maken en niet meteen opnieuw te klikken;
  - focus alleen telt niet als verandering, en `value="on"` bij checkboxen wordt weggelaten.
- **Volatile filtering:** twee fingerprints met 180 ms ertussen bepalen welke regels of attributen vanzelf veranderen (klokken, animaties). Die tellen niet mee.
- **Nooit pauzeren:**
  - Chrome-flags `--disable-backgrounding-occluded-windows`, `--disable-renderer-backgrounding`, `--disable-background-timer-throttling` en `--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling`;
  - `Emulation.setFocusEmulationEnabled` per pagina en per OOPIF;
  - `focus-into-iframe` (de focus gaat naar een kind-frame) telt niet als pauze, `window-blur` wel.
- **Versie van de helper:** de helper blijft in een open pagina staan, ook na een nieuwe chat. Een andere versie ruimt de oude op (`dispose`) en vervangt hem. Zonder dit draaide LearningBox nog oude code.
- **Nieuwe tabs:** `act` meldt het als een actie een tab opent. Een tab die niet vooraan staat, wordt niet gerenderd (de screenshot hangt). Herstel met `tabs close=N` of `front=true`.
- **Screenshot:** `Page.captureScreenshot` met een uitsnede van het frame of element, als JPEG, met een harde time-out van 6 s.

## Bevindingen in LearningBox / Storyline (getest op 2026-11-17)

- De les draait in frame `.../course_items/<id>/scorm/index_lms.html`. Die is same-origin met het portaal. Boven de iframe zitten de portalknoppen ("Inleveren", fullscreen).
- De antwoordopties zijn radio's of checkboxen in de onzichtbare laag. Hun labels kwamen overeen met de zichtbare tekst en de volgorde op het scherm. De volgorde kan bij een herstart van de dia wisselen; ga dus altijd uit van een verse snapshot.
- De knop "indienen" is een zichtbare button. In de verborgen laag staan ook knoppen zoals Volgende/Vorige (0x0), Juist/Onjuist en de mediabediening.
- De knop "Theorie" ("Group 8") opent een PDF in een **nieuwe tab**. Daardoor liepen screenshots vast. Waarschijnlijk was dit ook de oorzaak van de oorspronkelijke time-outs.
- `verify noPause` slaagde in alle runs: de les pauzeerde niet terwijl de gebruiker in Claude zat.

## Tests (de demo dekt deze gevallen)

- de snapshot ziet de cross-origin iframe;
- scriptklik genegeerd, echte klik werkt;
- invullen, toetsenbord;
- checkbox in een onzichtbare laag (`#feelacc`) → `VERANDERD [checked]`;
- alleen een SVG-wijziging (`#fav`) → `maybe`;
- een verouderde helper wordt vervangen;
- geen pauzes;
- volledig scherm;
- een link naar een nieuwe tab wordt gemeld;
- screenshot als JPEG.

Bouw een nieuw geval eerst na in `demo/app.html` en voeg er een test voor toe.

## Open punten / ideeën

- Apps die volledig in `<canvas>` tekenen: alleen `screenshot` en `click_xy`. Een vision-hulp zou hier kunnen helpen.
- Gesloten shadow-DOM is niet uit te lezen.
- De helper draait in de main world van de pagina. Een isolated world zou netter zijn.
- Probleem 2 (een overlay of agentvenster dat altijd beschikbaar is) is nog niet gebouwd. Ideeën uit het gesprek: een browserextensie met `chrome.debugger`, of een Electron-shell met de agent ingebouwd.
- Er is nog niets gecommit (de repo heeft geen commits en geen remote).
