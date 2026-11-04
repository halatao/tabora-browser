# Chrome Web Store submission kit

**Submitted 4 November 2026 · awaiting Chrome Web Store review; not published**

| Field | Proposed value / verified status |
| --- | --- |
| Product | Tabora Browser |
| Publisher display name | Tabora Browser |
| Store publisher ID | `0aa43023-1eb2-4102-8318-a94e93e58fbe` |
| Account holder | Ondřej Halata; name confirmed by connected Google profile |
| Developer/contact email | ondrej@halatao.cz; the Store dashboard confirms the contact email is verified |
| Homepage | https://github.com/halatao/tabora-browser |
| Support | https://github.com/halatao/tabora-browser/issues |
| Source license | MIT; third-party components retain their own licenses |
| Uploaded Store version | 0.6.3, from the authenticated `preview-v0.6.3` release |
| Category / listing language | Tools / English; the description discloses that the extension UI is Czech |
| Existing unpacked extension ID | `kenmodennegnggpghfmlpbbdfomadfdc` |
| Store item ID / public key | Item `ghkhjhmanloapainmhnnpkbopllcfomg` created on 4 November 2026; [public key](chrome-store-public-key.pem) exported from its dashboard and checked to derive that same ID |
| Review / publication | Version 0.6.3 submitted for review on 4 November 2026. Automatic publication after approval is disabled. |
| Privacy policy | [Published policy](https://github.com/halatao/tabora-browser/blob/main/docs/privacy.md) |
| DSA trader status / legal address | Owner selected trader; the dashboard requires additional owner action through Google Payments. Do not copy identity documents or billing details into this repository. |
| Account registration/payment status | Completed on 4 November 2026 with the owner's explicit approval of the developer agreement and USD 5 total fee; the dashboard confirmed successful registration. |

## Listing text

**Short description**

Control your browser with local AI agents through MCP, scoped browser modes and an optional encrypted vault.

**Detailed description**

Tabora Browser lets a local AI agent read pages and perform browser tasks through MCP. Use your connected agent to decide each step, or configure a supported decision provider in the local host.

- Safe mode creates tabs for the task. Risk mode can take over existing tabs. Read-only mode blocks modifying actions.
- Work with page text, tables, forms, supported frames and shadow DOM, scoped screenshots, documents, uploads and downloads.
- Organize tasks in named tab groups and select the browser profile you want to use.
- An optional encrypted local vault can fill credentials on their matching HTTPS origin.
- Supported interactions can run in background tabs without selecting them. Some pages, security checks and OS dialogs still need your attention.

A separate local Windows host is required. Windows x64 packages include the runtime; a system Node or Git installation is not required. MCP browser control does not require an internal model subscription. Calling a model through an SDK or service requires that provider's own authentication and may incur its charges.

Tabora's source is MIT licensed. External SDKs and services have their own licenses and terms. The extension UI is currently Czech and MCP descriptions are English. This is preview software; supported operations and limitations are documented in the repository.

## Single purpose and permission explanations

Single purpose: execute and observe user-authorized browser tasks for local AI agents through scoped MCP sessions.

| Permission | Purpose |
| --- | --- |
| `activeTab` | User-invoked access to a selected browser tab. |
| `tabs` | Select and track tab IDs, URLs, titles and task ownership. |
| `tabGroups` | Create and maintain task-owned tab groups. |
| `scripting` | Run the bundled reader and action implementation in authorized documents. |
| `nativeMessaging` | Connect to the separately installed local host for MCP routing and local integrations. |
| `storage` | Persist profile preferences, permission choices and bounded maintenance state. |
| `sidePanel` | Display mode, provider/model, task and vault controls. |
| `webNavigation` | Bind actions to the current document/frame and invalidate stale targets after navigation. |
| `debugger` | Fixed Chrome input, capture and supported background-interaction operations; not an arbitrary agent CDP interface. |
| `downloads` | Manage requested downloads and expose relevant task artifacts. |
| HTTP(S) host access | Read and act on the sites selected for the user's tasks, including supported frames. |

The extension bundles its executable code; its CSP disallows remote script loading. Model responses choose validated operations rather than supplying executable extension code. Native-host updates are separately signed program packages, not a mechanism for replacing Store-managed extension files.

## Privacy declaration

All nine data categories are selected because authorized tasks can process arbitrary user-selected pages and files. The category-by-category rationale is in the [privacy declaration worksheet](privacy-declaration.md). This does not represent a separate publisher tracking or advertising service. The form declares no remotely hosted executable extension code.

Purpose and permission explanations and the privacy URL are saved. Agent/MCP outputs and selected model requests can leave the device; SDK/provider policies remain applicable. The publisher explicitly approved all three final data-use attestations, which were saved before submission.

## Reviewer workflow

1. Install the Windows x64 host from a tested signed-manifest release and register its native/MCP launcher.
2. Use the matching Store identity. In a new test profile, select Safe mode with vault off and connect an MCP client.
3. Open a public test page in a session-owned tab; observe text and perform one harmless action. Release the session and close its created tabs.
4. Verify that Read-only mode blocks writes and that Risk mode is required to take over an existing tab.
5. Model integrations and vault use are optional; reviewers need no real customer credentials. CAPTCHA, account MFA and OS security prompts require handoff.

## Identity, assets and remaining gates

The Store ID is `ghkhjhmanloapainmhnnpkbopllcfomg`, different from the unpacked ID `kenmodennegnggpghfmlpbbdfomadfdc`. Host 0.6.3 supports explicit, reversible channel migration and exact native origins; see [the migration procedure](../distribution.md#chrome-web-store-channel). Keep the current unpacked identity working during that migration. Packaged Store registration and update checks passed; acceptance using the actual Store-installed extension remains a publication gate.

The dashboard rejected the original 0.6.2 extension ZIP because `manifest.key` is not allowed in a Store upload. A separate draft-upload ZIP was derived from the verified signed release by removing only that manifest field; every other file was checked unchanged. The released ZIP and installed extension were not modified. Starting with 0.6.3, packaging produces the Store variant automatically, checksummed and covered by the release signature.

The draft contains the saved description, homepage/support URLs, category/language, a 128 × 128 icon, two 1280 × 800 screenshots and reviewer instructions. Contact-email verification is complete. The reviewer instructions explain Windows host installation, Store registration, a harmless public-page MCP task and session cleanup; no customer login or paid model is required.

The screenshots show the actual bundled Safe and Read-only panel in an isolated synthetic profile with vault off. Their provenance records version 0.6.3 and build fingerprint `bb6636a0f612c5704d01906de92d396121309cf90e544ceb88b1e9d4dd585bca`. Both screenshots are RGB PNGs without alpha; the icon uses the existing extension artwork. No ordinary user-profile screenshot was uploaded.

The uploaded Store ZIP was checked against the Ed25519-signed release manifest (sequence 4), with SHA-256 `eff75993392d770020ec6607a083c8b84f7c7e3177747beadca66ba27f3eaeb0`. The release passed [browser CI](https://github.com/halatao/tabora-browser/actions/runs/41831273368) and [standalone packaging/update checks](https://github.com/halatao/tabora-browser/actions/runs/41831273363).

The dashboard confirms “Pending review.” The final attestations were approved and saved, and an earlier homepage URL timeout cleared on revalidation. Automatic publication was explicitly unchecked before submitting. Google warned that broad host permissions may require an extended review. Trader verification separately requires owner action. Complete that verification, address any reviewer requests and verify the actual Store installation before manually publishing. Do not describe pending review as publication.

References: [registration](https://developer.chrome.com/docs/webstore/register/), [publishing](https://developer.chrome.com/docs/webstore/publish), [user-data disclosure](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq), [extension identity](https://developer.chrome.com/docs/extensions/reference/manifest/key).
