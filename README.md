# 小雅 Web 聊天（xiaoya）

浏览器端 Web 应用：用户通过**文本/语音（麦克风）**与「小智」对话；接入**虾哥云（小智公共服）协议**
完成设备注册/激活与 WebSocket 聊天；接入 **SoulX FlashHead** 实时数字人推理，把小智返回的 TTS 音频 +
人像图渲染为口型同步的「说话头像」；FlashHead 不可用时**降级为 2D 动画头像**。

> 默认 `FLASHHEAD_MODE=gradio`：连接本地已运行的 SoulX FlashHead 推理服务（`http://127.0.0.1:6006`）。推理服务不可用时自动降级为前端 2D 动画头像，无需 GPU / 云 Key 也能聊天。

## 目录结构

```
xiaoya/   ← 仓库根目录即应用根（含 package.json / src / server 等）
├── package.json / vite.config.ts / tsconfig.json / tailwind.config.js / postcss.config.js
├── index.html / .env.example / README.md
├── src/
│   ├── main.tsx / App.tsx / types.ts / index.css
│   ├── lib/        wsClient.ts(WS 客户端) opus.ts(Opus 编解码) audio.ts(播放/录音)
│   ├── store/      chatStore.ts(zustand 状态)
│   └── components/ ChatView / ActivationGuide / Avatar / Settings
├── server/         index.js(Express+ws) device.js(身份) ota.js(注册/激活) bridge.js(桥接) flashhead.js(适配器)
└── flashhead-server/  main.py(FastAPI) infer.py(模型推理占位)
```

## 环境要求

- Node.js 18+（含全局 `fetch` 与 `crypto.randomUUID`）
- npm
- Python 3.10+（仅在使用本地 FlashHead 推理时需要，可选）
- 麦克风权限（语音输入）

## 快速开始

### 1. 安装依赖

```bash
npm install
```

> 若沙箱无网络无法安装：代码写法已按上述依赖版本编写，请在有网络的环境下执行安装。
> 关键依赖：前端 `react`/`@mui/*`/`zustand`/`opus-decoder`/`opus-recorder`；后端 `express`/`ws`/`dotenv`/`cors`/`opus-decoder`。
>
> 📦 音频编解码使用**非 scoped 包** `opus-decoder` / `opus-recorder`（已规避老版本 npm 对 `@wasm-*` scoped 包的解析 bug）。直接 `npm install` 即可；若遇依赖解析问题，可改用 `pnpm install`。

### 2. 配置环境变量（可选）

```bash
cp .env.example .env
# 默认即可运行（FLASHHEAD_MODE=2d）
```

### 3. 启动（开发模式：前端 + 后端同时）

```bash
npm run dev
```

- 前端：http://localhost:5173
- 后端：http://localhost:3001 （`/ws`、`/avatar` 由 Vite 代理转发）

### 4. 仅启动后端

```bash
npm run server      # 等价于 npm start
```

### 5. 构建前端

```bash
npm run build       # 产物输出到 dist/，可由后端 server/index.js 静态托管
```

## 设备激活流程

1. 打开 http://localhost:5173，应用自动请求激活状态。
2. 若未激活，页面展示 **4 位绑定验证码**。
3. 在小智 App 中添加设备并输入验证码完成绑定。
4. 后端每 5 秒轮询虾哥云激活接口，绑定成功后自动进入聊天界面。

设备身份（MAC / UUID / serial_number / hmac_key）生成一次后持久化到 `server/data/device.json`。

## FlashHead 数字人（可选，仅本地推理）

数字人推理**只支持本地推理模式**（云端 WaveSpeed 模式已于 2026-08-04 移除）。后端启动时探测推理服务，
不可用时自动降级为前端 2D 动画头像，聊天不受影响。

### 模式一：Gradio（默认，推荐）

连接本地已运行的 SoulX FlashHead Gradio 流式推理服务（端点 `/run_inference_streaming`）：

```bash
# .env
FLASHHEAD_MODE=gradio
FLASHHEAD_URL=http://127.0.0.1:6006
FLASHHEAD_TIMEOUT=10000   # 启动探测超时（ms），超时则降级 2D
```

### 模式二：FastAPI 参考服务（local）

```bash
# 1) 安装 Python 依赖（示例）
pip install fastapi uvicorn numpy
# 2) .env
#    FLASHHEAD_MODE=local
#    FLASHHEAD_URL=http://localhost:8000
# 3) 启动推理服务
python flashhead-server/main.py
#    或: npm run flashhead
```

`flashhead-server/infer.py` 给出完整**接口契约**与推理骨架；真实权重为专有/需 GPU，
请在具备环境后补全 `load_weights` 与 `step` 的真实逻辑（约 1.3B 参数，PyTorch + CUDA）。

### 降级

`gradio` / `local` 任意失败（连不上、推理报错、超时）均会向浏览器下发 `{type:"mode",mode:"2d"}`，
前端自动切换为 2D 动画头像并实时播放语音。

## 协议要点

- **WS 四头**（浏览器无法设置，必须后端代理）：`Authorization: Bearer <token>`、`Protocol-Version: 1`、
  `Client-Id`、`Device-Id`、`Serial-Number`。
- **二进制帧格式**（浏览器↔后端↔小智三处一致，已实测确认）：一条 WS 二进制消息即一个**完整裸 Opus 帧**（RFC 6716，**无长度前缀**，帧头如 `db 83 ...` 为 Opus TOC）；文本消息为 JSON，与音频帧按 WS 消息类型区分。
- **音频对齐**：麦克风 16k/16bit/单声道 PCM → Opus；小智 TTS Opus → 解码 16k PCM 播放；
  送入 FlashHead 的音频统一 16k 单声道 PCM（Int16 小端）。

## 已知限制

- 浏览器麦克风 / GPU 推理无法在此环境实测；代码以正确对接协议为目标。
- FlashHead 本地推理模型权重为专有资源，需自备 GPU 与权重后补全 `infer.py`。
- 索引历史（IndexedDB）、移动端适配、无障碍、人像自定义等为 P2，留 TODO。
