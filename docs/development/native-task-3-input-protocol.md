# Task-3 handoff: pinned native question and approval protocol

Inspected 1 October 2026 from the **versioned package archive referenced by the
retained dev execution**, without executing or modifying that execution. This
is source-protocol evidence, not a live structured-input qualification.

## Exact input inspected

AI-DLC `v2.9.0`, linux/arm64; source commit
`22f5d1b15a064c9ae80046e5b1761d5877e2f69f`.
Package `sha256:0399ab50fa7ed00eae5a246159fdb1d594c8fd4946c6aeb72452d9d6e2770ce0`;
materialization `sha256:eed746ebdc9078b8bf9217cebaad743e8f90eded8b299da8b96c99eb81bf9368`.
The S3 package manifest version is `ZE0QrJqT04mftvL1V0QhjmKY6Q3lkYrK`, SHA-256
`c450ebc6679f79629c5ea76e84be7c26231719b027c6f261b8adfc4afea6eb9e`.
Downloaded runtime archive SHA-256
`e66e864ac4c29f30024c32cab579eea3e0142a303596d2192b1c88b4ad69b25b`
and size 13,473,410 bytes match that manifest exactly. Local evidence is under
`.native-evidence/pinned-workflow/`; no upstream HEAD was substituted.

## Question data and response routing

The package's `runtime/codex/.codex/aidlc-common/protocols/stage-protocol.md`
sections 1–3 and each harness's `skills/aidlc/question-rendering.md` define:

- A fenced `question` spec has `prompt`, `header`, `multiSelect`, and ordered
  `options[].label` / `options[].description`. This is rendering input; it must
  not be echoed as the user-facing response.
- File-backed questions use `<record>/**/*-questions.md`, lettered options and
  blank `[Answer]:` tags. Ordinary questions end in `X. Other (please specify)`;
  multi-select answers can be `A, B, E`. The file is the authoritative record.
- Non-gate questions are recorded with `aidlc engine log decision --stage … --decision … --options …`, then `log answer --stage … --details <exact choice>`.
  **Correction (5 October 2026):** `report --user-input <exact label>` applies
  only to stage gates (`--result approved|rejected`) and the resume menu
  (`--result resumed`). Engine `ask` directives route by `response_route`:
  `new-work-routing` and the cold-start compose/scope offer go through `next …`
  (for example `next compose "<task>"`), `guard-recovery` runs the chosen remedy
  command, and `unit-claim` claims. `report` accepts no `--result answered`.
  Kiro must show its `numbered_prose_question` verbatim.
- Consolidated-summary confirmation is a separate checkpoint when
  `directive.ceremony.summary_confirmation` is `on`. Persist exactly
  `[Answer]: Looks correct` or `[Answer]: Request changes`, with the matching
  `--checkpoint summary-confirmation --questions-file …` decision/answer receipt.
  It is not stage approval. Request changes requires feedback and a new
  confirmation before artifact generation.

## Approval is engine-owned

Before presenting a stage approval, call `aidlc engine orchestrate report
--stage <slug> --result awaiting-approval`. An explicit later human selection
maps to `--result approved --user-input <exact choice>`, or `--result rejected
--user-input "Request Changes" --reason <feedback>`. After revision, report
`revised` and present the gate again. Approval auto-advances the engine; there
is no separate frontend `advance` operation. Plan Approval binds to content
and stage attempt, not merely to the directive that displayed it.

Do not infer approval from transcript wording, tool activity, completed model
turns, or published files. Native activity is observational. A shared UI must
retain the protected execution/attempt/turn identity and engine question or
artifact identity, and submit the actual human choice once. General Quorum
votes must not be translated into an engine approval without the task-3
identity, version and policy contract.

## Harness-specific rendering and qualification

| Harness | Pinned rendering contract |
| --- | --- |
| Codex | `request_user_input` when available; numbered prose fallback for headless/unavailable tool. Tool supports 1–3 questions, 2–3 options each; exact selected labels are recorded. |
| Claude | `AskUserQuestion` renders the spec. |
| Kiro CLI | Numbered prose plus exactly one final Other option; no structured-question tool is assumed. |

Kiro ACP `session/update` assistant and tool events are now projected through
the same native privacy and backpressure boundary, while the final result
collector remains separate. A local test proves an update reaches the activity
callback before the prompt resolves. **Actual deployed Kiro CLI streaming and
structured input still require a fresh live harness check.** The final ACP
result fixture alone does not qualify incremental streaming. This handoff also
does not claim live Claude/Codex structured-tool responses were exercised.

## Transport boundary for task-2 and task-3

Native intent IDs are project-scoped and may be intentionally reused in another
project. Native realtime scopes and channels therefore use
`native-intent:<projectId>:<intentId>`, including token caches and socket
admission. Native tokens do not authorize platform `intent:<id>` channels or
global Yjs intent documents. REST history and token issuance resolve the
protected native project and current membership.

**Native Yjs document formats remain intentionally disabled.** Task-2 must
define and enforce the protected revision-specific document contract before
enabling collaborative native documents. Task-3 must carry that protected
project/execution/revision identity through structured input and approval
submission; the observation channel alone is not authorization to mutate
engine state.

## Task-3 implementation contract (5 October 2026)

- **Capture, never prose parsing.** At turn end the runtime builds an optional
  `pendingInput`:
  - **Approval gate:** when engine state holds the current stage at `[?]`, the
    options are the protocol labels (`Approve`, `Request Changes`, and only the
    protocol's optional `Accept as-is` / `Add <stage>`).
  - **Other questions:** the agent writes the `question` spec it rendered to
    the reserved, unpublished `<project>/.native-control/pending-question.json`,
    as asked by the runtime's first-turn transport instruction. The runtime
    clears the file before each turn, reads it without following links, and
    caps its size. Every option label must appear in that turn's visible
    response.
  - **Fallback:** if neither source yields a valid question, the reply stays
    free text.
- **Binding.** `pendingInput` is stored in interaction `schemaVersion: 2`, and
  `contentSha256` covers both messages and the question, so a reply is bound to
  the exact options shown. v1 interactions are unchanged.
- **Answer.** A member submits the `QuestionEditor` selection with the reply.
  The controller re-renders it against the committed question and requires the
  reply text to equal the canonical rendering: the bare exact label(s); free
  text after a blank line (e.g. `Request Changes\n\n<feedback>`); one line per
  question for batches. The ledger stores the selection. The harness receives
  only that exact text as a genuine human turn, which the engine's human-turn
  hooks require. The agent records it with the command the question type
  requires. The runtime never writes engine state, and no assistant, file or
  Quorum output can approve.
- **Collaboration.** The shared draft is a revision-specific Yjs document
  `native-answer-<digest>-<interactionId>-<sequence>`, minted only while that
  turn awaits a reply (same lifecycle limits as reply drafts).
