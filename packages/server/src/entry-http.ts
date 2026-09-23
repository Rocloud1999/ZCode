import { createLocalServices, disposeServiceResourcesAndWait, getAppConfigDir } from "@zcode/services/node";
import type { ServiceCollection } from "@zcode/services";
import {
  materializeBundledZCodeBuiltinProviderConfig,
  readBundledZCodeBuiltinProviderConfig,
} from "./bundledZCodeBuiltinProviderConfig.js";
import { createHttpServer } from "./http.js";
import { readWebOffPeakOptions } from "./off-peak/configuration.js";
import { createWebOffPeakRuntime, reserveWebOffPeak } from "./off-peak/bootstrap.js";

async function main(): Promise<void> {
  const offPeakOptions = readWebOffPeakOptions(process.env);
  const reservation = offPeakOptions ? await reserveWebOffPeak(offPeakOptions) : undefined;
  let services: ServiceCollection | undefined;
  let offPeak: Awaited<ReturnType<typeof createWebOffPeakRuntime>> | undefined;
  let server: ReturnType<typeof createHttpServer> | undefined;
  let shuttingDown: Promise<void> | undefined;

  const shutdown = (): Promise<void> => {
    shuttingDown ??= (async () => {
      // 租约必须晚于 Agent 子进程回收释放；不能让第二个 worker 与旧 Agent 同时运行。
      if (server?.listening) server.close();
      try {
        await offPeak?.stop();
      } finally {
        // 清理失败时保留租约到整个进程退出，由 systemd 杀掉整个 control group。
        if (services) await disposeServiceResourcesAndWait(services);
        await reservation?.lease.close();
      }
    })();
    return shuttingDown;
  };
  const stopProcess = (exitCode: number) => {
    // 防止权限请求或坏连接无限阻塞关闭；不提前释放租约。
    const timeout = setTimeout(() => process.exit(1), 25_000);
    timeout.unref();
    void shutdown().then(() => process.exit(exitCode), () => process.exit(1));
  };
  const stopFromSignal = () => stopProcess(0);

  try {
    const zcodeBuiltinProviderConfigFilePath = await materializeBundledZCodeBuiltinProviderConfig({
      environmentConfigRoot: getAppConfigDir(),
      content: readBundledZCodeBuiltinProviderConfig(),
    });
    const port = Number(process.env["PORT"]) || 3030;
    const host = process.env["ZCODE_SERVER_HOST"]?.trim() || process.env["HOST"]?.trim() ||
      (offPeakOptions ? "127.0.0.1" : undefined);
    const staticRoot = process.env["ZCODE_WEB_STATIC_ROOT"]?.trim() || undefined;
    const authToken = process.env["ZCODE_SERVER_AUTH_TOKEN"]?.trim() || undefined;
    services = createLocalServices({
      zcodeBuiltinProviderConfigFilePath,
      providerProvisioningTargetEnabled: Boolean(authToken),
    });
    if (reservation) offPeak = await createWebOffPeakRuntime(services, reservation);
    server = createHttpServer(services, port, {
      ...(host ? { host } : {}),
      ...(staticRoot ? { staticRoot, spaFallback: true } : {}),
      ...(authToken ? { authToken, authRequired: true } : {}),
    });
    if (offPeak) {
      process.once("SIGINT", stopFromSignal);
      process.once("SIGTERM", stopFromSignal);
      server.once("error", () => {
        console.error("[zcode-server:http] listener failed; stopping idle worker");
        stopProcess(1);
      });
      server.once("close", () => { void shutdown().catch(() => { process.exitCode = 1; }); });
    }
  } catch (error) {
    await shutdown();
    throw error;
  }
}

void main().catch((error: unknown) => {
  console.error("[zcode-server:http] startup failed", error);
  process.exitCode = 1;
});
