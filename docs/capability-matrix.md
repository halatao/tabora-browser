# Capability conformance after controller migration

`workflow-v2` is the common controller. Public recipe APIs translate into V2.
Raw-goal planning is a bounded grammar; an available executor does not mean that
every natural-language request is understood. Unsupported intent is explicit.

| Area | V2 executor | Supplied workflow | Raw goal | Validation |
| --- | --- | --- | --- | --- |
| Scoped navigation, reads | Yes | Yes | Retrieval with observed candidates | MCP, controller, capabilities |
| Tables, exact currency/ranking | Yes | Yes | Bounded observed scalar/list choices | list-answers, decimal, controller |
| Pagination/virtual records | Yes, declared limits | Yes | No general collection planning | workflow, capabilities |
| Checkbox/select | Yes | Yes | All/both checks; exact observed option | goal-plan, canonical-controller |
| Text inputs/editor replacement | Yes | Yes | One quoted literal and unique grounded editable | goal-inputs, canonical-controller, widgets |
| Asynchronous state/text | Yes | Yes | Supported action sequence + explicit state/text predicate; bounded fresh absence receipts | controller, goal-plan, workflow |
| Ordered repeated clicks/count | Yes | Typed actions | Bounded declared sequence | goal-plan |
| Frames/shadow roots | Yes, granted origins | Yes | Common reader/control grounding; exact paragraphs with document-local root ordinals | capabilities, controller |
| Native keyboard/drag/widgets | Yes, debugger permission | Yes | Explicit workflow required | widgets, background |
| Visual tasks | Capture + declared model capability | Explicit routing | Explicit workflow required | visual, decision-images |
| Uploads/downloads/documents | Scoped host artifacts | Yes | Explicit workflow required | files, workflow |
| Vault login/authentication handoff | Opaque credential, HTTPS binding | Yes | Explicit credential/workflow required | auth, native, workflow |
| Popups/site tools | Owned/granted, explicit enable | Yes | Explicit workflow required | MCP, webmcp |
| Cancellation/revocation/cleanup | Yes | Common lifecycle | Common lifecycle | MCP, native, managed, controller |

Jev remains text/choice-only for verified contracts. Vision requires explicit
routing to a supported configured SDK; there is no hidden fallback. Planning
does not grant origins, files, vault access or credentials. No universal raw-goal
coverage or measured speed advantage is implied by this matrix.
