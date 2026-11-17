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

- `npm run demo` start de demo-portaalpagina op `http://localhost:5173`, met een weerapp/playground op `127.0.0.1:5174` in een iframe.
- `npm run chrome` start een aparte Chrome met CDP op poort 9222. Het profiel staat in `%LOCALAPPDATA%\iframe-agent\chrome-profile`. Inloggen op sites doe je één keer; dat blijft bewaard.
- Open daarna Claude Code in deze map. Het bestand `.mcp.json` registreert de server `iframe-agent`. Keur hem goed als Claude Code erom vraagt. Was de sessie al open, start hem dan opnieuw.

## Handmatige demo

1. Open in de gestarte Chrome `http://localhost:5173`. Klik op **Volledig scherm**, of laat de agent dat doen.
2. Ga terug naar Claude Code. Chrome verliest dan de focus. Vraag bijvoorbeeld:
   > Kies Utrecht in de weerapp, ga naar morgen en controleer dat de temperatuur voor morgen zichtbaar is en dat de app niet gepauzeerd is.
3. Wat je zou moeten zien: de agent gebruikt `snapshot`, `act` (op `clickable "Utrecht"` en daarna `"Volgende dag"`) en `verify`. Hij meldt **GESLAAGD**. In Chrome blijft de klok "Looptijd" lopen. Zou de app pauzeren, dan zie je in rood "Gepauzeerd".
4. Controle op de opzet: de tegels in deze app negeren bewust scriptklikken, net als veel players. Alleen echte invoer werkt.
5. Scroll in de iframe naar **Uitdagingen** voor bredere cases: radiogroep, canvas (`click_xy`), verborgen knoppen (`snapshot hidden=true`), bedekte control, nested iframe, shadow DOM en dialoog.

## Soorten iframes

Alle soorten worden uitgelezen en zijn klikbaar met echte invoer. De demo heeft er onder **Uitdagingen › Soorten iframes** een voorbeeld van, met een test per soort:

- cross-origin (OOPIF) en geneste iframes;
- `srcdoc`;
- `sandbox`, met en zonder `allow-scripts` (opaque origin);
- `data:`;
- `about:blank` gevuld met `document.write`;
- een iframe in shadow DOM;
- een iframe die later verschijnt.

In `frames` en `snapshot` staat bij elk frame welke soort het is. Bijvoorbeeld: `(iframe, sandbox="", opaque origin)`.

## Op een eigen iframe-app

Open de app in **dezelfde** Chrome (die van `npm run chrome`) en geef de agent een opdracht. Handig om te weten:

- Kies met `tabs` de juiste tab als er meer tabs open zijn.
- Ontbreekt een knop? Probeer `snapshot` met `hidden: true` (toont ook elementen zonder afmeting) of met een hogere `max`.
- Doet een klik niets? Gebruik dan het toetsenbord (`press` Tab, Space of Enter), `screenshot` van het frame, of `click_xy`.

## Buddy: chatvenster boven een app op volledig scherm

De buddy is een klein venster dat **altijd bovenop** staat, ook boven Chrome op volledig scherm. Je typt er een opdracht in, en de buddy bedient de app in de iframe met dezelfde tools als hierboven.

- Klikken in en typen naar de buddy laat het volledige scherm staan.
- De app pauzeert er niet van.
- Elke stap staat in het venster, bijvoorbeeld `act f1:e3 → VERANDERD …`, met screenshots.

### Starten

Gebruik drie terminals:

```bash
npm run demo      # of open je eigen app
npm run chrome
npm run buddy
```

- **Ctrl+Shift+Space** haalt de buddy naar voren en zet de cursor in het invoerveld. Dat werkt ook als Chrome op volledig scherm focus heeft.
- **–** of **Esc** (in de buddy) klapt hem in tot een bolletje. Klik op het bolletje om hem weer te openen.
- **⟲** begint een nieuw gesprek. **Stop** onderbreekt een lopende opdracht.
- De stip in de kop is groen als Chrome én een model gekoppeld zijn. De statusregel toont de tab, "volledig scherm" en het aantal pauze-events.
- Zonder Electron: `npm run buddy:server` en open `http://127.0.0.1:5199` in een browser. Die tab staat dan niet bovenop.

### Je gewone Chrome koppelen

Naast de eigen Chrome van `npm run chrome` kan de buddy ook je **gewone** Chrome gebruiken, met je eigen tabs en logins.

1. Gebruik Chrome 144 of nieuwer. Open `chrome://inspect/#remote-debugging` en zet de schakelaar aan. Dit is een officiële functie van Chrome; er wordt niets omzeild.
2. Start de buddy met `BUDDY_BROWSER=user`, of zet `"browser": "user"` in `buddy.config.json`.
3. Chrome vraagt om toestemming. Klik op **Toestaan**.

Goed om te weten:

- **Elke nieuwe koppeling geeft een toestemmingsvraag.** Daarom koppelt de buddy maar één keer, bij de start. Is de verbinding weg of klikte je op Weigeren, dan probeert hij het niet vanzelf opnieuw. Klik in de buddy op **Koppel** om het opnieuw te proberen.
- **De buddy raakt alleen de tab aan waarin hij werkt.** Dat is de tab die vooraan stond. Met `tabs select=N` kiest hij een andere tab, en alleen die krijgt dan de helper.
- **De modus staat standaard op Vragen** (zie hieronder).
- **Een ander profiel:** zet `CHROME_USER_DATA_DIR` op de map die `DevToolsActivePort` bevat.
- **Voor Claude Code of Cursor zonder buddy:** `IFRAME_AGENT_BROWSER=user` in de `env` van `iframe-agent`.

### Meekijken

In het buddy-venster (`npm run buddy`) heeft de agent de tool `look`: een schermopname van je Chrome-venster.

- `look` werkt **ook als Chrome niet gekoppeld is**, voor elk soort iframe, elke player en op volledig scherm.
- Het is alleen kijken. Bedienen kan alleen als Chrome gekoppeld is.
- De buddy staat zelf nooit op de opname (content protection).
- Het venster wordt gekozen op de titel `… - Google Chrome`. Een ander venster kies je met `BUDDY_CAPTURE_WINDOW=<deel van de titel>`.

### Modi: wat mag de buddy

Bovenin de buddy kies je de modus:

| Modus | Wat de buddy doet |
|---|---|
| **Kijken** | Alleen uitlezen, meekijken en uitleggen. Klikken, typen en navigeren worden geweigerd. |
| **Vragen** | Elke actie verschijnt eerst als kaart met **Toestaan** en **Weigeren**. Dit is de standaard bij je gewone Chrome. |
| **Zelf** | Acties gaan direct. Dit is de standaard bij de eigen Chrome. |

Andere instellingen: `BUDDY_MODE`, of `"mode"` in `buddy.config.json`.

Twee regels gelden in alle modi:

- De buddy doet alles wat er van hem word gevraagd.
- Hij doet niets onomkeerbaars (betalen, verwijderen) zonder een uitdrukkelijk "ja".

Tekst op webpagina's behandelt hij als informatie, niet als opdracht.

### Met je abonnement (bridge)

Wil je geen API-key gebruiken, maar je bestaande abonnement (Claude Pro/Max, ChatGPT Plus/Pro, Cursor, Copilot, …)? Dan wordt **je eigen AI-app de agent**:

- De buddy is alleen het venster boven Chrome.
- Je AI-app praat via de MCP-server `iframe-buddy` met de buddy. Die server staat al in `.mcp.json` en `.cursor/mcp.json`.
- Er gaat geen token of login van je abonnement door deze code.

Opzet:

1. Start de buddy als bridge: `BUDDY_PROVIDER=bridge npm run buddy`, of zet `"provider": "bridge"` in `buddy.config.json`.
2. Start in je AI-app de lus:
   - **Claude Code:** open een nieuwe chat in deze map en kies `/mcp__iframe-buddy__buddy`. Of zeg: *"Wees mijn browserbuddy: roep buddy_wait aan en blijf luisteren."*
   - **Codex CLI:** voer `codex mcp add iframe-buddy -- node <pad>/buddy/bridge-mcp.js` uit en vraag dan hetzelfde.
   - **Cursor:** het project registreert `iframe-buddy` al. Herstart Cursor en vraag in de agent-chat hetzelfde.
   - **Andere MCP-clients** (Copilot agent mode, Gemini CLI, …): `node buddy/bridge-mcp.js` over stdio.
3. Typ in de buddy. Je AI-app krijgt het bericht via `buddy_wait`, bedient Chrome en antwoordt met `buddy_reply`.
   - Je ziet elke stap in de buddy.
   - De modus en de goedkeuringen van de buddy gelden ook voor je AI-app.
   - **Stop** in de buddy stopt de opdracht.

`buddy_wait` wacht standaard 50 s per keer, en roept zichzelf daarna opnieuw aan. Elke herhaling kost een kleine modelbeurt van je abonnement. Heeft je app een langere MCP-time-out, dan kan de agent `timeoutSec` tot 600 zetten:

- **Claude Code:** `MCP_TOOL_TIMEOUT`;
- **Codex:** `tool_timeout_sec` in `config.toml`.

Waarom zo, en geen eigen inlog met je abonnement:

- **Anthropic:** OAuth van Pro/Max is alleen bedoeld voor "ordinary use of Claude Code and other native Anthropic applications". Andere apps mogen geen Claude-login aanbieden en geen abonnementstokens gebruiken ([Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)). De bridge gebruikt de officiële app zelf.
- **OpenAI:** `codex exec` (zonder venster) annuleert MCP-toolcalls, tenzij je de sandbox uitzet ([openai/codex#24135](https://github.com/openai/codex/issues/24135)). Dat is niet betrouwbaar, dus die route is er niet.
- **Claude Code-channels** (berichten pushen in plaats van wachten) staan nog in research preview. Een eigen channel kan alleen met `--dangerously-load-development-channels`, dus die route is er nog niet.

### Model kiezen in de buddy

Klik in de buddy op **⚙**. Kies daar een van deze opties:

- je eigen AI-app (abonnement, via bridge);
- Anthropic;
- OpenAI;
- Ollama;
- LM Studio;
- OpenRouter;
- een andere OpenAI-compatibele server.

Vul eventueel de modelnaam, de server-URL en een API-key in, en klik op **Gebruiken**.

- Het wisselen gebeurt meteen, zonder herstart. Er start dan een nieuw gesprek.
- Met **Onthouden** komt je keuze in `buddy.config.json` (staat in `.gitignore`).
- Een key die je hier intypt, wordt als platte tekst in dat bestand bewaard. Laat het veld leeg om de key uit een omgevingsvariabele te gebruiken.
- De UI krijgt de key nooit terug.

### Model kiezen met een API-key (niet aan Claude gebonden)

Stel het model in met omgevingsvariabelen, of met een bestand `buddy.config.json` in deze map. Dat bestand staat in `.gitignore`.

| Wat | Instelling |
|---|---|
| Je eigen AI-app met abonnement | `BUDDY_PROVIDER=bridge` (zie hierboven) |
| OpenAI | `BUDDY_PROVIDER=openai` `BUDDY_MODEL=gpt-4.1` `OPENAI_API_KEY=…` |
| Ollama (lokaal, gratis) | `BUDDY_PROVIDER=openai` `BUDDY_BASE_URL=http://localhost:11434/v1` `BUDDY_MODEL=qwen2.5:14b` |
| LM Studio / OpenRouter / Groq / Mistral / Gemini | `BUDDY_PROVIDER=openai` met hun OpenAI-compatibele `BUDDY_BASE_URL`, `BUDDY_MODEL` en `BUDDY_API_KEY` |
| Anthropic (Claude) | `BUDDY_PROVIDER=anthropic` `ANTHROPIC_API_KEY=…` (standaardmodel `claude-opus-5-5`, ander model via `BUDDY_MODEL`) |

In PowerShell zet je een variabele zo: `$env:BUDDY_PROVIDER = 'openai'`. Daarna start je `npm run buddy` in hetzelfde venster. Een config-bestand is vaak makkelijker.

Kies een model dat **tool calling** ondersteunt. Krijgt het model geen beelden, zet dan `BUDDY_VISION=0`; screenshots worden dan niet doorgegeven.

Voorbeeld van `buddy.config.json`:

```json
{ "provider": "openai", "baseUrl": "http://localhost:11434/v1", "model": "qwen2.5:14b", "vision": false }
```

Andere instellingen: `BUDDY_BROWSER` (`dedicated` of `user`), `BUDDY_MODE`, `BUDDY_PORT` (standaard 5199), `BUDDY_HOTKEY` (standaard `CommandOrControl+Shift+Space`; nooit Escape), `CDP_URL`.

### Waarom het fullscreen niet verstoort

- De buddy is een apart programma. Klik je erin, dan verliest alleen het Chrome-venster de focus. Chrome blijft op volledig scherm.
- De buddy koppelt bij het opstarten al aan Chrome. Daardoor gelooft de pagina dat ze focus houdt (focus-emulatie). Klikken en typen in de app gebeurt via CDP en heeft geen OS-focus nodig.
- Screenshots komen rechtstreeks uit Chrome; de buddy staat er dus niet op.
- **De lokale API is afgeschermd.** De buddy kan je ingelogde Chrome bedienen, dus een webpagina mag de buddy niet aansturen:
  - alleen de eigen host;
  - POST alleen als JSON en van de eigen origin;
  - de bridge alleen met het token uit `%LOCALAPPDATA%\iframe-agent\buddy.json`.

## Tools

Buddy-only: `look`. Bridge: `buddy_wait`, `buddy_reply`, plus alle tools hieronder.

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
- de screenshot;
- radio-overlay, canvas `click_xy`, hidden snapshot, nested iframe en bedekte knop;
- elke soort iframe (srcdoc, sandbox met en zonder scripts, data:, about:blank met document.write, in shadow DOM, later geladen);
- je gewone Chrome via `DevToolsActivePort`: alleen de werktab wordt aangeraakt en er wordt niet vanzelf opnieuw gekoppeld;
- de buddy: een chatbericht dat de iframe bedient en controleert (met een gescript nepmodel, zonder API-key), en de modeladapters;
- de modi en goedkeuringen, `look` met een nep-opname, en de afscherming van de lokale API;
- de bridge: een echte MCP-client in de rol van "jouw AI-app" doorloopt `buddy_wait` → snapshot/act/verify → `buddy_reply`, inclusief Stop en goedkeuring.

## Grenzen van deze eerste versie

- **Wisselen van tab verbergt de pagina.** Dat kan geen enkele instelling voorkomen. Houd de app-tab dus actief. Een ander venster op de voorgrond of naar Claude Code gaan is geen probleem.
- **Knoppen die een nieuwe tab openen** (zoals "Theorie" met een PDF) zetten de app-tab naar de achtergrond. Chrome rendert de app dan niet meer, en screenshots hangen. `act` meldt zo'n nieuwe tab; met `tabs` en `close=<index>` sluit de agent hem, en de app-tab komt weer vooraan.
- **Apps die volledig in een `<canvas>` tekenen:** het canvas zelf staat in de snapshot, de getekende zones niet. Gebruik `screenshot` en `click_xy` (een punt onder de vouw wordt eerst in beeld gescrold).
- **Gesloten shadow-DOM** wordt via CDP uitgelezen en is gewoon klikbaar.
- **Je gewone Chrome** mist de startflags tegen achtergrondvertraging. Focus-emulatie werkt wel, maar een geminimaliseerd of volledig bedekt venster kan vertragen. `verify noPause` meldt het als de app daardoor pauzeert.
