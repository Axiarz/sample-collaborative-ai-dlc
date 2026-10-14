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
token. Interrupted cleanup leaves recoverable FAILED state; review a fresh
preview before retrying. Integrated unit rows and their completed stages are
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
choices and runtime ARN/endpoint remain pinned. Starting recovery and deploying
the release remain separate operator actions.

### Automatic preservation recovery checks

The incomplete terminal section preview now checks **both** execution targets
before it permits confirmation. Its required capabilities are
`preserve-integrated-section@1` and `checked-runtime-dispatch@1`, using capability
schema 1. This check applies to the terminal preservation recovery introduced
above. Existing running-lane repair, ordinary rewind (which resets affected
integrated lanes), gate resume, and historical reads keep their existing
contracts. There is no alternative request field that skips the check: the
server derives it from authoritative execution, unit-plan and unit state.

The preview reports one of three states:

- **Recovery is available:** both targets support the required behavior.
- **A deployment update is needed:** the published orchestrator package is not
  attested by this API deployment, or the original runtime lacks the capability.
- **Recovery cannot currently be verified:** configuration is missing, a metadata
  read is denied or unavailable, an endpoint is updating, or a target changes
  while the check is running. Refresh after the service or deployment settles;
  an administrator must fix missing read permissions.

The orchestrator observation resolves the configured qualifier with `GetAlias`
(numeric qualifiers need no alias read), refuses weighted aliases, and reads
the published version with `GetFunctionConfiguration`. Terraform generates
`RECOVERY_ORCHESTRATOR_RELEASE` from the actual published **qualified ARN and
deployment package SHA-256**, plus `lambda/shared/recovery-capabilities.json`.
Both identity and package hash must match the service observation. A feature
flag, release label, creation time, or the name `live` cannot certify a target.
Only the release attested by the current API deployment is admitted; pointing
an alias at another version requires its matching API deployment as well.

The runtime observation uses the original snapshot through `resolveRuntimeTarget`,
including the established fallback for legacy records without a snapshot.
`GetAgentRuntimeEndpoint` resolves the captured endpoint (or `DEFAULT`) to a
ready live version. Before and after a `recovery-capabilities` invocation it
compares the endpoint version and update identity. The command reports the
capability contract and SHA-256 of executable source files in the container's
protected `agentcore/` and `shared/` directories. It does not read credentials,
account usage, discover models, open a CLI/model session, access the intent
workspace, or dispatch business handlers. A fresh metadata-only AgentCore
session avoids an old warm business session; it expires under normal runtime
idle policy. This can start a runtime microVM, so it is not a zero-cost HTTP
health check. No session-stop operation is issued by preview.

Observations are included in the preview token. Confirmation repeats the checks,
compares the token, and repeats them once more immediately before atomic run
retirement. Reads have a bounded request deadline and there is no compatibility
cache. No token retirement, unit/stage reset, artifact archival or execution
launch occurs on a failed check. Ownership conditions still admit at most one
concurrent confirmation.

After confirmation, the new durable invocation uses the **observed numeric
Lambda version**, even if the alias subsequently moves. Its existing `load-meta`
checkpoint captures the runtime guard; no new durable operation is inserted into
old replay histories. Every runtime command in this recovery is enclosed in
`recovery-dispatch`, which checks the observed source digest and capabilities
before credentials, accounting or business work. A later runtime rollout with
different source is refused rather than silently continuing recovery on it;
old containers reject the unknown envelope. Refresh and preview the resulting
failed recovery before retrying. This preserves the original endpoint and
does not create, update or repoint runtime endpoints.

An endpoint update can still happen after the last metadata read. A later
compatible container with identical executable source can serve that endpoint;
an incompatible/different source fails the guarded dispatch. The guard is a
code compatibility check, not a mechanism for making mutable AWS endpoints
immutable. Infrastructure administrators must continue to honor published
environment revision immutability.

### Mixed-version rollout and verification

1. Deploy the orchestrator package, intents API/IAM, runtime image and frontend.
   Terraform propagates the package identity to the API; changing shared
   capability code participates in both Lambda and runtime packaging hashes.
   Intents needs `lambda:GetAlias`, `lambda:GetFunctionConfiguration`, and
   `bedrock-agentcore:GetAgentRuntimeEndpoint` on its existing target scopes.
   No model, credential-read, or endpoint mutation permission is added.
2. During rollout, a new API refuses unattested orchestrator packages and old
   runtimes. A new frontend refuses a terminal preview from an old API that
   omits compatibility. An old frontend talking to the new API cannot bypass
   server checks. An old API remains unguarded until it is replaced: do not
   enable terminal recovery while old API workers/deployments still serve it.
   Existing histories and ordinary supported retries are not migrated.
3. For a managed environment pinned to an older immutable revision, rebuilding
   the project's current environment does **not** change the old intent's pin.
   Review whether its original target can legitimately receive the update.
   Otherwise retain that history and create a follow-up intent on a supported
   environment. Never patch execution pins or repoint an immutable revision to
   make a blocked check pass.
4. After deployment, an owner/admin opens **Preview recovery** on an eligible
   test intent. Check both supported observations in the expandable deployment
   details. Refresh once and verify that no execution records, artifacts or
   model work changed. No confirmation is needed for this check.
5. In a disposable test deployment, verify missing read permission and an older
   captured endpoint produce a blocked preview; restore the deployment. Move a
   launch alias between preview and confirmation and expect 409 without record
   mutation. Restore it, refresh, then deliberately confirm only when a real
   recovery is intended. Confirm numeric-version launch, original environment
   targeting, preserved integrated units, and normal human approvals.

Deterministic tests cover these decisions with sanitized service responses and
local stores. They do not certify a currently deployed AWS package, IAM policy,
endpoint, or model. Deployment and the above post-deployment checks are required
before making that claim.
