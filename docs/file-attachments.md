# Automatic local attachments

The primary path is `find → import/stream → observe → upload → verify`, with no picker or open panel. Calling MCP agents can execute it directly. Internal typed workflows also resolve task-supplied filenames within configured roots and upload their immutable snapshots; providers choose opaque actions and never receive filesystem execution or file bytes. See [capabilities.md](capabilities.md).

## Access and configuration

Set `TABORA_FILE_ROOTS` in the MCP server environment to a JSON array of absolute permitted directories. Setup accepts `-FileRoot`; direct launches default to the launch working directory. The generated MCP config explicitly uses the installation checkout unless overridden at build/setup. Configure task directories before connecting, not by passing an arbitrary root in a tool call. Changes require reconnecting that MCP client. Authentication is the existing current-Windows-user DPAPI-protected named-pipe credential. This is an application boundary, not protection against arbitrary programs already running as the same OS user.

CLI setup encodes that JSON in `TABORA_FILE_ROOTS_B64` to preserve quotes/spaces through Windows PowerShell and cmd launchers. This is a serialization transport, not encryption. A configured encoded value takes precedence over plain JSON; do not set conflicting values.

`browser_files_roots` reports configured roots. `browser_files_find` scans at most 5,000 entries with a bounded queue, returns at most 100 matches and a continuation offset. It matches filename substrings, not document content or natural-language semantics. Use the calling agent's existing filesystem tools for richer discovery. A truncated scan must not be mistaken for a complete directory. Import accepts a single returned fileRef or an exact absolute path; traversal, device paths, UNC paths and symlink/junction components are rejected. File identity and modification metadata are checked before and after snapshotting. Concurrent modification produces a failure before export.

If the calling agent already has file bytes, `begin/chunk/finish` accepts a new attachment stream without granting the host access to the original path. Bytes bypass decision providers. This does not turn any website into a filesystem client. Attachments are bound to the authenticated client, profile and session; a second client or another profile cannot reuse them.

## Tool flow

1. Create/open/attach a session normally.
2. Find the intended file within a returned root; choose only by the actual user criteria. Import its fileRef, or directly import a known granted path. The returned metadata includes an opaque ID and SHA256, not source path or contents.
3. Alternatively begin a stream, append canonical base64 chunks at sequential offsets, then finish (optionally supply SHA256). No model call is needed per chunk.
4. Observe `all` or `fill`. File inputs are distinct targets with accept/multiple/disabled metadata, including inputs hidden by standard upload widgets.
5. Call `browser_upload` with the target ID, artifact IDs and binding.documentId + ':' + snapshot.documentToken. Upload uses the owned background tab without activating its window, streams approved bytes and validates hashes in the secure extension worker before the single dispatch. With debugger permission the renderer's focus/visibility is emulated for the operation; without it, visibility-sensitive site behavior is not guaranteed. The target is consumed.
6. Observe the application's actual result. Attaching FileList and triggering input/change may start a web upload, or may require a separate normal form submit. `businessOutcomeVerified` stays false; local dispatch is not server success. Never blindly retry an unknown write.

File upload uses the DOM FileList backend with synthetic events and does not need debugger permission. Other optional native-input/capture operations use a separate debugger backend. Standard file inputs and common onchange uploaders are supported; native-only widgets, website FSA pickers and OS dialog automation are not. Readonly forbids upload. Browser permission, Safe group/tab ownership, document identity, connected target and cancellation checks remain in the extension.

MIME metadata comes from the extension-supplied File type or the source filename extension; `accept` is a compatibility filter, not content validation or malware scanning. Staging does not certify contents. Separately, `browser_document_read` supports bounded offline PDF/OCR parsing of owned artifacts. Hash verification certifies transferred bytes, not their meaning or trustworthiness.

## Lifecycle and limits

- 32 KiB decoded chunks, 50 MiB per file, 100 MiB / 20 artifacts per session, 200 stored artifacts globally.
- Ready artifacts and unfinished transfers expire after 15 minutes. Upload tickets expire after 60 seconds; very large/slow transfers can fail explicitly at this limit rather than continue unbounded.
- Native/IPC frames retain their 256 KiB limit. No entire attachment is inserted into a decision prompt or tool response.
- Original files remain unchanged. Only randomly named staged copies inside this process's artifact directory are deleted on release/revoke/cleanup.
- Mode/access/provider/vault-policy changes, client/profile disconnect and session cancellation revoke files and upload tickets. No file access is inherited from shared vault secrets.
- Server acceptance cannot be rolled back. Cancellation stops future chunks/dispatch; an already dispatched upload requires observing its outcome.

The staged directory is user-private application data. A crash can leave snapshots until a later host-start cleanup; it is not an encrypted vault. Filenames and attachment content may be sensitive. Use the same user's filesystem protection and do not enable unrestricted roots.

## Optional manual picker

`browser_files_request` creates a bounded manual request. The extension panel displays it, and its file input opens only after a user click. User cancellation is a normal terminal state. Selection is staged using the same chunks/store, then fulfillment assigns it to the requesting MCP session. Automatic imports/streams never create this waiting-for-user state. Standalone panel attachments stay in the panel scope, rather than silently becoming available to every MCP client.

## Validation

`tests/artifacts.test.ts` covers snapshots, actual hash, bounded streams, traversal/junction denial, ownership, quota and revocation. `tests/files-browser.mjs` runs real extension/native host/MCP operations against the independent Python fixture server in the sibling `browser-capability-bench` directory. Its report is an executor integration result, not decision-model performance or full BCB. Optional picker actions are explicitly assisted simulations. To use a different Python executable set `TABORA_BENCH_PYTHON`; otherwise `python` must be on PATH.
