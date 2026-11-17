# iframe-agent

Een MCP-server waarmee een agent (Claude Code) **elke iframe-app** in Chrome kan zien, bedienen en controleren. Ook cross-origin iframes en iframes op volledig scherm werken.

## Wat hij oplost

| Probleem | Oplossing |
|---|---|
| De snapshot stopt bij de iframe-rand | `snapshot` leest **alle frames** uit, met refs als `f1:e3` |
| Eigen players negeren scriptklikken | `act` gebruikt **echte** muis- en toetsenbordinvoer (via CDP, `isTrusted = true`) |
| Vectorvormen hebben geen knoprol | Elementen met een klikcursor worden meegenomen als `clickable` |
| Onzichtbare bedieningslaag over getekende opties (zoals Storyline) | Staat standaard in de snapshot als `(onzichtbare laag)`. Dat zijn de echte klikdoelen voor `act` |
| Niet weten of een klik werkte | Elk `act` meldt **wat er veranderde**: tekst, de status van alle checkboxen en radio's, en anders "MOGELIJK VERANDERD (alleen visueel)". `verify` controleert een beoogde uitkomst |
| App pauzeert of stopt bij focusverlies | Chrome start met flags tegen achtergrondvertraging, en de pagina krijgt focus-emulatie. `verify noPause` bewijst dat het werkt |
| Screenshots lopen vast | Een uitsnede van alleen het frame, als JPEG, met een harde timeout van 6 s |

## Starten

```bash
npm install
```

```bash
npm run demo
```

Laat dit terminalvenster open. Start in een tweede terminal:

```bash
npm run chrome
```

- `npm run demo` start de demo-portaalpagina op `http://localhost:5173`, met een weerapp op `127.0.0.1:5174` in een iframe.
- `npm run chrome` start een aparte Chrome met CDP op poort 9222. Het profiel staat in `%LOCALAPPDATA%\iframe-agent\chrome-profile`. Inloggen op sites doe je één keer; dat blijft bewaard.
- Open daarna Claude Code in deze map. Het bestand `.mcp.json` registreert de server `iframe-agent`. Keur hem goed als Claude Code erom vraagt. Was de sessie al open, start hem dan opnieuw.

## Handmatige demo

1. Open in de gestarte Chrome `http://localhost:5173`. Klik op **Volledig scherm**, of laat de agent dat doen.
2. Ga terug naar Claude Code. Chrome verliest dan de focus. Vraag bijvoorbeeld:
   > Kies Utrecht in de weerapp, ga naar morgen en controleer dat de temperatuur voor morgen zichtbaar is en dat de app niet gepauzeerd is.
3. Wat je zou moeten zien: de agent gebruikt `snapshot`, `act` (op `clickable "Utrecht"` en daarna `"Volgende dag"`) en `verify`. Hij meldt **GESLAAGD**. In Chrome blijft de klok "Looptijd" lopen. Zou de app pauzeren, dan zie je in rood "Gepauzeerd".
4. Controle op de opzet: de tegels in deze app negeren bewust scriptklikken, net als veel players. Alleen echte invoer werkt.

## Op een eigen iframe-app

Open de app in **dezelfde** Chrome (die van `npm run chrome`) en geef de agent een opdracht. Handig om te weten:

- Kies met `tabs` de juiste tab als er meer tabs open zijn.
- Ontbreekt een knop? Probeer `snapshot` met `hidden: true` (toont ook elementen zonder afmeting) of met een hogere `max`.
- Doet een klik niets? Gebruik dan het toetsenbord (`press` Tab, Space of Enter), `screenshot` van het frame, of `click_xy`.

## Tools

`tabs`, `open`, `frames`, `snapshot`, `act` (click, dblclick, hover, fill, type, press, select, check, uncheck, focus), `click_xy`, `press`, `screenshot`, `verify` (text, textGone, ref+refHas/refLacks, url, noPause), `app_events`.

## Tests

```bash
npm test
```

De tests gebruiken een onzichtbare (headless) Chrome tegen de demo. Ze controleren:

- het uitlezen van de cross-origin iframe;
- dat scriptklikken genegeerd worden en echte klikken werken;
- invullen en het toetsenbord;
- volledig scherm;
- geen pauzes;
- de screenshot.

## Grenzen van deze eerste versie

- **Wisselen van tab verbergt de pagina.** Dat kan geen enkele instelling voorkomen. Houd de app-tab dus actief. Een ander venster op de voorgrond of naar Claude Code gaan is geen probleem.
- **Knoppen die een nieuwe tab openen** (zoals "Theorie" met een PDF) zetten de app-tab naar de achtergrond. Chrome rendert de app dan niet meer, en screenshots hangen. `act` meldt zo'n nieuwe tab; met `tabs` en `close=<index>` sluit de agent hem, en de app-tab komt weer vooraan.
- **Apps die volledig in een `<canvas>` tekenen** hebben geen elementen om uit te lezen. Gebruik daar `screenshot` en `click_xy`.
- **Gesloten shadow-DOM** is niet uit te lezen.
