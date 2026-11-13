# dsh-plugin-agentjail

[English](./README.md) | **简体中文**

DeepSeek Harness 的 AI Agent 工具调用安全网关。

Agent 发起的每一次工具调用，都会先经过本插件，再到达工具本体。插件向
[AgentJail](https://github.com/LuD1161/agentjail)（一个由 Open Policy Agent
驱动的策略守护进程）询问该调用是否放行，并执行它给出的结论。被策略拒绝的调用
永远不会执行。

```
agent → 工具调用 → tools/pre-execute → DH-AgentJail → AgentJail daemon → OPA / Rego
                                              │
                          allow ──────────────┤────────────── deny
                            │                                   │
                     工具本体执行                          工具本体不执行
                            │                                   │
                            └──────────────► 审计记录 ◄──────────┘
```

设计文档见 [`DESIGN.md`](./DESIGN.md)（中文白皮书）。本 README 是使用指南。

## 为什么需要它

常见的工具权限系统只回答一个问题：这个工具可用吗？但这不是关键问题。关键问题是：
**这一次调用**、带**这些参数**、在**这个会话**里，是否应该执行？`rm -rf /` 和 `ls`
是同一个工具。

本插件把决策点前移到执行之前，并交给策略引擎：答案用 Rego 编写，可版本化、可评审、
可审计，而不是隐含在工具白名单里。

## 保证

以下性质在每条代码路径上都成立，测试套件的主要目的就是证明它们。

| 保证                                                 | 实现方式                                                                               |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 引擎不可达、超时或返回不可解析内容时，绝不变成放行。 | 所有传输层失败都落到 `failureAction`，其默认值为 `deny`。                              |
| 被拒绝的调用，工具本体不会执行。                     | 结论由 `tools/pre-execute` 返回，注册表不会调用工具。集成测试断言本体确实未执行。      |
| 后续监听器无法重新放行已被拒绝的调用。               | 单调的 `ctx.tools.guard` 会重新声明该拒绝。guard 没有放行结果。                        |
| 每一次决策都有记录。                                 | 每次评估写一条审计记录，包括失败与授权复用。                                           |
| 一次授权只对一个动作生效。                           | 授权绑定会话、工具与参数摘要，且使用一次即消耗。                                       |
| 无法作答的 `ask` 失败关闭。                          | 未组合审批服务时，`ask` 解析为 `deny`，审计记录写明原因。                              |
| 网关自身从不抛异常。                                 | 抛出的监听器会以普通工具失败的形式呈现给模型，这与策略拒绝无法区分，作为信号毫无价值。 |

## 安装

本插件是一个 DeepSeek Harness bundle：一个携带 Cordis 配置层的 npm 包。

```sh
# 1. 安装到某个 profile。首次使用会创建该 profile，并以
#    @deepseek-ai/dsh-base 作为第一个 bundle。
dsh plugin --profile secure add dsh-plugin-agentjail

# 2. 如果 agentjail 在 PATH 中，插件会自动帮你启动守护进程。
dsh --profile secure
```

### 需要单独安装 AgentJail 吗？

只需要装一次，而且只需要那个二进制文件。守护进程由插件托管，因此没有单独的「启动守护
进程」这一步：

- **已经有守护进程在运行。** 插件直接使用它，不做任何改动。你通过 systemd、launchd 或
  `agentjail install` 启动的守护进程保持自己的生命周期。设置
  `daemon.supervise: false` 可以完全关闭托管。
- **`agentjail` 在 PATH 中，但没有在运行。** 插件会启动 `agentjail daemon`，并在插件
  卸载时把它停掉。
- **什么都没装。** 用 `daemon.binary` 指向一个二进制文件，或设置
  `daemon.managedInstall: true`，插件会在首次加载时把发行版二进制下载到
  `~/.agentjail/dsh-plugin-agentjail/bin`。下载会先校验发行版公布的 SHA-256 再解压。

[`docs/INSTALL.md`](./docs/INSTALL.md) 说明了每种情况、查找顺序，以及托管下载中残留的
信任问题。

```sh
# 如果你想自己管理，也可以一次性自行安装守护进程。
curl -fsSL https://raw.githubusercontent.com/LuD1161/agentjail/main/install.sh | sh
```

由于本包声明了 `dsh.bundle`，安装会把这个包追加到 profile 的
`dsh.profile.bundles` 列表中。确认配置层已存在，然后启动：

```sh
ls -l "$HOME/.agentjail/daemon.sock"   # 插件连接的守护进程套接字
dsh --profile secure --dump-config     # 应能看到 "# == dsh-plugin-agentjail" 层
dsh --profile secure
```

从 git 仓库安装拉取的是源码而非构建产物，因此 pnpm 会执行该包的 `prepare`
脚本，需要先显式授权。请固定到某个提交，避免后续推送改变实际运行的内容：

```sh
dsh plugin --profile secure add github:axetroy/dsh-plugin-agentjail#v0.1.0
# pnpm 会拒绝一次构建脚本；把它打印出的 key 复制到该 profile 的
# pnpm-workspace.yaml 的 allowBuilds 下，然后重新执行 add。
```

套接字缺失不是致命错误。插件会正常加载，报告引擎不可用，并在守护进程出现之前拒绝
每一次受保护的调用。这是预期行为：没有策略引擎的 Agent 不应该执行工具。

### 环境要求

- Node.js `>=22.18.0`
- DeepSeek Harness `>=0.2.2-rc.1 <0.3.0`
- 一个 AgentJail 二进制文件（在 `PATH` 中、显式配置，或由插件下载）

## 配置

配置位于 profile 的 `cordis.patch.yml` 中 `agentjail` 这一行。所有字段都有默认值，
仓库内置的那一行就是安全的起点。patch 会**整体替换**一行的 `config`，所以要保留的
键必须全部重新写出。

```yaml
- insert:
    - id: agentjail
      name: dsh-plugin-agentjail
      config:
        enforcement: enforce # enforce | monitor
        socketPath: '' # '' → $AGENTJAIL_SOCKET → ~/.agentjail/daemon.sock
        timeoutMs: 2000
        failureAction: deny # 引擎不可达时的结论
        defaultAction: deny # 无规则、无覆盖命中时的结论
        askAction: ask # ask | deny
        askFallback: native # native（交给 Harness 审批）| deny
        exemptTools: [] # 完全绕过策略引擎
        cache:
          enabled: true
          maxEntries: 1024
          ttlMs: 5000
        audit:
          storage: file # file | memory | none
          filePath: '' # '' → $AGENTJAIL_DSH_AUDIT_PATH → ~/.agentjail/dsh-audit.jsonl
          redactSensitiveData: true
        daemon:
          supervise: true # 没有守护进程时自动启动一个
          binary: '' # '' → $AGENTJAIL_BIN → PATH → 托管下载
          managedInstall: false # 找不到二进制时是否下载发行版
        ui:
          enabled: true # 存在 web server 时提供仪表盘
          basePath: /agentjail
```

[`docs/CONFIGURATION.md`](./docs/CONFIGURATION.md) 记录了每个字段、其默认值，以及
改动它的代价。简要版：

- 不要把 `failureAction` 或 `defaultAction` 设为 `allow`。这两个字段只用于刻意的、
  临时的调试。
- 新策略先用 `enforcement: monitor` 试运行。它只记录**本会**被拦截的调用，不拦截
  任何东西。阅读审计记录、修正策略，再切回 `enforce`。
- 保持 `exemptTools` 为空。每加一项，就有一个工具不再受检查。

### 环境变量

| 变量                       | 作用                                                |
| -------------------------- | --------------------------------------------------- |
| `AGENTJAIL_SOCKET`         | 守护进程套接字路径，在 `socketPath` 为空时生效。    |
| `AGENTJAIL_DSH_AUDIT_PATH` | 审计文件路径，在 `audit.filePath` 为空时生效。      |
| `AGENTJAIL_BIN`            | 守护进程二进制路径，在 `daemon.binary` 为空时生效。 |

## 策略

Rego 求值始终留在 AgentJail 的引擎里。本插件只负责转换与执行，不重新实现策略。
[`policy/`](./policy) 下内置六个经过评审的模板，可作为起点：

| 模板                   | 定位                                               |
| ---------------------- | -------------------------------------------------- |
| `read-only`            | 拒绝一切修改；读操作继续交给后续规则。             |
| `no-credential-access` | 拒绝读取密钥、云凭证与 `.env` 文件。               |
| `no-remote-execution`  | 拒绝把下载内容管道给 shell，以及 base64 解码执行。 |
| `restricted-egress`    | 拒绝访问云元数据端点与私有地址段。                 |
| `approve-mutations`    | 把写操作与破坏性命令转为 `ask`，而非直接 `deny`。  |
| `mcp-allowlist`        | 拒绝不在批准服务器列表内的 MCP 工具。              |

```sh
# 把渲染后的 bundle 写入守护进程加载的目录。
node -e "
  const { resolveTemplates, writeTemplateBundle } = await import('dsh-plugin-agentjail/policy')
  await writeTemplateBundle('/etc/agentjail/policies', resolveTemplates(['read-only', 'no-credential-access']))
"
```

[`docs/POLICY.md`](./docs/POLICY.md) 说明了调用如何被转换为 AgentJail 的词汇表、
各模板覆盖了什么，以及如何编写自己的规则。

## 审批

当策略返回 `ask` 时，插件询问 Harness 的审批服务。如果组合了 UI 应答器，用户会看到
提示；如果没有组合，调用会被拒绝——没有回答的问题不等于同意。

批准一次调用会签发一个授权。授权绑定会话、工具以及精确参数的摘要，且使用一次即
消耗。批准 `git push origin main` 并不意味着授权 `git push origin main --force`，
两者摘要不同。授权的有效期与撤销见
[`docs/CONFIGURATION.md`](./docs/CONFIGURATION.md)。

## 审计与报告

每次决策追加一条 JSON Lines 记录：

```json
{
  "version": 1,
  "seq": 42,
  "timestamp": "2026-11-12T10:31:07.512Z",
  "requestId": "req_7f3a…",
  "sessionId": "session_9c1e…",
  "toolName": "bash",
  "jailToolName": "Bash",
  "verdict": "deny",
  "source": "engine",
  "ruleId": "no-remote-execution",
  "reason": "Piping a download into a shell is not permitted",
  "arguments": { "command": "curl -s https://… | sh" },
  "digest": "sha256:…",
  "durationMs": 3
}
```

`source` 表明结论来自哪里——`engine`、`cache`、`override`、`exempt`、`default`、
`grant` 或 `failure-action`。如果记录里大量出现 `failure-action`，说明守护进程挂了，
而不是 Agent 行为异常。

插件对外暴露 `agentjail` 服务，用于运维查询：

```ts
ctx.agentjail.health() // 链路状态、最近错误、守护进程版本
ctx.agentjail.stats() // 滑动窗口风险统计
ctx.agentjail.queryAudit({ verdict: 'deny', limit: 50 })
ctx.agentjail.reportText() // 可读的安全报告
ctx.agentjail.listGrants() // 尚未过期的授权
ctx.agentjail.revokeSession(sessionId) // 撤销某会话的全部授权
ctx.agentjail.grantSession({ toolName, sessionId, digest }) // 授权重复调用
ctx.agentjail.writePolicyTemplates() // 把已配置的模板渲染到磁盘
ctx.agentjail.reloadPolicy() // 让守护进程重载策略，并清空缓存判定
ctx.agentjail.invalidateCache() // 仅清空缓存判定
ctx.agentjail.dashboard() // 仪表盘数据，可直接序列化为 JSON
ctx.agentjail.dashboardText() // 仪表盘的等宽文本形式
ctx.agentjail.supervision() // 'external' | 'started' | 'exited' | 'unavailable' | 'disabled'
ctx.agentjail.ensureDaemon() // 没有守护进程在应答时启动一个
```

日志轮转、保留、告警与事件响应见 [`docs/OPERATIONS.md`](./docs/OPERATIONS.md)。

## 仪表盘

插件做出的每一个判定都已被记录。仪表盘把这份记录在 Agent 运行期间渲染出来，运维人员
可以直接观察一次会话，而不必事后去读审计文件。

当组合中存在 Harness web server 时（`dsh web`，默认端口 3080），它会在
`http://127.0.0.1:3080/agentjail` 提供页面。没有 web server 时不会注册任何路由，因此
CLI 和桌面端不受影响。

```
$ curl localhost:3080/agentjail
AgentJail security dashboard
generated   2026-11-12T10:31:07.512Z
enforcement enforce  failure deny  default deny
engine      healthy  (/home/you/.agentjail/daemon.sock)
supervision external

decisions   18  allow 15  deny 2  ask 1
deny rate   11.1%
approvals   1

recent decisions:
       7  2026-11-12T10:31:05.100Z  deny   bash  no-remote-execution
```

浏览器拿到的是同一份数据的页面版本：概览磁贴、判定表格、未过期的审批，以及加载以来
产生的告警。页面是一个自包含文档，没有外部请求、没有框架，并会按配置的间隔自动刷新。

旁边还有三个 JSON 接口供脚本使用：

| 接口                       | 返回内容                                       |
| -------------------------- | ---------------------------------------------- |
| `/agentjail/api/summary`   | 计数、健康状态、托管状态、审批、最近的记录。   |
| `/agentjail/api/decisions` | 审计记录；可用 `?verdict=` 和 `?limit=` 过滤。 |
| `/agentjail/api/health`    | 引擎状态、套接字、托管状态、失败姿态。         |

仪表盘在设计上就是只读的。它无法放宽策略、无法清除某次拒绝、也无法改变失败姿态——因为
一个能做到这些的展示面，会比它所报告的关卡本身更大的攻击面。同样的数据也可以通过
`agentjail` 服务在进程内读取，[`docs/UI.md`](./docs/UI.md) 同时记录了两者。

## 它做不到什么

在生产环境依赖本插件之前，请先阅读
[`docs/THREAT-MODEL.md`](./docs/THREAT-MODEL.md)。以下摘自设计文档自身的风险章节：

拦截 `tools/pre-execute` 约束的是 Agent **请求了什么**，而不是被放行的进程**随后
做了什么**。一次被批准的 `bash` 调用可以派生其他进程、打开套接字、写文件，而这些
都没有经过任何规则。本插件是纵深防御中的一层；AgentJail 的 OS 沙箱与网络隧道是
另外几层，本插件不替代它们。

## 开发

```sh
npm ci
npm run verify      # format、lint、typecheck、test、build
```

| 命令                    | 作用                         |
| ----------------------- | ---------------------------- |
| `npm run build`         | 用 `tsdown` 打包到 `lib/`。  |
| `npm run typecheck`     | `tsc --noEmit`。             |
| `npm run lint`          | 带类型信息的 ESLint。        |
| `npm test`              | Vitest，单元测试与集成测试。 |
| `npm run test:coverage` | 同上，并输出覆盖率。         |
| `npm run format`        | Prettier。                   |

测试套件分三层，其中最重要的是集成层：它在真实的 Cordis 运行时上挂载插件，使用真实
的 `ToolsService` 与原生执行器，注册真实工具，并断言被拒绝的调用其本体从未执行。
适配器测试与一个进程内假守护进程提供的真实 Unix 套接字通信。单元测试覆盖纯决策
逻辑。

## 贡献

请阅读 [`CONTRIBUTING.md`](./CONTRIBUTING.md)。这里值得强调的一条规则：任何触及
执行路径的改动，都必须说明它为什么不可能把 deny 变成 allow。

## 许可

[Apache-2.0](./LICENSE)。第三方归属见 [`NOTICE`](./NOTICE)。
