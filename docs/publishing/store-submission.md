# Chrome Web Store submission kit

**Prepared 4 November 2026 · draft, not submitted**

| Field | Proposed value / verified status |
| --- | --- |
| Product | Tabora Browser |
| Publisher display name | Tabora Browser |
| Store publisher ID | `0aa43023-1eb2-4102-8318-a94e93e58fbe` |
| Account holder | Ondřej Halata; name confirmed by connected Google profile |
| Developer/contact email | ondrej@halatao.cz; connected Gmail account matches |
| Homepage | https://github.com/halatao/tabora-browser |
| Support | https://github.com/halatao/tabora-browser/issues |
| Source license | MIT; third-party components retain their own licenses |
| Latest prepared source version | 0.6.3 |
| Existing unpacked extension ID | `kenmodennegnggpghfmlpbbdfomadfdc` |
| Store item ID / public key | Draft item `ghkhjhmanloapainmhnnpkbopllcfomg` created on 4 November 2026; [public key](chrome-store-public-key.pem) exported from its dashboard and checked to derive that same ID |
| Privacy policy | [Published policy](https://github.com/halatao/tabora-browser/blob/main/docs/privacy.md) |
| DSA trader status / legal address | Owner selected trader; the dashboard reports verification pending through Google Payments. Do not copy identity documents or billing details into this repository. |
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

## Privacy declaration preparation

Do not select “no user data handled.” Page content is processed even when a workflow stays local. Relevant categories include website content, authentication information for the optional vault, and browsing activity such as controlled-tab URLs/titles. Review other categories against the actual dashboard definitions and the intended use of arbitrary user-selected websites; page content can include communications or sensitive information.

Explain that agent/MCP outputs and selected model requests can leave the device. There is no publisher advertising backend. SDK/provider policies remain applicable. The owner must review the final disclosures and attestations before submission.

## Reviewer workflow

1. Install the Windows x64 host from a tested signed-manifest release and register its native/MCP launcher.
2. Use the matching Store identity. In a new test profile, select Safe mode with vault off and connect an MCP client.
3. Open a public test page in a session-owned tab; observe text and perform one harmless action. Release the session and close its created tabs.
4. Verify that Read-only mode blocks writes and that Risk mode is required to take over an existing tab.
5. Model integrations and vault use are optional; reviewers need no real customer credentials. CAPTCHA, account MFA and OS security prompts require handoff.

## Identity and remaining assets

The draft Store ID is `ghkhjhmanloapainmhnnpkbopllcfomg`, different from the unpacked ID `kenmodennegnggpghfmlpbbdfomadfdc`. Host 0.6.3 supports explicit, reversible channel migration and exact native origins; see [the migration procedure](../distribution.md#chrome-web-store-channel). Keep the current unpacked identity working during that migration. Do not submit a live item until the actual Store build and installation path have passed publisher acceptance.

The dashboard rejected the original 0.6.2 extension ZIP because `manifest.key` is not allowed in a Store upload. A separate draft-upload ZIP was derived from the verified signed release by removing only that manifest field; every other file was checked unchanged. The released ZIP and installed extension were not modified. Starting with 0.6.3, packaging produces the Store variant automatically, checksummed and covered by the release signature.

The draft contains the prepared description, homepage and support URLs. Purpose/permission explanations and the privacy URL are prepared in the privacy form. It has not been submitted for review. Remaining listing work includes category/language, icon, screenshots, final privacy disclosures/attestations, reviewer instructions and contact-email verification. The dashboard specifies a 128 × 128 store icon and at least one 1280 × 800 or 640 × 400 screenshot, JPEG or 24-bit PNG without alpha. CI generates these assets from the actual bundled panel in a synthetic profile and publishes a provenance record with them.

Use the extension icon and screenshots from an isolated test account/CI fixture. Do not reuse screenshots of an ordinary logged-in user profile. Required dimensions, crop and Store form fields must be checked against the current dashboard before upload. Screenshots and any promotional image remain to be attached.

References: [registration](https://developer.chrome.com/docs/webstore/register/), [publishing](https://developer.chrome.com/docs/webstore/publish), [user-data disclosure](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq), [extension identity](https://developer.chrome.com/docs/extensions/reference/manifest/key).
