import { randomUUID } from "node:crypto";
import type { Execution, ExecutorDeps, IdleTask, PermissionMode, TerminalOutcome } from "./contract.js";

const IDLE_PROVIDERS = new Set([
  "account:zai-offpeak-idle-plan", "account:bigmodel-offpeak-idle-plan",
]);
const MODES = new Set(["build", "edit", "plan", "yolo"]);
const RESUME_PROMPT = "Continue the previous task from where it left off. The run was interrupted " +
  "(server restart or execution window expired). Do not start over; review what has " +
  "already been done and complete the remaining work.";

export class WebOffPeakPolicyError extends Error {
  readonly failureKind = "permanent";
}

/** Prepared runs make no model request until submit(), after durable admission metadata. */
export async function prepareIdleExecution(deps: ExecutorDeps, task: IdleTask): Promise<Execution> {
  if (task.workspaceIdentity?.trim()) throw new WebOffPeakPolicyError("remote_workspace_unsupported");
  if (!task.serverTicketId?.trim()) throw new WebOffPeakPolicyError("missing_offpeak_ticket");
  const selection = task.modelSelection;
  if (!selection || !IDLE_PROVIDERS.has(selection.providerId)) {
    throw new WebOffPeakPolicyError("non_idle_provider_rejected");
  }
  if (!MODES.has(task.permissionMode)) throw new WebOffPeakPolicyError("unsupported_permission_mode");
  await deps.assertWorkspace(task.workspacePath);
  if (!(await deps.validateSelection(selection))) throw new WebOffPeakPolicyError("idle_model_unavailable");
  const requestAuth = await deps.buildRequestAuth(task.serverTicketId);
  const headers = new Map(Object.entries(requestAuth.headers).map(([key, value]) => [key.toLowerCase(), value]));
  // 防止桥接时遗漏凭据或误用普通套餐请求；不制造、不替换服务端票据。
  if (!requestAuth.apiKey || !headers.get("authorization")?.startsWith("Bearer ") ||
      !headers.get("x-coding-plan-api-key") || headers.get("x-off-peak-ticket-id") !== task.serverTicketId) {
    throw new WebOffPeakPolicyError("incomplete_idle_request_auth");
  }

  const resume = Boolean(task.conversationId?.trim());
  const existingId = task.conversationId?.trim() || task.sessionId?.trim();
  let sessionId: string;
  let inputId: string;
  if (existingId) {
    sessionId = existingId;
    inputId = `${task.offPeakTaskId}:${resume ? "resume" : "bound"}:${randomUUID()}`;
    const scope = { workspacePath: task.workspacePath };
    const [deleted, sessions] = await Promise.all([
      deps.tasks.listDeletedTaskIds(scope), deps.tasks.listTasks(scope),
    ]);
    if (deleted.includes(sessionId)) throw new WebOffPeakPolicyError("bound_session_deleted");
    if (!resume && sessions.some((session) => session.taskId === sessionId && session.status === "running")) {
      // 先检查忙碌态，避免改变一个正在处理用户消息的会话权限。
      throw new Error("bound_session_busy");
    }
    await deps.tasks.resumeTask({ ...scope, taskId: sessionId, offPeakTaskId: task.offPeakTaskId });
    await deps.tasks.setConfigOption({ taskId: sessionId, traceId: inputId, configId: "mode", value: task.permissionMode });
  } else {
    // 与 Desktop 一样使用 deferred：由首次 V4 admission 先写入 session 主记录。
    // 不把隐藏 idle provider 写入 Session Selection。
    const created = await deps.tasks.createTask({
      workspacePath: task.workspacePath, mode: task.permissionMode as PermissionMode,
      offPeakTaskId: task.offPeakTaskId, deferPersistenceUntilFirstPrompt: true,
    });
    sessionId = created.taskId;
    inputId = created.traceId;
  }

  let outcome: TerminalOutcome | undefined;
  let resolveFinished!: (result: TerminalOutcome) => void;
  const finished = new Promise<TerminalOutcome>((resolve) => { resolveFinished = resolve; });
  let disposed = false;
  let submitted = false;
  const subscription = deps.tasks.onTerminal(sessionId, (event) => {
    if (disposed || outcome || event.inputId !== inputId) return;
    outcome = {
      outcome: event.outcome === "succeeded" ? "succeeded" : event.outcome === "stopped" ? "stopped" : "failed",
      ticketExpired: event.outcome === "failed" && deps.isTicketExpired(event.error),
    };
    resolveFinished(outcome);
  });
  return {
    conversationId: sessionId, sessionId, inputId, finished,
    peekOutcome: () => outcome,
    async submit() {
      if (disposed || submitted) throw new WebOffPeakPolicyError("duplicate_or_disposed_submission");
      submitted = true;
      await deps.tasks.sendPrompt({
        taskId: sessionId, traceId: inputId,
        content: resume ? RESUME_PROMPT : task.prompt,
        // 这是服务端内部自动派发，不改变 /ws 浏览器连接的 terminal-client 权限。
        clientMode: "desktop-continuous",
        toolDenylist: ["CronCreate", "OffPeakCreate"],
        modelSelection: selection,
        modelExecution: {
          memoryExtraction: "skip", selectionScope: "execution", requestAuth,
          subagents: { foregroundModel: "submission", background: "deny" },
        },
        offPeakTaskId: task.offPeakTaskId, offPeakRunType: resume ? "resume" : "init",
      });
    },
    async stop() { await deps.tasks.stopGeneration({ taskId: sessionId, workspacePath: task.workspacePath, runId: inputId }); },
    dispose() { if (!disposed) { disposed = true; subscription.dispose(); } },
  };
}
