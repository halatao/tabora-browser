# Store privacy declaration review

This worksheet prepares the Chrome Web Store form. The publisher reviews its final declarations and the three required attestations before submission. It does not replace the [privacy policy](../privacy.md).

## Data categories

Tabora handles the pages and files selected for user-authorized tasks. MCP observations and selected-provider requests can leave the device. Local-only handling still needs disclosure under the Store's [user-data guidance](https://developer.chrome.com/docs/webstore/user_data/).

| Store category | Relevant handling |
| --- | --- |
| Personally identifiable information | Profile labels, website credentials' usernames and user-selected page/form/file content. |
| Health information | May occur in a user-selected document or page; Tabora has no separate medical record collection service. |
| Financial/payment information | May occur in a user-selected statement, purchase page, table or uploaded document. |
| Authentication information | Optional encrypted vault and configured provider credentials. Normal vault tools return metadata; filling uses the bound HTTPS origin. |
| Personal communications | User-selected messages, mail, chat pages and documents can be observed and sent to the selected agent. |
| Location | Selected pages/files may contain addresses or location data. Remote providers receive normal connection metadata. Tabora does not request geolocation permission. |
| Web history | Controlled-tab URLs/titles and task evidence; Tabora does not request Chrome's history database permission. |
| User activity | Requested action receipts, action diagnostics and timings; this does not mean recording all manual mouse or keyboard activity. |
| Website content | Requested text, tables, forms, supported frames, images/screenshots and documents. |

For the general-purpose distribution, all these categories can be processed by an authorized task. Do not mark “no user data” merely because the native host is local. There is no publisher advertising/analytics backend. Do not promise that arbitrary page content is free of sensitive data or that third-party SDKs/providers retain nothing.

## Required attestations

The dashboard requires the publisher to attest that:

1. User data is not sold or transferred except in the Store's approved cases.
2. Data is not used or transferred for purposes unrelated to the extension's single purpose.
3. Data is not used or transferred to determine creditworthiness or for lending.

The intended purpose is user-authorized browser automation. The configured agent and provider are recipients selected for that purpose. The publisher must review the [Limited Use requirements](https://developer.chrome.com/docs/webstore/program_policies/#limited_use) against the deployed distribution and its provider behavior before confirming. No automatic attestation is made by the build or asset exporter.

## Remote executable code

The extension bundles its JavaScript, disallows remote executable scripts in its CSP and validates model-selected operations. It does not download remote JS/Wasm for execution in extension pages. The native host is separately installed Windows software and has separately signed package updates. Describe both components to reviewers rather than implying that the local host is part of the Store-managed extension package.
