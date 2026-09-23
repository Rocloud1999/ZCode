import type { Execution, IdleTask, RunJournal, TerminalOutcome, WorkerDeps } from "./contract.js";

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const POLL_MS = 20_000;
const RETRY_BASE_MS = 30_000;
const RETRY_CAP_MS = 15 * 60_000;
interface ActiveRun {
  task: IdleTask;
  execution?: Execution;
  stopping?: boolean;
  shutdownStopRequested?: boolean;
}

/** One owner; no UI subscriptions, cloud polling or paid-model fallback in this class. */
export class WebOffPeakWorker {
  private readonly deps: WorkerDeps;
  private readonly now: () => number;
  private timer?: ReturnType<typeof setInterval>;
  private ticking?: Promise<void>;
  private starting?: Promise<void>;
  private active?: ActiveRun;
  private accepting = false;
  private stopping = false;
  private faulted = false;
  private startCalled = false;
  private readonly finalizers = new Set<Promise<void>>();
  private readonly retry = new Map<string, { attempts: number; at: number }>();

  constructor(deps: WorkerDeps) { this.deps = deps; this.now = deps.now ?? Date.now; }

  getStatus(): { state: string; activeTaskId?: string } {
    return {
      state: this.faulted ? "faulted" : this.stopping ? "stopping" : this.accepting ? "ready" : "stopped",
      ...(this.active ? { activeTaskId: this.active.task.offPeakTaskId } : {}),
    };
  }

  /** Caller must hold the data-directory lease before invoking this method. */
  async start(options: { timers?: boolean } = {}): Promise<void> {
    if (this.startCalled) throw new Error("web_offpeak_worker_already_started");
    this.startCalled = true;
    this.starting = this.recover();
    try { await this.starting; } finally { this.starting = undefined; }
    if (this.stopping) return;
    this.accepting = true;
    if (options.timers !== false) {
      this.timer = setInterval(() => { void this.tick(); }, POLL_MS);
      this.timer.unref();
      void this.tick();
    }
  }

  private async recover(): Promise<void> {
    const accepted = new Set<string>();
    for (const record of await this.deps.journal.list()) {
      const task = await this.deps.repo.get(record.taskId);
      if (!task || TERMINAL.has(task.status)) {
        await this.deps.journal.remove(record.taskId);
        continue;
      }
      if (record.stage === "terminal") {
        await this.settle(record);
      } else if (record.stage === "accepted" && task.conversationId === record.sessionId) {
        accepted.add(record.taskId);
        // 保留 accepted 记录直到新轮次准备完成；无论重启多少次都能识别已知会话。
      } else if (record.stage === "prepared" && task.status === "queued") {
        await this.deps.repo.releaseClaim(record.taskId, { now: this.now() });
        await this.deps.journal.remove(record.taskId);
      } else {
        await this.deps.repo.markTerminal(record.taskId, {
          status: "failed", endedAt: this.now(), failureReason: "web_offpeak_admission_uncertain_review_required",
        });
        await this.deps.journal.remove(record.taskId);
      }
    }
    for (const task of await this.deps.repo.listNonTerminal()) {
      if (task.status === "running" && !accepted.has(task.offPeakTaskId)) {
        // 没有本 worker 的接受记录时，不能擅自重跑其他宿主/旧版本留下的运行。
        await this.deps.repo.markTerminal(task.offPeakTaskId, {
          status: "failed", endedAt: this.now(), failureReason: "web_offpeak_untracked_run_review_required",
        });
      }
    }
    const count = await this.deps.repo.recoverInterrupted(this.now());
    this.deps.log("recovery_complete", { count });
  }

  tick(): Promise<void> {
    if (!this.accepting || this.stopping || this.faulted) return Promise.resolve();
    if (this.ticking) return this.ticking;
    const work = this.tickOnce().catch(() => this.halt("worker_tick_failed"));
    this.ticking = work.finally(() => { this.ticking = undefined; });
    return this.ticking;
  }

  private async tickOnce(): Promise<void> {
    if (this.active) {
      const run = this.active;
      const task = await this.deps.repo.get(run.task.offPeakTaskId);
      if ((!task || task.status !== "running") && run.execution && !run.stopping) {
        run.stopping = true;
        await run.execution.stop();
      }
      return;
    }
    let enabled: boolean;
    try { enabled = await this.deps.isEnabled(); }
    catch { this.deps.log("official_config_unavailable"); return; }
    if (!enabled || this.stopping) return;
    const claimed = await this.deps.repo.claimDue(this.now());
    let selected: IdleTask | undefined;
    // 不在本地排第二个接受队列；额外认领立即归还，权威队列始终在现有 Repo。
    for (const task of claimed) {
      if (!selected && (this.retry.get(task.offPeakTaskId)?.at ?? 0) <= this.now() && !this.stopping) {
        selected = task;
      } else {
        await this.deps.repo.releaseClaim(task.offPeakTaskId, { now: this.now() });
      }
    }
    if (selected) await this.admit(selected);
  }

  private async admit(task: IdleTask): Promise<void> {
    const id = task.offPeakTaskId;
    const run: ActiveRun = { task };
    this.active = run;
    let execution: Execution;
    try {
      execution = await this.deps.prepare(task);
      run.execution = execution;
    } catch (error) {
      if (this.deps.isPermanent(error)) {
        await this.deps.repo.markTerminal(id, {
          status: "failed", endedAt: this.now(), failureReason: "web_offpeak_configuration_rejected",
          dispatchError: "web_offpeak_configuration_rejected",
        });
      } else {
        const attempts = (this.retry.get(id)?.attempts ?? 0) + 1;
        this.retry.set(id, { attempts, at: this.now() + Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** Math.min(attempts - 1, 8)) });
        await this.deps.repo.releaseClaim(id, { now: this.now(), error: "web_offpeak_prepare_failed" });
      }
      if (this.active === run) this.active = undefined;
      this.deps.log("prepare_failed", { taskId: id });
      return;
    }
    const latest = await this.deps.repo.get(id);
    if (this.stopping || !latest || latest.status !== "queued" ||
        !latest.schedulable || latest.serverTicketId !== task.serverTicketId ||
        latest.prompt !== task.prompt || latest.permissionMode !== task.permissionMode ||
        JSON.stringify(latest.modelSelection) !== JSON.stringify(task.modelSelection)) {
      execution.dispose();
      await this.deps.repo.releaseClaim(id, { now: this.now() });
      this.active = undefined;
      return;
    }
    const record: RunJournal = {
      version: 1, taskId: id, sessionId: execution.sessionId, inputId: execution.inputId, stage: "prepared",
    };
    // 顺序不变量：把 session id 落库放在 send 前；终态事件即使早于 ACK 也不会丢失关联。
    await this.deps.journal.put(record);
    const running = await this.deps.repo.markRunning(id, {
      startedAt: this.now(), conversationId: execution.conversationId,
      sessionId: execution.sessionId, serverTicketId: task.serverTicketId,
    });
    if (!running) {
      execution.dispose();
      await this.deps.journal.remove(id);
      await this.deps.repo.releaseClaim(id, { now: this.now() });
      this.active = undefined;
      return;
    }
    const beforeSend = await this.deps.repo.get(id);
    if (this.stopping || !beforeSend || beforeSend.status !== "running") {
      execution.dispose();
      // 未发送却已落 running 的 prepared journal 会在恢复时显式报告，不猜测已执行。
      this.active = undefined;
      return;
    }
    await this.deps.journal.put({ ...record, stage: "submitting" });
    if (this.stopping) return;
    try {
      await execution.submit();
    } catch {
      // ACK 失败并不证明请求未到达。禁止释放回队后再自动 submit，避免重复副作用。
      const known = execution.peekOutcome();
      if (!known) await execution.stop();
      await this.finish(run, record, known ?? { outcome: "failed", ticketExpired: false, failureCode: "admission_uncertain" });
      this.deps.log("submission_failed_without_paid_fallback", { taskId: id });
      return;
    }
    await this.deps.journal.put({ ...record, stage: "accepted" });
    this.retry.delete(id);
    this.deps.log("idle_turn_accepted", { taskId: id });
    const finalizing = execution.finished.then(async (outcome) => {
      if (this.active !== run) return;
      // 退出引发的 stopped 留给下次续跑；已知成功/失败不能因为退出竞态而丢弃。
      if (run.shutdownStopRequested && outcome.outcome === "stopped") return;
      await this.finish(run, record, outcome);
    }).catch(() => this.halt("terminal_write_failed"));
    this.finalizers.add(finalizing);
    void finalizing.finally(() => this.finalizers.delete(finalizing));
  }

  private async finish(run: ActiveRun, record: RunJournal, outcome: TerminalOutcome): Promise<void> {
    const terminal: RunJournal = { ...record, stage: "terminal", outcome };
    await this.deps.journal.put(terminal);
    await this.settle(terminal);
    run.execution?.dispose();
    if (this.active === run) this.active = undefined;
  }

  private async settle(record: RunJournal): Promise<void> {
    const task = await this.deps.repo.get(record.taskId);
    if (task && !TERMINAL.has(task.status) && record.outcome) {
      if (record.outcome.ticketExpired) {
        // 复用官方客户端的 3102 回队/重取号，不生成本地准入票。
        await this.deps.onTicketExpired(record.taskId);
      } else {
        await this.deps.repo.markTerminal(record.taskId, {
          status: record.outcome.outcome === "succeeded" ? "completed" : record.outcome.outcome === "stopped" ? "cancelled" : "failed",
          endedAt: this.now(),
          ...(record.outcome.outcome === "failed" ? { failureReason: record.outcome.failureCode === "admission_uncertain" ? "web_offpeak_admission_uncertain_review_required" : "web_offpeak_execution_failed" } : {}),
        });
      }
    }
    await this.deps.journal.remove(record.taskId);
    this.deps.log("idle_turn_settled", { taskId: record.taskId });
  }

  private halt(event: string): void {
    this.faulted = true;
    if (this.timer) clearInterval(this.timer);
    this.deps.log(event, this.active ? { taskId: this.active.task.offPeakTaskId } : undefined);
  }

  /** Call before disposing services; release the external lease only AFTER child cleanup. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.accepting = false;
    if (this.timer) clearInterval(this.timer);
    await this.starting?.catch(() => undefined);
    await this.ticking;
    const run = this.active;
    if (run?.execution) {
      // 只有主动退出造成的 stopped 才按中断恢复；此前已到达的终态仍然落库。
      run.shutdownStopRequested = !run.execution.peekOutcome();
      await run.execution.stop();
      run.execution.dispose();
    }
    // Pending unresolved finished promises must not block shutdown forever.
    // Existing persistence operations finish before the shared sqlite handles are closed.
    if (run?.execution?.peekOutcome()) await Promise.all([...this.finalizers]);
    this.active = undefined;
  }
}
