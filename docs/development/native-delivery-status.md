# Native execution delivery status

Updated 5 October 2026. Historical deployment branch: `feat/native-aidlc-execution`.

## Task-3 checkpoint — 5 October 2026: structured answers, cold-recovery and codex Quorum fixes

**Task 3 is deployed to dev.** The lead approved and applied
`.native-evidence/deploy-t3/native-t3.tfplan`, SHA-256 `3262b630…`, state serial
1199: 96 added, 32 changed, 96 destroyed (helpers and images only). Post-apply
checks:

- Runtime 121 is READY.
- 42/42 Lambda hashes, 7 IAM checks, 15 wiring checks and 518 frontend assets verified.
- Retained runs are unchanged, and the retained image pins are present.

The m2b Quorum model-pin plan (below) was applied earlier at serial 1196 → 1199,
runtime 120.

### Live task-3 result: intent `aa996035-d7b9-4bdf-afae-649360cb6b41`

What worked:

- The first turn's plan-choice question was captured as structured `pendingInput` from the rendered spec. It offered compose / express / classic / feature.
- Both members saw clickable options and no free-text box.
- A selection made in window 2 reached window 1 in 254 ms, with presence shown.
- Window 1 submitted it. The controller accepted text `compose` with selection `[0]`.

**What did not work: the turn after a cold restore could not run the workflow.**

The run went cold and recovery restored it. Two separate defects showed up, and neither is a task-3 regression.

1. **Cold recovery dropped the machine pin registry. This is the root cause, present since milestone 1.**
   - Pinned AI-DLC 2.9.0 dispatch (`core/tools/aidlc-lifecycle.ts:675-720`) requires `<installRoot>/pins.json` to list the project's canonical path.
   - The first turn registers it with `config --pin`. Recovery rebuilds `machine/` and re-ran only `use`.
   - The restored turn failed with `this project's 2.9.0 pin is not registered on this machine`. The agent improvised a re-pin and then `report --result resumed --user-input compose`, which is the wrong command for an ask; the engine answered "aidlc-state.md is absent". The selection was never recorded.
   - **Fix:** after `use`, recovery replays `config --pin <v> --project-dir <project> --from <pkg> --offline --json`. That rewrites only `pins.json` plus the project's two pin files, with identical bytes.
   - New executor recovery tests: one replays the pin, one fails closed when the re-pin fails. Both fail without the fix.
2. **A single status-poll failure during recovery is terminal.**
   - The first recover attempt hit an AgentCore `RuntimeClientError` 424 on a status poll. It came about 23 s after the filesystem restore, during the roughly 160 s package reinstall.
   - The worker maps any runtime client error in RECOVERING to `RESTORE_FAILED` (`execution-worker.js`).
   - A protected re-recover with the same `recoveryId` succeeded.
   - **Not changed yet.** It is tied to removing the reinstall from cold recovery (startup work).

**Codex Quorum root cause.** Codex's CLI context materializer creates only the codex home. Nothing created the Quorum working directory `/tmp/quorum/<root>/<discussion>`; for Claude, the MCP config write happens to create it. With the directory missing, the spawn emits `error`, and the result is `cli_failed`, `exitCode: null`, no output. That is the same incident `compose-plan-start.js` already fixed for compose. **Fix:** create the workspace before materializing and spawning, which applies to both the platform and native paths. Test coverage: an ordering test with an injected `mkdirFn`, which fails without the fix. No test writes to the host `/tmp`.

Validation:

- Native foundation: 119 files, 5,476 tests.
- Agentcore workspace: all pass except the 3 documented inherited `discussions.test.js` Quorum guard failures, plus 2 cwd-relative `native-runtime-package` tests that pass from the repo root.
- Receipts are in `.native-evidence/t3b/`.

### Recovery and Quorum fix plan (approved by the lead and applied)

Saved plan `.native-evidence/deploy-t3b/native-t3b.tfplan`, SHA-256
`260905aaa46ae804cd183c135ef44567d526bde58f70f218a77bfc2acf4c7f23`, state serial 1207. That serial is the t3 apply's own final write; the state object is unchanged since 09:06:53Z.

What the plan does:

- **31 updates:** 29 Lambdas whose code is byte-identical (CodeSha256 checked against the deployed functions) and which change only image and runtime references; the platform AgentCore runtime; and the orchestrator alias.
- **93 helper and image replacements.** The AgentCore image `930fd6bb97e3297d` is built locally as `sha256:3b37f3a6…`, and both fixed files match the checkout. `keep_remotely=true`.
- No frontend change. 3 retained image pins are present, and 4 retained run records are unchanged.

Index: `.native-evidence/deploy-t3b/review-handoff.json`.

An independent read-only review recommended approval. After the lead's approval the plan was applied: 93 added, 31 changed, 93 destroyed. Post-apply checks:

- The platform runtime is version 122, READY, on an executable manifest and config identical to the reviewed build.
- 42/42 Lambda hashes, 7/7 IAM checks and 15/15 wiring checks pass.
- The 4 retained run records are unchanged, and all 3 pins are present.

The fix applies to runs on the new image. The existing fixture keeps its pinned image, so the gate demo continues on a fresh bounded intent.

### Intake plan-offer routing: a gap in the pinned package (fix approved and applied)

Fresh intent `55a1fb87-2ea1-4648-9e3c-ba998c59fb26`, on the t3b image:

- The structured plan choice worked again: window 2's selection reached window 1 in 208 ms, with presence shown.
- Window 1 submitted `compose` with selection `[0]`, accepted on the warm path at 12:52:40Z with no pin error.
- **The turn still dead-ended.** The agent ran `report --result resumed --user-input compose`, and the engine replied "aidlc-state.md is absent – nothing to resume".

Cause: AI-DLC 2.9.0 has two contradictory rules for this question.

- The intake offer ("None of the ready-made plans is an obvious fit…") is a bare `{kind: "ask"}` emitted before any workflow state exists. The engine's contract (`aidlc-orchestrate.ts` Branch 4b) is to re-run `next compose "<text>"`.
- The codex skill's generic rule says to answer every other ask with `report --user-input`, which cannot work without state.

Local proof with the pinned 2.9.0 binary, sandboxed in `.native-tmp`, no model:

| Command                         | Result                   |
| ------------------------------- | ------------------------ |
| `next "<text>"`                 | Returns the offer        |
| `report … --user-input compose` | Exactly the live error   |
| `next compose "<text>"`         | Dispatches the composer  |
| `next --scope express "<text>"` | Leads to intent creation |

**Fix:** the native transport instruction now routes that intake answer through `next`, and nothing else. The member's reply text stays verbatim. Plan `.native-evidence/deploy-t3c/native-t3c.tfplan`, SHA-256 `c806d39002ec7a56ac1cbc989441299b7bfa8e961ce837336fe5778de134a945`, serial 1216: 9 updates (8 Lambdas with identical code, plus the platform runtime) and 33 helper/image replacements. Image `c87a2b6b8ba73b55` is built locally as `sha256:8235d07c…`, and its file matches the checkout. 4 pins are present and 4 retained records are unchanged. Upstream, this inconsistency should be reported to AI-DLC.

An independent review recommended approval. It noted that 7 of the Lambda updates are environment-only, while `native-package-worker` only renames a byte-identical archive. Follow-ups: correct the branch citation in the code comment, and tighten the quoting of the request text. After the lead's approval the plan was applied: 33 added, 9 changed, 33 destroyed. Post-apply checks:

- Runtime 123 is READY, with a manifest and config identical to the reviewed build.
- 42/42 Lambdas, 7/7 IAM checks and 15/15 wiring checks pass.
- 4 retained records are unchanged, and 4 pins are present.

### Transient codex stream errors discarded valid turns (fix approved and applied)

Fresh intent `8efff0ce-6476-4802-9e2a-418ada5e42db`, on the t3c image, **failed on its first turn**.

- Codex hit a transient model-service error and reported it as `{"type":"error"}`, with the text `Reconnecting... 1/5 (stream disconnected before completion…)`.
- The turn then continued, rendered the plan question and completed.
- Our codex output parser treated any `error` event as fatal (`native_execution_output_failed`), so the turn was dropped ("Agent turn ended without a published response").
- That code was missing from the controller's diagnostic allowlist, so it showed only as `unknown`.

This bug has been present since milestone 1. In codex 0.145.0 (`exec/src/event_processor_with_jsonl_output.rs`), every server error notification becomes a non-terminal `error` event. The outcome comes only from the turn status: `turn.completed`, `turn.failed`, or nothing for an interrupted turn.

The fix has three parts:

- **Parser:** for codex, only `turn.failed` is fatal, and `turn.completed` is still required. Tests cover the exact live event sequence, failed after an error notice, and interrupted after an error notice; the accept test fails without the fix.
- **Controller diagnostics:** now report all 7 `native_execution_output_*` codes.
- **t3c review follow-ups:** the comment's branch citation is corrected, and the intake instruction is reworded ("when the user replies", request passed unchanged as one shell-safe argument).

Plan `.native-evidence/deploy-t3d/native-t3d.tfplan`, SHA-256
`3c5cb4bf1591e6b8d18f17cd51278b8cb589f2776105e70f3c03e669dd0fbd19`, serial 1218:

- 9 updates. The only Lambda code change is `native-runs-dev-execution`, whose bundle diff is exactly the allowlist entries. The other 7 Lambdas have identical code, plus the platform runtime update.
- 21 helper/image replacements. Image `bf5f43800975c7dc` is built locally as `sha256:7a157d72…`, and its files match the checkout.

Validation: native foundation 5,486/5,486; targeted agentcore 139/139.

An independent review recommended approval. It confirmed that a non-zero codex exit is still rejected and that `turn.completed` is still required. Its follow-up: the intake instruction should use a `--` delimiter. After the lead's approval the plan was applied: 21 added, 9 changed, 21 destroyed. Post-apply checks:

- Runtime 124 is READY on the reviewed build.
- 42/42 Lambdas, 7/7 IAM checks and 15/15 wiring checks pass.
- 4 retained records are unchanged, and 4 pins are present.

### Live run after all fixes — 6 October 2026 (intent `4fb0096a-73e4-4d41-a740-dccddba5ac22`, t3d image)

What now works end to end:

- **Turn 1:** the structured plan choice.
- **Cold recovery after about 15 h idle:** the controller saw `SESSION_LOST` and restored automatically. There was no pin error, and the turn ran.
- **`compose`:** routed through `next compose` and dispatched the composer, which proposed a 7-stage read-only plan.
- **Plan Approval as a structured choice (Approve / Edit the grid / Reject).** Member `jwthewes@amazon.de` selected Approve. The selection reached member `jwthewes+b@amazon.de` in 462 ms after a reload, and `+b` submitted `Approve` with selection `[0]` (07:31:16Z).
- **A second automatic cold recovery** (07:31:38 → 07:35:37). The engine then recorded the approval, created the workflow (`moving-pipes-requirements-only`, 7 of 33 stages, 4 approval gates) and started Intent Capture.

What stopped it:

- **The runtime container died mid-turn without a trace**, about 6 min after harness launch and about 10 min after the recovery invoke.
  - The runtime log ends at `firstOutput`. Status calls returned AgentCore 424 three times, then a fresh process reported `native_execution_existing_owner`.
  - The controller correctly classed it as `DELIVERY_UNCERTAIN`, with `canRecover: false`, because a pre-turn checkpoint cannot be replayed after the workspace changed. This fixture is therefore terminal.
- **What has been ruled out:**
  - The session limits: idle is 900 s with roughly 10 s polling, and `maxLifetime` is 28800 s.
  - AgentCore `SystemErrors`: the count is 0.
- **Still a candidate:** memory or CPU pressure from codex dispatching workflow subagents. Per-minute memory data is not yet available.

Open findings, not yet fixed:

1. **Container death mid-turn.** It needs root-causing, through microVM memory, process accounting or a harness-side heartbeat.
2. **`DELIVERY_UNCERTAIN` is terminal for members.** A protected "restore the last checkpoint and re-send the same accepted reply" action, requiring an explicit member decision, would make this recoverable without a blind replay.
3. **Account switch without a reload.** When the member in a tab changes, that tab keeps its previous Yjs connection, so shared selections stop arriving until the page reloads. Realtime state should be reset when the authenticated identity changes.
4. **Startup cost:** each cold recovery takes 3–4 min, mostly the package reinstall.

### Root-causing the mid-turn container death: evidence collection (t3f approved and applied)

Platform data cannot explain the death:

- Session limits are ruled out: idle is 900 s with roughly 10 s polling, and `maxLifetime` is 8 h.
- `/ping` correctly reports `HealthyBusy` while busy.
- AgentCore `SystemErrors` is 0.
- The `MemoryUsed-GBHours` metric shows the 8 GB allocation for every session, so it cannot show real usage.
- The runtime log ends without a line, and the node server process itself restarted. That points to a kill of the server process or a microVM recycle, not a child failure.

**Change: diagnostics only.** A new module, `native/resource-telemetry.js`, logs fixed-schema numeric samples:

- **When:** at boot (including system uptime, which separates a microVM restart from a process restart), every 15 s while busy, and once on return to idle.
- **What:** cgroup v2 memory current/max/peak with the `oom`/`oom_kill` counters, RSS and heap, free memory, load, process count, and free bytes on `/`, `/tmp` and the homes disk.
- **SIGTERM** is logged and then re-raised with the default disposition.

Verification:

- Inside the runtime image with a 2 GB limit, the sampler reported cgroup max/peak and the OOM counters.
- Tests: native foundation 120 files / 5,492; targeted agentcore 166.

Plan `.native-evidence/deploy-t3e/native-t3e.tfplan`, SHA-256
`899f5dd183dc5220aecce095e75127d38bc4ceeadc2d95a963278f9cf08f93aa`, serial 1221:

- 9 updates: 8 Lambdas with identical code, plus the platform runtime.
- 9 helper/image replacements. Image `dfcf945e6fd692fd` is built locally as `sha256:f69b1fd4…`.
- 5 pins are present, and 4 retained records are unchanged.

The independent review of t3e recommended approval. Its follow-up: if the microVM runs the container in the root cgroup, the cgroup OOM counters are null. The sampler therefore also reads the kernel-wide `oom_kill` counter from `/proc/vmstat`; its in-image output is saved in `.native-evidence/t3f/in-image-sample.json`.

Superseding plan `.native-evidence/deploy-t3f/native-t3f.tfplan`, SHA-256 `3f7bbbf13f83833b445c96d2bfc171afb2f660e2b691f5479ae1c9e1926e3cbb`, serial 1221:

- The same shape as t3e: 9 updates (8 Lambdas with identical code, plus the platform runtime) and 9 helper/image replacements.
- Image `d9da4efd10d49c4e` is built locally as `sha256:d68c6432…`.
- t3e is not applied.

An independent delta review recommended approval. After the lead's approval t3f was applied: 9 added, 9 changed, 9 destroyed. Post-apply checks:

- Runtime 125 is READY on the reviewed build.
- 42/42 Lambdas, 7/7 IAM checks and 15/15 wiring checks pass.
- 4 retained records are unchanged, and 5 pins are present.

### Live run with telemetry — 6 October 2026 (intent `da2f81e2-cf81-414c-9dc8-f8eebce8eeda`, t3f image)

Two members (`jwthewes@amazon.de` and `jwthewes+b@amazon.de`) drove the run on the warm path, alternating who selected and who submitted. Every shared selection reached the other window in 206–219 ms, with presence shown.

The answers given, in order:

- plan choice: `compose`;
- Plan Approval: `Approve`;
- answer mode: `Guide me`;
- Intent Q1–Q4, plus a Q5 the workflow added itself to resolve a conflict between Q2 and Q4;
- the pre-generation summary: `Looks correct`.

**Telemetry evidence for the earlier container death.**

- The microVM has 8 GB of RAM, the container has no memory limit of its own (`cgroup max: null`), and the local disk has about 6 GB free.
- Memory scales with the codex process tree. During the composer and workflow-creation turn, the peak rose 0.9 → 1.8 → 3.3 → 5.6 GB as processes grew from 3 to 68. The highest sampled usage was 4.6 GB, free memory fell to 3.4 GB, and there were no OOM kills.
- This is the leading root cause for the silent mid-turn death on 5–6 October: a burst from parallel subagents and tool shells exhausts the microVM's memory. It has not yet been reproduced as a kill.
- **Fix direction:** cap codex subagent and tool concurrency for native runs, or bound the process tree's memory so a burst fails the turn visibly instead of killing the runtime.
- AgentCore also boots about 11 warm microVMs per runtime session group, each logging its own boot sample. This is informational.

**The stage then stopped short of its gate.**

1. **Upstream (AI-DLC 2.9.0):** `aidlc engine review-brief` fails with "aidlc-review-brief.ts does not export main(argv)". The engine route table maps it to `TOOLS.reviewBrief` (`aidlc.ts:1000-1005`), but the dispatcher's module switch has no case for it. The agent worked around it.
2. **The product-lead reviewer** returned no review on its first attempt, about 15 min. Under the protocol the conductor retried, and the second attempt returned NOT-READY.
3. **Blocking:** `runtime-graph.json` is never produced, so `learnings surface` refuses and the stage cannot reach approval. It is written by the PostToolUse `rebuild-stage-graph` hook (matcher `Bash`), and the in-run doctor says that hook "is not firing on this harness".
   - An in-image probe (`.native-evidence/t3f/hook-probe.log`) shows codex 0.145 does fire project hooks under `--dangerously-bypass-hook-trust`: SessionStart wrote `aidlc/.aidlc-sessions` bindings with and without seeded trust. So hook trust is not the cause; the harness note about 0.137–0.139 is outdated for 0.145.
   - The remaining suspect is the PostToolUse tool-name matcher (`Bash`) against codex 0.145's shell tool name. Under investigation.
   - Separately, seeding the projected hook trust (`.codex/trust-seed.toml` into the codex home, verified by `aidlc config trust --check`) is implemented and tested locally, but not deployed.
4. **Display finding:** the response cites the private runtime path `/mnt/native/project/...` in a link. This is the known task-3 item to rewrite such citations into artifact links.

**Root cause of the missing runtime graph: upstream AI-DLC 2.9.0, now proven.**

- Research into codex 0.145 source shows `matcher: "Bash"` does fire: `exec_command` and `shell_command` report `tool_name: "Bash"`, and hooks are enabled by default.
- `rebuild-stage-graph` therefore runs, but it compiles only after _transition_ commands (`classifyRuntimeCompileCommand`: `state|jump|bolt|unit|recompose|report|orchestrate report|config set`). It deliberately excludes `intent create`.
- So a fresh workflow reaches its first stage's learnings step with no `runtime-graph.json`.
- The doctor's remediation, `aidlc engine graph compile`, is the wrong tool; `aidlc engine runtime compile` writes the file.
- Sandbox proof: after `intent create` and `next`, `learnings surface` fails; `runtime compile` creates the file and `learnings surface` succeeds.
- **Lead decision:** unblock this fixture with a member reply only, and defer the runtime fix.

**The engine gate was demonstrated live, with two members:**

- The member reply (`runtime compile`, then resume) unblocked Intent Capture. The agent compiled the graph, surfaced the stage notes, and recorded the multi-question notes choice (selection `[0],[0]`).
- **The engine-held approval gate was presented:** `pendingInput` with `kind: approval`, `source: engine-gate`, `stage: intent-capture`, options Approve / Request Changes. Both members saw it, with no free-text box.
- Member `jwthewes@amazon.de` chose **Request Changes** with feedback (selection `[1]` plus `freeText`). The engine recorded `orchestrate report --stage intent-capture --result rejected --user-input 'Request Changes' --reason '<feedback>'`.
- The revision asked a three-question structured choice for the numeric targets (150 px gap, 220 px spacing, 120 px/s). It hit an engine provenance guard (the unchanged stakeholder map was bound to the earlier confirmation) and offered the recovery "Redo Intent Capture"; a member chose it. The stage restarted with the answers kept, and the new confirmation was accepted.
- **Open:** the fresh product-lead re-review has been silent for over 30 minutes. The first round also needed a retry and ended in a fallback after "temporary service errors".
  - The reviewer roles pin `model = "openai.gpt-5.6-terra"`, while the run uses `openai.gpt-5.6-sol`. Both are ACTIVE and AUTHORIZED, inference-profile only.
  - Sub-agent output is not visible in the native activity stream, so the reviewer's failure mode cannot be seen. Surfacing sub-agent errors is a follow-up.
- **Remaining for the gate demo:** the second member approves the re-presented gate, and the engine's `approved` report is checked.

### Memory spikes explained (6 October 2026)

Measured inside the runtime image with the pinned linux-arm64 2.9.0 release. Logs: `.native-evidence/t3f/mem-probe.log` and `mem-burst.log`.

- **Cost of one hook:** each AI-DLC codex hook is a full start of the `aidlc` Bun binary, about 200 MB RSS and roughly 250 MB of unique anonymous memory, for 0.3–0.4 s. That holds even when the hook immediately decides there is nothing to do. For comparison, `aidlc --version` uses 56 MB and `codex --version` 49 MB.
- **Hooks per shell command:** the projection registers five PreToolUse hooks for every Bash tool call: `bind-bash-session`, plus four with no matcher (`state-transition-guard`, `reviewer-scope`, `review-freeze`, `plan-approval-guard`). It also registers PostToolUse `rebuild-stage-graph`. Engine commands the agent runs (`aidlc engine …`) cost another ~200 MB each.
- **Concurrency:** codex 0.145 runs all matching handlers of one event concurrently (`codex-rs/hooks/src/engine/dispatcher.rs:89-117`, `FuturesUnordered`).
- **Measured bursts** (container anonymous memory over baseline): 1 shell call (5 hooks) +1.27 GB; 2 calls +1.52 GB; 4 calls +2.91 GB; 8 calls (40 hooks) +5.07 GB.
- **Fit with the live run:** the run peaked at 5.6 GB with 42–68 processes. Sampled usage stayed low because each burst lasts under a second, so only the peak counter caught it.
- **Why it is not visible locally:** a single interactive session rarely issues many parallel tool calls, the bursts last under a second, and macOS memory compression hides them. In the native runtime, parallel tool calls, sub-agents and five concurrent hooks per call stack inside an 8 GB microVM.
- **2.10.0** is lighter but has the same shape: about 140 MB per hook, and 8 concurrent shell calls cost +3.07 GB (2.9.0: +5.07 GB). Logs: `.native-evidence/upstream/`.
- **Reported upstream** at the lead's request: https://github.com/awslabs/aidlc-workflows/issues/2066. It is the Codex counterpart of #1180/#2022; #1946 fixed only Kiro IDE's two PostToolUse hooks.
- **Mitigation (lead decision: thread limit only, 4).** Native codex runs pass `-c agents.max_threads=4` (codex default 6).
  - In-image proof that the key is honoured: `=0` is rejected with "agents.max_concurrent_threads_per_session must be at least 1".
  - The executor diff against the deployed t3f image is only that flag. The hook-trust change is excluded and saved in `.native-tmp/hook-trust/`.
  - Plan `.native-evidence/deploy-t3g/native-t3g.tfplan`, SHA-256 `66c16827f2ba5167e60ef8dd7d0219327a6e4e222b1045b83b1f10501b940c68`, serial 1223: 9 updates (8 Lambdas with identical code, plus the runtime) and 5 helper/image replacements. Image `81e5da7d530e18fe` is built locally as `sha256:9569ceab…`.
  - Tests: native foundation 5,493/5,493; targeted agentcore 167/167.
  - An independent review recommended approval. At the limit, codex returns "agent thread limit reached" to the model and the turn continues.
  - **Approved by the lead and applied:** 5 added, 9 changed, 5 destroyed. Runtime 126 is READY on the reviewed build. 42/42 Lambdas, 7/7 IAM checks and 15/15 wiring checks pass. 4 retained records are unchanged, and 6 pins are present.

### 7 October 2026: gate demo completed; thread limit measured; mid-turn death persists

**The approval gate demo is complete** (fixture `da2f81e2`):

1. After its slow reviewer finished, the run presented the engine gate again.
2. `jwthewes+b@amazon.de` approved. This followed `jwthewes@amazon.de`'s Request Changes round the previous day.
3. The engine recorded `orchestrate report --stage intent-capture --result approved --user-input 'Approve'` and reported "Intent Capture approved. Progress 4/6 in-scope stages".
4. The product-lead review again "timed out twice"; that is an open finding.

**Fresh intent `f1d3504c-82ce-4312-b85d-c5bee417ead1` on the t3g image** (codex `agents.max_threads=4`):

- The plan choice used reworded labels ("Compose a tailored plan" …). Routing still worked: the composer ran and Plan Approval followed.
- **Memory with the limit:** during the workflow-creation turn, the peak stayed at **2.5 GB with up to 12 processes**. On the old image it reached 5.6 GB with 42–68 processes.
- **The runtime still died mid-turn**, and the evidence argues against memory as the cause:
  - The serving microVM (`…90db090233`, booted 09:28:16) logged its last sample at 09:46:46: 702 MB used, 7.3 GB free, 4 processes, zero kernel and cgroup OOM kills.
  - Then nothing: no further samples and no SIGTERM line.
  - Status calls returned AgentCore 424 from 09:47:18. At 09:48:11 the session was served by a pre-warmed microVM (`…9fc3723380`, booted 09:28:02), which reported `existing_owner`. The controller classed it as DELIVERY_UNCERTAIN and stopped that VM (its SIGTERM was logged, `busy: false`).
  - **This fits a VM that froze or was hard-killed within a ~30 s window**: the sampler stopped and the SIGTERM handler never ran.
- **Ruled out:**
  - Session limits.
  - EFS throttling: elastic mode, 5 GiB/s permitted, PercentIOLimit ≈ 0%.
  - Steady-state memory.
- **Not ruled out:** a sub-15-second memory burst that drove the guest into thrashing before any OOM kill, or an AgentCore health-check kill.
- **Next diagnostic:** a flight recorder. Sample every second to a small file on EFS, and have the next process on the same session (the warm VM that takes over) log the previous VM's last seconds at boot.

**Flight recorder (plan t3h prepared, not applied; lead: "Stability is core").**

- **New `native/flight-recorder.js`.** Every second while busy (every 15 s when idle) it takes a numeric sample:
  - event-loop lag;
  - cgroup memory used, free memory and server RSS;
  - load and the kernel OOM counter;
  - per-category process count and RSS (`codex|aidlc|node|shell|git|other`, from `/proc/<pid>/status`; never names, arguments or paths).
- **Storage:** a 120-sample ring at `/mnt/native/.native-flight/recorder.json` (mode 0700, atomic temp file plus rename).
- **At boot:** a ring left by another boot is logged as `native.flight.previous`, with its last 60 samples and the gap to this boot.
- **15 s telemetry:** each sample now carries `window` maxima (lag, memory, processes) since the previous sample.
- **In-image proof** (`.native-evidence/t3h/flight-probe.log`): real aidlc hook bursts plus a 3 s loop freeze, then SIGKILL. The successor's boot reported the dead process's ring: 85 processes (82 aidlc), 5,981 MB peak, 2,490 ms lag, last sample 477 ms before the successor booted. Under an 85-process burst sampling slows (8 samples in about 11 s), but bursts are still captured.
- **Tests:** native foundation 121 files / 5,504; targeted agentcore 178.
- **Plan** `.native-evidence/deploy-t3h/native-t3h.tfplan`, SHA-256 `e7673958645ffbffc912a4df95749ecc4b2ceed7065f94afb5e083326cb54452`, serial 1225:
  - 9 updates: 8 Lambdas with identical code, plus the runtime.
  - 5 helper/image replacements. Image `bec7cb8375610f78` is built locally as `sha256:1c8eed6d…`; it differs from t3g only in the three telemetry files.
  - 7 pins are present, and 4 retained records are unchanged.
- **The t3h review recommended approval, with three findings, now fixed and superseded by t3i:**
  - **P2:** replayed ring samples came from an agent-writable file and were logged unvalidated. They are now rebuilt from the numeric fields and the six fixed keys only.
  - Overlapping `/proc` scans are now guarded.
  - Stale temp files are now removed at boot.
  - The tamper test fails without the fix. The in-image probe still reports the dead process's ring (`.native-evidence/t3i/flight-probe.log`). Native foundation 5,506; targeted 180.
- **Plan** `.native-evidence/deploy-t3i/native-t3i.tfplan`, SHA-256 `334f5d093c24b22ed9508189d9dd8bf667a11692ed022e70965fd31e20daf4e9`, serial 1225:
  - The same shape as t3h. Image `645aa40f67358c53` is built locally as `sha256:0cb6fea7…`.
  - t3h will not be applied.
- **The t3i review recommended approval.** Its two P3 findings are fixed and superseded by t3j:
  - The lag of ticks skipped during a slow scan is now carried into the next sample, so a stall that ends mid-scan is no longer lost.
  - Scans time out after 10 s, so one hung read cannot silence the recorder.
  - Both new tests fail without the fix. The in-image probe after SIGKILL replayed the dead process's ring with 2,738 ms lag and **2 kernel OOM kills during the burst** (7 GB container limit).
  - Native foundation 5,508; targeted 182.
- **Plan** `.native-evidence/deploy-t3j/native-t3j.tfplan`, SHA-256 `fb3941192e17823beddefddfc766a977b37bf6d3f20762623e83c9a5af50abc4`, serial 1225:
  - The same shape. Image `105ec30c9087d097` is built locally as `sha256:5e5aae57…`.
  - t3i will not be applied.
- **The t3j review recommended approval.** Its findings are fixed and superseded by t3k:
  - **P3-7, a regression introduced by the timeout:** abandoned scans could pile up and exhaust the libuv thread pool. Now no new scan starts while a timed-out one is pending; the recorder takes lag-only samples instead.
  - **P3-6:** the lag of a failed or timed-out scan is now carried forward.
  - Both new tests fail without their fix.
  - Fake-timer tests use instant writes to avoid a timing hazard that surfaced under load. The foundation suite passed twice in a row (5,509); targeted 183.
- **Plan** `.native-evidence/deploy-t3k/native-t3k.tfplan`, SHA-256 `e9b2a43b0c0619d0c0df08749fc5eb871f2fe343ab14cbdd0cbacd3f81743a58`, serial 1225:
  - Re-planned after the test-only edit. Image `42d37f1cff14b385` is built locally as `sha256:d500086a…`.
  - t3j will not be applied.
- **The t3k review recommended approval.** Its residual was that one scan read every `/proc/<pid>/status` concurrently. The lead chose to fix it first, giving t3l:
  - **Strictly serial reads were tried first.** In that single probe run the recorder took 2 samples and missed the burst. That run's log was overwritten, so it has no receipt. It is also ambiguous: it fits the container-wide stall seen below as well as it fits serial reads being too slow. Bounded concurrency was chosen as the safer design either way.
  - **Final design:** at most 2 reads in flight, a 700 ms per-scan budget (`procs` is always the full count; a new `scanned` field says how many were read), and a 3 s stuck-scan timeout.
- **Probe finding** (`.native-evidence/t3l/flight-probe.log`, 4 burst runs in the t3g image, 7 GB container limit):
  - **In 2 runs the whole container stalled for 12–20 s with no OOM kill.** The last sample before the stall showed 4.3–5.2 GB used and load up to 18. This is a local reproduction of the silent mid-turn freeze under a hook burst.
  - In the other 2 runs the recorder took 8 samples on schedule, with a burst of 42–45 processes and 6.1–6.3 GB, plus the 2.49 s freeze.
- **Tests:** foundation passed twice (5,511); targeted 185.
- **Plan** `.native-evidence/deploy-t3l/native-t3l.tfplan`, SHA-256 `3a9d512ec83d58896880fc41a9348c296404ec49102db93e7d3d391d7ac7fdec`, serial 1225. Image `1494e2331854c0ae` is built locally as `sha256:cde6bd07…`. t3k will not be applied.
- **An independent review recommended approval.** It confirmed at most 2 `/proc` reads in flight across scans, and at most 3 of libuv's 4 threads used by the recorder in the worst case. **Approved by the lead and applied:** 5 added, 9 changed, 5 destroyed. Runtime 127 is READY on the reviewed build. 42/42 Lambdas, 7/7 IAM checks and 15/15 wiring checks pass. 4 retained records are unchanged, and 7 pins are present.
- **Stability run on 2.9.0** (intent `7426e54d`, t3l image): no death in about 50 min on one microVM. Peak 5.5 GB with 68 processes, lag at most 6 ms, 0 OOM kills. It stopped at the known missing-`runtime-graph.json` gap before the gate.

### 12 October 2026: AI-DLC 2.11.0 adopted for new runs (no deploy)

The package version is pinned per draft from a verified project import, not baked into the image. Existing runs keep 2.9.0.

- **Local checks in the t3l image** (`.native-evidence/upstream/`):
  - The executor's own `use`, `config --pin` and `config --harness codex` commands succeed, and all 18 initialization checks pass, the same as on 2.9.0 (`init-check-codex.log`).
  - **Hook memory:** 139 MB per hook. 8 concurrent shell calls cost +2.99 GB (2.9.0: +5.07 GB). There are still five PreToolUse hooks per shell call: the upstream fix for #2066 (PR 2076) is not in the `v2.11.0` tag (`mem-2.11.0.log`).
  - **`learnings surface` no longer needs `runtime-graph.json`.** The doctor now names the correct `runtime compile` fix (`graph-probe3-2.11.0.log`).
  - **New in 2.11.0:** `orchestrate next` stops if the workflow progressed with no hook heartbeat, and tells the person to trust hooks in Codex `/hooks`. Live codex runs write heartbeats under `--dangerously-bypass-hook-trust`, so this check passes.
- **Import:** job `667b4ddd`, package `sha256:9fdb284f…`, release `v2.11.0`, commit `6a378b53`. Integrity is verified; the signature is `not_checked`.
- **Live run, intent `83e1e7d3-fcd0-4422-bb26-aaf8ac7de6d8`:**
  - It reached the engine-held Intent Capture approval gate (`pendingInput` kind `approval`, source `engine-gate`) in 43 min with no workaround.
  - Path: compose plan, plan approval, Guide me, 4 answers, then the product-lead review.
  - One microVM throughout: peak 3.4 GB (36 processes), 0 OOM kills, no successor boot.
- **Gap found, fixed locally but not deployed:** the 2.11.0 plan offer has 12 options (compose plus 11 plans). The structured-input limit was 10, so the spec was dropped and the member had to reply in free text (`compose`).
  - `optionsMax` is now 16 in `lambda/shared/native-pending-input.js` and its frontend mirror.
  - Each side has a regression test. Backend 9/9 and frontend 5/5 pass.

## Milestone 2 checkpoint — 1 October 2026: shared replies, artifact discussion and Quorum

**Code, focused validation and the reviewed dev deployment are complete in
retained checkout `mc-orch-b4c0d660dcfa`. The lead approved the exact saved plan
below, which was applied and verified. The two-member live demonstration ran on
5 October 2026 (below): shared drafts, one accepted answer, revision-anchored
discussion and Claude Quorum passed. Default (codex) Quorum failed; its fix is
planned and awaits lead approval.** Milestone 1
also remains not fully qualified (see below). Tasks 3–5 have not started. No
existing run, retained pin, workflow or checkpoint was changed; no commit, push,
branch, worktree, worker or Publish action was performed.

### Contracts delivered

| Area                           | Contract                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Protected collaboration access | `lambda/shared/native-realtime-ownership.js` `resolveNativeCollaborationAccess`: current membership snapshot first (no ID oracle for nonmembers), then the protected RUNTIME binding and EXECUTION row (consistent reads); a changed binding generation or a recreated project identity is denied. Discussions, Quorum context and reply-draft tokens all use it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Native Yjs documents           | `native-reply-<digest>-<interactionId>-<sequence>` requires exactly `native-reply:<digest>:<interactionId>:<sequence>`; `native-discussion-<digest>-<discussionId>` requires `native-collab:<digest>`. `<digest>` is the protected binding digest `sha256(JSON [projectId, intentId])`, so a reused ID in another project never shares a document. Both parser copies (`lambda/shared/realtime-token.js`, `lambda/yjs-server/realtime-token.js`) are pinned by the same vectors. Native channel tokens never open a reply draft, a platform `intent-*` document or another project.                                                                                                                                                                                                                                                                                                                         |
| Reply-draft token              | `POST …/intents/{intentId}/realtime-token` with exactly `{executionBackend:'native', document:{kind:'reply', interactionId, sequence}}` (intents Lambda). The reply scope is minted only when the protected row is `AWAITING_USER`, not cancelled, and its current interaction ID and turn equal the request; otherwise 409. Malformed requests are 400; a platform target can never receive a reply scope.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Shared reply draft             | `NativeInteractionPanel` binds the existing `CollaborativeTextarea`/presence to that document for the life of one unanswered interaction, so transient status changes (image policy, refresh) do not drop the draft; editing and submission stay gated on the verified awaiting state. Submission freezes the shared value into the unchanged `{requestId, interactionId, contentSha256, text}` request; a retry resends exactly those bytes, even if collaborators keep editing.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Accepted answer                | Still one `RESPONSE#<interactionId>` conditional transaction (one accepted action, one continuation). The immutable ledger item now also freezes the accepting membership snapshot `{membershipId, projectIdentity}` and the presented `publicationId`; the execution pointer keeps its established shape, and earlier unattributed ledgers (retained run `9a36…`) remain valid. The continuation is queued before the post-commit membership read-back, so a revocation racing an accepted reply can no longer strand it in `DISPATCHING`; the revoked caller still receives no result. Acceptance is the authority point: the worker does not re-authorize the responder after acceptance.                                                                                                                                                                                                                |
| Native discussions             | New API resources `/projects/{projectId}/native-intents/{intentId}/discussions*` (discussions Lambda). Threads hang off a dedicated `NativeDiscussionRoot` that only this Lambda writes, created lazily under an execution-wide creation guard (exactly one root under concurrent first threads). An artifact thread is one revision `<fileId>:<sha256>`, verified against the named protected publication (current row, or its immutable `PUBLICATION#<sequence>` history row) and stored with path, hash, publication ID and sequence. Older-revision threads stay distinct and readable after files change. Fan-out uses only `native-intent:<projectId>:<intentId>`. The platform intent routes now refuse any ID with a protected native record (previously a native ID reached them through the path-project fallback).                                                                               |
| Quorum                         | User-invoked on every native artifact revision, including generic and binary files. It runs in the shared platform discussion runtime (session `aidlc-discuss-native-<hash>`), never the native writer. Its payload carries only the verified selected revision (text up to 12 KiB, marked if truncated; binary/over-3 MiB files are named, not read) and the thread's own messages; no MCP graph/process bridge (`mcpEntry: null`), intent map, process events or META. The credential is resolved for the requesting member through the existing broker; the CLI defaults to the run's harness; the grant is bound to the native root ID. An unverifiable revision fails visibly instead of substituting other bytes. Quorum cannot approve, apply or answer: no edit/apply, approval, parallel or per-unit PR route exists under the native tree, and native capabilities remain disabled in UI and API. |

### Draft lifecycle limits

These are the existing Yjs semantics, verified rather than extended. **Drafts
are not durable.** Yjs documents live in the single Yjs task's memory: a draft
survives reconnects and is restored while at least one client is connected or
within the 60-second last-client grace period, and is lost after every client
has left for longer than that, or when the Yjs task restarts. **Applying the
milestone-2 plan replaces the Yjs task definition and therefore drops every
in-flight draft at rollout.** Accepted answers and discussion messages keep
their durable records. Further limits:

- One draft per interaction and turn; a new turn always starts empty, and an
  old turn's text is never carried over. After acceptance each tab shows the
  protected receipt; a member's different unsent text stays visible locally.
- A stale tab cannot obtain a reply scope for a changed interaction and cannot
  submit (the protected response check is unchanged). An already-connected
  stale socket can keep editing a dead document until its 10-minute token
  expires and the server closes it with 4401.
- A revoked member's open Yjs/app-WebSocket connections end only at token expiry
  (≤ 10 minutes), the same as platform collaboration; REST, token issuance,
  thread creation, messages and Quorum deny immediately. Native discussion
  messages are delivered with content on the native channel (platform parity),
  unlike the content-free native activity hints.

### Validation receipts

All under `.native-evidence/m2/` in this checkout:

| Receipt                     | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `native-foundation.log`     | **117 files, 5,447 tests passed** (milestone-1 receipt: 112 files, 5,231). Adds reply-ledger attribution and revocation race, revision reads, native document grammar parity, reply-token minting, Quorum native mode, and the no-bridge materializer.                                                                                                                                                                                                                               |
| `collaboration-backend.log` | Real gremlin-server/DynamoDB Local: discussions, intents, ws-connection and yjs-server — **576 passed, 3 failed (inherited)**. The new `native-discussions.test.js` (11 tests) covers two-member threads, revision anchors, unverifiable/forged anchors, concurrent first threads (one root), nonmember/revoked/recreated/foreign-project denial, same-ID project isolation, platform-route refusal, verified-only Quorum context, required CLI, visible failure and revoked Quorum. |
| `frontend-tests.log`        | **102 files, 1,235 tests passed**, including `AppShell.native-collaboration.test.tsx`: two members edit one revision-specific draft with presence, one submission of the shared value, both see the same accepted receipt; a changed interaction gets a new draft; reconnect within retention vs. loss after expiry; native Discuss/Quorum on the exact displayed revision with native-only documents and routes.                                                                    |
| `frontend-build.log`        | TypeScript and production build passed; existing large-chunk warning.                                                                                                                                                                                                                                                                                                                                                                                                                |

Inherited failures, not regressions:

- **Three platform Quorum cases** in `lambda/discussions/test/discussions.test.js`. That file is unchanged from HEAD, and its cases seed no platform META. The inherited, previously reviewed guard `discussionRuntimeTargetFor` is byte-identical to the original selected checkout (where it is already modified against HEAD). It intentionally refuses to dispatch unknown intent data when META is missing, and `services.test.js` asserts that behaviour.
- **`test_api_cannot_redeem_credentials_or_write_publications`** in `terraform/modules/compute/native-runs/tests`. It expects no `dynamodb:Query`, but milestone 1 added and reviewed the native output-history `Query` grant. This session did not change the native-runs Terraform.
- **`terraform fmt` drift** on inherited lines in `modules/api/lambda/main.tf`, `variables.tf` and `native-intents.tf`. New files are formatted. Nothing was reformatted after planning, because the saved plan embeds the reviewed configuration.

### Reviewed dev plan (approved by the lead and applied)

Prepared with `scripts/deploy-terraform.sh dev --phase plan --skip-seed`
(`AIDLC_KEEP_PLAN=1`, `AWS_PROFILE=solution AWS_REGION=us-east-1`, checkout-local
Terraform data/plugin/temp/npm caches). The repository destruction check passed.
Files are in `.native-evidence/deploy-m2/`; `review-handoff.json` indexes all digests.

| Artifact                                                       | Identity                                                                                                                                                                                                                              |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `native-m2.tfplan`                                             | SHA-256 `bfd1b3705a7c8973b16e85a07c12efcd544322560500bba3c7ab743dbfb13b85`; state lineage `e83979b6-e79b-4dbd-e03f-8442c74f741c`, serial **1187** (the milestone-1 post-apply serial; no drift)                                       |
| `archive-manifest.json`                                        | SHA-256 `8e7963b6e5db8c6507a5648fa408a78803def0385d89c2f091563f2fe499e3d8`; 42 archives, each with the exact saved-plan preparation-query digest                                                                                      |
| `frontend-assets.json`                                         | SHA-256 `527c8ff556abcf8f9a282a12760c3d5284b019014e246226972aaedcb29ed8af`; 518 files; unchanged `frontend/.env`                                                                                                                      |
| `runtime-image.json`                                           | Local Linux ARM64 build of planned tag `d4e114d719e223bd`, image ID `sha256:54dc8ba8667be852d3cddeb54c609866eec956be2ee70608f8a716e655001985`; changed runtime sources inside the image match the checkout byte for byte. Not pushed. |
| `retained-runs-preplan.json`, `referenced-images-preplan.json` | Both prior runs' four protected records unchanged; required pin `sha256:a226eb96…` present, zero missing                                                                                                                              |

Plan content:

- **54 creates:** the native discussion API resources, methods, integrations and CORS preflights.
- **30 Lambda updates.** The discussions Lambda gains only `NATIVE_EXECUTION_PUBLICATION_BUCKET=collaborative-ai-dlc-native-runs-dev-pub-49df4ac0` (matches the bucket in state) and `NATIVE_RUNTIME_ACCOUNT_ID`.
- **One IAM addition:** `s3:GetObjectVersion` on that bucket's `native-executions/*` only. Recovery and control prefixes are excluded.
- **Updates:** the API stage, the API deployment, and the platform AgentCore runtime artifact.
- **Packaging-helper replacements:** the same pattern as milestone 1.

No persistent data resource is deleted. Reviewer attention points:

- **AgentCore image:** rebuilt with the Quorum native-mode changes, `keep_remotely=true` before and after. The milestone-1 index `60217369…` and the retained pin remain in ECR. New native runs would pin the new image, whose digest is computed at apply. Existing runs keep their pins.
- **Yjs image and task definition:** replaced because the Yjs parser changed. The old Yjs image tag uses `keep_remotely=false`, so it is removed from ECR when replaced. The old task-definition revision is deregistered. The service rolls to the new revision, which drops in-memory drafts (see the draft lifecycle limits above).
- **API Gateway:** redeploys with the new routes (create-before-destroy).

### Applied deployment and post-apply verification

The pre-apply recheck matched the plan digest, all 42 archives and the retained
runs/pins. The lead approved the exact plan; it was applied with
`scripts/deploy-terraform.sh dev --phase apply --skip-seed` (`AIDLC_KEEP_PLAN=1`):
**166 added, 35 changed, 112 destroyed**, exactly the planned actions. The reseed
was skipped and the saved plan retained. `scripts/deploy-frontend.sh dev` then
deployed the frontend. Post-apply state: lineage unchanged, serial **1196**.

| Receipt (`.native-evidence/deploy-m2/`)                    | Result                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apply.log`, `frontend-deploy.log`                         | Exact reviewed plan applied; frontend deployed and CloudFront invalidated                                                                                                                                                                                                                                                                            |
| `deployed-lambda-hashes.json`                              | **42/42** Lambda CodeSha256 values match the reviewed archives                                                                                                                                                                                                                                                                                       |
| `deployed-frontend-assets.json`                            | **518/518** S3 files match; CloudFront index and all **27** entry assets match                                                                                                                                                                                                                                                                       |
| `deployed-native-iam.json`                                 | **Seven** native policies match the plan                                                                                                                                                                                                                                                                                                             |
| `deployed-wiring.json`                                     | **15** live wiring checks passed                                                                                                                                                                                                                                                                                                                     |
| `deployed-runtime-image.json`                              | Runtime version **119**, READY; tag `d4e114d719e223bd`, ECR index `sha256:43fd8c254907032777fa9bf2f39784f0bff00c522049d014b6ff1c5dab750f1e`; executable ARM64 manifest `sha256:bfcff9fe…` and config `sha256:ef816de7…` identical to the reviewed local build (only the BuildKit attestation index differs); native Lambdas reference the same image |
| `milestone2-live-checks.json`                              | Deployed discussions policy equals the plan, including the single `s3:GetObjectVersion` grant on `native-executions/*`; the discussions Lambda has the exact bucket/account/table env; all native discussion routes return **401** unauthenticated (not member-access proof); Yjs task definition revision 29 rollout COMPLETED, 1/1 running         |
| `retained-runs-after.json`, `referenced-images-after.json` | Both prior runs' four protected records unchanged; required pin `sha256:a226eb96…` present, zero missing; the milestone-1 index `sha256:60217369…` is still in ECR                                                                                                                                                                                   |

### Live demonstration — 5 October 2026

Run through the deployed app with Playwright: two isolated browser contexts,
signed in by the user as two distinct existing owners of project
`22371643-2db5-42a4-a571-e47fc35745f5` (`e4787488…` and `6498e4c8…`; the user
added the second account to the project for this demonstration). Three fresh
bounded intents, "M1 qualification sample 1–3" (`68ec3280…`, `724d2ba8…`,
`2a546dca…`), used the retained run's unchanged pins: source `f0370481…`
(binding revision `57fe01a1…`), package job `61f63842…`, Codex with
`openai.gpt-5.6-sol`. Receipts are in `.native-evidence/live/`. No identity was
created or reset and no gateway claims were constructed. The two prior runs'
protected records are unchanged. All three fixtures were left at a safe
`AWAITING_USER` boundary.

| Check                           | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared reply draft              | Both members edited one revision-specific draft. Window 2 saw window 1's text within 0.8 s and window 1 saw window 2's within 1.0 s (including typing). Each window showed the other's presence ("Also editing: …") and remote cursor, and both held the identical 156-byte text.                                                                                                                                                                           |
| One accepted answer             | The second member submitted the shared value: 202, `acceptedAt` 07:11:05.002Z, sequence 2, attributed to `6498e4c8…`. Both windows showed "Reply accepted. Delivery pending." with Send disabled. The next turn opened a new, empty shared draft with presence. Repeated in samples 2 and 3, with the sender alternating between members.                                                                                                                   |
| Artifact discussion             | The thread on `aidlc/spaces/default/memory/org.md` was verified server-side against the protected publication (SHA-256 `3ef5a32a…`, publication `060c83c4…`, sequence 1). The second member's message appeared in window 1 within 1.0 s.                                                                                                                                                                                                                    |
| Quorum                          | **Claude:** completed in about 12 s, grounded in the verified revision and the thread, and visible to both members. **Codex (the default, matching the run's harness): failed visibly twice**, cold and warm. Root cause: native Quorum ignored the run's model pin and fell back to project settings, which define no codex model; the failure reason was also not logged. Fixed in the pending plan below. No edit/apply or approval route was reachable. |
| Activity before completion      | Samples 2 and 3: the first parsed assistant message was visible in **both** members' Agent panels while the turn was RUNNING, within at most 6.2 s and 2.5 s of runtime capture. These bounds include polling and clock offset.                                                                                                                                                                                                                             |
| Durable history, reload, replay | Parsed activity was persisted throughout each turn. After a full reload, window 2 replayed all 16 ordered rows of both turns. Pagination beyond 64 rows was **unexercised**: the bounded task produced fewer rows.                                                                                                                                                                                                                                          |
| Old native URL                  | `/space/{projectId}/native-intent/{intentId}` opened the shared page in both windows.                                                                                                                                                                                                                                                                                                                                                                       |
| Cold recovery                   | For each sample, only that fixture's per-run session was stopped, after its checkpoint matched the publication. The next reply recovered through `RECOVERING` and was delivered once.                                                                                                                                                                                                                                                                       |

Findings:

- **Private runtime path in published interaction text.** The stored interaction text cites `/mnt/native/project/index.html:20`. The activity stream rewrites such paths, but the content-addressed interaction body does not. This should be fixed by translating citations to authorized artifact links at display time (task 3, artifact links).
- **Input protocol.** In sample 1's second turn, the agent called the engine with `report --result answered`. The engine rejected it, and that error became the turn's response. Accepted human input must be delivered through the pinned protocol (`report --user-input`) by task 3.
- **Discussion header copy.** The header still reads "messages are saved to the sprint graph", inherited text.
- **Not exercised live:** run switching while reads are outstanding, a fresh platform-intent regression run, other harnesses (Claude Code, OpenCode, Kiro), and live revocation. These remain pending.

### Timing samples (3 per path; initial samples, not SLA evidence)

From server `native.lifecycle` boundaries (`timing-3x3.json`). Harness wall time
includes model and tool time. Pure model inference time is unavailable.
Client-to-runtime comparisons carry clock-offset uncertainty. No timeout, token
or spending cutoff was introduced.

| Path / metric                                | Samples (s)             | Median    | Max       |
| -------------------------------------------- | ----------------------- | --------- | --------- |
| Fresh: prepare → READY                       | 103.0, 109.1, 97.6      | 103.0     | 109.1     |
| Fresh: start acknowledged → runtime accepted | 69.6, 67.8, 66.3        | 67.8      | 69.6      |
| Fresh: installation                          | 204.7, 184.8, 184.8     | 184.8     | 204.7     |
| Fresh: runtime accepted → harness launch     | 215.5, 192.4, 191.4     | 192.4     | 215.5     |
| Fresh: harness wall                          | 228.2, 250.3, 176.4     | 228.2     | 250.3     |
| Fresh: checkpoint upload                     | 15.6, 15.5, 13.4        | 15.5      | 15.6      |
| Warm: reply accepted → harness launch        | 5.5, 3.4, 10.4          | 5.5       | 10.4      |
| Warm: harness wall                           | 90.0, 127.9, 177.7      | 127.9     | 177.7     |
| Warm: harness done → checkpoint uploaded     | 34.2, 27.3, 26.7        | 27.3      | 34.2      |
| Cold: reply accepted → harness launch        | 252.7, 245.3, 233.7     | 245.3     | 252.7     |
| Cold: checkpoint download and verify         | 3.2, 3.3, 3.1           | 3.2       | 3.3       |
| Cold: filesystem restore                     | 20.8, 19.2, 18.8        | 19.2      | 20.8      |
| **Cold: restore done → runtime accepted**    | **194.7, 191.2, 182.3** | **191.2** | **194.7** |

The largest cold cost is idle reconciliation after the restore has finished:
21–22 repeated recovery dispatches at about 10.5 s intervals. Fresh-start cost is
dominated by installation. Both are candidates for the user's budget decision;
no optimization has been made.

### Pending Quorum fix (plan prepared, not applied)

Change:

- `lambda/discussions/handlers.js` passes the run's verified `{harness, model}`, taken from the protected execution configuration, as `nativeContext.runModel`.
- `discussion-assist-start.js` applies it only to that CLI, with strict validation, and logs the native failure reason code (never content).
- Tests: Quorum 9/9; native discussions 11/11 (real graph).

Saved plan `.native-evidence/deploy-m2b/native-m2b.tfplan`, SHA-256
`f84af64346bb11d1cc2faa43a7f2ceb3c88f33e34aac9bfb51cb2d9c7366574f`, state serial
**1196**. Destruction check passed.

What the plan does:

- **9 updates:** only the discussions Lambda changes code. The other 7 Lambdas are byte-identical and update only their image-digest environment values.
- **36 helper and image replacements.** The AgentCore image `a657ac45d25a4a32` is built locally as `sha256:39f2b9df…`, and its changed file matches the checkout. `keep_remotely=true` before and after.
- **No Yjs change.**

Required pins: `a226eb96…` (retained run) and `43fd8c25…` (the three demo intents), both present. Index:
`.native-evidence/deploy-m2b/review-handoff.json`.

## Milestone 1 recovery checkpoint — 1 October 2026

**Milestone 1 remains incomplete. The reviewed dev deployment and artifact
verification are complete; authenticated live runs, UI proof and timing samples
are blocked by unavailable existing-member access.** The selected worker checkout
`mc-orch-b4c0d660dcfa` contains the inherited modified/untracked foundation.
Before editing, the lead-identified 22-file delta from retained checkout
`mc-orch-f5262b756da7` was compared against that foundation and then imported.
The source is interrupted task `f5262b75-6da7-4aea-bf7b-ba7ba32e8045`,
session `dd618a1a-2ab7-4e1c-a996-b55376a47e20`. The retained checkout was
read only; no existing runs were changed.

The imported paths cover `.gitignore`, native activity and its tests,
controller image authorization/API/worker integration and tests, retained
runtime fixtures, the runtime-image inventory script and its tests, and the
Terraform inspector/image-retention tests. Original selected-checkout bytes,
the inherited Git status, and each imported SHA-256 are retained locally in
`.native-evidence/recovery-20261001/`. `receipt.json` records all 22 exact paths.
Both retained source fixtures match `provenance.json`: runtime-server
`67785da2060f5fc54ef2019a87c8d320a185b2d853c9b694b0584bc5eeb4ef4a`
and workspace-check
`7486e5e499c35a83906c3dbad1869b2d8e75d7b96d4f667b36f5f5fa0c194d44`.
This verifies fixture bytes, not live runtime compatibility.

### Current local implementation and validation

The setup blocker was resolved under the lead's explicit authorization. Root
and frontend dependencies were installed with `npm ci --ignore-scripts`, using
checkout-local npm/cache/temp directories. Required dev configuration was copied
from the lead-named source without printing values; no Terraform backend cache
or writable dependency link was copied. AWS account `746558295630` was freshly
verified using `solution` in `us-east-1`.

The retained partial activity implementation is now integrated with the shared
native workspace. `IntentContext` chooses explicit platform/native adapters;
`AppShell` routes existing `/space/:projectId/native-intent/:intentId` URLs to
`IntentView`, with the real Agent activity panel and transcript. Composer state,
access invalidation, run isolation and image-status changes at an unchanged
execution revision are covered. No synthetic workflow stages were introduced.

Native stdout uses the existing normalizers with bounded native-only parser
retention. Privacy filtering runs before display truncation, covers fragmented
fields/events, masks unresolved tails, and releases sparse safe activity after
an 80 ms batching delay. Unacknowledged output survives memory-cache overflow
and partial spool-write failure; older spooled events drain before newer memory
entries. The command runner awaits pressure promises and cancellation releases
waiters. ACP reads use a 64 KiB pull window and serialize asynchronous update
projection instead of exhausting callback slots on ordinary bursts. Permission
limits remain bounded; pressure-held projection has no deadline. The affected
142-test receipt is `.native-evidence/kiro-pressure.log`. Closed spool markers permit bounded cold replay; an unclosed cold
spool requires recovery review rather than endless catch-up.

Trusted ingestion owns durable OUTPUT records in the protected native bindings
table. Execution/attempt/epoch/session/writer/turn ownership, lease, immutable
retry hashes and cursor ordering are checked transactionally. Acknowledgment
follows persistence. The supervisor requires verified stream closure and a
final durable acknowledgment before exposing a waiting/terminal result or
advancing ownership. Transport retries poll status/output without resending the
model prompt. WebSocket messages are content-free invalidations; protected
history reads reauthorize access. Native token ownership resolves the protected
execution, without requiring a platform graph Intent. Platform fanout behavior
and parser defaults remain unchanged. Native runtimes have no broad process-table
or native-history DynamoDB grants.

The deployed REST token route maps to the **intents Lambda**, which now reads
protected native ownership with scoped `GetItem` permission and repeats
membership authorization before signing. Native tokens, socket admission,
fanout, frontend connection targets and token caches use
`native-intent:<projectId>:<intentId>`. Two projects may intentionally reuse an
intent ID without sharing even content-free hints. Platform `intent:<id>`
channels remain unchanged. Native tokens grant no global intent scope.
**Native Yjs document formats are intentionally not enabled**: task-2 must add
a protected, revision-specific document authorization contract before enabling
them. Existing platform/Yjs authorization remains separate.

Approved image pins remain eligible while referenced by resumable executions or
eligible checkpoints, without a fixed image-count limit. Revocation blocks
execution/renewal but leaves committed results readable. Policy-store failures
also preserve result reads. The ECR plan-inspector tests cover actual
`aws_ecr_repository` deletion and both replacement orderings; they do not delete
a live repository. No existing execution was mutated for these checks.

Current receipts, all inside this checkout:

| Receipt                                          | Result                                                                                                                                                                                 |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.native-evidence/native-foundation-final.log`   | **112 suites, 5,231 tests passed**, including native activity, retained router, store/worker, actual token handler, project namespace isolation, Codex/OpenCode/normalizer regressions |
| `.native-evidence/native-transport-boundary.log` | **54 backend tests passed**, including actual token handler, competing project IDs, socket admission, native fanout, protected ownership and history                                   |
| `.native-evidence/frontend-transport.log`        | **20 tests passed**, including qualified token/cache/connection targets, native activity and real routed shared-page composition                                                       |
| `.native-evidence/platform-token-regression.log` | **Four existing platform token integration tests passed** against local test services; 208 unrelated tests skipped                                                                     |
| `.native-evidence/frontend-final.log`            | **11 suites, 384 focused tests passed**, including actual routed shared-page composition and adapter tests                                                                             |
| `.native-evidence/frontend-routed.log`           | Eight routed/adapter checks passed; services only mocked in routed composition                                                                                                         |
| `.native-evidence/frontend-build-final.log`      | TypeScript and frontend production build passed; existing large-chunk warning                                                                                                          |
| `.native-evidence/backend-build.log`             | All four native control Lambda entry bundles built                                                                                                                                     |
| `.native-evidence/retained-router.log`           | Exact retained HTTP router test passed                                                                                                                                                 |
| `.native-evidence/image-retention-final.log`     | Image inventory and ECR destruction/replacement checks passed                                                                                                                          |

The prior receipts of 5,189 backend and 412 frontend tests remain historical;
the focused selections differ. The retained fixture's missing EFS import is
provided by an explicit test-only dependency bridge. Its pinned router and
workspace-check source bytes and provenance hashes are unchanged.

Read-only saved-configuration checks reproduce both historical configuration
hashes. For resumable run `9a36cf43-eacb-4b9d-a4e3-4b5ceaecb831`, the runtime
configuration hash `3510cec21ae6620ab01489089cc1717eb016d27ec33295a689c091c16ea10e53`
also matches the **actual versioned checkpoint manifest**
`f147ee2d90c3f7620bd043e18ca05a6b45cf232c77d3b0be94561b10deab73d9`.
Receipts are `.native-evidence/retained-configurations/checks.json` and
`.native-evidence/pinned-package.log`.

### Reviewed dev deployment and remaining live qualification

The lead independently approved the exact final dev plan and all referenced
archives/assets, then explicitly authorized apply. The plan was prepared using
`scripts/deploy-terraform.sh dev --phase plan --skip-seed`, with
`AIDLC_KEEP_PLAN=1`. macOS rejected Terraform provider sockets under the long
absolute temporary path; short relative `.native-tmp/` directories inside this
checkout resolved that failure. Provider/cache/backend data stay local.
**The exact approved plan has been applied to dev**, using
`AWS_PROFILE=solution AWS_REGION=us-east-1`, `AIDLC_KEEP_PLAN=1`, separate
plan/apply phases and `--skip-seed`. The original saved plan remains available.
No plan/source/archive/frontend inputs changed after review.

All review and deployment files below are relative to this checkout's
`.native-evidence/deploy/`. The original review receipts remain unchanged:

| Artifact                                                          | Identity / evidence                                                                                                                                                                                                     |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `native-m1-transport.tfplan`                                      | SHA-256 `538526619ccdd2680c0f0d54ef80187992c9d6d4013c5e9c6795a72e6b056042`                                                                                                                                              |
| Saved-plan state and fresh read                                   | Lineage `e83979b6-e79b-4dbd-e03f-8442c74f741c`, serial **1178**, dev account `746558295630`, `us-east-1`                                                                                                                |
| `archive-manifest.json`                                           | **42 archives**, SHA-256 `534846e9bd49c2aa75ef1dc4c68c08819a8ebcfcb7ab50f80ff99fc83fd76b6f`; contains each archive's SHA-256, Lambda CodeSha256, build recipe and exact saved-plan preparation-query digest             |
| `frontend-assets.json`                                            | **518 intended files**, SHA-256 `2f84ec03924516730394579c3364808fd9fe4ce86c7e16ca915914339d56b023`                                                                                                                      |
| `runtime-image.json`                                              | Local Linux ARM64 image tag `3660a368375068a8`, image ID `sha256:53376cb80625179cd3c8a4ec95ae30c96c0b0b6cad0a497eeb9167b7a60c5ef0` in `746558295630.dkr.ecr.us-east-1.amazonaws.com/collaborative-ai-dlc-agentcore-dev` |
| `review-handoff.json`                                             | Digests for 25 plan, archive, image, build and test receipts; supersedes all earlier `native-m1`, `native-m1-review` and `native-m1-final` plans                                                                        |
| `review-integrity.json`                                           | All reviewed artifacts, 42 archives, 518 frontend files and 177 runtime sources match                                                                                                                                   |
| `native-wiring-checks.json`                                       | **24 checks passed**, including actual token integration, scoped native owner IAM, output Cognito GET, source-only packages and runtime boundary                                                                        |
| `terraform-validation.json`                                       | Valid; zero errors, six provider deprecation warnings                                                                                                                                                                   |
| `archive-build.log`, `inspection.log`, `plan-review-summary.json` | Archive build, destruction check and resource/image changes                                                                                                                                                             |

The source-only packages module resolves all four native archive filenames
before apply. The two previously deferred API/worker archives are now known;
all 42 recipes match the preparation results embedded in this saved plan.
This plan updates 31 Lambdas and leaves 11 unchanged; all 42 remain in the
manifest. Eleven known planned byte hashes match; the remaining 31 hashes and
some environment maps are computed at apply. The wiring receipt therefore
checks exact embedded configuration and planned resource references where
values are unknown. Post-apply comparisons of the deployed environment values
and Lambda hashes are now complete.

There is **no persistent AWS resource deletion**. Replacement/removal actions
cover packaging helpers, the API deployment and Docker image resources.
The Yjs local Docker resource rebuild is caused by the absolute build
context/Dockerfile moving from the source checkout to this checkout, alongside
provider default normalization. Its image name/tag is unchanged; its registry
image, ECS service and task definition are all no-ops. No unrelated remote Yjs
rollout is planned. The native registry replacement has `keep_remotely=true`
both before and after. The fresh `referenced-images-before.json` check finds
the required resumable-run pin present in ECR, with zero missing pins.

The pre-apply recheck matched all reviewed hashes, all 54 zip entries against
current compiled files, 512 embedded Terraform source files, state serial 1178
and required retained ECR pins. Apply completed through
`scripts/deploy-terraform.sh dev --phase apply --skip-seed`, followed by
`scripts/deploy-frontend.sh dev`, with checkout-local npm/temp/cache directories.
The generated frontend configuration and rebuilt assets still match their
reviewed hashes. Post-apply state is serial **1187**, on the same lineage.

| Deployment receipt                                      | Observed result                                                                                                                       |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `preapply-checks.json`, `apply.log`                     | Exact reviewed plan applied; seed skipped; saved plan retained                                                                        |
| `deployed-lambda-hashes.json`                           | **42/42** Lambda CodeSha256 values match; all Active/Successful                                                                       |
| `deployed-wiring.json`                                  | **15 checks passed**: actual token/output routes, exact Cognito pool, native env, protected token ownership IAM and runtime boundary  |
| `deployed-native-iam.json`                              | **Seven policies** exactly match the reviewed policy documents, including the native runtime boundary                                 |
| `deployed-runtime-image.json`, `runtime-ecr-index.json` | Runtime version **118**, READY; immutable ECR/container-byte linkage below                                                            |
| `referenced-images-after.json`                          | Required retained digest `sha256:a226eb964ae779ee64496f0bdbf481dee4e9025dcf5d642015c9018975d6c0ff` remains present; zero missing pins |
| `retained-runs-unchanged.json`                          | Both recorded prior runs' RUNTIME and EXECUTION rows match their pre-deployment hashes: **four unchanged records**                    |
| `frontend-deploy.log`, `deployed-frontend-assets.json`  | **518/518** deployed S3 files match; CloudFront index and all **27** referenced entry assets match                                    |
| `frontend-invalidation-status.json`                     | Invalidation `IE8KRJ2YNGER0FJREPRE9WXUE6` completed                                                                                   |
| `yjs-service-after.json`, `cloudfront-after.json`       | Yjs task definition unchanged with completed deployment; CloudFront uses the verified dev frontend origin                             |
| `unauthenticated-route-checks.json`                     | Deployed native output GET and token POST both return 401 without authentication; this is not member-access proof                     |

The actual deployed ECR index digest is
`sha256:60217369786677a4f8d35dd733fb13d649aa56fae6bb89fa2e5ac750b2d3c929`.
It contains Linux ARM64 manifest
`sha256:d192002ec2de7f4d784db7f98049290b3718c13a444b99178fcc21a26771e55a`,
exactly matching the reviewed build log, and configuration digest
`sha256:459a2fc0ba7f01609c3935bb92b224a2e2faa1b1998aeae9d39f20aae3198c8e`.
These content-addressed descriptors establish identical executable container
bytes and layers to the 177-source-file verified build. The different index
digest comes from the new attestation descriptor
`sha256:5a7199fe2054c4f42c1c6a0521f4f7882eca2c282dfc434dcab959637a6da23a`.
This comparison uses immutable manifests, not equality of a mutable image tag.
The lead independently confirmed the linkage. The exact deployed digest was
also pulled locally; no further redundant image rebuild was performed.

The [task-3 protocol handoff](native-task-3-input-protocol.md) records the actual
pinned runtime archive's question, file-answer, summary-confirmation and stage
approval protocol. Kiro ACP session updates are covered before prompt completion
locally; the rebuilt image also passes nine coalesced updates and all 177
included source-file hashes match the checkout; actual deployed CLI streaming is **not yet qualified**.

Lifecycle telemetry now marks dispatch, preparation, package verification,
checkout, installation, harness launch/first output/completion, checkpoint
verification/download/restore/upload, publication and graph projection. The
required **three samples per path** (fresh, warm and cold) remain pending
authenticated-member access. No new samples have been run, so individual
durations, median and maximum are **not measured**. Report every duration and distinguish
non-harness overhead from harness/model/tool time; do not describe harness wall
time as model-only inference without separate evidence. No model-turn limit was
introduced and no latency budget was imposed.

Live activity-before-completion, two-member visibility, reload/reconnect history,
old URLs and platform regression remain pending deployed proof. Both worker and
lead computer-use connections fail with `Sky Computer Use native pipe startup failed`;
the previously verified owner Chrome session cannot currently be controlled.
The lead confirmed no alternative browser connector. Second-member access is
already requested from the user.

The needed existing access is either restored control of that authenticated
owner session or an existing authenticated API test-access location supplying
an unexpired **Cognito ID token** for the existing project member. The dev pool
is `us-east-1_iopWlPbtr`, app client `50luol5lla50to3369hnkjbn1r`; the app obtains
its session through Amplify and sends `Authorization: Bearer <idToken>` to the
same-origin `/api` endpoints. No such API test-access location has been provided.
A restored browser is still required for visual proof; a second real member
session is required for shared visibility. No gateway claims were forged,
no native test intent was created, and no users or credentials
were created/reset. Use only fresh bounded test intents in existing project
`22371643-2db5-42a4-a571-e47fc35745f5` and preserve retained runs. Milestone 1 is
**not complete** until these checks and performance measurements are recorded.

### Outstanding live fixture recipe

These steps are **not executed**. Resume only with the existing authenticated
member access described above. Keep private tokens outside logs and source
files; never substitute a Lambda invocation with constructed gateway claims.
Store new receipts under checkout-local `.native-evidence/live/`, recording
only public output and non-secret identity/hash/timing fields.

1. Verify the owner can read project
   `22371643-2db5-42a4-a571-e47fc35745f5` through the real authenticated API.
   Confirm the existing workflow-source binding, completed package import and
   coding credential are still authorized. Record their revisions and immutable
   package/materialization hashes, harness/CLI/model, application repository
   commit and deployed image digest. Use one fixed configuration for all
   baseline samples; a pin change starts a separate series.
2. Create **three new native intents**, each with a fresh UUID and title
   `M1 qualification sample 1`, `2` or `3`. Use Codex for the initial timing
   baseline and the same verified workflow package. The draft POST is
   `/api/projects/{projectId}/native-intents`, with exactly
   `{intentId,title,prompt,harness,sourceId,packageJobId,bindingRevision}`.
   Use this fixed bounded task: “Inspect the checked-out flappy-bird scaffold
   read-only. Summarize the current entry point and ask one clarifying question
   before proposing a code change. Do not edit application code, approve a
   workflow gate, commit, or publish Git changes.” Keep the three IDs in the
   fixture receipt; never substitute an inherited run ID.
3. **Fresh path, once per new intent:** POST `{}` to
   `/api/projects/{projectId}/native-intents/{intentId}/prepare`; wait for READY.
   Record preparation separately. POST `{"requestId":"<fresh UUID>"}` to
   `.../{intentId}/start` once. Open the existing native URL
   `/space/{projectId}/native-intent/{intentId}` and the real Agent panel before
   completion. Capture a parsed assistant/tool event while the turn is still
   running, then its durable history sequence and the completed interaction.
   Lifecycle labels alone are insufficient streaming evidence.
4. **Warm path, once per intent:** while that runtime session is still present,
   GET `.../{intentId}/interaction`. POST to `.../{intentId}/response` exactly
   `{requestId,interactionId,contentSha256,text}`, using the current interaction
   and a fresh request UUID. Fixed reply: “Continue read-only: explain one
   existing entry-point function, then ask the next clarifying question. Do
   not implement, approve, commit, or publish changes.” Record the returned
   response `acceptedAt` and subsequent output. Retry status/history reads after
   transport failures; never submit a fresh request ID merely because a
   response was lost.
5. **Cold path, once per intent:** after the warm turn reaches its verified
   waiting boundary, confirm its protected recovery checkpoint is complete and
   matches the same image/package/configuration. Read that fresh intent's
   target runtime ARN, endpoint and session ID. Stop **only that session**
   through `StopRuntimeSession`, retaining the API response as evidence of the
   cold condition. Submit one presentation-bound reply as above and observe
   recovery plus continuation. If the API presents a recoverable review state,
   use `.../{intentId}/recover` with exactly `{requestId,recoveryId}` from the
   current response. An ambiguous/non-recoverable state is a failed sample,
   never permission to replay a model prompt.
6. **Shared visibility/replay:** a second existing signed-in project member
   opens the same fresh native URL before completion. Compare logical
   transcript sequences and text across both users. Capture the native token's
   qualified scope without retaining the token:
   `native-intent:<projectId>:<intentId>`. Disconnect/reconnect one client during
   output, then reload. GET `.../{intentId}/outputs?after=<last seq>` until
   `nextAfter` is null; compare the complete ordered history with both
   transcripts, including a stream longer than 64 rows. If the bounded task
   produces fewer rows, record the live pagination case as unexercised; do not
   insert synthetic trusted OUTPUT rows.
7. Reopen the native bookmark to prove the retained URL renders the shared
   page. Switch between the three new runs while reads are outstanding; verify
   no mixed transcript and one composer with the intended run's draft. Exercise
   a separate fresh, bounded platform intent through the existing platform
   composer; verify its normal page/activity and unchanged `intent:<id>` scope.
   Do not use existing runs as mutation fixtures or invent workflow stages.
8. Repeat the parsed-activity-before-completion check with each other harness
   whose existing approved credential is available, especially Kiro ACP.
   Record unavailable credentials/access explicitly. The local Kiro update
   tests and immutable image proof do not establish actual live CLI streaming.
   Leave each fresh fixture at a safe waiting boundary, or cancel only that
   fixture if cleanup is required; record its final state. Do not delete
   retained runs, checkpoints or images.

Revocation, same-ID cross-project isolation, lost acknowledgments, competing
ingestors, parser bounds and cancellation races have focused automated
coverage. No live membership/image-policy mutation was performed during this
checkpoint. Do not revoke shared access or a referenced runtime image merely
to manufacture a live result.

### Timing collection for the pending fixtures

Collect three samples for **each** path above. Preserve per-sample data before
computing summaries; the current sample count is **0/3 fresh, 0/3 warm, 0/3
cold**, with no individual durations, median or maximum available.

- Record browser/API request start and receipt using a monotonic client clock,
  durable reply `acceptedAt` (or execution `startedAt`), first visible parsed
  output sequence/time, and final visible interaction/time. Do not mistake an
  OUTPUT `timestamp` for persistence time: it records runtime capture.
- Read `native.lifecycle` events for these exact fresh execution/attempt IDs
  from `/aws/lambda/collaborative-ai-dlc-native-runs-dev-execution` and their
  actual per-run AgentCore log groups, discovered using the fresh runtime ID.
  Retain `boundary`, `at`, sequence/writer generation and available byte/file/
  retry counts. Include dispatch/target readiness, checkout, package verify/
  install, checkpoint verify/download/restore/upload, harness launch/first
  output/completion, publication and graph completion. Runtime `accepted` means
  runtime admission, not the earlier authenticated API acceptance.
- Join only matching execution, attempt, turn and writer generation. Keep
  repeated attempts and failed samples visible. Separate prepare time,
  acceptance→harness launch, harness launch→completion, post-harness
  publication/checkpoint/graph time, and emitted activity→browser receipt.
  Account for overlaps instead of summing nested intervals. Report client/
  server clock-offset uncertainty for cross-clock comparisons.
- Harness wall time includes model and tool execution. Report it under that
  name, separate from platform overhead. Report **pure model inference time
  as unavailable** unless independent harness/provider timing establishes it;
  never label the entire turn as model-only time.
- For each metric/path, report all three durations, their median and maximum,
  pins, success/failure and collection limitations. These samples support the
  user's later budget decision; they are not percentile/SLA evidence. No
  timeout, spending cutoff or model-turn limit is introduced.

### Integration handoff

| Area                         | Reviewed implementation / contract                                                                                                                                                                                                                                      |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared workspace adapters    | `frontend/src/contexts/IntentContext.tsx`, `contexts/adapters/nativeIntent.ts`, `contexts/adapters/nativeActivity.ts`; existing platform provider retained; native `AppShell` → `IntentView` → real Agent transcript                                                    |
| Frontend transport           | `frontend/src/lib/realtimeToken.ts`, `services/realtime.ts`; project/backend-qualified cache and connection targets                                                                                                                                                     |
| Protected native namespace   | `lambda/shared/native-realtime.js`, `native-realtime-ownership.js`, `lambda/intents/index.js`, `lambda/ws-connection/index.js`, `lambda/shared/ws-fanout.js`; native channel/scope is exactly `native-intent:<projectId>:<intentId>`                                    |
| Durable output and lifecycle | `lambda/agentcore/native/activity.js`, `kiro-acp-client.js`, `command-runner.js`, `executor.js`; `lambda/native-runtime-control/activity-store.js`, `execution-worker.js`                                                                                               |
| Image/recovery compatibility | Native runtime image policy/store/credential checks, unchanged pinned source fixtures plus test-only EFS import bridge; saved configuration/checkpoint hashes retained                                                                                                  |
| Task-2 boundary              | Superseded by the [milestone 2 checkpoint](#milestone-2-checkpoint--1-october-2026-shared-replies-artifact-discussion-and-quorum): protected revision-specific native reply and discussion documents; native scopes still never grant global platform intent/Yjs access |
| Task-3 input findings        | [Pinned protocol handoff](native-task-3-input-protocol.md): actual structured-question/file-answer protocol, separate summary confirmation, engine-owned approval and explicit qualification limits                                                                     |
| Evidence index               | `.native-evidence/deploy/review-handoff.json` preserves approved plan/build/test digests; `.native-evidence/deploy/deployment-checkpoint.json` indexes completed deployment checks and the external live-access blocker                                                 |

## Earlier delivery evidence

For the proposed next milestones, see
[the collaborative integration plan](native-collaboration-integration-plan.md).
It covers reuse of the existing intent UI, parsing and persistent activity
history, artifact-level Quorum, shared questions, approvals, latency and the
remaining pilot acceptance tests.

**Codex cold-session recovery now passes through the real UI and graph.**
The user-authorized clarification resumed the same Codex conversation and
produced turn 2 in intent `9a36cf43-eacb-4b9d-a4e3-4b5ceaecb831`.
Independent verification passed **37 checks**: prior rollout bytes are
preserved, the accepted reply appears once, and all **439** new checkpoint
files match their recorded S3 versions and hashes. The plan remains unapproved.
The new response survives reopening; Files and the **18-node/17-relationship**
graph work, including graph-to-response navigation.

Reply to restored-session readiness took **4m 7s**, and reply to the new
response plus graph took **5m 30s**. Latency remains a limitation.
The attempted test Stop returned HTTP 404; the normal reply path then proved
cold ownership and successful recovery. This qualifies that observed recovery,
not the cause of expiry or a separately successful forced Stop. Other harnesses,
in-flight recovery and a live failed-status retry remain unqualified.
The [recovery checkpoint](native-session-recovery-plan.md#current-live-checkpoint)
records exact timings, evidence and limits. No new deployment is required for
this verified result.

### Earlier first-question result

**The fresh native run reached its first question, and its checkpoint and UI
projection are verified.** Execution
`9a36cf43-eacb-4b9d-a4e3-4b5ceaecb831` retains Codex, AI-DLC v2.9.0 and the
approved pipe-visualization Compose prompt. Its real response proposes a plan
and awaits the user's choice. Overview preserves the response after reopening,
Files shows **16** published files, and Graph shows **18 nodes and 17
relationships** with working graph-to-file navigation.

Independent verification passed **29 checks**, including exact S3 versions,
hashes and lengths for all **439 private checkpoint files** (7,825,265 bytes).
The public files match the allowed checkpoint subset. No reply, plan approval,
continuation or runtime restart was submitted.

Start to the saved question took **11m 22s**, or **11m 29s** including graph
projection. Workspace READY was reached 121.466 seconds after draft creation;
that measurement includes the delay before clicking Prepare. The complete
controller timeline recorded **108 successful status reads and zero retries**.
At this first checkpoint, restart recovery and a live status-read failure were
still unverified; the subsequent Codex recovery result is recorded above. The response also
notes that the pinned scaffold branch has no pipe implementation.

The user-applied retry/diagnostics deployment passed **56/56 independent plan
checks** and **36/36 applied checks**, advancing state **1177 → 1178** with the
exact reviewed Lambda hash. Runtime **117**, its image and credentials code
remain unchanged. Local verification includes **991 controller tests** and
independent SDK failure/recovery tests. Status retries cannot resend a prompt;
confirmed ownership conflicts and revoked access retain their safeguards.

The previous draft `b484ecf5-8cd9-42dd-875c-f1fa0c7678f3` remains stopped at
`RECOVERY_REQUIRED` without a checkpoint. Its original status failure remains
unexplained and has not been replayed. Follow the
[current recovery checkpoint](native-session-recovery-plan.md#current-live-checkpoint)
for the full measured timeline and subsequent authorized recovery test.

The legacy composer run is preserved but failed during the image update;
that [compatibility defect](native-pinned-runtime-compatibility-follow-up.md)
is tracked separately.

The following checkpoints retain the earlier history; the entry above is the
current deployment and live-test status.

**The first real native composer question is now visible and durable.**
Deployment state **1164**, shared runtime **116**, all 32 referenced Lambda
hashes and the published image are verified. Fresh draft
`cb6c2fdd-1cf7-46f3-844c-f81d223353b0` uses the unchanged pipe-visualization
request and reaches `AWAITING_USER`. Its actual plan-selection question appears
in Overview with a reply field, survives reopening, and accompanies 16
published files. Files and graph file navigation work. No answer was submitted
during the initial question check.
Preparation took **1:37**; Start to saved question took **6:07**, including
about four minutes before model execution.

**The response graph connection is now deployed and verified.** State **1166**
matches all three reviewed Lambda archives and configurations; runtime **116**
and its image remain unchanged. The live graph shows the response node, and
clicking it opens the same saved question in Overview. The user then submitted
`1` to select Compose. The existing attempt entered turn 2 about **4.8 seconds**
after accepting the reply. That turn's immutable response and files are verified,
but its response is an AI-DLC command error; composer continuation has not passed.
The [composer checkpoint](native-composer-checkpoint.md) records the evidence
and remaining continuation and recovery limits. M1 is not complete yet.

**Graph ingestion is fixed; durable harness-session recovery is next.**
The user authorized this workaround for the pinned core's initial plan-selection
defect, which is [tracked separately](native-core-plan-selection-follow-up.md).
The exact request is accepted as sequence 3 in the same attempt and must not
be resubmitted. Ingestion of publication 2 is now complete. Local inspection
found that the graph client's deletion helper emits a `discard` operation
unsupported by the deployed Neptune version; the earlier in-memory tests
missed this. The deployed repair uses `toList()` to consume the deletion
without adding that operation.

The correction is locally verified by **98 focused tests** and a real
TinkerPop server reproduction with both supported serializers. Saved plan
`/tmp/aidlc-native-graph-cleanup-dev.tfplan` contains the worker fix and a
byte-identical credentials dependency; it has no runtime or persistent-resource
changes. The [deployment handoff](native-composer-checkpoint.md#graph-cleanup-deployment-handoff)
records its checksum and deployment evidence. The user applied it; state
**1167**, both Lambda hashes and unchanged runtime/image pins are verified.
The worker completed the pending projection in **4.08 seconds**.

A status-only check at **07:17:13 UTC** then confirmed a cold runtime:
it recovered the saved sequence-2 result from EFS, but did not reconstruct the
Codex conversation or an executable owner. The explicit Compose reply remains
saved. Its `pending` marker alone does not prove that replay is safe.

The user selected **durable session recovery** as the next milestone and
**automatic recovery at verified waiting points**. Required private recovery
data remains independent of optional debug archives, which stay off.
Recovery must preserve the exact session, accepted reply, package/model/source
pins and committed Files/Graph. Ambiguous in-flight execution must stop for
review. The implementation and local verification are now complete for the
recovery pilot: 5,008 native/backend tests and 333 frontend tests pass, and the
new image passes offline CLI restoration checks for Codex, Claude and OpenCode.
Kiro's actual CLI restoration and all live recovery remain unqualified.
The [reviewed recovery deployment](native-session-recovery-plan.md#deployment-handoff)
is ready for the user to apply. Its 42 Lambda archives are verified, with no
persistent-resource destruction. The deliberate restart test follows deployed
hash/configuration verification and the user's test-draft decision.

## Earlier checkpoints

The following entries preserve the earlier delivery history. The 30 September
composer checkpoint above supersedes their first-question blockage.

**Active direction:** the preparation timeout repair is deployed and verified;
deliver native execution through the **existing Intent UI and graph**.
Pre-provisioning is deferred. The [active delivery sequence](native-ui-first-slice.md#active-delivery-sequence)
defines the remaining visible checkpoints; a real first question/files/graph
result is the next feature milestone.

**M1b now publishes files, but the first native question is still blocked.**
Start/Cancel, the first native question, exact Files and generic Graph links are
connected through the protected execution controller. Recovery state **1157**,
all eight referenced Lambda hashes and the published image are verified.
The observed shared runtime and both version consumers agree on **115**.

Fresh draft `4344f624-aa8b-4e5e-a393-0dc04133ce9b` prepared in **1:47**,
passed EFS initialization, then returned a Codex session and committed
**16 files**. Independent verification passes **128 manifest/file checks**,
and the files open in the existing UI. The result is `STOPPED`, with no active
intent, question file or published source change. Initialization itself took
another **3:15**; provisioning and initialization are separate measurements.

Two integration gaps are reproduced locally with the exact package/request.
Codex needs `$aidlc` to explicitly load the installed skill; our common prompt
used `/aidlc`. AI-DLC also asks for the workflow plan **before an intent exists**,
whereas our classifier only recognizes questions inside an intent. The earlier
test's explicit `poc` scope bypassed this choice. The original request is
present and its hash matches. The live transcript was not retained, so its
exact tool sequence is not claimed.

Graph ingestion remains pending. Its trusted worker lacks the Neptune
`DeleteDataViaQuery` permission required for property upserts; the agent runtime
must keep no graph access. The next correction addresses explicit skill
invocation, native initial-question transport and this scoped ingestion
permission. The user has now selected the native intent page for the actual
composer conversation. Completed assistant messages are required run content;
they are not treated as proof that a native gate or the workflow completed.
The [first-turn checkpoint](native-first-turn-checkpoint.md) records current
evidence and remaining limits. The first-question milestone is not complete.

The Codex marker and trusted-worker permission fixes are now implemented locally.
The composed backend run passes **367 tests**, the focused marker suite passes
**112**, and **15 IAM/wiring checks** plus Terraform validation pass. The files
remain readable after the producing runtime session is stopped. No new deploy
has been requested. The [composer interaction plan](native-initial-question-plan.md)
now covers the actual ordered assistant messages, protected member replies and
serial continuation in the same native session. A one-time engine preflight
would not cover composer questions and is no longer the primary approach.

**The composer interaction slice is now locally verified.** The native Overview
shows ordered assistant messages/tables and lets a member reply through the
protected controller. Graph response nodes open that interaction. A composed
two-turn test preserves the same session through a lost acknowledgement without
duplicating the turn. **4,639 regression tests**, **251 frontend tests**,
typecheck/build and the final ARM64 image's **10 source checks** pass. Independent
collector review is closed. The actual page's local fixture passes display,
reply/retry and graph navigation checks. The saved plan
`/tmp/aidlc-native-composer-dev.tfplan` is ready, with all 32 archives verified
and no persistent-resource destruction. The
[deployment handoff](native-initial-question-plan.md#deployment-handoff) records
its exact hash and apply command. The next live check still stops at the first
real question. Cold harness-session
recovery and full conversation-history navigation remain unqualified.

**Earlier initialization recovery:** state 1155 preceded the verified run above.
The fresh same-task draft `b255dd02-b500-4218-9616-aa3671d0b4f8` prepared in
about **1:42**, passing 25 preparation and 12 attempt/IAM checks. It failed in
the new baseline check before model execution. We reproduced a concrete bug
using Node's actual stat conversion: valid high-bit 64-bit filesystem IDs can
appear signed, but our check accepted only positive values. The actual live
EFS ID was not observed. The correction preserves exact ID bits and adds fixed
diagnostic reasons. **396 composed backend tests**, independent review and the
ARM64 image checks pass. Both ordinary and simulated signed-ID initialization
pass all **18 checks** against the exact package/application commit, preserving
all **20 `.kiro` files**. This image correction is now deployed. The previous
frontend run passed 184 tests; the earlier complete native regression run passed
4,367 tests.
Those earlier results did not establish native file publication or graph
ingestion; the current publication proof is recorded above.

**Native discovery is deployed and verified in the existing UI.**
M1a adds protected native summary listing and normal project/sidebar/dashboard
navigation to the native status page. State **1144** matches the reviewed API
ZIP, configuration, permission and ACTIVE index. Independent checks pass
**28 deployment checks and 13 discovery checks**, including all ten existing
native fixtures. The authenticated local frontend opens native entries from
the project list, sidebar and both dashboard layouts, retaining saved URLs and
disabled unsupported controls. Local validation passed 365 backend and 262
frontend tests, typechecking/builds and independent review. The
[discovery checkpoint](native-discovery-checkpoint.md) records the proof and
remaining live authorization/pagination limits. M1b connects the first real
turn, exact files, question and graph; M1 is not complete until those work
together.

**Preserve both real-task drafts and their failed attempts.**
The user selected **“Fix the pipe visualization”** as a separate native draft:
`e0d2836d-c794-48d0-8b77-52550cf3c65a`, Codex, official AI-DLC v2.9.0.
Its exact prompt and separate identity are verified, and the normal project
list distinguishes it from the existing platform draft with the same title.
The first draft joined ten preparation fixtures; the recovery test added the
second same-task draft noted above.
Backend timing for the new draft is **about 1m45s** from the correlated Prepare
request to protected READY; the independent readiness review passes 15 checks.
No project-native model has started. The deployed controller successfully
upgraded this draft's isolated runtime from preparation version **1** to a
separate execution endpoint pinned to version **2**, preserving the original
preparation pins. Attempt `4222fe9f-4ce5-4743-b52f-d008b75aea3b` is now `FAILED`
after initialization. The second attempt
`bbab0dae-c34f-423e-ae04-cc76e54f7dc1` is also `FAILED`, with zero committed
publications. Following the filesystem identity correction deployment, use a fresh draft with
the same authorized prompt; the existing attempt and workspace stay immutable.
The first execution verification stops at the workflow's first question.

**Historical preparation evidence for the ten fixtures follows.**
The initial A/B verification used state **1139**, including the directory-tagging
repair. Run A now has its
own runtime/version-pinned endpoint, role and EFS access point. The provisioner
reached **READY at 11:41:41Z on 28 September**, after one 10-second diagnostic
abort recovered on the next automatic retry. A fresh independent session also
passed NFS4 write/readback, hard-link, atomic-rename and cleanup checks, then
stopped with HTTP 200. All **16 independent configuration checks** passed.
Run B reached **READY at 12:00:49Z** and passed its own fresh-session filesystem
check. Runtime/role/AP/root identities differ between the runs. Both runtimes
rejected six mismatched/unsupported requests between successful filesystem
controls. IAM principal-policy simulations deny cross-AP/root access, and an
unauthenticated API read returns 401. These checks do not prove physical
cross-mount denial or authenticated nonmember isolation. All diagnostic sessions
were stopped. The [preparation checkpoint](native-workspace-preparation-checkpoint.md)
records the proof and a worker-only fix for the new-role validation delay that
required a manual retry for B. Model and human-action controls stay disabled.

**The new-role recovery fix is deployed and verified on two fresh runs.**
State **1140** and the actual deployed worker ZIP/bundle match the reviewed
bytes. C and D each encountered the exact role-validation error, stayed
PREPARING, and created their runtimes on the next automatic attempt with
identical request parameters. Both reached READY without manual retries in
about **12 minutes**, including the current three-minute queue intervals.
Each passed a fresh-session EFS write/readback/hard-link/rename/cleanup check
and stopped with HTTP 200. C's independent configuration review passed **21/21**.
D's duplicate Create and repeated Prepare after READY both returned **200**
and left the complete protected row unchanged. Four preparation fixtures are
now READY. No further deployment correction was needed for this loop.

**Preparation timeout repair is now verified; earlier timing experiments follow.**
The [latency investigation](native-workspace-latency.md) traces both 12-minute
runs to four approximately 180-second readiness retry intervals. The worker
spent only 8.57–9.54 seconds in its five invocations per run; asynchronous AWS
work overlaps the idle intervals. The user selected this improvement before
the first agent-turn milestone. Short readiness retries with guarded lease
release are deployed at **1141**; all 19 deployed checks pass. Two fresh
member-created runs reached READY in **4:22 and 4:16**, approximately **64%
faster**. All eight short retries were confirmed. Both first diagnostic
invocations nevertheless hit the ten-second deadline and recovered on the
conservative three-minute retry. Fresh independent EFS proofs passed and both
sessions stopped. The 20-second diagnostic follow-up is deployed at **1142**;
its 293 tests, builds and 16 deployment checks pass. Fresh G/H preparations
take **4:18 and 4:14**, but both still abort the first invocation and recover
on the three-minute retry. Independent filesystem checks pass and sessions
stop with HTTP 200. The extra ten seconds did not solve the delay. The
time-correlated AWS latency samples are **51.833 and 50.470 seconds**, beyond
the entire 30-second worker window; startup versus EFS time is not yet separated.
The user selected only the worker timeout repair on 29 September.
The reviewed plan increases the worker to 90 seconds, its fixed diagnostic to
80 seconds and conservative queue visibility to 540 seconds; readiness backoff
stays short. All 294 tests, builds and both 21-check plan reviews pass.
The user applied state **1143**. Exact deployed bytes/settings pass 15 parent
and 18 independent checks. Fresh I/J runs reach READY in **1:39 and 1:41**
without the first-invocation timeout or recovery cycle; independent EFS proofs
pass and both sessions stop with HTTP 200. The agreed timeout check is complete.
No project-native agent has started; the existing UI/graph slice is next.

**Authenticated nonmember reads are denied.** A separate test account receives
403 for the original run A, run C and the native draft capability route. The
UI exposes no run details or creation form. A related frontend correction
clears previously loaded details on a later 401/403/404 and invalidates late
responses; its 29 focused / 48 related tests, TypeScript/production build and
independent 10-check review pass. The local denial path is verified. Direct
unauthorized POSTs, live membership revocation and another enabled project's
boundary remain unqualified. No AWS backend deployment is needed for this
frontend correction.

**Debug preferences are deployed and verified through the authenticated UI.**
The card saved on/eight days, retained the values after reload, then was restored
to off/seven days with independent SSM readback. Required recovery remains
independent. That settings checkpoint used runtime **111 READY**, state **1122**; deployed Lambda bytes,
retained prior image and unchanged runtime isolation configuration passed
**40 independent live checks**. The
[settings checkpoint](native-debug-settings-checkpoint.md) records the proof.
No model was invoked during that verification.

The latest Kiro interaction qualification remains the historical runtime
**110 READY**, state **1118**, image tag **`15c34685dcbc7627`**. Its actual
sources/CLI/EFS checks and **54 independent deployment checks** passed.

Kiro completed the real first question → Blue Lake title answer → next question
loop in the same ACP/native session. Full user and assistant replay hashes
matched before the answer was sent, and both turns acknowledged configured
`auto`. The native file changed only at Q1; Q2 and scope confirmation stayed
blank. State/directive contents were unchanged. Both turns exited 0 with cleanup;
parent and independent two-turn review each passed **21/21 checks**. The session
was stopped with HTTP 200 at **06:56:50Z on 25 September**. See the
[current checkpoint](native-interaction-probe.md#runtime-110--current-kiro-verification)
and [actual answered file](/tmp/aidlc-plan-tools/native-kiro-prompt-applied-20260925/kiro-questions-after-answer.md).
No further backend deployment is required for this Kiro correction.

## Current position

The pilot remains incomplete. The four harnesses now each have a bounded
question/answer/follow-up result: Kiro on runtime 110, Claude on 108, Codex on
107 and OpenCode on 106. This is not one all-four production acceptance run.
Their test sessions are stopped. Nine ignored Claude permission entries remain;
Kiro's `auto` is a routing mode, its native directive owner is `sessionless`, and
native startup/HUMAN_TURN events do not establish protected human authority.

The next visible result is a real native intent whose first question and files
are published durably and visible to two members. [The UI slice plan](native-ui-first-slice.md)
records the implementation sequence and confirmed decisions. On 25 September
the user selected per-run isolation, native opt-in with the current backend
remaining default, and the **flappy-bird** project in **dev**. The user also
confirmed conditional approval re-presentation after uncertain recovery, no
application time/token/spending cutoffs, and platform debug archive settings
defaulting off with seven-day retention when enabled. Required recovery state
is independent of debug retention. Native answer/approval controls and their submission handlers
are now guarded in the frontend. The 132 focused tests and full typecheck passed;
the affected 18 tests also passed after a fixture typing correction. Lint and
formatting passed. Browser verification is outstanding. The first-slice
decisions are settled; real-project model execution and shared publication remain to qualify live.

The settings API/UI and native routing foundations passed 139 backend and 38
frontend tests, frontend typecheck/build and affected Lambda builds. An ARM64
image smoke passed. The settings deployment includes its existing runtime-image
dependency and preserves the previous remote image through a non-destructive
Terraform ownership migration. It does not enable archive capture, native
intent start or the protected binding provisioner. Those remain part of the
first real intent and recovery work. Preference persistence is now verified.
The current implementation loop adds an opt-in native draft and a dedicated
runtime, role and EFS access point per run. Two
**draft → preparing → workspace ready** paths now pass, including separate
resources, fresh-session filesystem checks and request-scope rejection. Run A
recovered automatically from a diagnostic abort; Run B needed an explicit retry
after newly created role validation failed. The deployed worker fix retries
that exact same-role error automatically within a ten-minute propagation window,
after fully validating the role on every attempt. The 195 native-control tests pass;
the automatic-retry branch now passes live on C and D. Duplicate Create and
fully allocated Prepare retry acceptance also pass on D.
Model dispatch, file publication and protected human actions remain closed.
The [workspace preparation checkpoint](native-workspace-preparation-checkpoint.md)
records the implementation, wider API dependency review, applied deployment
and each repair. Runtime and identity creation now pass live; the worker then
checks the actual role/AP/runtime/endpoint and filesystem before publishing
readiness. The trusted controller has direct creation/retag authority for native
identities and tagging authority on the shared default identity directory.
These grants are not per-run IAM ownership boundaries; agent roles do not
inherit them. Preparation proof does not establish native workflow installation,
model execution, artifact publication or checkpoint recovery.

For the historical shared runtime, computed metadata remains 111 while the
control-plane evidence identifies 112. Run A instead uses its dedicated runtime
version 1. Shared file/question UI, protected answers/approvals, execution fencing,
project isolation and cold recovery remain unqualified.

| Part of the agreed outcome                                   | Evidence today                                                                                                                                                                                                                                                                                                                                                                                    | Remaining                                                                                                                                                                          |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflow repository configuration                            | Official public GitHub source saved through the authenticated UI; latest import and Download preview exercised                                                                                                                                                                                                                                                                                    | Private GitHub, GitLab and Bitbucket live cases; broader release selection                                                                                                         |
| Immutable workflow packages                                  | Official public UI import succeeded through normal Pipe/SQS in one attempt; receipt and all six object versions match the verified archive                                                                                                                                                                                                                                                        | Broader provider, retry and recovery acceptance                                                                                                                                    |
| Two execution backends                                       | Backend identity and capability guards implemented; unsupported native edits/PR actions disabled in UI/API                                                                                                                                                                                                                                                                                        | Native configuration/start/answer/cancel/recover routing                                                                                                                           |
| Four native harnesses                                        | Scoped question/answer/follow-up passes: Kiro runtime 110 with full user/assistant replay and auto acknowledgement; Claude 108 with native SessionEnd; Codex 107; OpenCode 106. All test sessions stopped                                                                                                                                                                                         | End-to-end all-four acceptance, native hook/permission observations and recovery qualification                                                                                     |
| Native filesystem artifacts in the collaborative application | A fresh read-only session confirmed the Codex native artifacts persisted on EFS after the failed session was stopped                                                                                                                                                                                                                                                                              | Execution-workspace snapshots, durable publication, ingestion and shared native views; persistence alone is not cold recovery                                                      |
| Isolated human approvals                                     | Permission boundary and membership policy agreed                                                                                                                                                                                                                                                                                                                                                  | Protected action store, authenticated acceptance, native delivery and replay reconciliation                                                                                        |
| Native recovery and serial supervision                       | Package-job leases/recovery implemented; this is not execution recovery                                                                                                                                                                                                                                                                                                                           | Execution supervisor, checkpoints, stop/resume/cancel and cold recovery                                                                                                            |
| Usable pilot                                                 | Ten drafts reach Workspace ready; I/J take 1:39/1:41 with no invocation abort/recovery wait. C/D recover automatically; duplicate requests preserve D. Fresh-session NFS4 checks, earlier runtime-scope rejection, 18 IAM simulations, unauthenticated denial and authenticated nonmember read/draft-entry denial pass. UI denial handling passes 48 related tests; model/actions remain disabled | Direct unauthorized POSTs, live revocation, another enabled project and physical isolation; integrated native file/question UI and graph, all-four acceptance and rollout decision |

In the detailed plan, P1 is substantially implemented with live package-byte
evidence and verified normal dispatch for the official public source. Broader
provider, retry and recovery coverage remain unqualified. P2, P4 and P8 have
partial foundations. P3 and the native integration work in
P5–P7 remain to be built. P9 acceptance and P10 rollout have not started.

## The next user-visible milestones

These organize the existing plan; they do not reduce the confirmed feature,
provider, harness or approval-boundary requirements.

The user requested short implementation/verification loops on 22 September.
For each loop, identify one observable result, make the smallest required
change, run its relevant local checks, and exercise it live before expanding
that slice. Report actual output or the concrete failure. Do not substitute
additional mocks, documentation, or infrastructure deployment for execution.

The storage probe, normal public UI import, immutable receipt comparison and
local four-harness initialization are complete. The
[initialization checkpoint](native-initialization-probe.md) records the real
signature verification, generated files, two compatibility fixes and remaining
doctor warnings. The completed harness loop used a tiny model-driven question →
answer → continuation test on each harness. Runtime-106 Codex recorded its answer but did
not deliver the next questions. Kiro passed file-based continuation; separate
conversation logs leave history resumption unqualified.
Runtime-106 OpenCode completed the same-session question/answer/follow-up loop, with the
answer recorded in the native artifact on EFS and both turns clean.
On historical runtime 107, Claude's configured
model completed the title question/Blue Lake answer/follow-up loop in the same
structured/native session, with Q2–Q4 blank and both turns clean. It was stopped
with HTTP 200 at **11:38:29Z**. Nine ignored permission entries and a cancelled
SessionEnd hook were recorded in both runtime-107 turns. Runtime 108 subsequently
verified the native end hook on both turns; the permission warning remains.
Codex's runtime-107 probe also passed: the prior input-tool error is absent, the
native title answer is recorded, and the follow-up is delivered in the same
structured/native session. It was stopped at **11:58:50Z**.

The user selected existing dev AgentCore, keeping credentials in AWS. The
[operator interaction experiment](native-interaction-probe.md) is now implemented
and locally checked: fixed public package, disposable filesystem, all-four native
setup, separate test-answer action, session resumption and bounded evidence.
Its first deployment partially applied on 24 September before a plan-time ECR
token expired. Credential-helper authentication corrected that issue; the user
deployed the recovery plan, and runtime **103**, image and all seven remaining
Lambda bundles were independently verified.

The first real operator invocation then failed before the model started:
native AI-DLC uses hard-link transaction locks, unsupported on AgentCore's
persistent `/mnt/workspace` mount. Live diagnostics proved the limitation for
both installation and project pinning. Moving both to local disk passed native
setup and filesystem checks for all four harnesses inside AgentCore. The user
requested persistent-filesystem investigation first (D19), including the
existing 1-GB capacity constraint, then explicitly excluded EC2 and proposed an
EFS working directory with harnesses kept on AgentCore local disk. The
[storage assessment](native-storage-options.md) now follows that split: AI-DLC
installation, workflow files and code on EFS; active harness homes/databases
local, with durable recovery exports. Existing Kiro, OpenCode and Codex store
helpers provide a starting point. EFS integration is supported by the current
compute model and locked provider. Project isolation and native cold recovery
remain unqualified. The user deployed the EFS retry successfully:
runtime **104** is READY and state is serial **1103**. The exact scoped discovery
policy is unchanged. Live EFS hard links, symlinks, rename, executable permissions
and a **1,082,130,432-byte** write/sync/readback passed with matching checksums
and cleanup. Testing also found that our mount check rejected AgentCore's valid
backing-overlay/EFS mount stack. Signed installation and all-four configuration
then passed on EFS (13 commands, 67 checks). Installation took 137 seconds,
exceeding the launcher's old 120-second setup budget. The mount-check and
300-second setup-timeout corrections were subsequently deployed and verified
on runtime **105**, state serial **1105**.
The investigation is recorded in the
[EFS verification checkpoint](native-efs-probe-checkpoint.md).
The [interaction checkpoint](native-interaction-probe.md) records the evidence.

The first runtime-105 Codex attempt passed **four setup commands and 18
filesystem checks**, started the model and created a native
`intent-capture-questions.md` file. The **600-second model deadline** ended the
turn with `SIGKILL`; cleanup reported false, with Codex and AI-DLC zombies
adopted by PID 1. The failed session was stopped with HTTP 200 at **09:17:43Z**.
A fresh read-only session confirmed the native artifacts remained on EFS;
that diagnostic session was also stopped. No answer or approval was submitted.
Artifact creation and persistence do not qualify question return, continuation
or native cold recovery.

Runtime corrections address native launcher PATH forwarding, a local
Codex HOME outside `/tmp` so its helpers are accepted, PID-1 child reaping with
Tini, and exclusion of the sensitive native steering-token key from snapshots.
All 116 focused tests and the actual new ARM64 image checks passed. The user
applied the shell-reaper plan. Runtime **106 READY**, state **1108**, image
`59d8f47b1f0a4bc11668b90cf5bf254c2dc4ad4178904c29ba1d1d27910c8d29`
and actual source/mount/launcher checks are verified. The prior plans are
historical, not current apply targets. Earlier failure evidence remains
under `/tmp/aidlc-plan-tools/native-model-verify-20260924/`:
`codex-failed.json`, `codex-processes-after-timeout.json`,
`codex-stop-session.json`, `codex-durable-artifacts.json`,
`path-launcher-proof.json` and `codex-home-proof.json`.

Codex then returned the title question and resumed the same native session for
the synthetic answer. Both turns exited 0 with confirmed cleanup. Native Q1 now
reads **`X. Blue Lake`**; Q2–Q4 remain blank. `request_user_input` was unsupported
in exec mode, so next-question delivery and full Codex qualification remain open.
The session was stopped with HTTP 200 at **10:20:50Z**. After the turns, a
credential-free diagnostic measured **6.918 ms** for a login shell versus
**6,534.280 ms** for the bind hook, with unchanged session/pin metadata and
cleaned cache/home. This establishes hook-path overhead, not EFS causality;
storage architecture is unchanged.

Kiro returned the title question, recorded Blue Lake in the same native question
file and returned Q2/Q3 with both turns clean. Session IDs changed
`ad2d4ad5...` → `e96470cc...`, with two JSONL conversation logs and an empty
legacy SQLite store; history resume is not qualified. The `auto` model-selection
`MethodNotFound` warning also leaves exact model fidelity open. Kiro was stopped
with HTTP 200 at **10:48:49Z**; no speculative resume-flag change is included.
Claude passed setup, then CLI 2.1.246 received API 400 requiring at least 2.1.255:
exit 1, cleanup complete, no model response. OpenCode passed four setup commands
and 16 checks, then asked the title question, recorded **`X. Other: Blue Lake`**
and returned a follow-up choice for the remaining questions. Both turns exited 0
with cleanup and empty diagnostics; their structured events and native session
file agree on `ses_f2cf455cdffenpsQK2rQuqQHVQ`. Q2–Q4 remain blank.
OpenCode was stopped with HTTP 200 at **11:06:54Z**. Those four runtime-106
disposable sessions were stopped.

The [historical interaction results](native-interaction-probe.md#runtime-106--historical-interaction-results)
link the before/after artifacts and qualification limits. The
[CLI compatibility plan](native-interaction-probe.md#cli-compatibility-deployment--applied-and-verified-historical)
has since been applied and verified: runtime **107 READY**, state **1111**,
image tag **`7020eeb9b852efb2`**, and **25/25 independent deployment checks**.
Actual runtime sources, Claude 2.1.257, Codex 0.145.0 with both question-tool
overrides, Tini and NFS passed verification; all four affected Lambda bundles
and environments match state. That plan is historical. The generated Claude
SessionEnd timeout correction has since been applied and verified on runtime 108;
its same-session question/answer/follow-up and native end-hook experiment passed.
IAM, EFS and network configuration are unchanged. Shared native UI,
isolated human approvals, project isolation and execution cold recovery remain
open beyond this verified operator interaction loop.

1. **Prove the native interaction path.** Use the verified pinned public package,
   whose four harness configurations are now verified, and run the same small scenario through each:
   create a native artifact, ask a real question, accept a deliberate test
   answer through the harness-supported channel, and continue. Retain the
   files and native evidence. This is an integration experiment, not a claim
   that collaborative approval authority is implemented. It resolves the
   largest remaining technical uncertainty before expanding the product UI.
2. **Demonstrate the collaborative loop.** Start from the application, view the
   actual native file, answer or approve as an existing project member through
   the isolated authority store, and observe native continuation and updated
   shared artifacts. Demonstrate a second collaborator seeing the same state.
   Unsupported edits and per-unit PRs remain disabled.
3. **Demonstrate the agreed pilot.** Interrupt and restore a run, verify
   cancellation and serial execution, and complete the same acceptance matrix
   across all four harnesses and supported public/private source providers.
   Enable the pilot only after those results and the rollout decision.

Do not serialize all independent implementation behind every provider/recovery
test. Work on the backend boundary, protected action store and harness interaction
adapters can proceed alongside the remaining package verification.
Deferred tests still have to pass before the pilot is described as supported.

## What the current storage work actually delivers

The user-selected **8,192 MiB RAM** is deployed and verified. The remaining first
import settings stay 4,096 MiB temporary disk, 600 seconds, one worker and
three attempts.

A temporary storage probe used the existing worker role and network without
increasing permissions or enabling imports. Its first live run passed
conditional creation, current/pinned reads, overwrite rejection and
missing-condition rejection, then stopped on an unsupported condition value.
The user deployed the narrow probe correction; its deployed code was verified.

The second live run reached 13 of 20 cases. Overwrites, both copy attempts and
ordinary multipart initiation were rejected. **Multipart initiation with a
signed `If-None-Match: *` header succeeded**, exposing a real policy gap. The
probe stopped immediately. Independent reads confirmed the original 32-byte
file and version were unchanged, with no extra objects or delete markers.
The one empty synthetic upload session was inspected and aborted using
operator credentials; the package upload inventory was empty at that checkpoint.

The user deployed the correction. The third invocation completed all 20 cases:
18 passed, with only expected fixture reuse and the unsupported wrong-header
response recorded as inconclusive. Both multipart attempts, copies, overwrites,
adjacent-prefix writes and all deletion attempts were rejected. Independent
reads confirmed the original file/version and empty multipart inventory.

**Dev activation was verified on 23 September: 16/16 checks passed**, including
the exact deployed worker hash, both import flags, enabled SQS consumer, running
Pipe, retired probe/log group, and unchanged permissions.

The user applied `/tmp/aidlc-native-dispatch-fix-dev.tfplan`. Live `DescribePipe`
exactly matches the reviewed raw-heredoc `InputTemplate`; the Pipe is `RUNNING`,
its role/source/target/filter are unchanged, and the SQS consumer is enabled.

At **10:57:37.216Z**, a fresh authenticated UI official `latest` import used
normal Pipe/SQS delivery only and reached `SUCCEEDED` in **one attempt**, with
**no diagnostic replay**. Worker duration was **7,516.43 ms**, maximum memory
**738 MiB**, and initialization **340.20 ms**. UI Download verified v2.9.0,
commit `22f5d1b15a064c9ae80046e5b1761d5877e2f69f`, and Claude, Codex, Kiro and
OpenCode projections. The job pin and materialization exactly match the earlier
archive whose exact-version S3 manifest and all five files were independently
verified; the fresh receipt comparison remains with the main task.

Historically, the 06:18:41Z import stalled at `QUEUED`, attempts 0, and its
06:22:54Z diagnostic replay succeeded. The new normal success after the
template-only fix supports the escaped-template explanation for that failure;
the old SQS body was never captured, so its exact shape remains unknown.
See the
[import checkpoint](native-package-import-checkpoint.md) for job, package and
evidence identifiers, and the [dispatch review](native-package-dispatch-review.md)
for the correction. Signatures remain `not_checked`, execution remains
`not_qualified`, and milestone 1 is incomplete.

The interaction host is decided: existing dev AgentCore. The first loop measures
ordinary clarification and continuation; structured question transport and
lost-session behavior still require evidence. Those decisions remain with the user.

## Delivery expectation

The full pilot is not one or two infrastructure deployments away. Significant
integration remains, especially human interaction and execution recovery.
There is not yet enough end-to-end evidence for a dependable completion date.
Re-estimate after milestone 1 using observed harness behavior, rather than
using package test counts or the number of deployed resources as a proxy.

Each subsequent update should state which milestone advanced, what the user
can now observe, what was tested live, and what is still only locally tested.
Use the detailed [implementation plan](native-execution-plan.md) for design,
the [import checkpoint](native-package-import-checkpoint.md) for current live
evidence, and the [storage checkpoint](native-storage-probe-checkpoint.md) for
the completed probe history.
