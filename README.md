# dsh-panorama-workbench

为 **DeepSeek Harness 桌面版**提供的跨工作区会话全景工作台：把散在几十个字项目里的会话、活动与
任务状态聚合成一个面板，并在需要时主动提醒。

> **一条红线**：本插件**只读** DSH 原生的会话日志与工作区注册（不写、不改、不删），
> 所有派生数据（标签、摘要缓存、任务状态、观察统计）写入**自己的** SQLite：
> `$DSH_HOME/panorama/panorama.db`。删除该文件即可完全清除本插件产生的数据。

---

## 功能

### 1. 观察层（面板）
- 跨工作区分组展示会话，支持按**时间范围 / 工作区 / 标签**过滤；
- 概览统计（工作区数、会话数、可见数、运行中、最近活动）与**对账台账**
  （跳过 subagent / 空白隐藏 / 归档隐藏 / 行上限）；
- **有界摘要**：来自 `ctx.sessionQuery` 的 snippet，无命中显示"暂无摘要"，**不编造**；
- 会话行内可打标签、写备注、复制 session id；
- 导出端点 `GET /panorama/export`（结构化信号，**不含消息正文/工具参数/模型输出**）。

### 2. 记忆桥（连续·记忆）
- 把近期工作分布（活跃工作区、热度、标签、备注、高频时段）以**有界摘要**注入系统提示，
  让主 Agent 记得"最近在做什么"；每次提示装配重新解析，缓存 60 秒。

### 3. 任务状态链（结构化记忆）
- `task` + `task_event` 两张表：状态机 `queued → running → delivered → accepted | rejected`；
- **完整事件链**：每次状态/裁决/关联流转留痕，封驳理由永久保留。

### 4. 门下省审核 + 交付流水线（制衡）
- `panorama_deliver`：**交付 = 状态推进 + 独立审核 + 落裁决**，一条链，**不可跳过**；
- 审核者是**独立 spawn 的全新子会话**（不继承执行者上下文），`pass → accepted`、
  `fail → rejected`（理由即回炉单）；
- **回炉循环**：返工后可再次交付；累计 3 次封驳自动 `escalated`，**转人工**，防无限回炉；
- **结构性强制**：`panorama_task` 拒绝直接改写 `delivered/accepted/rejected`，也**不提供
  `verdict` 操作**——裁决只能来自审核，防止自我批准。

### 5. 主动信号（主动）
- 四类条件：`escalated-tasks`(warn) / `stale-rejected`(warn) / `stale-running`(info) /
  `idle-workspace`(info)；
- `panorama_watch` 可开启**每日自检**（Host schedule）：只汇报 warn 项，**没有 warn 就不打扰**。

---

## 要求

| 项 | 说明 |
|---|---|
| DeepSeek Harness | 桌面版，**精确版本 `0.2.2-rc.1`**（见 `peerDependencies`，不用 semver 范围） |
| Profile | 桌面版使用 `desktop`；其他 profile 亦可，但需自行确认服务齐备 |
| Node | DSH 自带（插件不额外依赖） |

## 版本策略

| 版本 | 含义 |
|---|---|
| `0.1.0` | 自用验证版（历史） |
| **`1.0.0`（当前）** | **首个对外发布版** |
| 后续 | semver：破坏性变更升 major，新功能升 minor，修复升 patch |

发布步骤见 [RELEASE.md](RELEASE.md)。

---

## 安装

### 方式一：从 GitHub 安装（推荐）

```bash
dsh plugin --profile <你的profile> add git+https://github.com/sdyizhi/dsh-panorama-workbench.git
```

> 安装后**重启 DSH 桌面版**——插件的 Host 代码只在启动时加载。

### 方式二：从 tarball 安装

```bash
# 下载 tarball（GitHub Release 或自行 npm pack）
dsh plugin --profile <你的profile> add /path/to/dsh-panorama-workbench-1.0.0.tgz
# 重启 DSH
```

### 方式三：从 npm 安装（可选）

```bash
dsh plugin --profile <你的profile> add dsh-panorama-workbench
# 重启 DSH
```

### 方式四：本地开发安装

```bash
dsh plugin --profile <你的profile> add link:/path/to/dsh-panorama-workbench
# 重启 DSH
```

### 验证安装

```bash
# 1) 组合里应出现 panorama-workbench 行
dsh --profile <你的profile> --dump-config | grep -A3 panorama-workbench

# 2) 侧边栏出现"全景工作台"入口；点开后面板诊断卡显示各服务状态
#    全部绿色 + "代码戳: 运行中=磁盘" = 安装成功
```

> ⚠️ **已知限制**：桌面壳的插件热更新通道（`/plugins/events` SSE）不可用，
> **改动插件后必须重启桌面版**才能生效。面板诊断卡的 `代码戳` chip 会提示
> `磁盘更新（需重启/重载）`——以它为准，不要靠"看起来对不对"猜。

---

## 配置

在 profile 的 `cordis.patch.yml` 中配置（全部可选）：

| 配置项 | 默认 | 说明 |
|---|---|---|
| `dataSource` | `'auto'` | `'auto'`（优先 native 控制器）/ `'strict'`（只用 sessionQuery+persistence） |
| `includeSubagents` | `false` | 是否在列表中包含 subagent 会话 |
| `summaryRowLimit` | `50` | 摘要批量请求的行数上限 |
| `memoryBridgeEnabled` | `true` | 是否注入"工作记忆"摘要 |
| `memoryBridgeWindowDays` | `7` | 记忆摘要的统计窗口（天） |
| `proactiveThresholdDays` | _(逐条件默认)_ | 全局闲置阈值（覆盖下列逐条件默认） |
| `proactiveThresholds` | `{}` | **逐条件阈值**（优先级最高），如 `{ "idle-workspace": 60 }` |
| `proactiveCron` | `'0 9 * * *'` | 每日自检的 cron（Host schedule） |
| `proactiveTimezone` | `'Asia/Shanghai'` | 自检时区 |
| `proactivePrompt` | _(内置)_ | 自检投递的提示词 |
| `reconcileMinCoverage` | `0.9` | 观察层对账：覆盖低于此值 → `stale-observation`(warn) |
| `reconcileMaxAgeDays` | `14` | 观察层对账：超过此天数未刷新 → `stale-observation`(warn) |

**逐条件默认阈值**（方案 B：任务以天计、项目以周月计）：

| 条件 | 默认 |
|---|---|
| `escalated-tasks` | 无阈值（立即生效） |
| `stale-rejected` | 3 天 |
| `stale-running` | 3 天 |
| `idle-workspace` | 30 天 |

示例：

```yaml
- name: dsh-panorama-workbench
  config:
    proactiveThresholds:
      idle-workspace: 60      # 项目节奏以两个月计
      stale-rejected: 2       # 封驳两天不回炉就催
```

---

## 面板

侧边栏 → **全景工作台**。自上而下：

1. **诊断卡**（默认折叠，异常自动展开）：传输、派生库、数据源、全文搜索、各工具注册状态、
   **代码戳**（运行中 vs 磁盘）；
2. **主动信号卡**：四类条件的 severity / 数量 / 首条摘要；
3. **任务卡**：新建任务、状态与裁决；
4. **工作区分组**（默认折叠，可一键展开/收起）。

---

## 工具（模型可见）

| 工具 | 用途 |
|---|---|
| `panorama_task` | 建/列/改状态/关联会话/删除任务（**不含裁决**） |
| `panorama_audit` | 独立复核（手动触发） |
| `panorama_deliver` | **交付必经审核**（唯一入口） |
| `panorama_signals` | 按需评估主动信号（含观察层健康度） |
| `panorama_watch` | 管理每日自检（`status`/`enable`/`disable`） |

> **验证工具是否真的可见**：不要只看插件 health。Host 注册成功 ≠ 模型可见；
> 判据是 `Tool.listTools`（Agent 可见工具清单）或实际调用。

---

## 数据与安全

| 项 | 位置 | 说明 |
|---|---|---|
| 派生数据 | `$DSH_HOME/panorama/panorama.db` | 标签、摘要缓存、任务与事件链、观察统计 |
| 原生数据 | DSH 自己的存储 | **只读**，本插件从不写入 |
| 摘要来源 | `ctx.sessionQuery` snippet | 有界纯文本摘录，**不读完整会话体** |
| 导出内容 | `/panorama/export` | 结构化信号，**不含消息正文/工具参数/模型输出** |
| 审核 Agent | 独立子会话 | 与执行者分离，不共享上下文 |

**清除数据**：停止 DSH 后删除 `$DSH_HOME/panorama/` 即可。

---

## 已知限制

1. **必须重启桌面版**：插件 Host 代码只在启动时加载；桌面壳的 SSE 热更新不可用。
2. **观察层是拉取式的**：统计来自"面板被打开时"抓取的全量会话列表，因此
   **时间维度（时长/工时）不在观察层**——它只记录最后活动时间点，不记录活跃时长。
   需要"时间花在哪"请用配套的离线工具（见 `../panorama-spec/README.md`）。
3. **多项目并行是常态**：`idle-workspace` 的阈值请按自己的项目节奏调整（默认 30 天）。
4. **审核者偶发带伤**：子审核 Agent 若以 `stopReason != completed` 结束，
   裁决仍被采信（DSH 会交出已捕获的结构化裁决），但事件链会标注
   `[reviewer-degraded(...)]` 供你复核。
5. **仅支持精确 DSH 版本**：`0.2.2-rc.1`；版本不匹配时某些契约可能不同。

---

## 卸载

```bash
dsh plugin --profile desktop remove dsh-panorama-workbench
rm -rf "$DSH_HOME/panorama"     # 可选：清除派生数据
```

---

## 文档

| 文档 | 内容 |
|---|---|
| [DEVELOPMENT.md](DEVELOPMENT.md) | 开发日志、架构、**实测踩坑**（改代码前必读） |
| [../panorama-spec/IMPLEMENTATION_SPEC.md](../panorama-spec/IMPLEMENTATION_SPEC.md) | 完整实现规格与验收记录 |
| [../panorama-spec/README.md](../panorama-spec/README.md) | 离线分析工具链（会话历史统计 / 观察层对账） |
