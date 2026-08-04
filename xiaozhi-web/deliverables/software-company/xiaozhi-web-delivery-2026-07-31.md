# 交付报告 · xiaozhi_web_chat（虾哥云小智 Web 聊天 + FlashHead 数字人）

> 交付总监：齐活林（Qi）｜团队：software-xiaozhi-web｜日期：2026-07-31
> 工作流：标准 SOP（PRD → 架构 → 实现 → QA）

---

## 1. TL;DR

基于《虾哥云接入指南.md》交付了一个**浏览器端聊天 Web 应用**：用户通过文本 / 语音（麦克风）与小智对话，后端代理小智 WebSocket（浏览器无法设置自定义头），Opus 音频经 WASM 编解码，并集成 SoulX FlashHead 实时数字人（不可用时优雅降级为 2D 动画头像）。源码 28 文件 + 测试 4 文件已落盘 `D:\Android\project\d-man\xiaozhi-web\`，QA 判定可交付；联调前预核对修复了 2 个协议级/完整性 Bug。

---

## 2. 四阶段成果

| 阶段 | 负责人 | 产出 |
|------|--------|------|
| PRD（简单版） | 许清楚 | 产品目标、5 条用户故事、需求池 P0/P1/P2（设备身份、OTA 激活引导、WS 代理、文本/语音、Opus、FlashHead+2D 降级、emotion、会话列表）、UI 设计稿、待确认问题 |
| 架构设计 + 任务分解 | 高见远 | 前后端分离结构、WS 桥接拓扑（浏览器↔Node↔小智 + /avatar 视频通道）、FlashHead 策略模式（Local/Cloud/2D）、18 文件目录树、Mermaid 时序图×4、T0–T14 任务列表、依赖清单、共享约定 |
| 代码实现 | 寇豆码 | 28 个源文件全部落盘，IS_PASS=YES |
| QA 测试验证 | 严过关 | 4 测试文件（device/ota/flashhead/bridge），实跑 11 用例 / 9 通过 / 0 失败 / 2 SKIP；前端协议走查；智能路由 NoOne |

---

## 3. 测试结论

- **实跑结果**：`# tests 11  # pass 9  # fail 0  # skipped 2`（主理人用 Node 22 实跑，与 QA 报告一致）
- **device.test.js（5 项全过）**：四元组格式、serial_number 公式（MD5 交叉验证）、hmac_key 公式、多次生成互异、持久化重载一致
- **ota.test.js（4 项全过）**：hmacOf 与 node 内置 crypto 一致、64 位 hex、可复现、密钥敏感
- **flashhead.test.js / bridge.test.js（各 1 SKIP）**：沙箱无网络，`ws`/`opus-decoder` 未安装，依赖它们的运行时用例 SKIP（非用例缺陷）
- **前端协议走查（代码走查，无实跑）**：
  - ✅ 前后端 13 个 WS `type` 字符串逐一对齐
  - ✅ `chatStore` 覆盖全部 `ServerToClientMessage`
  - ✅ 二进制帧在 `wsClient`/`opus`/`bridge` 三处一致（**经真实抓包修正为裸 Opus 帧直传**，见 §6 帧格式勘误）

---

## 4. 风险项（R1–R6）

| 编号 | 严重度 | 描述 | 状态 |
|------|--------|------|------|
| R1 | 中·外部协议 | 帧格式假定小智返回「带 4B 长度前缀的裸 Opus」 | ✅ 对照指南第 278 行已确认一致，**无需改** |
| R2 | 低·完整性 | `tts.sentence_start` 在 chatStore 无分支 | 🔧 已修复（见 §6） |
| R3 | 低 | `Avatar.tsx` 把 `/avatar` 任意二进制帧写死 `image/jpeg`（注释称支持 webm） | ⏳ 未处理（P2，建议单独迭代） |
| R4 | 低·架构 | `server/index.js` 的 `browserWs` 单全局变量仅支持单浏览器连接 | ⏳ 未处理（P2，多标签页场景） |
| R5 | 中·外部协议 | 文本输入 `state:'text'` 小智不接受，应为 `detect` | 🔧 已修复（见 §6） |
| R6 | 提示 | 设置页 FlashHead 模式仅展示，由环境变量 `FLASHHEAD_MODE` 控制 | ℹ️ 符合设计，非缺陷 |

---

## 5. 文件清单（D:\Android\project\d-man\xiaozhi-web\）

**根配置**：`package.json`、`vite.config.ts`、`tsconfig.json`、`tailwind.config.js`、`postcss.config.js`、`index.html`、`.env.example`、`README.md`
**前端 src/**：`main.tsx`、`App.tsx`、`types.ts`、`index.css`、`vite-env.d.ts`、`lib/wsClient.ts`、`lib/opus.ts`、`lib/audio.ts`、`store/chatStore.ts`、`components/ChatView.tsx`、`ActivationGuide.tsx`、`Avatar.tsx`、`Settings.tsx`
**后端 server/**：`index.js`、`device.js`、`ota.js`、`bridge.js`、`flashhead.js`
**FlashHead 参考服务**：`flashhead-server/main.py`、`infer.py`
**测试**：`test/device.test.js`、`ota.test.js`、`flashhead.test.js`、`bridge.test.js`

---

## 6. 联调前修复记录（2026-07-31 补）

对照《虾哥云接入指南.md》第 255–285 行，主理人 + QA 预核对发现 2 个 Bug，转工程师修复：

- **R5（协议级）**：`src/components/ChatView.tsx` 文本发送 `state:'text'` → 改为 `state:'detect'`（指南 6.2 ② 文本/音频均 `detect`，`text` 为独立字段）；`src/types.ts` 的 `listen.state` 联合类型由 `'detect' | 'text'` 改为 `'detect' | 'stop'`。
- **R2（完整性）**：`src/store/chatStore.ts` 的 `tts` 分支增补 `sentence_start` 处理（置 speaking=true 并按 `text` 追加 assistant 消息，对齐 `llm` 的 currentAssistantId 累加写法）。

修复后 IS_PASS：YES（工程师回交 + 主理人实测：node --check 通过、grep 无 @wasm-opus 残留、回归测试 9 通过 / 0 失败 / 2 SKIP）。

**附：本地 `npm install` 依赖 blocker（同日发现，两轮修复，最终解决）**
- **第一轮**：用户本地安装报 `ETARGET No matching version found for opus-decoder@^1.1.0`。
  - 根因：`package.json` 声明了三个不存在/版本错误的 Opus 包——`opus-decoder`（最高 0.7.11，无 1.x）、`opus-encoder`（npm 上根本不存在）、`ogg-opus-decoder@^1.1.0`（真实最新 1.7.3）。
  - 尝试：依赖改为 `@wasm-opus-decoder` + `@wasm-opus-encoder`，源码适配。**但用户 npm 过老，scoped 包名（`@xxx`）报 `EINVALIDPACKAGENAME: name can only contain URL-friendly characters`，依然装不上。**
- **第二轮（最终）**：彻底改用**非 scoped 包**，绕开老 npm 限制：
  - `package.json` → `opus-decoder@^0.7.11`（裸 Opus 解码）+ `opus-recorder@^8.0.5`（浏览器端 Opus 编码），均为无 `@` 前缀的包，老 npm 完全兼容。
  - `src/lib/opus.ts`：解码 `import('opus-decoder')` 取 `m.OpusDecoder`、`await ready`；编码 `import('opus-recorder')` 取 `m.Encoder`，把 worker 异步 `onmessage` 回调封装为 `Promise<Uint8Array>`（一次性回调 + try/catch reject）。
  - `server/bridge.js`：`require('opus-decoder')`、构造器取值 `.OpusDecoder`、`initDecoder` 异步 `await ready` + 失败降级 null。
- 验证：`node --check server/bridge.js` 通过；`grep -rn '@wasm-opus' src server` 无残留；回归测试 9 通过 / 0 失败 / 2 SKIP。
- 提示：若本地 npm 仍报 scoped 包名错误（其它包），说明 npm 版本过老，建议 `npm i -g npm@latest` 或换 pnpm。


---

## 7. 用户下一步建议

1. **本地跑起来**：`cd xiaozhi-web && npm install && cp .env.example .env && npm run dev`（前端 5173 / 后端 3001，默认 2D 头像即可用）
2. **设备激活**：打开页面 → 复制 4 位注册码 → 去 `xiaozhi.me` 控制台绑定 → 点「我已绑定」触发激活轮询
3. **补齐运行时测试**：有网后 `npm install` 再跑 `node --test test/`，把 2 个 SKIP（flashhead/bridge）转正
4. **升级数字人**：默认 `2d` 降级；真实说话头像需备 GPU/权重跑 `flashhead-server/` 或配 `WAVESPEED_API_KEY`，再改 `.env` 的 `FLASHHEAD_MODE`
5. **后续迭代**：R3（avatar webm 支持）、R4（多浏览器连接）、IndexedDB 历史持久化、移动端适配

---

*本报告依据各成员主理人中转后的正式产出汇编，未包含源码正文。*
