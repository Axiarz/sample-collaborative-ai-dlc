# Recovery ownership

A worker may change recovery state only while both ownership tokens match:
`META.orchestratorRunId` identifies its execution run, and
`STAGE.stageCallbackId` identifies its stage attempt. The orchestrator supplies
the run token in the dispatch, and the worker carries both tokens into its MCP
process. A consistent read helps diagnose state; the write transaction enforces
ownership even if a rewind happens after that read.

| Transition                  | Ownership and replay behavior                                                                                                                                                                                                             |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claim a stage               | Check the active META run and claim the callback without replacing the saved conversation. Repeating the same RUNNING callback is allowed; a different callback cannot claim a RUNNING stage.                                             |
| Open an agent question      | Create HUMAN, park STAGE, and update the linear META wait in one transaction. Unit questions park only their own stage. HUMAN records the creating run and callback.                                                                      |
| Open an engine gate         | Create HUMAN and park META atomically, conditional on the run. The durable gate-open step also retires a specific legacy gate if its later META ownership check fails.                                                                    |
| Answer                      | For owned gates, check the active run and, for agent questions, the creating callback with the pending-to-answered write. Deliver the callback from the committed answer row, including a binding that raced the endpoint's initial read. |
| Unpark                      | Both engine and stage gates use the same conditional transition. Already RUNNING with the same run token and no pending gate means the write previously committed; another owner or another pending gate means retirement.                |
| Finish or fail a worker     | Check the run and callback in the same transaction as the stage write. A retired result stops orchestration without failing a replacement attempt.                                                                                        |
| Retire an unusable question | Check the stage callback and gate identity. Clearing META also requires its expected pending gate. Cleanup errors cannot replace the original recovery error.                                                                             |

Engine-gate durable operation names and order remain compatible with the
implementation before the recovery PR. The replay fixture is frozen from commit
`590ace6`; its checkpoints are resumed with the current implementation in tests.

Legacy synchronous dispatches lack ownership tokens and retain their existing
behavior. The worker does not guess an owner to overwrite an unverified legacy
stage after a failed recovery read. Deploy the orchestrator and runtime changes
together; an already running container on an older image does not acquire these
checks retroactively.

Storage must accept a write to persist FAILED state. During a complete outage the
worker preserves its structured failure, while durable dispatch and callback
reconciliation remain the recovery backstop. These guards protect process state;
they do not undo provider requests or Git operations already in flight.

## Incomplete terminal sections

Lane repair also supports a terminal execution whose active plan contains
unfinished work. Ordinary rewind resets all affected unit rows, including
integrated lanes; use the reviewed **Preview recovery** flow when that code must
be preserved.

`POST .../intents/{intentId}/repair` with `{"preview":true}` is read-only. The
owner/admin preview loads the pinned workflow, identifies one incomplete section,
lists preserved and unfinished units and downstream shared stages to rerun, and
checks recorded final PRs with the provider. A closed/merged final PR blocks this
recovery. Confirmation sends the preview token and, when necessary, an explicitly
selected dependency-free `walkingSkeleton`. A changed preview returns 409.
Legacy unit rows without a section mapping remain readable, but this recovery
refuses them rather than guessing which integrated work to preserve.

Retirement compares the prior status, run token and update timestamp. Stage
resets, unit updates and replacement skeleton decisions check the recovery run
token in the same DynamoDB transaction as the write. A concurrent confirmation
cannot relaunch a second run. Rewind/recompose cannot steal that retirement
token. Repair stores its reviewed plan and a five-minute `repairStartedAt` lease,
longer than the API worker's lifetime. If the worker dies without running its
catch, preview becomes available after expiry; confirmation claims the old run
conditionally and resumes that saved section and skeleton choice. A handled
failure permits an immediate fresh preview. Generic start cannot bypass an
unfinished repair. A late owner cannot clear its successor's lease or relaunch.
Integrated unit rows and their completed stages are
never reset by this flow. Missing/unstarted lanes may resume from the section
boundary; completed stages of unfinished lanes are preserved.

New human skips persist a per-unit `completionSkip` receipt tied to the unit-plan
identity and answered gate. Original events and answers remain immutable.
Legacy skips without receipts are shown as accepted partial delivery when the
current run's answered halt gate records that choice; they are not silently
reinterpreted as false success.

## Deployment and durable compatibility

Deploy the orchestrator, intents API, AgentCore image and frontend together.
The first existing `load-meta` step captures `completionPolicyVersion: 1` for new
histories. A pre-change checkpoint lacks that marker and retains its previous
operation sequence. The frozen load-meta replay fixture covers this boundary.
Changing a Lambda alias does not rewrite a finished version-pinned execution or
repair its stored success.

Recovery launches a new durable history through the configured orchestrator
target. The original methodology, credential binding, repositories, model
choices and runtime ARN/endpoint remain pinned. Before approving production
recovery, verify that this launch target and the captured runtime endpoint serve
the fixed release. Do not change execution pins or patch DynamoDB rows to force
the new behavior. Starting the recovery and deploying the release are separate
operator actions.
