# Linux 无界面 Web 闲时任务：实验性补丁

基准：`zai-org/ZCode@872ad960de7ec172591f7e1952f7849229f94521`。

本补丁把一个纯 Node 执行宿主接入独立 Web HTTP 启动入口，复用现有闲时任务服务、官方取号客户端和 Agent。服务器不需要 Electron、显示器、Xvfb 或本机浏览器；用户仍使用另一台电脑上的浏览器管理会话和权限确认。

**状态：实验性实现，不是经过完整官方账号联调的发行版。** 新增便携模块的本地测试已执行；整个上游仓库的类型检查、构建、真实 Web 页面及官方取号/执行尚待验证。正式长期运行前必须完成本文验收；不能把队列卡片显示成功当成已经使用免费模型。该实现不会修改官方资格、取号限制或模型白名单，也不保证官方允许某个自行构建的客户端。

## 行为和边界

- 默认关闭。只有 `ZCODE_WEB_OFFPEAK_ENABLED=1` 时启动执行宿主。
- 只支持 Linux，一次执行一个任务；仅派发 `ZCODE_SERVER_WORKSPACE` 目录及其子目录下的本地任务，拒绝远程 workspace identity 和越界符号链接。
- 现有 `IOffPeakTaskService` 负责官方取号、队列同步和票据结算；新宿主仅认领已经可执行的任务，不自行生成票据。
- 每次自动执行传入闲时专用模型选择、官方票据和执行级凭据；保留桌面实现的子智能体和 Memory 限制，没有普通套餐模型回退路径。
- 默认权限取决于你提交任务时选定的模式。补丁不会把现有 `build`/`plan` 模式改成 `yolo`，也不会自动批准权限。某些原有界面或工具可能默认选择 `yolo`，首次测试应明确选 `build` 或 `plan`。
- 关闭浏览器不负责停止后端。需要审批的任务会等待用户在 Web 会话中响应；无人值守不意味着所有操作自动放行。
- 普通聊天仍是普通调用。不要用手动“继续”替代自动闲时续跑，也不要假定其他插件的外部 API 免费。
- 不新增 Cron 定时执行功能、不改桌面执行路径、不支持独立 CLI 的 `--offpeak` 参数。

## 1. 应用补丁及构建

需要完整源码、Linux、上游要求的 Node.js `24.14.0` 与 pnpm `10.33.2`。以下命令在完整仓库根目录执行，路径按实际环境调整：

```bash
git switch -c feat/web-offpeak-worker 872ad960de7ec172591f7e1952f7849229f94521
git apply --check /path/to/zcode-web-offpeak.patch
git apply /path/to/zcode-web-offpeak.patch
pnpm install --frozen-lockfile

# 这些都是构建/测试，不调用你的官方模型额度。
node scripts/check-workspace-freshness.mjs
pnpm --filter @zcode/server test:offpeak
pnpm typecheck
pnpm lint
pnpm architecture:check --changed

# 本地 Linux Web 入口不需要 Electron，也不需要生成远端安装包。
pnpm --filter @zcode/cli... build
pnpm --filter @zcode/server exec tsup
pnpm --filter @zcode/web build
```

这是待在完整 checkout 验证的构建流程。若上游依赖或检查失败，保存实际日志；不要删除原有检查或把失败写成通过。发布脚本会在这些检查失败时停止推送。

## 2. 独立运行用户、数据目录和登录

准备专用的非 root 用户 `zcode`，其 HOME 应为另一个目录（例如 `/var/lib/zcode-home`），不能与专用数据基目录相同。该用户需要对自己的状态目录有读写权限，对测试项目有你实际授权的访问权限。不要直接以 root 运行 Agent。示例安装布局：

```text
/opt/ZCode/                       已构建的完整代码
/var/lib/zcode-web-offpeak/       专用数据基目录，不与桌面版共享
/srv/projects/my-project/        服务器本机项目
/etc/zcode-web-offpeak.env       私密运行配置，不在 Git 仓库内
```

先创建专用状态目录和项目，再以**相同的运行用户、相同的 HOME、相同的数据目录**登录。以下选择与你套餐所属平台对应的一条：

```bash
sudo -u zcode -H env ZCODE_DATA_BASE_DIR=/var/lib/zcode-web-offpeak \
  /usr/bin/node /opt/ZCode/apps/zcode-cli/packages/cli/dist/zcode.cjs \
  login bigmodel --no-browser

# Z.AI 套餐用 login zai --no-browser，不能混用两个平台的身份。
```

在你自己电脑的浏览器打开终端输出的授权链接。登录实现会在服务器轮询结果并保存凭据；不要把 JWT、API Key、授权链接或凭据文件贴到聊天、Issue 或公开仓库。进入 Web 后检查套餐连接已正确识别；CLI 登录配置与 Web 的实际账号解析仍是完整联调验收项。若 Web 仍要求登录，不要伪造或手工拼接凭据。

`ZCODE_DATA_BASE_DIR` 是 `.zcode` 的父目录，不是 `.zcode` 目录本身。不得等于 HOME 或文件系统根目录，指向 HOME 的符号链接也会被拒绝。不要随意设置会改变上游路径语义的 `ZCODE_HOME`；以应用实际输出的存储位置为准。

## 3. 配置并启动

复制 `deploy/zcode-web-offpeak.env.example` 到 `/etc/zcode-web-offpeak.env`，把路径、Node 路径和令牌改为实际值。Node 必须是上游要求的版本；发行版自带的 `/usr/bin/node` 可能太旧。

用本机 `openssl rand -hex 32` 生成至少 32 字符的 Web 访问令牌，替换占位符。文件所有者建议 `root:zcode`、权限 `0640`，不要保存在仓库内。`ZCODE_WEB_OFFPEAK_ENABLED=1` 时，即使监听回环地址也必须提供令牌。**不要启用 `ZCODE_OFFPEAK_MOCK=1`：该开关会被拒绝，Mock 上游可能消耗普通套餐额度。**

先以前台方式检查启动日志和一条只读任务；不要直接把未验收实例当作生产后台服务。稳定后安装随附 unit：

```bash
sudo install -m 0644 deploy/zcode-web-offpeak.service \
  /etc/systemd/system/zcode-web-offpeak.service
sudo systemd-analyze verify /etc/systemd/system/zcode-web-offpeak.service
sudo systemctl daemon-reload
sudo systemctl enable --now zcode-web-offpeak.service
sudo journalctl -u zcode-web-offpeak.service -f
```

unit 直接运行 HTTP 后端构建产物。`KillMode=control-group` 必须保留：主进程与 Agent 子进程要一起退出，不能在旧 Agent 仍运行时启动第二个持有者。为该服务配置独立可写目录，避免多个桌面、Web 或容器实例共用数据。抽象 Unix socket 租约仅在相同 Linux 网络命名空间内有效，不是跨主机/跨容器的分布式锁。

### 使用统一的 `zcode --web` 包

也可以重新构建上游统一发行包后启动。旧包不会因为源码被修改而自动更新。其 runner 会覆盖 `ZCODE_SERVER_AUTH_TOKEN`：默认回环地址不传 `--token` 会把继承令牌清空，因此须明确传入：

```bash
export ZCODE_WEB_OFFPEAK_ENABLED=1
export ZCODE_DATA_BASE_DIR="$HOME/zcode-server-state"
# TOKEN 从你的私密本机配置读取，不要把真实值写进共享脚本。
zcode --web --workspace /srv/projects/my-project \
  --host 127.0.0.1 --port 3030 --no-open --token "$TOKEN"
```

命令参数可能被同机用户看到，长期运行优先使用上面的私密 EnvironmentFile + 直接 HTTP 入口。不要用 `--no-token`。

## 4. 从自己电脑访问

在自己的电脑上建立 SSH 隧道：

```bash
ssh -N -L 3030:127.0.0.1:3030 your-user@your-server
```

浏览器访问 `http://127.0.0.1:3030/?token=你的私密令牌`，让现有认证逻辑建立 Cookie。不要公开该 URL。默认不需要开放服务器防火墙的 3030 端口；不要直接把这个能执行命令的工作台暴露到公网。认证不会把 Agent 的文件权限限制在工作目录内，操作系统运行用户的权限仍然重要。

在现有 Web 界面进入“自动化 → 闲时任务”，使用本机项目创建任务。UI 是否显示入口、可用闲时模型、账号资格仍由原有服务决定；本补丁没有强行显示入口或改写 `enable_offpeak_task`。

## 5. 首次验收

建议只在可丢弃的测试仓库中提交一个小的只读任务，且不要自动放行危险工具。按顺序核查：

1. 登录和正确的 Coding Plan 连接可用；官方配置返回允许的闲时模型。
2. 官方取号成功，有真实票据/队列位置；未开启 Mock。
3. 排到后日志出现 `idle_turn_accepted`，会话自动执行，不是你手动发送普通消息。
4. 完成后日志出现 `idle_turn_settled`，任务进入对应终态，既有服务完成票据核销。
5. 关闭浏览器后只读任务仍能执行；重新打开能查看结果和响应权限。
6. 用测试任务检查重启恢复、取消和票据过期；结合官方用量页面核对实际计费归属。客户端字段正确不能单独证明官方账单结果。

补丁不会自动执行这组真实账号测试，也不会为了测试消耗你的票据或额度。官方返回资格不足/限额时正常等待或停止，不改变标识、绕过校验或伪造票据。

## 恢复语义和诊断

正常确认接收的中断任务恢复同一会话，使用接续提示，不重发原始任务。已知终态通过小型持久化 journal 重放到现有任务仓库，不重新调用模型。journal 只含任务、会话、输入 ID、阶段和归一化结果，不含凭据或提示词。

如果崩溃发生在“提交请求”和“得到确认”之间，无法知道模型是否已经执行，任务将失败并标记 `web_offpeak_admission_uncertain_review_required`；**必须先检查原会话和文件，再由人决定是否创建新任务**。这比自动重提导致重复写盘更保守，不能声称任意 shell 操作恰好执行一次。

主要诊断：

| 日志/错误 | 处理 |
| --- | --- |
| `web_offpeak_worker_already_running` | 同目录已有实例；不要强行共享或删除别人的状态。 |
| `official_config_unavailable` | 官方配置读取失败，等待/检查网络和登录。 |
| `prepare_failed` / `web_offpeak_configuration_rejected` | 检查项目、权限模式、闲时模型和套餐凭据；不会改走普通模型。 |
| `worker_tick_failed` / `terminal_write_failed` | 新派发暂停；检查磁盘/数据库，停止整组进程后再恢复。 |
| `web_offpeak_untracked_run_review_required` | 状态来自未知持有者；不要把桌面数据目录直接拿来共用。 |
| 服务端 `3101` / `3103` | 现有业务分类分别为资格不足/取号限额，按官方规则处理。 |

当前日志只保证新增模块的日志/小型 journal 不写密钥和任务正文；上游的模型轨迹及调试日志仍沿用上游行为。本补丁不是整套产品的日志脱敏审计。

## 参考源码

- [Web 启动入口](https://github.com/zai-org/ZCode/blob/872ad960de7ec172591f7e1952f7849229f94521/packages/server/src/entry-http.ts)
- [桌面闲时派发参考实现](https://github.com/zai-org/ZCode/blob/872ad960de7ec172591f7e1952f7849229f94521/packages/desktop/src/host/index.ts#L531-L691)
- [共享任务、队列和票据逻辑](https://github.com/zai-org/ZCode/blob/872ad960de7ec172591f7e1952f7849229f94521/packages/services/src/session/offPeakTaskService.ts)
- [闲时鉴权边界](https://github.com/zai-org/ZCode/blob/872ad960de7ec172591f7e1952f7849229f94521/packages/services/src/session/offPeakRuntimeModel.ts)
- [CLI 无浏览器登录](https://github.com/zai-org/ZCode/blob/872ad960de7ec172591f7e1952f7849229f94521/apps/zcode-cli/packages/cli/src/login-command.ts)
- [统一 Web runner](https://github.com/zai-org/ZCode/blob/872ad960de7ec172591f7e1952f7849229f94521/scripts/zcode-distribution/runner.mjs)
- [官方闲时任务文档](https://zcode.z.ai/cn/docs/idle-time-tasks)
