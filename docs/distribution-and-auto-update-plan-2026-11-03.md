# Instalace bez Gitu a automatické aktualizace Tabory

**Implementační plán · 3. listopadu 2026 · výchozí kód 0.5.6**

> Cíl: uživatel stáhne instalátor, propojí prohlížeč a agenta a dále dostává ověřené aktualizace mezi úlohami. Nepotřebuje Git, systémový Node.js, npm ani sestavování zdrojů. Aktualizace zachová profily, jejich oprávnění a zašifrovaný vault.
>
> **Stav realizace, 4. listopadu 2026:** lokální preview 0.6.0 implementuje samostatný ZIP, stabilní launcher, registraci, podepsaný update protokol, koordinaci extension/brokeru a recovery. Postup je v [distribuční dokumentaci](distribution.md), rozsah ověření a zbývající brány v [validačním reportu](distribution-validation-2026-11-04.md). Veřejné podepsané vydání a Chrome Web Store zatím publikované nejsou. Následující plán zachovává původní výchozí stav a požadavky.

## 1. Co máme a co je potřeba doplnit

| Oblast | Ověřený současný stav | Požadovaný výsledek |
| --- | --- | --- |
| Kontrola verze | `src/host/updates.ts`, `browser_update_check`, oznámení agentovi | Zachovat a rozšířit o distribuční kanál, stav instalace a skutečnou dostupnost balíčku |
| Vzdálený zdroj | GitHub latest release; při jeho absenci metadata `main/package.json` | Instalovat pouze ověřené vydání, nikdy přímo obsah větve `main` |
| Vydávání | V repozitáři `halatao/tabora-browser` nejsou k datu kontroly žádné releases ani assets; CI pouze ověřuje zdrojový kód | Release workflow vyrábí, testuje a zveřejňuje instalační artefakty |
| Instalace | `scripts/setup.ps1`: Node/npm, instalace závislostí, build, registrace hostu a klientů | Hotový payload s vlastním runtime; per-user instalátor a ZIP bez build kroku |
| Registrace | Native host i MCP odkazují na konkrétní checkout; host používá systémový Node | Stabilní spouštěče nezávislé na umístění aktuální verze |
| Extension | Rozbalená instalace, současný postup vyžaduje reload | Řízený reload pro unpacked; Chrome Web Store pro spotřebitelský kanál |
| Broker/MCP | Sdílený broker může běžet ze staršího buildu; MCP se umí znovu připojit k brokeru | Koordinovaný přechod generace, pravdivý stav nutnosti restartu klienta |
| Data | Oddělený state directory, včetně podpory fyzické cesty a aliasu | Zachovat tentýž adresář i identitu profilů; aktualizovat program odděleně od dat |

Stažení zdrojového ZIPu už dnes může nahradit Git, ale stále vyžaduje Node/npm a sestavení. Není to hotový uživatelský instalační balíček. Připojení MCP k novému brokeru také **nenahraje nový kód do už běžícího MCP procesu**.

## 2. Doporučené distribuční kanály

| Kanál | Instalace | Aktualizace extension | Aktualizace hostu |
| --- | --- | --- | --- |
| **Běžný uživatel — cílový stav** | Windows instalátor + Chrome Web Store | Distribuce přes Store; bezpečné dokončení při nečinnosti | Podepsaný balíček z GitHub Releases, lokální updater |
| **Současní uživatelé / preview** | Instalátor nebo hotový ZIP + jednorázové Load unpacked | Updater připraví soubory a extension sama provede `runtime.reload()` | Stejný lokální updater |
| **Vývoj ze zdrojů** | Existující setup a vlastní Node | Vývojářský build/reload | Oznámení a explicitní údržba checkoutu; žádné automatické přepsání změn |

První podporovaný spotřebitelský payload bude **Windows x64**. ARM64 a další systémy jsou samostatná rozšíření po ověření nativních závislostí. Edge lze zachovat ve zdrojové/unpacked cestě; publikace v jeho obchodě je oddělený release úkol.

Navržený Windows instalátor: **Inno Setup s `PrivilegesRequired=lowest`**, vlastní runtime a registrace pouze pro aktuálního uživatele. Nevyžadovat administrátora ani měnit enterprise policies. ZIP ponese tentýž otestovaný payload a `tabora.exe install`, který jej nainstaluje do stabilního adresáře; nezaregistrovat náhodnou složku v Downloads jako trvalý host.

Automatické aktualizace nabídnout jednou při instalaci. Výchozí nabídka: stable kanál, aktualizace mezi úlohami. Kdo je vypne, dostává pouze oznámení. Běžný panel nadále obsahuje režimy, provider/model a vault; nevytvářet další složité nastavování.

### Omezení, která musí produkt říkat přesně

- První instalace do běžného Chrome profilu vyžaduje souhlas prohlížeče. Agent může uživatele navést; instalátor nesmí upravovat Chrome Preferences ani obcházet souhlas.
- `chrome.runtime.reload()` umí znovu načíst unpacked extension, ale samo nestahuje její novou verzi. Do dnešní instalace je potřeba podporu řízeného reloadu nejprve jednou zavést.
- Nová oprávnění vyvolávající varování mohou vyžadovat další souhlas uživatele. Výsledek pak bude `consent_required`, nikoli falešné „aktualizováno“.
- Store distribuuje aktualizace vlastním tempem. Host nesmí přepisovat instalaci spravovanou Store ani obcházet jeho distribuční mechanismus.
- Bez ověřené podpory restartu konkrétního MCP klienta nelze slíbit automatickou výměnu celého běžícího MCP serveru. První verze může vyžadovat jeho znovupřipojení a musí to výslovně oznámit.

## 3. Rozhodnutí a ověřovací brány před implementací

### A. Identita extension a přechod do Store

`scripts/build.mjs` při chybějícím klíči generuje veřejný klíč; odpovídající soukromý klíč neukládá. Samotný `extension-key.txt` proto nedokládá možnost zachovat dnešní ID při publikaci. Existující ID nelze bez ověření slíbit.

1. Zjistit vlastnictví Store položky a případného odpovídajícího podpisového klíče; soukromé klíče nevypisovat ani nekopírovat do repozitáře.
2. V publisher dashboardu ověřit skutečné ID budoucí položky a porovnat jej s unpacked ID. Pro novou Store položku postupovat podle oficiálního postupu získání jejího veřejného klíče.
3. Pokud se ID změní, navrhnout jednorázový, explicitní přenos nastavení mezi starou a novou instalací ve stejném skutečném profilu. Nepárovat podle zobrazovaného jména „Ondřej“.
4. Zachovat UUID profilu, jeho režim, vypnutý MCP přístup, omezení webů, provider/model a nastavení vaultu. Přenos musí prokázat vazbu na tentýž profil a vyřešit souběh obou extensions; pouhé tvrzení nového klienta o UUID nestačí.
5. Native manifest může během migrace přijmout pouze konkrétní schválená legacy/Store ID. Žádný wildcard. Nedojde k přenosu cookies, hesel ani automatickému odemčení vaultu.

**Brána:** doložené ID nebo otestovaný migrační postup. Bez něj nepřevádět existující uživatele do Store automaticky. CI nesmí při release tiše vygenerovat novou identitu.

### B. Skutečně samostatný runtime

Build hostu používá `packages: external`. Samotné `dist/host/*.js` tedy nestačí. Sestavit inventář: Node runtime, produkční moduly, nativní `@napi-rs/canvas`, OCR data/workery, PDF workery a pomocné skripty pro DPAPI a cesty.

Samostatně ověřit spouštění Codex/Claude SDK: které binárky balíček obsahuje, které vyžadují lokální instalaci a jak se hlásí chybějící login. Přítomnost SDK neznamená přihlášeného providera. Základní MCP ovládání musí fungovat bez obou providerů.

Playwright je dnes devDependency, ale managed browser jej používá za běhu. Zabalit jeho potřebnou runtime část nebo managed podporu vydávat jako volitelnou komponentu. Chromium stahovat zvlášť ve verzi svázané s payloadem; běžný Chrome tento download nepotřebuje. Offline instalace nesmí předstírat dostupnost nenainstalovaného managed browseru.

**Brána:** zabalený payload projde na čistém Windows bez Gitu, Node, npm a checkoutu. Nespoléhat na vývojářský PATH ani volit single-file executable před ověřením nativních modulů.

### C. Životní cyklus MCP

Ověřit reconnect v podporovaných verzích Codex/Claude klientů, výměnu jejich MCP procesu a aktualizaci seznamu nástrojů. Registrace musí směřovat na stabilní spouštěč. Reconnect broker peeru v `mcp-connection.ts` řeší pouze spojení, nikoli aktualizaci MCP serveru.

**Brána:** buď prokazatelný automatický reconnect klienta, nebo dokumentovaný stav `mcp_restart_required`. Nezavádět prostý restart child procesu pod živým stdio spojením: porušil by inicializaci, rozpracované requesty a stav protokolu. Případná trvalá MCP proxy vyžaduje vlastní návrh a testy a není podmínkou prvního instalačního balíčku.

## 4. Uspořádání instalace a vlastnictví dat

```text
<per-user program root>/TaboraBrowser/
  tabora.exe                    stabilní CLI a spouštěč MCP/native hostu
  updater/                      malý spouštěč mimo měněný payload
  versions/<release-id>/        neměnný host + runtime + závislosti
  extension-unpacked/           stabilní cesta registrovaná v Chrome
  installation.json             kanál, aktivní/předchozí verze, identita instalace

<dosavadní fyzický state directory>/
  ...                           existující profily, vault, konfigurace
  updates/                      omezená staging oblast a recovery journal
```

- Výchozí program root navrhnout pod `%LOCALAPPDATA%/Programs`; datový root zachovat podle stávajícího resolveru, včetně explicitního `TABORA_STATE_DIR` a MSIX aliasu/fyzické cesty. Nespojovat je jen textovou podobností cest.
- Native registry bude ukazovat na stabilní manifest a launcher, MCP na `tabora.exe mcp`. Spuštění používá přibalený runtime, ne náhodný systémový Node.
- Vytvořit jeden resolver instalačního layoutu s podporou současného source layoutu. Použít jej pro broker, state.json, DPAPI skripty, setup i doctor; nevytvářet několik rozdílných odhadů instalační cesty.
- Registrace rozpozná vlastní instalaci. Cizí native/MCP konfiguraci nepřepíše; explicitní migrace dnešního checkoutu ukáže konkrétní změny. Lokální Git změny zůstanou zachované.
- Generované checkoutové `mcp.config.json` se nesmí přibalit. Nová instalace nesmí zdědit vývojářské file roots ani automaticky povolit celý disk nebo instalační adresář.
- Managed profil má vlastní kopii extension a omezení originů. Při aktualizaci regenerovat kopii z jeho uložené konfigurace, nikoli ji přepsat buildem s širším přístupem.
- Repair opravuje program a vlastní registrace. Uninstall odstraní pouze vlastní instalaci a registrace; uživatelská data ve výchozím stavu ponechá.

## 5. Formát vydání a ověření vzdálených balíčků

### Artefakty jednoho vydání

| Artefakt | Účel |
| --- | --- |
| `tabora-<version>-windows-x64-setup.exe` | Per-user instalátor s Authenticode podpisem |
| `tabora-<version>-windows-x64.zip` | Stejný hotový payload pro instalaci bez Gitu |
| `tabora-<version>-extension.zip` | Připravená extension pro unpacked kanál / vstup pro Store submission |
| `release-manifest.json` + oddělený podpis | Strojově ověřitelný seznam artefaktů, kompatibility a hashů |
| `SHA256SUMS`, SBOM a third-party notices | Kontrola obsahu a licence distribuovaných částí |

Manifest ponese verzi schématu, release ID, monotónní pořadí, kanál, čas vydání a platnost metadata, minimální verzi updateru, OS/arch, velikosti a SHA-256, identitu extension a rozsahy kompatibility protokolu. Podpis ověřovat nad přesnými bajty manifestu; neurčovat vlastní nejednoznačnou JSON normalizaci.

Použít podpisový kořen zabudovaný v instalátoru/updateru, například Ed25519. Hash kontroluje shodu dat; podpis dokládá jejich vydavatele. Podpisové klíče patří do chráněného release prostředí, veřejné klíče do programu. Návrh musí obsahovat rotaci kořene a chování při expirovaných metadatech; výpadek kontroly nesmí zablokovat již nainstalovanou funkční Taboru.

Stahovat pouze HTTPS z oficiálního release zdroje a schválených GitHub asset redirectů. Omezit velikosti, čas a počet pokusů; před použitím ověřit celý soubor. MCP, web ani model nesmějí zadávat libovolnou URL, cestu nebo příkaz ke spuštění updateru. Metadata z `main/package.json` smějí oznámit vývojovou verzi, nikdy autorizovat instalaci.

Extrakce do nové staging složky odmítne průnik mimo root, absolutní/UNC/drive cesty, ADS, neplatná Windows jména, kolize jmen, symlinky/reparse entries a nepřiměřené rozbalení. Úklid smí zasahovat pouze do prokázaně vlastních staging/version složek. Žádné mazání podle neověřené cesty z manifestu.

GitHub release workflow sestaví z tagu a lockfile, zkontroluje shodu verzí, vytvoří artefakty a spustí testy **nad nimi**. Vydání se označí za dostupné až po nahrání a ověření celé sady. Minimální oprávnění CI; podpisové klíče nevystavovat PR buildům. Authenticode certifikát a Store publisher účet jsou externí předpoklady. Nepodepsané preview musí být označené; neslibovat absenci SmartScreen varování.

## 6. Bezpečný aktualizační protokol

```text
check → download → verify → staged → waiting_for_idle
                                      ↓
                               maintenance_lock
                                      ↓
                      drain → activate → reconnect → health_check
                                      ↓                 ↓
                               recovery_required     completed
```

1. **Check:** rozšířit současný checker. Zachovat timeout, cache, omezení odpovědi a zákaz blokování browser akcí síťovým dotazem. Výsledek rozliší novější zdrojový kód od dostupného instalačního artefaktu.
2. **Stage:** stáhnout a ověřit payload bez zásahu do běžící verze. Zapsat durable journal s update ID, instalací, cílovou verzí a stavem; nikdy do něj nezapisovat obsah vaultu nebo stránky.
3. **Maintenance:** jeden zámek pro celou instalaci a sdílený broker. Atomicky zastavit přijímání nových akcí/úloh a nechat rozpracované doběhnout. Samotná existence neaktivní relace aktualizaci navždy neblokuje. Jiný vlastník nebo probíhající práce znamená `waiting_for_idle`, bez násilného převzetí.
4. **Nejasný výsledek:** pokud byla zapisující akce odeslána a není znám její výsledek, ponechat informaci o přerušení a požadavek na kontrolu výsledku. Aktualizace ani rollback nesmí zopakovat tuto akci. Idle relace a plány po změně generace explicitně zneplatnit; nový stav vyžaduje observe/replan.
5. **Activate host:** updater mimo měněný payload připraví novou neměnnou verzi a řízeně přepne aktivní ukazatel. Přechod brokeru zahrnuje všechny jeho klienty; nestačí přeregistrovat cestu a ponechat starý broker živý. Neukončovat cizí Node/Chrome procesy.
6. **Activate extension:** postup závisí na kanálu níže. Přepnutí programu, výměna unpacked souborů a restart extension nejsou jedna atomická transakce. Journal musí obnovit postup po pádu v každém mezikroku i při zamčeném souboru na Windows.
7. **Reconnect:** ověřit připojení každého dotčeného profilu a generaci hostu, extension a MCP. Původní session ownership se nepřenáší jako volná licence jinému klientovi. MCP proces na starém kódu nesmí být vydáván za aktualizovaný.
8. **Health:** nové spojení, vyjednaná kompatibilita, doctor a krátká bezpečná read-only kontrola. `scheduled` není `completed`. Stav udržuje updater i po zániku volajícího spojení.
9. **Rollback:** při selhání aktivace obnovit předchozí ověřený program, pokud je kompatibilní s aktuálním datovým schématem. Nikdy nevracet starou kopii vaultu nebo obchodní účinky akcí. Uchovat poslední funkční verzi a omezit retenci dalších.

### Extension podle kanálu

**Unpacked:** zachovat stabilní instalační cestu, uvést všechny instance do maintenance, připravit ověřené soubory a koordinovat jejich výměnu a `chrome.runtime.reload()`. Starý worker musí zvládnout reload nových souborů a potvrdit připravenost před ukončením. Neopírat doručení odpovědi o náhodný krátký timer; úspěch ověřuje až nové spojení s očekávaným buildem. Pokud soubory nelze bezpečně vyměnit nebo worker neumí reload, vrátit přesnou nutnost zásahu. Součástí fáze je prakticky ověřit pořadí na běžném Chrome, včetně obnovy po pádu.

**Store:** použít lifecycle `onUpdateAvailable` a případný řízený `runtime.reload()` v bezpečném okamžiku; `requestUpdateCheck()` používat s ohledem na jeho throttling. Trvalé native spojení a otevřený panel mohou oddalovat nečinnost, takže pouhé čekání na automatický idle nemusí stačit. Updater neinstaluje vzdálený extension kód do Store adresáře. Nově vyžadovaný souhlas se hlásí uživateli.

**Managed:** restartovat pouze vlastní managed instanci po dokončení její práce. Zachovat její data a konfiguraci, včetně zakázaného MCP a omezených originů. Běžný Chrome ani jeho soukromé taby kvůli aktualizaci nezavírat, neaktivovat a nerestartovat.

### Kompatibilita verzí a dat

Store extension a host nemusí aktualizovat ve stejný okamžik. Doplnit explicitní release identity, verze kontraktu a vyjednané schopnosti; využít současné vyjednávání diagnostického envelope. Podporovat stanovené překrytí starší/novější verze a blokovat pouze nekompatibilní operace s přesným důvodem.

`sameBuild` zůstane diagnostika přesné shody, nikoli univerzální podmínka provozu Store kanálu. Release manifest musí uvést testovanou kompatibilitu a bezpečné pořadí přechodu. Updater nesmí opakovaně bojovat se Store o jinou verzi extension.

Data měnit pouze verzovanou migrací s ověřením. Starší program odmítne novější nekompatibilní schéma; updater pak nepředstírá možnost rollbacku. Aktualizace neodemkne vault, nezmění jeho klíč, nerozšíří sdílení secrets ani oprávnění profilu. Po restartu obnovovat pouze zamčený stav a vyžadovat běžné explicitní odemčení.

## 7. Rozhraní pro agenta a uživatele

Navržená rozšíření MCP; konečná jména sladit se současnými nástroji:

| Nástroj | Chování |
| --- | --- |
| `browser_update_check` | Stávající rozhraní zachovat; přidat `installKind`, kanál, verze jednotlivých komponent, dostupnost ověřitelného balíčku a další krok |
| `browser_update_prepare` | Vybere oficiální vydání, ověří kompatibilitu, stáhne a připraví; vrací update ID a lokální ticket, nic nerestartuje |
| `browser_update_apply` | Přijme validovaný ticket pro tuto instalaci; naplánuje nebo zahájí maintenance; nikdy libovolný příkaz/URL |
| `browser_update_status` | Trvalý stav podle update ID: čekání na práci, jednotlivé komponenty, dokončení, rollback nebo požadovaná akce |

Aktualizační příkazy jsou lokální administrace vlastní instalace, nikoli browser akce vyvolatelná obsahem stránky. Povolit je jen autentizovanému lokálnímu klientovi s příslušnou maintenance autorizací. Explicitní apply a předem povolené idle-auto používají tentýž stavový automat a respektují práci ostatních vlastníků. Žádný neautentizovaný HTTP updater.

Rozlišovat alespoň `update_available`, `download_failed`, `verification_failed`, `incompatible`, `waiting_for_idle`, `scheduled`, `applying`, `consent_required`, `mcp_restart_required`, `completed`, `rolled_back` a `recovery_required`. Síťové selhání není `up_to_date`.

Agent oznámí podstatnou změnu a konkrétní další krok v právě používaném chatu. Neslibovat zprávu do neaktivního chatu. Zachovat deduplikaci oznámení a oddělený textový blok od výsledku browser nástroje. Panel ukazuje stav a jedinou relevantní akci; vault zůstane vypnutý, pokud jej uživatel nezapnul.

CLI nad stejnou implementací: `tabora install`, `doctor`, `update check|prepare|apply|status`, `repair`, `uninstall`. Instalace registruje nalezené podporované klienty; chybějící klient není chyba základní instalace. Pozdější registrace nemá vyžadovat reinstall. Nedostupné CLI řešit konkrétní konfigurací podporovaného klienta, ne přepsáním celého jeho configu.

## 8. Realizační etapy a podmínky převzetí

Etapy jsou reviewovatelné celky; testy přibývají současně s implementací, ne až na konci.

| Etapa | Konkrétní práce a výstupy | Hotovo, když |
| --- | --- | --- |
| **P0 — ověřovací prototypy** | Store ID/migrace, inventář runtime, pokus výměny unpacked souborů + reloadu, MCP reconnect matice | Jsou vyřešené brány A–C a doložené technické limity; žádný nepodložený slib zero-click |
| **P1 — payload a stabilní layout** | `scripts/package.mjs`, instalační resolver, `tabora.exe`, přibalený runtime, licence; source setup zůstává | Hotový ZIP funguje mimo checkout bez systémového Node/npm; read-only MCP a doctor projdou |
| **P2 — instalátor a migrace** | Per-user installer definice, vlastní registrace, repair/uninstall, explicitní převod source instalace | Čistá instalace i upgrade zachovají state root, UUID a oprávnění; konflikt nic nepřepíše |
| **P3 — release pipeline** | `.github/workflows/release.yml`, manifest schema, podpisy a ověření, tag/version kontrola, SBOM | CI testuje přesné distribuované artefakty; celá sada je publikovatelná, bez lokálních dat a tajemství |
| **P4 — host updater** | Rozšíření `updates.ts`, samostatné download/verify/stage a updater journal, zámek, aktivace a rollback | Selhání/storno/crash nenechá instalaci bez funkčního programu; aktivní akce nejsou opakovány |
| **P5 — lifecycle extension a brokeru** | Maintenance protokol v host/shared/extension, reload handshake, managed kopie, vyjednávání kompatibility | Update funguje ve více profilech bez aktivace jejich oken; nová generace je potvrzená, změna oprávnění jasně hlášená |
| **P6 — MCP a uživatelská cesta** | Update nástroje a CLI, per-component status, reconnect dle P0, stručná upozornění | Agent zvládne připravit a sledovat update; případný restart MCP není zaměněn za úspěšné dokončení |
| **P7 — vydání a dokumentace** | E2E update matice, README Download/Install/Update, release instrukce, pilot na vlastní instalaci | Ověřený předchozí → nový balíček, recovery a rollback; veřejné návody odpovídají skutečně dostupným artefaktům |

Závislosti: **P0 → P1 → P2; P1 → P3; P2 + P3 → P4 → P5 → P6 → P7**. Store submission lze připravovat souběžně po vyřešení identity; jeho schválení není podmínkou prvního no-Git preview balíčku. První užitečný výstup jsou P1–P3, kompletní automatická údržba vyžaduje P4–P7.

Existující setup/install-host/uninstall-host využít jako podklad pro registrace, ale sjednotit jejich pravidla ve sdílené instalační vrstvě. `updates.ts` nadále vlastní kontrolu dostupnosti, nová update služba orchestraci a updater výměnu souborů. Browser exekuce zůstává v extension, secrets v hostu a provider adaptéry pouze rozhodují.

Před první veřejnou publikací jsou potřeba publisher účet, skutečné Store ID, release podpisový klíč a rozhodnutí o Authenticode certifikátu. Tyto předpoklady neblokují vývoj lokálních balíčků; jejich absence blokuje tvrzení, že je spotřebitelský distribuční kanál hotový.

## 9. Testovací plán

| Oblast | Povinné případy / důkaz |
| --- | --- |
| Čistá instalace | Čistý Windows x64 bez Gitu/Node/npm/checkoutu a bez provider loginů; instalátor i ZIP; MCP čtení stránky, skutečný profil a doctor |
| Cesty a opravy | Mezery/diakritika, fyzický state root a alias, explicitní state override, jiná vlastní/cizí registrace, repair, uninstall/reinstall s ponechanými daty |
| Kompletnost payloadu | OCR, PDF, nativní canvas, file upload, SDK diagnostika chybějícího loginu; volitelný managed browser online/offline a správná revize Chromium |
| Důvěryhodnost balíčku | Poškozený hash, chybný podpis, replay/downgrade, prošlá metadata, chybná architektura/kontrakt/min updater, neúplné vydání, nebezpečné ZIP cesty a objem |
| Selhání v jednotlivých krocích | Přerušená síť, zaplněný disk, zamčený soubor, pád/restart ve všech journal bodech, broker timeout; po obnově existuje jednoznačně aktivní ověřená verze |
| Souběh | Dva MCP vlastníci, více profilů, dlouhá úloha a neaktivní relace; žádná nová akce neprojde mezi maintenance kontrolou a přepnutím generace |
| Zapisující akce | Serverový čítač dokazuje jediné provedení; update po dispatchi s nejasným výsledkem neprovede replay; agent dostane recovery stav |
| Reload a reconnect | Odpověď `scheduled`/přerušené IPC, nový worker/broker, přetrvávající starý MCP proces, obnovený seznam nástrojů, chyba reloadu; durable status nezávisí na původním procesu |
| Uchování dat a oprávnění | Stejné UUID, vypnutý MCP zůstane vypnutý, stejné origin/file-root restrikce, vault zůstane zamčený a zašifrovaný, zachované private/shared scopes; bez exportu cookies a secrets |
| Kanály a migrace | Unpacked update, source checkout s lokálními změnami, Store/asynchronní host verze oběma směry, případná změna ID a opakování migrace bez duplikace profilu |
| Souhlas Chrome | První instalace, nové permission warning, neprovedený souhlas: pravdivá blokace a jasný další krok; žádná změna enterprise policies |
| Provoz na pozadí | Běžný Chrome s neaktivním tabem/minimalizovaným oknem a managed headless; update nekrade focus, nezavírá soukromé taby a neobnoví širší oprávnění |
| Rollback | Funkční návrat po selhání health checku; odmítnutí nekompatibilního návratu datového schématu; žádné vracení obchodních účinků ani staršího obsahu vaultu |

Automatizované testy providerů používají syntetické odpovědi; placené modely nejsou podmínkou testu instalátoru. U testovacího Chrome profilu lze instalaci automatizovat, ale neobcházet souhlas v běžném profilu uživatele.

Při změně native/MCP hranic spustit `npm run check`, `test:native`, `test:managed`, `test:mcp`, `test:mcp-legacy` a nové cílené update testy. Release gate navíc používá čistou VM a **stažený balíček**, ne testy pouze nad checkoutem. Měřit velikost downloadu, instalaci, čekání na úlohy a samotný výpadek odděleně. Kontrola verze nesmí přidat síťové čekání do běžné browser akce; download nesmí držet execution lock. Časové limity stanovit podle měření prvního payloadu.

## 10. Definice dokončení

- Uživatel nainstaluje hotový balíček bez Gitu, vlastního Node/npm a build kroků. Po počátečním souhlasu je prokazatelně připojen správný profil.
- Oficiální release lze najít, stáhnout, kryptograficky ověřit a nasadit mezi úlohami. Každá komponenta hlásí svou skutečnou verzi a stav.
- Unpacked extension provede ověřený reload; Store kanál používá aktualizace prohlížeče. Rozdílné podporované verze nevedou k nekonečné aktualizační smyčce.
- Agent umí update připravit a sledovat. Pokud klient vyžaduje restart MCP nebo Chrome nový souhlas, dostane konkrétní instrukci; systém netvrdí zero-click dokončení.
- Profily, restrikce, vault a nejisté výsledky akcí přežijí restart i selhání updateru. Recovery/rollback je ověřený testem, ne jen popsaný.
- README odkazuje na existující otestované artefakty a rozlišuje dostupné preview, Store a vývojovou instalaci.

## Podklady

Lokální výchozí implementace: `scripts/setup.ps1`, `scripts/install-host.ps1`, `scripts/uninstall-host.ps1`, `scripts/build.mjs`, `scripts/state-directory.mjs`, `scripts/browser.mjs`, `src/host/updates.ts`, `src/host/broker-client.ts`, `src/host/mcp-connection.ts` a [současný návod na aktualizace](updates.md).

- [Chrome runtime API](https://developer.chrome.com/docs/extensions/reference/api/runtime): reload a chování unpacked instalace.
- [Extension update lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/extensions-update-lifecycle): Store cyklus, nečinnost a řízení aplikace aktualizace.
- [Manifest key](https://developer.chrome.com/docs/extensions/reference/manifest/key): získání veřejného klíče Store položky a porovnání identity.
- [Permission warnings](https://developer.chrome.com/docs/extensions/develop/concepts/permission-warnings): změny oprávnění vyžadující další souhlas.
- [Manifest V3 policies](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements): pravidla pro kód a vzdálené zdroje ve Store extension.
- [Distribution overview](https://developer.chrome.com/docs/extensions/how-to/distribute): podporované distribuční cesty.
- [Inno Setup — PrivilegesRequired](https://jrsoftware.org/ishelp/topic_setup_privilegesrequired.htm): instalace pro aktuálního uživatele bez požadavku na administrátora.
