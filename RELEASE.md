# 发布手册 — dsh-panorama-workbench

版本：`1.0.0`（对外发布版；`0.1.0` 为自用验证版）
目标渠道：**npm**（DSH 的插件管理器通过 npm registry 安装第三方插件）

---

## 1. 发布前状态（已验证）

| 项 | 状态 |
|---|---|
| 工件完整性 | ✅ 22 文件；14 个运行时模块 + 清单 + locale + LICENSE + README |
| `dsh.bundle.patch` / `dsh.client` | ✅ 指向存在的文件，platform=web，immediately=true |
| `peerDependencies` | ✅ 精确 `0.2.2-rc.1`（不用范围） |
| npm 包名 | ✅ `dsh-panorama-workbench` 可用（registry 查询 404） |
| 全套测试 | ✅ 12 套（含发布校验） |
| 版本一致性 | ✅ `package.json` 1.0.0 = `index.js` `VERSION` 1.0.0 |
| **发布前试装** | ✅ 见 §1.1 |

### 1.1 发布前试装（实测，2026-11-13）

用 `npm pack` 出的 tarball 真装进一个**临时 profile**（从 `headless` 模板复制，不碰生产 profile）：

| 检查 | 结果 |
|---|---|
| pnpm 安装 tarball | ✅ 成功 |
| 组合出现 `panorama-workbench` 行（inject 正确） | ✅ `--dump-config` |
| 已安装包落盘 | ✅ 22 文件 / 14 个运行时模块齐全 |
| **静态导入解析**（源码包 & 已安装包） | ✅ 16 条相对导入全部可解析 |
| **外部依赖** | ✅ 仅 `node:fs` / `node:os` / `node:path` / `node:sqlite`——**零 npm 依赖** |
| profile 启动 | ✅ exit 0，无错误 |

**结论**：包完全自洽（零 npm 依赖），不存在"本地能跑、发布后缺文件"的风险。
试验 profile 与 tarball 已清理；`desktop` profile 未受影响。

> ⚠️ 试装时 pnpm 提示 `missing peer @deepseek-ai/dsh@0.2.2-rc.1`——这是**正常的**：
> 该 peer 由 DSH 安装本身提供（任何基于 `dsh-base` 的 profile 都有），
> 插件管理器的兼容性检查按 "DSH peer 包名" 识别它。

---

## 2. 发布步骤

### 2.1 准备仓库（GitHub）

仓库地址：**https://github.com/sdyizhi/dsh-panorama-workbench**

```bash
cd D:/dsh-open/dsh-panorama-workbench
git init
git add .
git commit -m "release: dsh-panorama-workbench 1.0.0"
git remote add origin https://github.com/sdyizhi/dsh-panorama-workbench.git
git push -u origin main
```

> `package.json` 的 `repository` / `bugs` / `homepage` 已指向该仓库。
> `.gitignore` 已排除 `node_modules/` 与 `*.tgz`。

### 2.2 发布（GitHub 为主，npm 可选）

**GitHub（推荐，无需 npm 账号）**：推完代码即发布，用户通过 git URL 安装。

**npm（可选）**：
```bash
npm login && npm publish --access public
npm view dsh-panorama-workbench versions   # 验证
```

### 2.3 别人怎么装

```bash
# 方式一（推荐）：Git URL
dsh plugin --profile <profile> add git+https://github.com/sdyizhi/dsh-panorama-workbench.git

# 方式二：tarball（从 GitHub Release 下载）
dsh plugin --profile <profile> add /path/to/dsh-panorama-workbench-1.0.0.tgz

# 方式三：npm（需先发布）
dsh plugin --profile <profile> add dsh-panorama-workbench

# 安装后必须重启桌面版（Host 代码只在启动时加载）
```

---

## 3. 发布后检查清单

- [ ] GitHub 仓库 `sdyizhi/dsh-panorama-workbench` 的 `main` 分支有 25 个文件
- [ ] 在**另一个干净 profile** 安装一次，确认能挂载、面板可开
- [ ] 面板诊断卡：`传输 / 派生库 / 数据源 / 各工具 registered / 代码戳`
- [ ] 卸载：`dsh plugin --profile <name> remove dsh-panorama-workbench`
      + 可选 `rm -rf "$DSH_HOME/panorama"`

---

## 4. 版本约定

| 版本 | 含义 |
|---|---|
| `0.1.0` | 自用验证版（历史） |
| `1.0.0` | 首个对外发布版 |
| 后续 | semver：破坏性变更升 major，新功能升 minor，修复升 patch |

**每次发版必须同步两处版本号**：`package.json` 与 `index.js` 的 `VERSION` 常量
（面板诊断卡显示后者；两者不一致会误导排查）。

---

## 5. 已知限制（写给使用者，README 里也有）

1. **改动插件必须重启桌面版**——桌面壳的 SSE 热更新不可用。
2. **观察层无时长维度**（不读会话日志是红线）；时间画像用离线工具。
3. **`idle-workspace` 是 info**，不会触发自检提醒。
4. **带伤审核仍采信裁决**，事件链标注 `[reviewer-degraded(...)]`。
5. **仅支持精确 DSH 版本** `0.2.2-rc.1`；其他版本需版本豁免（`allow-version`）。

---

## 6. 不支持的场景（避免发布后被打脸）

- ❌ 其他 DSH 版本（会触发 `incompatible-version`，需 `plugin_manager.set_version_exemption` 显式豁免）
- ❌ 无 `sessionQuery` / `workspaceRegistry` 的最小 profile（段 2 不挂载，面板显示点名降级横幅）
- ❌ 期望"自动摘要"（P3 决定：不做 LLM 自动摘要，只用 snippet）
