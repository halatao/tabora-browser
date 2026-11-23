# Password creation and changes over MCP

Tabora generates the password inside its native host. The agent receives an opaque `changeId`, fills explicitly observed password fields, and saves the credential only after independently confirming the website accepted the change. Filling does not submit the form or prove that a reset succeeded.

Enable and unlock the vault in the extension first. Unlock each profile once per Windows sign-in; there is no inactivity timeout. Explicit lock or disabling the vault revokes remembered access, and Windows sign-out/reboot invalidates it. Tabora and Codex have separate vaults; these tools neither search nor import the Codex credential store.

## Procedure

1. Create an owned browser session, attach/open the intended HTTPS page, and call `browser_state`.
2. Call `browser_password_prepare` with `sessionId`, `stateVersion`, and either an existing `credentialId` or `account: {label, username}`. New accounts default to profile-only scope; sharing requires explicit `account.scope`. Password length defaults to 24 characters (16–128); symbols can be disabled for a site's policy.
3. Call `browser_password_fill` with `changeId`, fresh `stateVersion`, and the observed `passwordTargetId`. Supply `confirmationTargetId` and `currentPasswordTargetId` when present. Current-password filling requires an existing unchanged credential. A username input is not required.
4. Inspect the result and submit using an ordinary separately authorized action. Observe the website result. If it is ambiguous, do not blindly repeat the submission.
5. Call `browser_password_resolve` using a fresh state on the same HTTPS origin:

| Outcome | Vault behavior |
| --- | --- |
| `confirmed` with `confirmation: "agent_verified"` or `"user_confirmed"` | Atomically save the new account or replace the existing entry under the same ID. |
| `rejected` | Close the attempt; preserve the original account. |
| `unknown` | Retain the encrypted pending password and preserve the original account. |

Confirmation is an explicit **caller attestation**, returned as `confirmationSource: "caller_attestation"`. Tabora does not infer server acceptance from local field values, a successful click, or arbitrary page text. The calling agent must verify the website result or receive the user's confirmation.

## Failure and recovery

The host saves an `unknown` state **before** giving the generated password to the extension. A crash during filling therefore cannot turn a partial write into reported success. Passwords are not returned by MCP, observations, metadata, or provider requests; host export redaction includes pending passwords. The isolated sensor writes only to the selected password inputs. Existing generic `fill` restrictions remain in force.

After a host restart or lost browser session, reconnect the profile and call `browser_password_changes` with the profile ID. The prior explicit unlock is restored only within the same Windows sign-in; after sign-out, reboot, or manual lock, unlock in the panel first. Create a new owned session, inspect the same HTTPS site, and call `browser_password_resume` with the pending `changeId` and current `stateVersion`. The exact document grant is replaced; the generated password stays the same. Resume defaults to `unknown` and does not fill anything. Set `refillAfterInspection: true` only after checking the prior outcome and deciding another fill is necessary. It permits one deliberate fill, never an automatic submission.

The pending password change’s document grant expires after 24 hours; this is separate from vault unlocking. Expiration retains the encrypted pending password for recovery; it does not replace the current credential. Explicit resume renews the grant. There can be at most 32 unresolved changes. Completed/rejected history is pruned when needed to make space. Concurrent changes to the same credential are refused, and finalization compares the original entry's revision to prevent overwriting another edit.

## Boundaries and compatibility

- Filling is restricted to the exact prepared HTTPS origin, tab and top-frame document. Recovery requires the same exact origin. Subdomains and lookalike domains are separate.
- Targets must be distinct observed password inputs in the same form (or explicitly selected inputs without a form). Disabled, read-only, private, hidden, wrong-purpose and replaced fields are rejected. Generic page actions cannot write passwords.
- Read-only mode, vault-disabled profiles, missing unlock grants and foreign sessions cannot perform the flow. MCP cannot unlock the vault or call generic `vault.put`.
- The first staged change upgrades the encrypted vault envelope from version 1 to **version 2**. Existing entries and IDs are preserved. Old hosts fail closed on version 2; downgrade cannot read this vault. Keep host and extension updated together. Ordinary vault use without staged changes retains version 1.
- No website-specific selectors or TikTok behavior are used. This does not add CAPTCHA/MFA bypass, iframe password filling, browser-password-manager import, or automatic proof of server acceptance.

## Verification

`npm test` covers encrypted staging, create/update by ID, rejection, unknown outcomes, expiry, restart recovery, origin/document/profile/session isolation, concurrent edits, and host authorization. `npm run test:password` uses a disposable HTTPS site, synthetic vault, real extension session/sensor and owned MCP router. It exercises a two-password reset form without a username input, website rejection and acceptance, no automatic submission, and secret-free tool outputs. The fixture has no native-messaging permission and never registers a host or opens a user profile.
