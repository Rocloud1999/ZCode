/** Transport-independent contracts for the opt-in Web execution host. */
export interface IdleSelection {
  providerId: string;
  modelId: string;
  options?: { reasoningLevel?: string };
}

export interface IdleTask {
  offPeakTaskId: string;
  status: string;
  workspacePath: string;
  workspaceIdentity?: string;
  serverTicketId?: string;
  modelSelection?: IdleSelection;
  permissionMode: string;
  prompt: string;
  conversationId?: string;
  sessionId?: string;
  schedulable?: boolean;
}

export interface TerminalOutcome {
  outcome: "succeeded" | "failed" | "stopped";
  ticketExpired: boolean;
  failureCode?: "admission_uncertain";
}

export interface Execution {
  conversationId: string;
  sessionId: string;
  inputId: string;
  finished: Promise<TerminalOutcome>;
  peekOutcome(): TerminalOutcome | undefined;
  submit(): Promise<void>;
  stop(): Promise<void>;
  dispose(): void;
}

export interface WorkerRepo {
  get(id: string): Promise<IdleTask | null>;
  listNonTerminal(): Promise<IdleTask[]>;
  claimDue(now: number): Promise<IdleTask[]>;
  releaseClaim(id: string, options?: { now?: number; error?: string }): Promise<void>;
  markRunning(id: string, options: {
    startedAt: number; conversationId?: string; sessionId?: string; serverTicketId?: string;
  }): Promise<IdleTask | null>;
  markTerminal(id: string, options: {
    status: "completed" | "failed" | "cancelled";
    endedAt: number; failureReason?: string; dispatchError?: string;
  }): Promise<IdleTask | null>;
  recoverInterrupted(now: number): Promise<number>;
}

/** Metadata only: never persist requestAuth, prompt text or model output here. */
export interface RunJournal {
  version: 1;
  taskId: string;
  sessionId: string;
  inputId: string;
  stage: "prepared" | "submitting" | "accepted" | "terminal";
  outcome?: TerminalOutcome;
}

export interface Journal {
  list(): Promise<RunJournal[]>;
  put(record: RunJournal): Promise<void>;
  remove(taskId: string): Promise<void>;
}

export interface WorkerDeps {
  repo: WorkerRepo;
  journal: Journal;
  isEnabled(): Promise<boolean>;
  prepare(task: IdleTask): Promise<Execution>;
  onTicketExpired(taskId: string): Promise<void>;
  isPermanent(error: unknown): boolean;
  log(event: string, details?: { taskId?: string; count?: number }): void;
  now?: () => number;
}

export type PermissionMode = "build" | "edit" | "plan" | "yolo";
export interface RequestAuth { apiKey: string; headers: Record<string, string> }
export interface SendIdlePrompt {
  taskId: string;
  traceId: string;
  content: string;
  clientMode: "desktop-continuous";
  toolDenylist: string[];
  modelSelection: IdleSelection;
  modelExecution: {
    memoryExtraction: "skip";
    selectionScope: "execution";
    requestAuth: RequestAuth;
    subagents: { foregroundModel: "submission"; background: "deny" };
  };
  offPeakTaskId: string;
  offPeakRunType: "init" | "resume";
}

export interface TaskPort {
  createTask(params: {
    workspacePath: string; mode: PermissionMode; offPeakTaskId: string;
    deferPersistenceUntilFirstPrompt: true;
  }): Promise<{ taskId: string; traceId: string }>;
  resumeTask(params: { taskId: string; workspacePath: string; offPeakTaskId: string }): Promise<unknown>;
  setConfigOption(params: {
    taskId: string; traceId: string; configId: "mode"; value: string;
  }): Promise<unknown>;
  listDeletedTaskIds(params: { workspacePath: string }): Promise<string[]>;
  listTasks(params: { workspacePath: string }): Promise<Array<{ taskId: string; status?: string }>>;
  onTerminal(taskId: string, listener: (event: {
    inputId: string; outcome: string; error?: string;
  }) => void): { dispose(): void };
  sendPrompt(params: SendIdlePrompt): Promise<unknown>;
  stopGeneration(params: { taskId: string; workspacePath: string; runId: string }): Promise<unknown>;
}

export interface ExecutorDeps {
  tasks: TaskPort;
  validateSelection(selection: IdleSelection): Promise<boolean>;
  buildRequestAuth(ticketId: string): Promise<RequestAuth>;
  assertWorkspace(path: string): Promise<void>;
  isTicketExpired(error: string | undefined): boolean;
}
