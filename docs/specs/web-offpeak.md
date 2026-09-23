# Web Off-Peak execution host — experimental

Baseline: zai-org/ZCode 872ad960de7ec172591f7e1952f7849229f94521.

## Scope and ownership

Opt-in Linux-only Node execution host for the standalone HTTP/Web entry. No Electron,
no UI on the server, no new cloud API, no credential export endpoint, no changes to the
Desktop, stdio remote host, Agent protocol, official eligibility or model allow-list.
The existing IOffPeakTaskService owns tickets, queue snapshots and ticket settlement;
OffPeakTaskRepo remains the only task-state authority. The worker owns one execution
at a time. A small write-ahead journal records only admission/outcome metadata, never
prompts, tokens or model output, and is not a second task queue.

Require a dedicated ZCODE_DATA_BASE_DIR and a Linux kernel-held abstract-socket lease
for that canonical directory. Acquire the lease BEFORE service startup/recovery.
Do not share this directory with Desktop, another runtime or a container PID namespace.
The service must be stopped with its child process group (provided systemd unit).

## Sequence and accounting invariants

local task -> existing official takeTicket -> existing sync marks schedulable
 -> lease owner claims -> checks official enablement and selected credentials
 -> prepares/resumes session -> subscribes to exact inputId
 -> durable prepared journal -> markRunning with session id
 -> durable submitting journal -> sendPrompt with EXECUTION-SCOPED idle selection/auth
 -> durable accepted journal -> terminal event -> durable terminal journal
 -> repo terminal write / existing 3102 continuation -> existing settlement outbox

Never turn an ordinary user message into a free one, never use the normal model as a
fallback, never enable Mock, never manufacture a ticket or change entitlement flags.
Use memoryExtraction=skip, selectionScope=execution, foregroundModel=submission,
background=deny, and deny CronCreate/OffPeakCreate exactly as the Desktop path does.
Permission requests remain pending for the user in the existing Web conversation.

One execution at a time, local polling every 20s (not a new official API poll).
Cancellation is authoritative in the existing repo; check it while an execution is
active and immediately before admission. Ignore events for another inputId and late
callbacks for a disposed run. Buffer a terminal event that arrives before send ACK.

## Recovery and uncertainty

Known accepted runs resume the same saved session after restart. Known terminal
outcomes are replayed into the repo before recovery; they do not re-run a model.
A crash in the submitting/ACK window is AMBIGUOUS: fail the task with an explicit
admission_uncertain reason instead of automatically re-submitting and duplicating
external side effects. No exactly-once guarantee for arbitrary Agent shell commands.
Failures to write the journal or settle locally halt new dispatch; restarting replays
known outcomes. No automatic downgrade to a paid request under any failure.

Shutdown stops claiming, interrupts only owned runs, retains unfinished rows/journals
for recovery, terminates services, then releases the lease. A supervisor timeout kills
the process group; it must not release the lease while an old Agent is still active.

## Acceptance

Tests: early terminal before ACK; wrong/late inputId; no-ticket/ordinary-provider
rejection; config disabled; single-flight ticks; transient prepare failure backoff;
failed send does not retry blindly; cancellation; closed-browser-independent event
subscription; 3102 requeue; accepted/ambiguous/terminal restart paths; corrupt journal;
lease exclusion/reacquisition; safe lifecycle stop during startup/dispatch.

Full workspace typecheck/lint and authenticated official execution are release gates.
This patch is NOT an upstream guarantee that the cloud accepts a headless build or
that a particular account has free entitlement.
