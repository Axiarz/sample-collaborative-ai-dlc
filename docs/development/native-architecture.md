# Native ownership, upgrade and operation

Native owns new methodology execution. Supported v2 security, correctness,
recovery, replay and integration remain maintained; new v2 methodology features
require a scoped architecture exception. This policy does not retire v2.

## Authority and effects

| Aggregate                                          | Mutation owner                     | Inputs                                                                | Effects and readers                                      |
| -------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------- |
| Preparation `RUNTIME`                              | Native authority                   | Authenticated draft/prepare commands; leased provisioner observations | Provisioner reconciles EFS/IAM/AgentCore                 |
| `EXECUTION`, accepted answers, publication history | Native authority                   | Authenticated commands; fenced execution observations                 | Supervisor reconciles one runtime turn                   |
| Output history and cursor                          | Native authority                   | Generation/lease-bound output batches                                 | REST reads; content-free socket invalidation             |
| Projection cursor                                  | Native authority                   | Projection claim and exact revision acknowledgement                   | Independent graph projector                              |
| Runtime image revocation                           | Operator                           | Explicit immutable revocation                                         | Bridge wakes affected executions; controller fences them |
| Discussion assistance                              | Discussion owner                   | Request/attempt-bound advisory completion                             | Quorum has no answer-acceptance authority                |
| Workflow files                                     | Admitted native runtime generation | Pinned methodology and accepted answers                               | Immutable verified publications/checkpoints              |
| Collaborative drafts                               | Yjs persistence owner              | Document-scoped collaboration                                         | Never accepted workflow answers                          |

The native authority is one deployment with IAM-restricted aliases for HTTP
commands, preparation observations, execution observations and projection
observations. Alias identity comes from Lambda invocation context, never the
payload. HTTP commands independently verify the Cognito token and recheck
membership. Reconciliation roles cannot write the control table or invoke another
caller class. Authority writes are restricted to `NATIVE#*` partitions; image
revocation partitions remain operator-only. Conditional stores enforce aggregate,
lease, generation and immutable-answer semantics within this IAM boundary.

Committed state drives wakeups through a DynamoDB stream bridge. Periodic,
paginated reconciliation repairs stream expiry and lost queue notifications.
Neither acceptance nor correctness depends on the browser retrying. Cancellation
uses its own queue and consumer concurrency, invalidates the ordinary lease
atomically, and closes the protected runtime fence before stopping the session.
Duplicate wakeups are hints to reconcile the same protected command identity.

Publication revisions are immutable. Graph progress has a separate cursor and
lease; it cannot gate dispatch or the next publication. The projector consumes
history in order, validates exact object versions, rechecks authorization, and
uses monotonic revision predicates at graph writes. A stale projector cannot
replace newer values. Legacy pending heads and history remain replayable.
The progress row records the exact target publication ID, sequence, epoch and
binding. Only its current lease can acknowledge that target. Projection can
finish an already committed revision after cancellation; cancellation cannot
authorize another publication. A deleted/replaced draft cannot be claimed or
acknowledged. Public execution status reports `projectionStatus: pending` while
the cursor lags. Reads serve immutable admitted content during that lag.

The HTTP entrypoint authenticates through the `commands` alias. The authority's
route operations handle collection reads, execution commands and committed
reads. The supervisor retains the lease/cancellation/error shell and delegates
dispatch reconciliation, recovery and completed-turn verification. The runtime
separates harness preparation, one turn and quiescent publication. The existing
intents realtime-token URL delegates to a dedicated adapter. Native protocol
interpretation stays in the pinned native adapters; these are not platform stage
transitions.

## Trust limits

One filesystem writer means one admitted runtime generation. Harnesses and tools
in that generation share a UID and can change local files. Local approval markers
are not protected approval. The immutable presented-answer ledger is authoritative;
approval-dependent platform effects must verify that ledger and exact context.
Native has no platform Git delivery, workflow-answer mutation or stage scheduler
capability. Existing v2 protected effects retain their engine-owned checks.
Membership still uses existing graph membership authority; projection independence
does not bypass membership when that authority is unavailable.
The execution reconciler alone writes the S3 runtime fence using conditional
object writes; the native runtime can read only its latest fence. Recovery still
requires positive predecessor-stop evidence before admitting a new generation.
Cancellation closes the fence before the stop request and never admits a
replacement writer.

The shared platform runtime still needs Neptune permissions for supported v2
commands. Quorum's result-only Lambda invocation and the forbidden direct-write
check establish its code boundary; this is not runtime-wide IAM isolation from
the discussion graph. Results are accepted only for the stored request and
attempt while running and unredacted. A legacy in-flight result with no attempt
can finish only until an explicit retry installs a new attempt. Discussion
results cannot accept native answers. Same-UID tools are not a security boundary
for either engine; do not use local approval files as permission for a protected
platform effect.

| Existing protected effect                     | Required authority                                                                                                                      | Regression evidence                                            |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Native continuation/selection                 | Current member, exact presented interaction/content digest, request identity and immutable answer transaction                           | `execution-serial.test.js`, `architecture-contract.test.js`    |
| Native new writer/recovery                    | Protected generation/fence and verified checkpoint; positive predecessor stop for recovery                                              | `execution-recovery.test.js`, retained/legacy protocol suites  |
| Native publication admission                  | Current lease/generation, exact pinned context and verified immutable bytes; publishing content is not approval of its proposed actions | `execution-worker.test.js`, `native-interaction-graph.test.js` |
| Supported v2 checkpoint-dependent progression | Durable positive-label confirmation receipt bound to shown content, attempt and checkpoint context                                      | `lambda/agentcore/test/checkpoint-confirmation.test.js`        |

Native methodology stage approvals beyond these platform effects are interpreted
by the pinned engine. Its local markers are not independently protected receipts;
this milestone does not certify a hostile same-UID harness cannot alter them.
Any added platform effect that depends on such an approval must validate the
immutable presented-answer binding at its trusted boundary first.

## Upgrade, drain and retirement

Application N−1 upgrade support and pinned-run support are different promises.
An N−1 installation can contain much older resumable work. Retain image/CLI bytes,
methodology archive versions, source/configuration pins, accepted answer ledgers,
checkpoint/publication decoders, runtime targets and permissions for every
supported dependent. Release age alone never authorizes deletion.

Close admission before draining. Existing prepared drafts, reads, replies,
cancellation and recovery remain serviceable. Never repin an existing execution,
restart its conversation, or replace an accepted answer during upgrade. A
migration requires a verified quiescent checkpoint and a separately reviewed
conversion contract; cross-engine migration is not provided by this milestone.
Deliberate revocation must close writers and preserve readable history.

Removal requires a current protected dependency inventory after admission closes,
zero unresolved executable references, verified stop/migration receipts where
applicable, and a reviewed plan. Unknown record/schema combinations fail closed.
Code cannot establish GitHub branch protection or deployed IAM correctness.

### Coordinated controller and infrastructure upgrade

| Setting                              | Meaning after this milestone                                                    | Default                                    |
| ------------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------ |
| `native_services_enabled`            | Resident reads, routes, preparation/execution recovery, projection and delivery | `true`                                     |
| `native_execution_admission_enabled` | Accept a new native execution                                                   | `null`, inherits `enable_native_execution` |
| `enable_native_execution`            | Backward-compatible alias for new-start admission                               | `false`                                    |
| `enable_native_preparation`          | Accept new native drafts                                                        | `false`                                    |

Deploy the controller packages, authority aliases, IAM, table stream, repair
schedule and queues together. Keep `native_services_enabled=true`. Existing
module/indexed resource addresses are retained. The old enablement flags now
close admission only: setting them false no longer destroys resources. This
deliberately changes the old dangerous rollback meaning. Fresh installations
also retain resident native infrastructure unless explicitly opted out through
the empty-dependency check; review its cost in the plan.

The installer accepts these ordinary Terraform inputs. Its existing saved-plan
inspection now rejects native service deletion/replacement without the protected
inventory receipt. Do not roll only the new transport back to a controller
without authority aliases. To stop new starts, set
`native_execution_admission_enabled=false`; to stop new drafts as well, set
`enable_native_preparation=false`. Preserve package/archive storage, runtime
images, source bindings, credentials and all services while supported work
exists. Do not disable unrelated package/source infrastructure as a drain action.
Existing draft preparation retries and exact existing-start retries still work.
Frontend capability responses disable new preparation/start while existing-run
status continues to advertise execution availability; no second UI is needed.

Old row schema 1 and old strict runtime transports remain supported. Immutable
publication history is replayed from sequence 1; pre-history first-turn rows use
their exact committed head. Missing intermediate revisions fail visibly instead
of inventing history. No row rewrite or repin is needed to create a projection
cursor. New publication heads retain the legacy pending field for readable
compatibility; current public lag comes from the owned cursor. The supported
tuples and exact-byte provenance paths are in
[native-compatibility.json](native-compatibility.json). Fixtures verify transport
and controller compatibility, not the retained CLI's live restore behavior.

### Dependency inventory and removal

Run `node scripts/native-dependencies.mjs <native-control-table>` with read-only
DynamoDB access. The paginated, consistent inventory emits hashed record
identities and dependency references, never answers or checkpoint contents.
Unknown records stay protected. Preparation records remain protected even after
failure because they can own external resources. A waiting or recoverable
execution, its accepted answer and its older image cannot expire merely because
the application upgraded.

For a never-used installation only, set `native_services_enabled=false` with both
admissions closed. Terraform invokes the read-only preflight, verifies the
deployed `commands` alias has admission disabled, waits out its request timeout,
rechecks its version and scans protected state. This requires DynamoDB Scan and
Lambda GetFunctionConfiguration permission for the operator. Missing resources
are accepted; permission failures are not. Coordinate this operation exclusively
with deployment ownership; do not reopen admission while reviewing/applying it.
Any protected row, including readable history, blocks full teardown. The existing
plan guard independently rejects persistent-storage destruction even for empty
services. It does not create an automatic data-deletion exception.

For used installations, leave the resident services and storage in place.
Dependency-specific removal must use `assertNativeRemoval` against the current
inventory and separately verify external stop receipts. There is deliberately
no automatic retirement/migration of old conversations or v2 replay in this
milestone. A future removal must retain history access, prove a quiescent
migration or explicitly revoke support, and carry scoped architecture review.

### Repair and incident operation

The stream bridge retries failed batches. The five-minute repair scans current
state and repairs preparation, execution, cancellation, projection and image
revocation wakeups, including quiet waiting executions. Duplicate messages
reload protected state and share one logical command. Execution, cancellation
and projection queues have no receive-count cutoff. Preparation retains its
existing DLQ; repair rediscovering `PREPARING` state does not depend on that old
message surviving. Watch wakeup errors, stream iterator age
and queue age alarms; attach notification actions in the deployment's alerting
policy. Repair is bounded by the Lambda timeout and the current pilot's table
size; qualify scan time/capacity before expanding admission.

For projection lag, preserve immutable objects, restore graph membership/read and
write access, and allow the projector to replay. `native_projection_retry` logs
and queue age expose failure. Do not edit execution state, skip a revision, or
advance the cursor manually. An authorization outage intentionally prevents
dispatch/projection until membership can be verified.

## Review and reproducible checks

`architecture/native-owners.json` declares aggregate owners, caller operations
and implementation boundaries. CI rejects forbidden factory imports (including
aliases, namespace imports and re-exports), direct native DynamoDB mutation
bypasses and direct Quorum graph writes. The Python IAM/wiring guards and mocked
Terraform test check generated roles, routes, aliases and resident resources.
This is static/code enforcement plus Terraform evaluation, not a deployed IAM
simulation.

The deterministic Acorn structural metric is `1 + if + ternary + loops +
non-default switch cases + catch`, attributed to the nearest function. Boolean
operators do not count. The committed baseline was measured from the published
pre-milestone HEAD using exactly that metric. New native functions must score at
most 20; pre-existing hotspots must not increase. An exception must name the
function, maximum and reason in the owner manifest for review through the existing
PR process. There are no initial exceptions. This measure is neither Jerome's older
metric nor a claim that a function is untestable.

Run `npm run architecture:check`, `npm run test:native-wiring` and
`node --test scripts/test/native-architecture.test.mjs`. From one clean HEAD,
`npm run architecture:map` emits ignored `reports/architecture/native.json` and
`native.html` with source hashes, imports, declared writers, IAM sources,
hotspots, compatibility provenance and unresolved dynamic edges. CI uploads the
map; release tooling includes it as a release asset. Previewing a dirty tree
requires `--allow-dirty` and is explicitly labeled.

For owner/command/fence/lifecycle/replay/protocol changes, include transition,
failure and compatibility evidence in the PR and use the repository's existing
review process. Diff size is a review triage signal, not a fixed cap. The native
architecture job checks technical boundaries and generates the map; it does not
assign reviewers or require approval of a particular commit. Adding the workflow
does not configure GitHub branch protection or prove a release ran.

## Release qualification

1. Record source HEAD, controller protocol/schema, exact retained runtime image
   and CLI versions, methodology archive/object versions, source/configuration
   hashes, response ledger and checkpoint/publication formats.
2. Run local retained-byte fixtures, authority denial tests, command delivery,
   cancellation, projection replay and admission-shutdown contracts.
3. In an authorized isolated deployment, start on the oldest supported image,
   park with an accepted answer, upgrade the controller, renew credentials,
   cold-restore the real CLI and consume that answer once.
4. Exercise lost acknowledgements, duplicate deliveries, stale generations,
   tampered checkpoints, revoked membership/image and unsupported formats.
5. Close admission and verify prepared, waiting, running and recovering work.
   Inventory all references before any runtime/resource or decoder removal.
6. Review generated architecture artifacts and release evidence through the
   repository's existing review process.

Local tests do not qualify real old-image recovery, live resources, model behavior,
deployed permissions or a rollout. Those require the authorized qualification above.
