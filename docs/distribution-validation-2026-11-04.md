# Distribuce Tabory 0.6.0 — ověření implementace

**4. listopadu 2026 · Windows x64 · lokální preview**

> Tento report zachycuje původní lokální validaci před nastavením podpisového kořene. Pozdější podepsané balíčky mají jiný fingerprint a kontrolní součty; jejich autoritativní manifest je přiložený ke konkrétnímu [GitHub vydání](https://github.com/halatao/tabora-browser/releases). Aktuální distribuční postup je v [distribuční dokumentaci](distribution.md).

Samostatný balíček, aktualizační protokol a koordinace běžících komponent jsou implementované. Toto není záznam veřejného vydání: GitHub Release, produkční podpisové klíče a Chrome Web Store zatím nejsou nastavené.

| Identita | Hodnota |
| --- | --- |
| Verze | `0.6.0` |
| Build fingerprint | `701b7400f5bb30064f2c3f414a145bc53615ac70d0a8b6fb78796523d4cf3ff7` |
| Contract | `2` |
| Extension ID | `kenmodennegnggpghfmlpbbdfomadfdc` |
| Přibalený Node | `v22.13.0` |
| Inventář závislostí | 127 komponent, licence v payloadu, `sbom.json` |
| Produkční důvěryhodné klíče | Žádné; vzdálená instalace je vypnutá |

## Co je implementované

- Windows ZIP s vlastním Node, SDK, nativními moduly, OCR/PDF podporou a Playwright runtime. Managed Chromium se stahuje samostatně.
- Stabilní `tabora.exe` pro CLI, binární native messaging a MCP. Programové verze a fyzický datový adresář jsou oddělené, včetně MSIX přesměrování cest.
- Registrace pouze vlastních native/MCP záznamů, kontrola konfliktů před první instalací, explicitní migrace source instalace a zachování datové vazby. Cizí konfigurace se nepřepisuje.
- Stable/Preview a politiky automaticky při nečinnosti, pouze oznámit, vypnuto. Běžný panel nezískává další nastavování.
- Ověření přesných bajtů manifestu pomocí Ed25519, hashů a velikostí artefaktů, pořadí vydání, platnosti, platformy, protokolu a identity extension. ZIP extrakce omezuje cesty, kolize, linky a velikosti.
- MCP `browser_update_prepare`, `browser_update_apply`, `browser_update_status`, trvalý journal, kontrola oprávnění a ticket vázaný na konkrétní instalaci a připravenou úlohu.
- Údržbová brána, dokončení probíhajících operací, reload unpacked extension, restart pouze vlastního managed browseru a následná kontrola skutečně připojených profilů. Rozpracované business akce se neopakují.
- Návrat programových souborů, recovery a úklid vlastního stagingu. Aktuální, předchozí a používané verze se zachovávají. Vault se automaticky neodemyká a data se nevracejí ze staré kopie.
- Definice per-user Inno Setup instalátoru a release workflow pro sestavení, testy, podpis, draft, zpětné ověření nahraných bajtů a publikaci kompletní sady.

## Výsledky testů

| Kontrola | Výsledek a rozsah |
| --- | --- |
| `npm run check` | Prošlo: TypeScript, 187 unit testů, 4 setup testy a build. Po poslední změně UTF-8 výstupu resolverů byl build zopakován. |
| `npm run test:native` | Prošlo: skutečné rámování native messaging, Windows DPAPI, redakce metadat, origin binding a zamčený vault. |
| `npm run test:managed` | Prošlo: instalace managed browseru, opakovaný start, skutečný DOM click přes MCP/native/extension, ukončení a persistentní restart. |
| `npm run test:mcp` | Prošlo: skutečné stdio a dva Chromium profily, skupiny, vlastnictví, vault scopes, revokace, paralelní akce a navigace. |
| `npm run test:mcp-legacy` | Prošlo: protokol 2025-03-26 a reconnect po restartu brokeru. |
| `node tests/mcp-update.mjs` | Prošlo: samostatné jednorázové oznámení nové verze; původní JSON výsledek zůstává kompatibilní. |
| `npm run test:sdk` | Prošlo: skutečné Codex/Claude SDK transporty proti syntetickým lokálním API; žádné placené modelové volání. |
| `npm run test:update-browser` | Prošlo: skutečné Chromium, maintenance, odmítnutí připraveného kliknutí před dispatch, native-triggered reload, nový broker, zachovaný UUID/vault-off a neplatný starý plán. |
| `npm run test:package` | Prošlo nad finálním ZIPem: extrakce, instalace v Unicode cestě, launcher/runtime, skutečné binární native messaging a interaktivní MCP bez Node/Git na PATH; změněný inventář odmítnut. |
| `npm run test:package-update` | Prošlo: finální payload → syntetická novější verze, skutečný detached updater, staging, výměna verzí a extension souborů, nový broker, ověřený nový host, zachovaná data i předchozí verze. Bez profilu zůstalo ověření extension výslovně čekající. |
| PowerShell a diff | Čtyři distribuční `.ps1` prošly parserem; `git diff --check` bez chyb. |

Browser test používá vlastní izolovaný profil a Developer mode zapíná přes `chrome://extensions`. Nepřepisuje preference profilu ani enterprise policy. Ověřuje životní cyklus aktualizace; není měřením rychlosti práce na pozadí. Command-line-loaded extension bez Developer mode Chrome při reloadu deaktivuje jako `unsupportedDeveloperExtension`; proto managed aktualizace používá restart pouze své instance.

## Připravené artefakty

Artefakty jsou lokálně v ignorovaném adresáři `release/`, ne v Git historii ani veřejném vydání.

| Soubor | Velikost v bajtech | SHA-256 |
| --- | ---: | --- |
| `tabora-0.6.0-windows-x64.zip` | 380 980 237 | `fd3d171010c0909c6d358ba47c7af9043727ed79fbc29159858c9bce9b20d745` |
| `tabora-0.6.0-extension.zip` | 2 034 276 | `56b1e4d82714b4a8cda0756a441ea26682076df14b9d2cf43a658e3650d56814` |

Součástí je `SHA256SUMS`, `sbom.json` a rozbalený payload. Kontrolní součet ověřuje shodu souboru; sám o sobě není podpisem vydavatele. Setup EXE ani produkčně podepsaný release manifest zatím vytvořené nejsou.

## Hranice ověření a zbývající kroky

1. **Podepisování a první vydání:** nakonfigurovat veřejné Ed25519 roots a odpovídající chráněný podpisový klíč, Authenticode certifikát a heslo. Výchozí `release-trust.json` má prázdné `keys`; nic se proto vzdáleně neinstaluje. Workflow je připravené, nebylo v tomto úkolu spuštěné ani publikované.
2. **EXE a čisté Windows:** lokální instalaci kompilátoru Inno Setup odmítla automatická kontrola s důvodem `blocked by policy`. Definice instalátoru je připravená; lokální kompilace EXE, jeho průchod wizardem, reálná migrace registrací a uninstall nejsou tímto reportem potvrzené. PATH izolace testu ZIPu nenahrazuje čistou Windows VM.
3. **Chrome Web Store:** ověřit publisher účet a skutečné Store ID. Jinou identitu implementace odmítá jako migrační požadavek. Přenos mezi dvěma různými ID není implementovaný ani automaticky povolený. První instalace a nová oprávnění nadále podléhají souhlasu Chrome.
4. **Provozní rollout:** otestovat kompletní podepsané vzdálené vydání na čistém Windows a aktualizaci balíčku s běžícím managed profilem. Zde jsou zvlášť ověřeny podepsané staging scénáře, skutečný offline přechod balíčků, skutečný reload extension a managed restart; nejde o důkaz všech jejich produkčních kombinací.
5. **MCP klient:** již běžící MCP proces se sám nepřepíše. Stav `mcp_restart_required` vyžaduje reconnect klienta. Bez připojeného ověřeného profilu zůstává `profile_connection_required`, nikoli falešné dokončení. Chybějící spojení samo nepotvrzuje konkrétní důvod ani potřebný souhlas.

Běžný uživatelský profil Ondřej nebyl v tomto úkolu migrován ani automaticky aktualizován. Testy balíčku nahrazují skutečnou registraci izolovanou funkcí a nemění uživatelské native registry ani MCP konfiguraci. Neproběhl commit, push ani publikace.

Instalace, CLI a publisher konfigurace jsou popsány v [distribuční dokumentaci](distribution.md). Původní požadavky zachovává [implementační plán](distribution-and-auto-update-plan-2026-11-03.md).
