# 从 fork 源码安装（新用户指南）

本 fork 包含两个尚未进入官方发布的功能：**人类接管回路**（Agent Window 里的"接管 / 交还"、动作状态与虚拟光标）和**站点记忆**（`bsk site`、`bsk record start --detach`）。两者都需要从源码构建 CLI 与扩展，商店版扩展不含这些改动。

## 准备

- Rust ≥ 1.85（仓库带 `rust-toolchain.toml`，`rustup` 会自动选版本）
- Node.js 20+ 与 pnpm 10（`corepack enable` 即可）
- Chrome / Edge 等 Chromium 浏览器

## 1. 取源码

```sh
git clone https://github.com/fish0710/BrowserSkill.git
cd BrowserSkill
git checkout fork-release          # 发行分支：upstream main + 人类接管回路 + 站点记忆
```

## 2. 构建并安装 CLI

```sh
cargo build --release -p bsk
mkdir -p ~/.local/bin && cp target/release/bsk ~/.local/bin/
bsk --version                       # 确认 ~/.local/bin 在 PATH 里
```

Windows 用 PowerShell：`cargo build --release -p bsk`，把 `target\release\bsk.exe` 复制到 PATH 中任一目录。

## 3. 构建并加载扩展

```sh
pnpm install
pnpm ext:build                      # 产物在 apps/extension/dist/chrome-mv3
```

浏览器打开 `chrome://extensions`，打开右上角"开发者模式"，点"加载已解压的扩展程序"，选择 `apps/extension/dist/chrome-mv3`。如果之前装过商店版，请先停用它，避免两个扩展抢连接。

## 4. 连通检查

```sh
bsk doctor                          # 应显示 daemon 与扩展均在线
bsk browsers                        # 能看到你的浏览器实例
```

## 5. 给 agent 装技能

```sh
bsk install-skill --list            # 看本机检测到哪些 agent harness
bsk install-skill                   # 按提示选择安装
```

## 6. 试一下新功能

```sh
bsk session start --json            # 人类接管：在 Agent Window 里点"接管"，agent 命令会被拒
bsk session wait-control --session <id>

bsk record start --detach --url https://zh.wikipedia.org/ --output ./rec --json
bsk observe --session <id>          # 用返回的 session 做任务，动作自动进入录制
bsk record stop --output ./rec
bsk site workflow save --from ./rec/trace.json --id demo --task t1
bsk site checkpoint --host zh.wikipedia.org --task t1 --reason direct_correction
bsk site context --host zh.wikipedia.org --task t2   # 下次任务先读记忆
```

## 更新

```sh
git pull
cargo build --release -p bsk && cp target/release/bsk ~/.local/bin/
pnpm ext:build                      # 然后在 chrome://extensions 点扩展的"重新加载"
```
