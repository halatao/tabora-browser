# Windows signing readiness

**4 November 2026 · preparation; no new signing service account or certificate issued**

## Verified project facts

- Maintainer: Ondřej Halata, GitHub [`halatao`](https://github.com/halatao), contact `ondrej@halatao.cz`.
- Public source: [`halatao/tabora-browser`](https://github.com/halatao/tabora-browser), created 1 October 2026; own source is MIT.
- Released Windows x64 ZIP: [`preview-v0.6.2`](https://github.com/halatao/tabora-browser/releases/tag/preview-v0.6.2).
- Own C# launcher and TypeScript host are built by GitHub Actions. Packages include a file/dependency inventory and detached Ed25519 release-manifest signature.
- A public-trust Authenticode certificate is not configured. An Inno Setup definition exists, but no signed setup EXE is published.

## Free OSS signing candidate

[SignPath Foundation](https://signpath.org/) is a candidate, subject to its review. Its [conditions](https://signpath.org/terms) require eligible open-source components, a public signing policy, identified maintainer/approval roles and verifiable builds. Approval must not be represented as already granted.

The current package includes `@anthropic-ai/claude-agent-sdk@0.3.285`, whose package metadata says `SEE LICENSE IN README.md`. The [upstream license](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/LICENSE.md) refers to Anthropic's Commercial Terms. `@openai/codex-sdk@0.159.2` is Apache-2.0. The MIT license of Tabora does not establish that every bundled dependency satisfies the OSS signing program.

A specific eligibility inquiry was sent from `ondrej@halatao.cz` to `support@signpath.io` on 4 November 2026, with the subject “OSS code signing eligibility — Tabora Browser (MIT), optional AI SDK dependencies”. It asks whether the signed distribution can exclude the optional Anthropic integration or whether launcher-only signing is eligible. It requests clarification; it does not claim all dependencies are OSI licensed, accept a contract, grant repository access or place an order. A reply is pending.

Do not remove Claude support or split production packages until an explicit implementation decision is made. Do not add a “code signing provided by SignPath” badge before actual approval.

## Proposed signing policy fields

- Own files eligible for signing: Tabora launcher and installer, built from the protected release workflow.
- Maintainer/reviewer and proposed signing approver: `halatao`; confirm the required MFA and approval process during onboarding.
- Third-party binaries retain upstream provenance and are not represented as authored by Tabora.
- Use a provider-managed protected signing key and a CI signing integration appropriate to the approved service. A newly generated self-signed certificate does not replace public-trust Authenticode.

The existing stable workflow's PFX signing path is one implementation. A managed signer can require a different CI integration; do not invent or expose an exportable private key for an HSM-backed service.

## Other gates

- [Microsoft Artifact Signing](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart) eligibility depends on legal entity and location. Do not infer an eligible organization or start a paid subscription from the contact email alone.
- Reading local Hyper-V VMs with `Get-VM` failed due to missing permissions. No Windows VM was created or modified. A full clean-Windows installer test remains pending.
- The earlier local Inno Setup compiler installation was rejected with `blocked by policy`; it has not been retried here.

The signing account and certificate approval remain external steps. The privacy policy and publisher preparation documents are approved for publication; the Store submission remains a draft. Project identity and CI provenance are documented, and the eligibility inquiry has been sent.
