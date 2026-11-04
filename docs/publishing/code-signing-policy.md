# Tabora release signing policy

Updated 4 November 2026. Maintainer and release publisher: [Ondřej Halata / halatao](https://github.com/halatao), contact **ondrej@halatao.cz**.

## Current signatures

Windows preview ZIPs are authenticated by the exact-byte Ed25519 release manifest and its detached signature. The public trust roots are in [`release-trust.json`](../../release-trust.json). The private release key is held in the restricted GitHub `release` environment, outside the repository. A checksum without a trusted signature is not publisher authentication.

The signed manifest identifies the release version, monotonic sequence, channel, platform, canonical payload identity, expiry and each downloadable artifact's name, URL, length and SHA-256 hash. Package inventories and dependency records identify bundled third-party files; signing the distribution does not represent those components as authored by Tabora or change their licenses.

No public-trust Authenticode certificate has been issued or configured. Ed25519 ZIP signatures do not replace Windows executable signing, and no SignPath sponsorship or approval is claimed.

## Release controls

- The maintainer creates the versioned release tag. GitHub Actions builds the locked dependency set and packages the runtime and extension artifacts.
- Publication requires passing browser CI for that exact tag, packaged native/MCP checks and offline update checks. Uploaded assets are downloaded again and compared before publication.
- Stable publication additionally requires its Windows installer and a valid Authenticode signature. ZIP-only preview publication skips installer compilation and never claims a signed setup EXE.
- The release environment allows `main` and the `v*` / `preview-v*` tags; publication runs only for tags. Independent human approval and publisher MFA are not asserted as enforced by the current workflow; any signing service's required approvals and account verification must be configured and verified during onboarding.

## Pending managed signing

The SignPath eligibility inquiry is pending. Before enabling that service, resolve the bundled SDK licensing question, approve the signing scope and configure its protected signing integration and required maintainer/approver controls. Proposed own-binary targets are the Tabora launcher and installer. Third-party binaries retain their upstream provenance.

Do not replace this gate with a self-signed certificate or publish a provider badge before approval. Review the final signed EXE and its chain/timestamp before adding it to an authenticated release manifest.

Report signing or distribution concerns to **ondrej@halatao.cz**. Public issues should not contain private keys, credentials, identity documents or customer browsing data.
