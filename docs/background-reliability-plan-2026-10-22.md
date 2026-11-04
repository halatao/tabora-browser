# Spolehlivá práce Tabory na pozadí

**Diagnostika a implementační plán · 22. října 2026**

Stav při sepsání 22. října: diagnostika dokončena, implementace runtime následovala později. Tento dokument doplňuje [dosavadní kontrakt práce na pozadí](background-execution.md).

**Aktualizace 3. listopadu 2026:** Runtime změny pro 0.5.6 a jejich hranice jsou popsané v [aktuálním stavu implementace](background-reliability.md). Nálezy a původní měření níže zůstávají historickým podkladem; nelze je zaměňovat za výsledky nového buildu. Přibyla také [kontrola aktualizací přes MCP](updates.md). Celá rozšířená akceptační matice níže není automaticky splněná pouze dokončením implementace.

## Cíl a hranice podpory

Tabora má číst a ovládat živý tab, i když uživatel pracuje v jiném tabu, jiném okně nebo jiné aplikaci a okno Chrome je minimalizované. Nemá kvůli tomu aktivovat tab, přebírat systémový fokus, obnovovat okno ani požadovat otevření panelu rozšíření.

Zavřené okno s ukončeným tabem už nemá živý cíl. Pro práci bez běžícího osobního prohlížeče existuje samostatná cesta přes spravovaný headless Chromium s vlastním profilem a přihlášením. Nesmí docházet k tichému přepínání profilů ani kopírování cookies a hesel. Uspání počítače a zamčená plocha nejsou těmito testy ověřené režimy.

`target_obscured` samo o sobě neznamená, že jiné systémové okno překrývá Chrome. Současná kontrola zjišťuje, co leží nad cílem uvnitř dokumentu, a stejný kód používá i pro některé geometrické chyby. Automatická rada „zobraz Chrome“ proto nemá dostatečnou oporu v této chybě.

## Co bylo skutečně ověřeno

K dispozici byl profil Ondřej, nikoli work2. Chybí záznam konkrétního selhání work2, jeho překryvu a fáze dispatch. Příčina tohoto incidentu proto zůstává nepotvrzená. Níže uvedené závady jsou zjištění z kódu a izolovaných reprodukcí, nikoli domnělá rekonstrukce incidentu.

Integrační testy běžely proti existujícímu buildu 0.5.5, contractVersion 2, fingerprint:

```text
52db655402ef13e431b3638148958754b5e64fe9d602d46135b79c0a4b1a777c
```

Build se v rámci diagnostiky nepřestavoval. Samostatná reprodukce překryvu používá aktuální zdrojový sensor; její výsledky je nutné odlišit od testu distribuovaného buildu.

| Ověření | Výsledek | Rozsah důkazu |
| --- | --- | --- |
| `node tests/background-browser.mjs` | 9 kontrol prošlo | Headless Chromium 153.0.8010.12; skutečná cesta MCP → host → extension |
| Stejný test s `TABORA_BACKGROUND_HEADFUL=1` | 9 kontrol prošlo | Normální okno; také skutečná minimalizace bez obnovení okna |
| `node tests/overlay-scroll-browser.mjs` | Prošlo | Existující test překryvů a scrollování |
| `node --import tsx --test tests/error-diagnostics.test.ts tests/canonical-controller.test.ts` | 16/16 prošlo | Diagnostický kontrakt a controller; nejde o reprodukci work2 |
| Nová izolovaná reprodukce dočasného překryvu | Potvrzeno předčasné selhání | Překryv mizí po 700 ms, DOM příprava selže za 4,2 ms a native příprava za 3,5 ms |
| Cíl mimo viewport, který scroll neodkryje | Potvrzeno nejednoznačné hlášení | `target_obscured` s prázdným `blockers` |

Po zmizení překryvu a novém pozorování DOM kliknutí uspělo. Reprodukce native větve testovala `native_prepare`, nikoli následný nativní dispatch. Při blokované přípravě nevznikl zápis.

Integrační test pokrývá DOM akci závislou na visibility/focus a dvou animačních snímcích, trusted native click s počítáním zápisů na serveru, text/klávesy, hover, drag/drop, maskovaný screenshot, kliknutí navázané na screenshot, odmítnutí cizího debuggeru a nové navázání po navigaci. Kontrolní uživatelský tab zůstal aktivní a nedostal vstup. Harness vypíná vlastní focus emulation Playwrightu a nepoužívá globální přepínače proti throttlingu.

### Naměřený čas executor operace

Šest vyvážených párů v každém režimu; mediány v milisekundách:

| Režim prohlížeče | Aktivní tab: wall | Tab na pozadí: wall | Rozdíl | Aktivní: executor | Pozadí: executor |
| --- | ---: | ---: | ---: | ---: | ---: |
| Headless | 219,205 | 268,925 | +49,720 | 197,0 | 236,5 |
| Normální okno | 178,730 | 244,985 | +66,255 | 163,0 | 213,5 |

Wall čas zahrnuje transport a získání/uvolnění CDP lease. Nezahrnuje předchozí pozorování, plánování ani model. Jde o malou zahřátou testovací stránku, nikoli úplný agentní benchmark, srovnání s oficiálním pluginem nebo záruku výkonu na libovolném webu.

Lokální podklady jsou v ignorovaném adresáři `reports/background/`: `headless.json`, `headed.json`, `diagnostic-actionability-2026-10-22.json` a stejnojmenný reprodukční `.mjs`. Nejsou součástí verzovaného dokumentu ani veřejným benchmarkem. Skutečné překrytí jinou aplikací, dlouhá nečinnost, frozen stav a restart workeru v těchto bězích ověřeny nebyly.

## Nálezy v implementaci

| ID | Zjištění a důsledek | Místo |
| --- | --- | --- |
| D1 | Hit-test zkouší devět bodů a dva okamžité scrolly. Nečeká na odstranění překryvu ani ustálení geometrie. Přechodná překážka tak končí okamžitou chybou. Potvrzeno reprodukcí. | `src/extension/actionability.ts`, `exposedPoint` |
| D2 | Chybějící průnik s viewportem sdílí `target_obscured` se skutečným překryvem. Část chyb nemá identitu překážky. | `actionability.ts`; převod bodu ve `v2-session.ts` |
| D3 | Commit a capture používají krátký background lease, ale state/read a legacy observe jej nepoužívají. První čtení může vzniknout za jiné visibility než následná akce. Konkrétní dopad ve work2 není ověřený. | `readiness.ts`, `v2-session.ts`, `session.ts` |
| D4 | Lease zapíná focus emulation a 1×1 screencast. Dokončení startovacího příkazu samo nepotvrzuje postup renderování. Bez debugger permission může nepovinná DOM cesta pokračovat bez emulace. | `target-debugger.ts` |
| D5 | Některá čekání na dvojité `requestAnimationFrame` nemají vlastní deadline. Selhání cleanupu může překrýt původní výsledek. | `sensor.ts`, `target-debugger.ts` |
| D6 | Controller ukládá do historie modelu kód chyby, ale ztrácí detaily blockerů. `modal_blocked` není v seznamu recoverable chyb. Recovery test simuluje obscured při plánování, nikoli skutečném commit. | `src/host/workflow.ts`, `tests/canonical-controller.test.ts` |
| D7 | Popis `browser_step` stále slibuje aktivaci tabu/okna, přestože implementace už provádí background operaci. Může vést klienta ke špatné interpretaci. | `src/browser-api.ts` |
| D8 | Odpojení native hostu ruší pending požadavky a maže sessions/owners. Opětovné připojení profilu neobnoví vlastněnou relaci a chybí trvalejší diagnostika původní příčiny. | `src/extension/background.ts` |
| D9 | Není explicitní rozhodování podle frozen/discarded stavu. Časování uvnitř commit neukazuje celou frontu, získání lease a cleanup. | Extension lifecycle; host interactive queue |

Už existují důležité ochrany: vlastnictví relace, přesné navázání na dokument, jednorázové plány, ochrana cizího debuggeru a evidence nejasného dispatch. Tyto mechanismy se nesmějí oslabit. `sent` se u native vstupu nastavuje před odesláním CDP příkazu; timeout tedy nemusí znamenat, že akce neproběhla.

## Navržený tok operace

```text
vlastník + dokument → stav tabu → krátký render lease → připravené čtení
→ uvolnění lease → rozhodnutí modelu → nová validace + lease
→ omezené čekání před dispatch → jeden dispatch → ověření → cleanup
```

Model nesmí přemýšlet pod trvale drženým render lease. Pokud emulace nebo čekání změnily dokument či identitu cíle, vyžaduje se nové pozorování a plán. Nezavádět trvalý screencast, globální Chrome flags, patchování `document.visibilityState`, odstranění překryvu z DOM ani force-click.

## P0 — Diagnostika a veřejný kontrakt

**Změnit:** `src/shared.ts`, extension executor/readiness, host workflow a existující IPC/MCP serializaci.

- Rozšířit stávající `ActionDiagnostic`; nevytvářet paralelní error wrapper. Přidat kompatibilní volitelné údaje: trace ID, fáze, příčina, dispatch stav, počet pokusů, elapsed/deadline a doporučený další krok.
- Rozlišit skutečný překryv, cíl mimo viewport, nestabilní geometrii, nepostupující renderování, chybějící capability a konflikt debuggeru. Definitivní veřejné kódy určit společně se schema/compatibility testy.
- Zaznamenat omezenou geometrii cíle/viewportu, frame a document binding, aktivitu tabu, stav a fokus okna, document visibility/focus a dostupný frozen/discarded stav. Nepodporovaný údaj označit jako neznámý.
- Přenést bezpečné detaily až do MCP a historie interního controlleru. Zachovat současný kompatibilní obal `data.details` pro striktní starší klienty.
- Měřit zvlášť frontu, attach, render readiness, actionability, dispatch, verify a cleanup. Cleanup nesmí změnit již známý výsledek dispatch na obecný neúspěch bez kontextu.
- Použít omezený diagnostický buffer podle profilu/relace, například nejvýše 100 událostí a 15 minut. Export pouze pro oprávněného vlastníka. Nelogovat hodnoty formulářů, celé DOM, URL query, screenshoty nebo secrets; redigovat i názvy blockerů podle existujících pravidel.

**Hotovo, když:** klient rozliší blokaci dokumentu od problému readiness a ví, zda mohl proběhnout zápis; starší MCP klienti nadále validují odpovědi. Žádná automatická rada o zobrazení Chrome bez odpovídajícího důkazu.

## P1 — Společná background readiness pro čtení a akce

**Změnit:** stávající `withInteractiveTab`, `target-debugger.ts`, V2 state/read a relevantní legacy observe cestu.

- Rozšířit existující mechanismus i na připravené čtení, které vyžaduje renderovaný stav. Levné statické čtení lze zachovat, ale jeho záruky musí být explicitní.
- Ověřit skutečný postup renderování omezeným probe; samotná odpověď na `Page.startScreencast` nestačí. Probe musí fungovat i pro statickou stránku a mít konečný timeout.
- Doplnit deadline pro attach, emulaci, rAF a cleanup. Samotný `Promise.race` nezruší pozdní CDP příkaz: používat generation/cancellation kontrolu a uklidit i pozdě dokončenou operaci.
- Sdílet přesně cílený lease mezi vnořenými operacemi; čtení a zápis nesmějí navzájem zrušit debugger. Model inference nesmí držet frontu. Neprovádět nesouvisející paralelizaci globální host fronty.
- Odlišit udělené oprávnění od ověřené background capability. Nepodporovaná operace skončí konkrétně před dispatch, bez foreground fallbacku.

**Hotovo, když:** první čtení visibility/rAF stránky funguje i bez předchozí akce v neaktivním a minimalizovaném okně; timeout nezanechá emulaci, stream ani opožděný zápis. Změna DOM vyvolaná probuzením vynutí čerstvé navázání cíle.

## P2 — Omezené čekání na proveditelnost akce

**Změnit:** společný actionability probe a jeho DOM/native volající v sensoru.

- Zachovat rychlý synchronní hit-test a obalit jej společným asynchronním čekáním. Výchozí návrh rozpočtu je 2 sekundy, vždy omezený celkovým deadlinem operace; rychlá cesta nesmí obsahovat pevný sleep.
- Po scrollu čekat na použitelnou geometrii a opakovat identitu, viditelnost, disabled/inert, modal a composed hit-test. Zahrnout nested scroll, shadow DOM a překryv nad iframe v rodiči.
- Opakovat pouze přípravu před jakýmkoli vedlejším účinkem. Mouse-down, submit nebo nejasný dispatch se nesmějí zopakovat jako způsob zotavení.
- Po spotřebování snapshotu čekat uvnitř vlastněné operace, nebo znovu pozorovat a plánovat. Neobnovovat spotřebovaný action ID.
- Při vypršení vrátit poslední bezpečnou diagnostiku a další krok; rozlišit neodstranitelný offscreen cíl od dialogu.

**Hotovo, když:** překryv mizející po 700 ms dovolí přesně jeden zápis; trvalý překryv skončí v limitu s identitou překážky; cíle mimo viewport a neplatné cíle se neklikají násilím. Stejná pravidla platí pro DOM i native cestu.

## P3 — Obnova controlleru a MCP klienta

**Změnit:** `src/host/workflow.ts`, veřejné tool popisy a relevantní dokumentaci.

- Předat modelu bezpečné detaily, nikoli jen kód. S `modal_blocked` pracovat strukturovaně podle typu překážky a dostupných oprávnění.
- Postup obnovy: omezené čekání → nové pozorování → identifikace překážky → případná samostatná akce na pozorovaném zavíracím prvku → nový plán původní akce. Nejvýše dva korektivní kroky pro stejnou překážku.
- Executor automaticky řeší čekání a scroll. Zavření překryvu rozhoduje controller/agent jako samostatnou autorizovanou akci; žádné plošné Escape ani úpravy DOM/CSS.
- Nezavírat naslepo potvrzení ztráty formuláře, autentizaci, platbu či neznámý nativní dialog. CAPTCHA a skutečné browser/OS handoff zůstávají explicitními omezeními.
- Při nejasném zápisu provést pouze čtení a ověření podle aplikačního důkazu. Nevytvářet znovu pipeline ani znovu neukládat policy jen proto, že se ztratila odpověď.
- Sjednotit doporučení externímu MCP klientovi s interním controllerem. Opravit zastaralý popis aktivace v `browser_step`; nepřidávat uživateli další přepínač nastavení.

**Hotovo, když:** bezpečně zavřitelná překážka se vyřeší bez uživatele, nebezpečný dialog vyvolá konkrétní handoff a ztracená odpověď nezpůsobí duplicitní zápis. Testovat také chybu při skutečném commit, nikoli jen při plan.

## P4 — Životní cyklus tabu, workeru a relace

**Změnit:** `background.ts`, session ownership/transport a diagnostiku reconnectu.

- Odlišit zavřený tab, frozen, discarded, pending navigation a živý skrytý dokument. Používat feature detection: minimum manifestu je Chrome 116, `Tab.frozen` je novější API.
- Ověřit, zda dostupná cesta umí frozen tab probudit bez aktivace. Pokud ne, vrátit konkrétní omezení; neslibovat to pouze na základě focus emulation.
- Posoudit dočasné `autoDiscardable: false` pouze pro vlastněný aktivní úkol, s obnovením původní hodnoty. Není to obecná ochrana před freezing a nesmí měnit globální Memory Saver nebo jiné taby.
- Discarded tab případně znovu načíst jen podle explicitní politiky obnovy. Neprovádět obecný refresh při nejasném zápisu nebo riziku ztráty rozpracovaných dat. Nový dokument vyžaduje nové pozorování a plán.
- Při odpojení uchovat omezený záznam zániku relace s příčinou a posledním dispatch stavem. Rozlišit dostupnost znovu připojeného profilu od bezpečně obnoveného vlastnictví relace.
- Obnovení musí ověřit profil, klienta, tab a dokument. Neobnovovat pending plány ani credential stav a automaticky nepřehrávat nejisté akce.
- Profil identifikovat stabilním ID a buildem, nikoli pouze názvem. Chybějící work2 nesmí vést k náhradě profilem Ondřej. Uklízet pouze vlastní pomocné taby/skupiny podle jejich životního cyklu.

**Hotovo, když:** restart nevede k tiché ztrátě příčiny, cizímu takeover ani opakování zápisu; každé omezení má konkrétní stav. Zavřený osobní browser se automaticky nenahrazuje jiným přihlášeným profilem.

## P5 — Regresní matice a měření

Rozšířit existující background a overlay harness; nevytvářet druhý paralelní benchmark. Izolovanou reprodukci převést na udržovaný regresní test. Měřit skutečné výsledky na testovacím serveru, nikoli jen návratové kódy nástroje.

| Oblast | Požadované scénáře |
| --- | --- |
| Viditelnost | Aktivní tab, neaktivní tab, jiné Chrome okno, překrytí jinou aplikací, minimalizované okno, headless |
| Čtení | První studené čtení, visibility/rAF, prodleva modelu, virtuální seznam, shadow DOM, iframe |
| Překážky | Překryv 100/700/1800 ms, trvalý modal, sticky vrstva, offscreen cíl, nested scroll, recyklovaný DOM cíl |
| Akce | DOM/native click, fill/key, hover, drag, select/check, upload, capture/image click, navigace a ověřený zápis |
| Dialogy | Bezpečné zavření, rozpracovaný formulář, známý nativní dialog, neznámé potvrzení |
| Lifecycle | Nečinnost přes 5 minut, frozen, discarded, worker/host restart, disconnect, konflikt debuggeru, reload, cancel v jednotlivých fázích |
| Izolace | Dvě relace ve stejném profilu, dva profily, vlastnictví při takeover, nedotčený kontrolní tab |
| Nejasný výsledek | Server zapíše a odpověď se ztratí; timeout po mouse-down; selhání cleanupu po úspěšném dispatch |

Spouštět na Windows Chrome Stable a připnutém testovacím Chromiu; zaznamenat verze a build fingerprint. Lifecycle test nesmí sám uměle udržovat worker při životě. Background test nesmí těžit z emulace Playwrightu ani globálních přepínačů throttlingu.

### Akceptační podmínky před vydáním

- Nejméně 10 opakování každého podporovaného scénáře bez neočekávaného selhání; nepodporovaný scénář musí skončit deklarovanou konkrétní chybou.
- Nula nevyžádaných aktivací tabu, změn systémového foreground okna a obnovení minimalizovaného okna. Sledovat průběžné události, nikoli jen konečný stav.
- Nula duplicitních zápisů, vstupů do kontrolního tabu a porušení vlastnictví. Po cancel/deadline žádné opožděné zápisy.
- Všechny operace skončí v deklarovaném deadlinu plus omezeném cleanup rozpočtu. Nezůstane debugger lease, emulace ani screencast. Mezi akcemi a během přemýšlení modelu se aktivita vrací do klidového stavu.
- Pro výkon nejméně 30 vyvážených párů; uvádět p50/p95, frontu, jednotlivé fáze, cold/warm start, recovery a počet modelových kroků/handoff. Předběžný cíl přírůstku na rychlé cestě: medián do 100 ms a p95 do 250 ms proti shodné aktivní variantě. Jde o návrh limitu, nikoli splněný výsledek současného měření.
- Nejprve cílené testy změny, následně `npm run check`; pro změny hranic také `test:native`, `test:managed`, `test:mcp`, `test:mcp-legacy` a relevantní background/capture/frame/overlay testy.

## Pořadí dodání

1. **Diagnostický kontrakt a popisy nástrojů:** P0 + oprava zavádějících instrukcí. Umožní další incidenty měřit, ne odhadovat.
2. **Readiness a čekání:** P1 + P2 se společnými DOM/native regresními testy.
3. **Obnova:** P3, včetně pozitivního ověřování nejistých zápisů.
4. **Lifecycle:** P4 a dokončení celé matice P5 před vydáním. Testy P5 přibývají průběžně v předchozích změnách.

Nejbližší reprodukce work2 má zachytit přesné ID profilu, host/extension fingerprint, trace, blocker a dispatch stav v aktivním, neaktivním a minimalizovaném režimu. Použít testovací stránku nebo neškodný testovací úkol. Před opakováním původního vytváření pipeline/ukládání policy nejprve ověřit, zda už předchozí zápis neproběhl.

Dokončení znamená funkční práci na podporované živé stránce bez přebírání fokusu a s doloženým výsledkem operace. Samotné připojení profilu nebo jeden úspěšný klik tuto podmínku nesplňuje.

## Podklady a inspirace

- [Chrome Tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs): odlišuje aktivitu tabu od fokusu okna; dokumentuje discarded a frozen stav. Podporu jednotlivých polí je nutné detekovat podle verze.
- [Životní cyklus extension service workeru](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle): debugger session od Chrome 118 prodlužuje život workeru. Native connection i další okolnosti ovlivňují životnost; nelze předpokládat stejnou dostupnost u všech verzí ani trvalý běh.
- [Playwright actionability](https://github.com/microsoft/playwright/blob/main/docs/src/actionability.md): inspirace pro omezené automatické čekání na viditelnost, stabilitu a přijímání událostí. Převzít principy čekání a diagnostiky, nikoli obcházení překážek pomocí force.
- [Dosavadní implementace Tabory](background-execution.md): krátký CDP lease, focus emulation, renderovací stream, přesné navázání na dokument a zákaz automatického foreground fallbacku již existují. Plán je doplňuje; nezavádí nový souběžný executor.
