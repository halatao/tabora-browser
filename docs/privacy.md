# Tabora Browser privacy policy

**Effective 4 November 2026 · Tabora 0.6.3**

Publisher and contact: Ondřej Halata, **ondrej@halatao.cz**. Project: [halatao/tabora-browser](https://github.com/halatao/tabora-browser).

Tabora connects a browser extension to a local native host and the AI agent or decision provider you choose. This policy describes Tabora's data handling. Websites, agent applications, model providers and their SDKs have their own policies.

## Browser data

Tabora uses browser-profile labels, permitted tab titles and URLs to select and scope work. For a task, it can read page text, forms, tables, supported frames, screenshots, documents and the results of browser actions. This material can contain personal information, communications or other sensitive content depending on the website you choose.

Safe mode creates task-owned tabs; Risk mode permits takeover of existing tabs; Read-only mode blocks modifying actions. These modes control Tabora's actions, not the content or policies of the websites themselves. The extension requests broad HTTP(S) access so that it can work across user-selected sites. It does not request Chrome's history-database or cookies API permissions.

## Agents and model providers

When an MCP client requests an observation or document, relevant content is returned to that client. Its application or AI provider may process or retain that content according to its own settings and policies.

When you select an internal decision provider, task instructions, available operation choices and relevant page context are sent to that provider. Image-capable workflows can also send a scoped screenshot. Current integrations include OpenAI/Codex, Anthropic/Claude and TypeSafe/Jev. Decisions API remains an unavailable preview integration in this version.

Tabora limits model tools and attempts to exclude or redact credential fields and known secrets. These controls do not guarantee that arbitrary website content is free of sensitive information. Review the task and chosen provider before sending sensitive material.

Tabora does not operate a separate publisher analytics service or sell browsing content for advertising. Third-party SDKs may make their own authentication, catalog, service or diagnostic requests under their own policies. In particular, Anthropic describes SDK data handling separately; this policy does not promise that all SDK traffic is disabled.

## Optional vault and local files

The vault is optional and off by default for a new profile. On Windows its contents are encrypted with AES-GCM and the encryption key is protected by Windows DPAPI for the local Windows user. Credentials can be shared across profiles or restricted to a specific profile. Unlock grants are handled separately from whether a profile has MCP enabled.

When you authorize credential filling, the credential is used on its matching HTTPS origin. Provider credentials are used with the provider you configure. Ordinary vault tools expose metadata rather than returning plaintext secrets to the agent.

File workflows can read files selected by you or imported within configured file-access roots. File names, paths, metadata and content may be used for the requested task or submitted to the destination website you select. A file supplied to an AI agent may also be processed by that agent or its provider.

## Storage, retention and updates

Profile preferences and site permissions are stored in browser extension storage. Host configuration, the encrypted vault, update records and managed browser profiles are stored locally in the host's configured data directory. Temporary artifacts and diagnostic records can remain until released, expired or cleaned up. Downloads saved to your chosen directory remain until you remove them. An agent client may keep its own conversation, tool-output or artifact history.

When update checks are enabled, the host contacts the project's GitHub endpoints. GitHub receives normal connection information such as the request IP address and user-agent header. Downloaded releases are verified before activation. Update journals contain installation/version and maintenance status information; application rollback does not restore an older copy of your vault.

Uninstalling the host retains the separate local data directory. Removing the extension may remove its browser-stored preferences. Before deleting data, finish active tasks and preserve anything you want to keep. You can lock the vault, revoke MCP access, restrict permitted sites or file roots, change the decision provider, and configure the host's update policy.

## Third-party policies and contact

- [OpenAI privacy policy](https://openai.com/policies/privacy-policy/)
- [Anthropic privacy policy](https://www.anthropic.com/legal/privacy) and [Claude data usage](https://code.claude.com/docs/en/data-usage)
- [TypeSafe/Jev privacy policy](https://typesafe.ai/legal/privacy-policy)
- [GitHub privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement)

For questions about Tabora, contact **ondrej@halatao.cz**. For copies or deletion of data held by another agent application, website or model provider, use that service's own controls and contact process.
