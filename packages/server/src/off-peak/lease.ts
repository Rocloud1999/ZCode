import { createHash } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { createServer } from "node:net";

/** Linux kernel-held lease: no stale PID files and no unlink/reacquire race after a crash. */
export async function acquireWebOffPeakLease(dataDirectory: string): Promise<{ close(): Promise<void> }> {
  if (process.platform !== "linux") throw new Error("web_offpeak_requires_linux");
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const canonical = await realpath(dataDirectory);
  const name = "\0zcode-web-offpeak-" + createHash("sha256").update(canonical).digest("hex");
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    const failed = (error: NodeJS.ErrnoException) => {
      reject(new Error(error.code === "EADDRINUSE" ? "web_offpeak_worker_already_running" : "web_offpeak_lease_failed"));
    };
    server.once("error", failed);
    server.listen(name, () => { server.off("error", failed); resolve(); });
  });
  let closing: Promise<void> | undefined;
  return {
    close() {
      closing ??= new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      return closing;
    },
  };
}
