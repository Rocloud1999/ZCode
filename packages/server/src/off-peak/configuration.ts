import { homedir } from "node:os";
import { isAbsolute, parse, relative, resolve, sep } from "node:path";
import { mkdir, realpath, stat } from "node:fs/promises";

export interface WebOffPeakOptions { dataDirectory: string; workspaceRoot: string }

export function readWebOffPeakOptions(env: Record<string, string | undefined>): WebOffPeakOptions | undefined {
  const flag = env.ZCODE_WEB_OFFPEAK_ENABLED?.trim();
  if (!flag || flag === "0") return undefined;
  if (flag !== "1") throw new Error("ZCODE_WEB_OFFPEAK_ENABLED must be 0 or 1");
  if (env.ZCODE_OFFPEAK_MOCK === "1") throw new Error("Web Off-Peak refuses Mock: Mock may consume your ordinary plan");
  const dataDirectory = env.ZCODE_DATA_BASE_DIR?.trim();
  const workspaceRoot = env.ZCODE_SERVER_WORKSPACE?.trim();
  if (!dataDirectory || !isAbsolute(dataDirectory) || (resolve(dataDirectory) === resolve(homedir()) || resolve(dataDirectory) === parse(resolve(dataDirectory)).root)) {
    throw new Error("Web Off-Peak requires an absolute, dedicated ZCODE_DATA_BASE_DIR (not HOME)");
  }
  if (!workspaceRoot || !isAbsolute(workspaceRoot)) {
    throw new Error("Web Off-Peak requires an absolute ZCODE_SERVER_WORKSPACE");
  }
  // 浏览器工作台能运行本机命令；实验性常驻执行入口不得自动暴露为无认证服务。
  const accessToken = env.ZCODE_SERVER_AUTH_TOKEN?.trim() ?? "";
  if (accessToken.length < 32 || accessToken.startsWith("REPLACE_")) {
    throw new Error("Web Off-Peak requires ZCODE_SERVER_AUTH_TOKEN with at least 32 characters");
  }
  return { dataDirectory: resolve(dataDirectory), workspaceRoot: resolve(workspaceRoot) };
}

export function isPathWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/** Reject HOME aliases before touching the application data directory. */
export async function ensureDedicatedDataDirectory(directory: string): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const canonical = await realpath(directory);
  if (canonical === await realpath(homedir()) || canonical === parse(canonical).root) {
    throw new Error("web_offpeak_data_directory_not_dedicated");
  }
  return canonical;
}

export async function createWorkspaceGuard(workspaceRoot: string): Promise<(path: string) => Promise<void>> {
  const canonicalRoot = await realpath(workspaceRoot);
  if (!(await stat(canonicalRoot)).isDirectory()) throw new Error("web_offpeak_workspace_not_directory");
  return async (path) => {
    const canonical = await realpath(path);
    if (!(await stat(canonical)).isDirectory()) throw new Error("web_offpeak_workspace_not_directory");
    if (!isPathWithin(canonicalRoot, canonical)) throw new Error("web_offpeak_workspace_outside_allowed_root");
  };
}
