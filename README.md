# cb-ration · 可转债抢权配售实时数据

可转债（配债）抢权配售的实时数据工具：待发转债、审核进度、百元含权、所需资金、预估流通盘等一目了然；支持**手机端筛选排序面板**与**关注 + 进度变化提醒**。

## 当前版本形态：纯前端（localStorage）

本仓库的 `index.html` 是**纯静态单文件**，可直接托管在 GitHub Pages / 任意静态空间，**无需任何服务器**。

- **账号与关注列表保存在浏览器 localStorage**（`cb_ration_users` / `cb_ration_cur`）。
- 优点：零后端、零部署成本，公网直接可用。
- 局限：**关注数据不跨设备同步**，换浏览器 / 清缓存 / 无痕模式会丢失。
- 进度变化提醒：关注某只转债时记录其当时审核阶段（`seen`），每次打开 App / 进入「我的关注」时与当前进度比对，有推进则弹 toast 提醒。

> 如需**云端多设备同步**（跨手机/电脑共享关注列表），需改用 Node 后端 `server.cjs`（本仓库未包含，见历史分支或另行部署到 VPS）。纯静态托管跑不了 Node，故公网版暂用 localStorage 方案。

## 本地预览

```bash
# 任意静态服务器即可，例如
python -m http.server 8080
# 浏览器打开 http://localhost:8080
```

> 注意：直接双击 `index.html`（file:// 协议）部分浏览器会限制 localStorage，建议用上面的 http 服务器方式访问。

## 数据更新

转债基础数据由 GitHub Actions（`.github/workflows/update.yml`）定时运行 `update.mjs` 抓取东方财富数据并写回 `审核进度快照.json` / `流通盘缓存.json`，无需手动维护。

## 目录

- `index.html` — 主程序（单文件，含全部前端逻辑）
- `update.mjs` — 数据抓取脚本（CI 定时运行）
- `审核进度快照.json` / `流通盘缓存.json` — 抓取产物（被 index.html 读取）
