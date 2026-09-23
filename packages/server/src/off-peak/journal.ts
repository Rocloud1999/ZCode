import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Journal, RunJournal } from "./contract.js";

const STAGES = new Set(["prepared", "submitting", "accepted", "terminal"]);
function decode(value: unknown): RunJournal {
  if (!value || typeof value !== "object") throw new Error("invalid_offpeak_journal");
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !STAGES.has(String(record.stage)) ||
      ![record.taskId, record.sessionId, record.inputId].every((v) => typeof v === "string" && v.length > 0)) {
    throw new Error("invalid_offpeak_journal");
  }
  if (record.stage === "terminal") {
    const result = record.outcome as Record<string, unknown> | undefined;
    if (!result || !["succeeded", "failed", "stopped"].includes(String(result.outcome)) ||
        typeof result.ticketExpired !== "boolean") throw new Error("invalid_offpeak_journal_outcome");
  }
  // 白名单投影：即使上层误传附加字段，也不把凭据或正文写入 journal。
  return {
    version: 1, taskId: record.taskId as string, sessionId: record.sessionId as string,
    inputId: record.inputId as string, stage: record.stage as RunJournal["stage"],
    ...(record.stage === "terminal" ? { outcome: {
      outcome: (record.outcome as RunJournal["outcome"])!.outcome,
      ticketExpired: (record.outcome as RunJournal["outcome"])!.ticketExpired,
      ...((record.outcome as RunJournal["outcome"])!.failureCode === "admission_uncertain" ? { failureCode: "admission_uncertain" as const } : {}),
    } } : {}),
  };
}

export function createFileJournal(directory: string): Journal {
  const filename = (id: string) => createHash("sha256").update(id).digest("hex") + ".json";
  async function ensure() { await mkdir(directory, { recursive: true, mode: 0o700 }); }
  async function syncDirectory() {
    const handle = await open(directory, "r");
    try { await handle.sync(); } finally { await handle.close(); }
  }
  return {
    async list() {
      await ensure();
      const result: RunJournal[] = [];
      for (const name of await readdir(directory)) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
        const record = decode(JSON.parse(await readFile(join(directory, name), "utf8")));
        if (filename(record.taskId) !== name) throw new Error("offpeak_journal_identity_mismatch");
        result.push(record);
      }
      return result;
    },
    async put(record) {
      const safe = decode(record);
      await ensure();
      const target = join(directory, filename(safe.taskId));
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temporary, "wx", 0o600);
        try { await handle.writeFile(JSON.stringify(safe) + "\n"); await handle.sync(); }
        finally { await handle.close(); }
        await rename(temporary, target);
        await syncDirectory();
      } finally {
        await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
      }
    },
    async remove(taskId) {
      await ensure();
      await unlink(join(directory, filename(taskId))).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      await syncDirectory();
    },
  };
}
