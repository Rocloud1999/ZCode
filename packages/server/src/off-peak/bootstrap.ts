import { realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  ICodingPlanSubscriptionService, IOffPeakTaskService, IZCodeTaskService, type ServiceCollection,
} from "@zcode/services";
import {
  OffPeakTaskRepo, type OffPeakTaskService, OffPeakPermanentDispatchError,
  getOffPeakRequestAuthBuilder, getAppConfigDir, createServiceLogger,
} from "@zcode/services/node";
import { isOffPeakTicketExpiredError, type TraceId } from "@zcode/shared";
import { WebOffPeakWorker } from "./worker.js";
import { prepareIdleExecution, WebOffPeakPolicyError } from "./executor.js";
import { createFileJournal } from "./journal.js";
import { acquireWebOffPeakLease } from "./lease.js";
import { createWorkspaceGuard, ensureDedicatedDataDirectory, isPathWithin, type WebOffPeakOptions } from "./configuration.js";

/** Acquire this before createLocalServices; a rejected second process must not touch recovery. */
export async function reserveWebOffPeak(options: WebOffPeakOptions) {
  const canonicalDataRoot = await ensureDedicatedDataDirectory(options.dataDirectory);
  const appConfigDir = getAppConfigDir();
  if (!isPathWithin(options.dataDirectory, appConfigDir)) {
    throw new Error("ZCode data paths do not match ZCODE_DATA_BASE_DIR; refusing shared state");
  }
  const lease = await acquireWebOffPeakLease(appConfigDir);
  try {
    if (!isPathWithin(canonicalDataRoot, await realpath(appConfigDir))) {
      throw new Error("Web Off-Peak state directory escapes its dedicated data root");
    }
    const guard = await createWorkspaceGuard(options.workspaceRoot);
    return { lease, guard };
  } catch (error) {
    await lease.close();
    throw error;
  }
}

/** Reuses the same ServiceCollection, credentials, task repo and official sync as Web RPC. */
export async function createWebOffPeakRuntime(
  services: ServiceCollection,
  reservation: Awaited<ReturnType<typeof reserveWebOffPeak>>,
) {
  const tasks = services.get(IZCodeTaskService);
  // createLocalServices instantiates this exact implementation; renderer-facing interface is narrower.
  const idle = services.get(IOffPeakTaskService) as OffPeakTaskService;
  const subscriptions = services.get(ICodingPlanSubscriptionService);
  const auth = getOffPeakRequestAuthBuilder(services);
  if (!auth) throw new Error("web_offpeak_request_auth_unavailable");
  const repo = new OffPeakTaskRepo();
  const log = createServiceLogger("web-offpeak");
  const worker = new WebOffPeakWorker({
    repo,
    journal: createFileJournal(join(getAppConfigDir(), "web-offpeak", "runs")),
    isEnabled: async () => (await subscriptions.getOffPeakClientConfig()).enabled,
    isPermanent: (error) => error instanceof OffPeakPermanentDispatchError || error instanceof WebOffPeakPolicyError,
    onTicketExpired: (id) => idle.handleTicketExpiredDuringRun(id),
    log: (event, details) => { log.info(event, details); },
    prepare: (task) => prepareIdleExecution({
      validateSelection: (selection) => idle.validateDispatchModelSelection(selection),
      buildRequestAuth: auth,
      assertWorkspace: async (path) => {
        try { await reservation.guard(path); }
        catch { throw new WebOffPeakPolicyError("workspace_not_allowed_or_missing"); }
      },
      isTicketExpired: isOffPeakTicketExpiredError,
      tasks: {
        createTask: (params) => tasks.createTask(params),
        resumeTask: (params) => tasks.resumeTask(params),
        setConfigOption: (params) => tasks.setConfigOption({ ...params, traceId: params.traceId as TraceId }),
        listTasks: (params) => tasks.listTasks(params),
        listDeletedTaskIds: (params) => tasks.listDeletedTaskIds(params),
        onTerminal: (taskId, listener) => tasks.onDynamicTaskTerminalOutcome(taskId)((event) => {
          if (event.inputId) listener({ ...event, inputId: event.inputId });
        }),
        sendPrompt: (params) => tasks.sendPrompt({ ...params, traceId: params.traceId as TraceId }),
        stopGeneration: (params) => tasks.stopGeneration({ ...params, runId: params.runId as TraceId }),
      },
    }, task),
  });
  try { await worker.start(); }
  catch (error) { await worker.stop(); repo.close(); throw error; }
  return {
    worker,
    async stop() { await worker.stop(); repo.close(); },
  };
}
