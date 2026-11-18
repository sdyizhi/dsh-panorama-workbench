# DEVELOPMENT — dsh-panorama-workbench

面向**改这个插件的人**。使用者请读 [README.md](README.md)。

完整实现规格与验收记录见 [../panorama-spec/IMPLEMENTATION_SPEC.md](../panorama-spec/IMPLEMENTATION_SPEC.md)；
离线分析工具链见 [../panorama-spec/README.md](../panorama-spec/README.md)。

---

## 1. 文件结构

```
dsh-panorama-workbench/
├── index.js            Host 入口：两段式注入 + 路由 + 工具注册 + health
├── client.js           面板（React 经 window.__ModuleLoader__，style token）
├── aggregator.js       行源 → 过滤链 → 分组（native/strict 双模式）
├── summary.js          摘要服务（manual_note → 缓存 → searchSessions snippet）
├── memory-bridge.js    R1 观察层 → 系统提示（有界摘要）
├── panorama-db.js      派生库（schema + 迁移 + task/task_event）
├── task-tool.js        panorama_task（不含裁决）
├── audit-tool.js       panorama_audit（独立复核）
├── audit-core.js       审核核心（与 deliver 共用）
├── deliver-tool.js     panorama_deliver（交付必过审）
├── signals.js          R3 四类条件（纯函数）
├── signals-tool.js     panorama_signals
├── watch-tool.js       panorama_watch（每日自检 schedule）
└── reconcile.js       R6 观察层对账（覆盖/新鲜度 → reconciliation_run 历史）
├── cordis.patch.yml    行定义（inject 列表、config）
├── locale/{en,zh}.json 文案
└── icon.svg
```

**红线**：只读原生数据；唯一写入目标是 `$DSH_HOME/panorama/panorama.db`。

---

## 2. 两段式注入（为什么这么写）

```
段1a  ctx.inject(['connection']) → /api/panorama/*  exact 路由（主传输）
段1b  ctx.inject(['webServer'])  → /panorama/*     镜像（浏览器可达，桌面壳不可达）
段2   ctx.inject(['webServer','workspaceRegistry','sessionPersistence','sessionQuery'])
      → 打开派生库 + 数据路由 + 工具注册 + 记忆桥 + 信号
```

- 段2 缺失任一服务 → **永不挂载** → 面板显示点名降级横幅（不静默失败）。
- `dataSource` 不锁存：控制器服务可能晚于本行激活（实测竞态），**在使用时点现算**。
- 行 `inject` 必须**静态声明**：动态 `ctx.inject(['connection'])` 在 HMR 重挂的同步阶段有竞态，
  且 cordis 属性守卫会抛 `cannot get property "X" without inject`。

---

## 3. ⚠️ 实测踩坑（动手前必读）

### 3.0 代码版本戳："运行中的 Host 是旧版"一眼可判
health 给出 `codeStamp`（apply 时）与 `diskStamp`（请求时），面板 chip + 黄条提示。
**判据从"chip 绿不绿"升级成"戳等不等"**——实测两次误判（`pending`、降级标记"消失"）都靠它定位。

### 3.1 `ctx.effect` 的语义（R1/R2 都曾中招）
Cordis 的 `ctx.effect(fn)` **立即执行 fn**，fn 的**返回值**才是卸载时的 disposer。

```js
// ❌ 注册即注销（R2 工具看不见、R1 记忆桥空转的根因）
const d = ctx.tools.register(tool)
ctx.effect(() => { d() })

// ✅ 立即注册 + 返回 disposer 交 Cordis 清理
ctx.effect(() => ctx.tools.register(tool))
```

### 3.2 `subagents.startActivation` 的 `request` 是嵌套的（0.2.2-rc.1 实测）
```js
// ❌ GitHub master 的扁平形状（0.2.2-rc.1 上抛 maxDepth undefined）
startActivation({ provider, label, prompt, parent, signal, delivery, outputSchema })

// ✅ 0.2.2-rc.1 真实契约
startActivation({
  provider, label,
  request: { prompt: ContentBlock[], parent: Agent, outputSchema?, maxDepth?, ... },
  signal, delivery: 'parent'|'caller', childId?,
})
```
**master 源码 ≠ 已发布版本**——以安装包为准。

### 3.3 逐 Agent 注册会遮蔽全局同名工具（且热重载不回收）
`agent.ctx.tools.register(...)` 落在 agent 自身 scope 层，**遮蔽**全局同名；effect 挂在
`agent.ctx` 上，插件热重载时不回收 → 旧定义长期压住新定义。
**仅在全局视图看不到本插件工具时才走此兜底。**

### 3.4 验证工具可见性：只能用 `Tool.listTools`
Host 侧 `register()` 不抛错、health chip 全绿，**都不等于模型可见**。

### 3.5 批量编辑同一文件会静默互相覆盖
多次 `edit` 同一文件时，后一次的 old_string 可能匹配到被前一次改动过的区域，
导致**某些修改被静默丢弃**。→ **批量编辑后立即 grep 关键标识符复核**。

### 3.6 PowerShell 引号
`node -e "..."` 含中文/引号会断。**一律写 `.mjs` 文件再执行。**

### 3.7 工具参数别只写进返回字段
`panorama_signals` 曾把模型传的 `thresholdDays` 只放进 `requestedThresholdDays`，评估仍用闭包默认值——
**参数"看起来生效、实际没生效"**。凡工具参数要影响计算，必须有回归测试断言它真的改变了结果
（见 `test-signals.mjs` 的 thresholdDays 生效性用例）。

---

## 4. 契约基线（实测，不是文档推测）

| 契约 | 结论 |
|---|---|
| `conn.fetch.register` path | 必须是含 `/api` 的**全路径**（`assertFetchRoute` 对非 `/api/` 抛错） |
| `requestRejection` | `401 \| 403 \| undefined`（undefined 放行） |
| `workspaceController.follow` | 普通 async generator，可进程内直调 |
| `sessionController.list` | **无分页**，整页返回，按 `updatedAt` 倒序 |
| `SessionHeader` | **不含 title/updatedAt**；有 `createdAt` |
| `readTitleSnapshots` | 返回 `value.session`（SessionHeader，含 createdAt）+ `value.title` |
| `snippetChars` | 后端配置（默认 240 码点），**不是请求字段** |
| 原生可见性 | 隐藏 `origin==='subagent'`、`blank===true`（除当前）、归档 |
| `ctx.systemPrompt.section/variable` | 返回 disposer；`variable` 每次 assemble 重解析；段按 order 拼接 |
| `ctx.schedule.create` | `{title, prompt, timing, target}`；`timing:{kind:'cron',cron:{expression,time_zone}}`；`target:{kind:'new_once'}`（实测通过，见 §12.8） |

---

## 5. 分层架构

prompt.txt 要求的"观察层 / 上层理解"分层：

- **插件（观察层）**：只吃公开只读 API，产出聚合/统计/snippet/任务状态；
  **不读会话日志**，因此**没有时长维度**。
- **离线工具（上层）**：`../panorama-spec/session-time-report.mjs` 读日志算完整工时，
  `compare-with-panorama.mjs` 与插件导出对账（差集 = 观察层盲区）。

> 实测结论（§12.6）：观察层**覆盖充分**（盲区 ~1%，因为行源全量返回），
> 缺的是**时长维度**——它回答"最近看过什么"，不回答"时间花在哪"。

---

## 6. 测试与自检

```bash
# 全部离线测试（不依赖运行中的 DSH）
for f in ../panorama-spec/test-*.mjs; do node "$f" || exit 1; done

# 真实数据自检（只读）
node ../panorama-spec/check-signals.mjs       # R3 信号
node ../panorama-spec/check-tasks.mjs         # 任务与事件链
node ../panorama-spec/compare-with-panorama.mjs --script ../panorama-spec/report-7d.json
```

**冒烟**：装好后 `/api/panorama/health` 应返回 JSON；面板诊断卡各服务状态齐全。

---

## 7. 发布检查清单

- [x] `package.json` 的 `files` 覆盖全部运行时文件（**曾漏掉 10 个模块**）
- [x] `peerDependencies` 与目标 DSH 版本精确一致（`0.2.2-rc.1`）
- [x] 版本号已定：`1.0.0` = 首个对外发布版（`0.1.0` 为自用验证版）
- [x] 发布工件校验：`npm pack` 22 文件、14 运行时模块齐全、清单正确（见 `RELEASE.md`）
- [x] 全套离线测试通过（12 套 + 发布校验）
- [x] 真实环境冒烟：面板打开、诊断卡无异常、工具可调用、信号/自检正常
- [x] 已知限制清单是最新的（见 README）

**当前状态（2026-11-13）**：六层能力全部实测验收，**已具备对外发布条件**（npm 包名可用、工件校验通过）。

## 8. DSH 版本升级（每次必须做）

DSH 运行时升级时（如 `0.2.2-rc.1` → `0.2.2-rc.3`），**必须同步更新两处**：

| 文件 | 位置 | 值 |
|---|---|---|
| `package.json` | `peerDependencies["@deepseek-ai/dsh"]` | 精确新版本号 |
| `index.js` | `PEER_DSH_VERSION` 常量 | 同上 |

版本不一致会触发 `incompatible-version`，面板显示"异常"横幅。
DSH 的 CLI 版本（`dsh --version`）≠ 运行时版本——以报错消息里的版本为准。

更新后跑 `check-package.mjs` 确认两处一致，再重启 DSH。
发布动作本身需要作者的 npm / GitHub 账号，见 `RELEASE.md`。
