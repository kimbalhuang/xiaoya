'use strict';

require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const { loadDevice, markActivated } = require('./device');
const { register, activate } = require('./ota');
const { XiaozhiBridge } = require('./bridge');
const { createFlashHeadAdapter, TwoDAdapter, probeLocalFlashHead } = require('./flashhead');

const PORT = parseInt(process.env.PORT || '3001', 10);
// FlashHead 只保留本地推理模式（gradio / local）；已移除 2d 可选模式与云端 WaveSpeed 模式
const FLASHHEAD_MODE = process.env.FLASHHEAD_MODE || 'gradio';
const FLASHHEAD_URL = process.env.FLASHHEAD_URL || 'http://127.0.0.1:6006';
// 本地推理服务探测超时（毫秒，默认 10s，可配置）；连不上则直接实时播放语音（不等待视频）
const FLASHHEAD_TIMEOUT = parseInt(process.env.FLASHHEAD_TIMEOUT || '10000', 10);

const device = loadDevice();

// 当前头像模式（由 FlashHead 适配器回传）。
// 未探测前初始为 '2d'（按实时语音处理）；探测成功后在 bootstrap 中切为 'live'（等视频）。
let currentAvatarMode = '2d';

// 所有 /avatar 客户端集合（用于广播视频帧与控制消息）
const avatarClients = new Set();

function broadcastAvatarFrame(buf) {
  for (const c of avatarClients) {
    if (c.readyState === c.OPEN) {
      try {
        c.send(buf);
      } catch (_) {
        /* noop */
      }
    }
  }
}

function broadcastAvatarControl(obj) {
  const s = JSON.stringify(obj);
  for (const c of avatarClients) {
    if (c.readyState === c.OPEN) {
      try {
        c.send(s);
      } catch (_) {
        /* noop */
      }
    }
  }
}

// FlashHead 适配器实例：由 bootstrap() 启动时探测本地推理服务后创建（live=本地推理 / 2d=实时语音占位）
let flashhead = null;

let flashheadStarted = false;

// ============ Express ============
const app = express();
app.use(cors());
app.use(express.json());

// 设备身份
app.get('/api/device', (req, res) => {
  res.json(device);
});

// OTA 注册（代理虾哥云）——仅返回注册数据，不在激活完成前持久化 token
app.post('/ota/register', async (req, res) => {
  try {
    const data = await register(device);
    res.json(data);
  } catch (e) {
    console.error('[ota/register]', e.message);
    res.status(502).json({ error: e.message });
  }
});

// OTA 激活（代理虾哥云，轮询）——激活成功后持久化 token
app.post('/ota/activate', async (req, res) => {
  const challenge = req.body && req.body.challenge;
  if (!challenge) return res.status(400).json({ error: '缺少 challenge' });
  try {
    const result = await activate(device, challenge, () => {});
    if (result.success) {
      const ws = result.websocket || { url: device.websocket?.url, token: device.websocket?.token };
      markActivated(device, ws);
    }
    res.json(result);
  } catch (e) {
    console.error('[ota/activate]', e.message);
    res.status(502).json({ error: e.message });
  }
});

// 静态托管前端构建产物（生产模式可选）
const distDir = path.join(__dirname, '..', 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get('*', (req, res) => res.sendFile(path.join(distDir, 'index.html')));
}

const server = http.createServer(app);

// ============ /ws 浏览器 ↔ 后端桥接 ============
// 两个 WSS 使用 noServer 模式 + 手动 upgrade 路由，原因有二：
// 1) ws 8.x 的 WebSocketServer({server, path}) 对「路径不匹配」的 upgrade 请求会调用
//    abortHandshake(socket,400) 直接销毁 socket。若两个 WSS 共享同一 http server，
//    连 /ws 时 /avatar 的 listener 会把已升级的 socket 干掉（连 /avatar 时反之亦然），
//    导致连接刚建立即被 1006 断开、message 事件永不触发（已实测复现）。
// 2) 显式禁用 perMessageDeflate（压缩扩展）：Node 22 + ws 8.x 在 Windows 下
//    客户端协商的压缩帧 RSV1 位解析异常，导致入站帧被判定非法丢弃（已实测复现）。
const wssBridge = new WebSocketServer({ noServer: true, perMessageDeflate: false });
const wssAvatar = new WebSocketServer({ noServer: true, perMessageDeflate: false });

// 统一处理 upgrade，按路径分发到对应 WSS（noServer 模式必须手动 handleUpgrade）
server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/ws') {
    wssBridge.handleUpgrade(req, socket, head, (ws) => wssBridge.emit('connection', ws, req));
  } else if (pathname === '/avatar') {
    wssAvatar.handleUpgrade(req, socket, head, (ws) => wssAvatar.emit('connection', ws, req));
  } else {
    // 未知路径：直接关闭，避免悬挂 socket
    socket.destroy();
  }
});
let browserWs = null;
let bridge = null;

function sendToBrowser(obj) {
  if (browserWs && browserWs.readyState === browserWs.OPEN) {
    browserWs.send(JSON.stringify(obj));
  }
}

function sendToBrowserBinary(buf) {
  if (browserWs && browserWs.readyState === browserWs.OPEN) {
    browserWs.send(buf);
  }
}

async function handleGetActivation(ws) {
  try {
    // 已激活（持久化标记）则直接 ready
    if (device.activated && device.websocket && device.websocket.token) {
      ws.send(JSON.stringify({ type: 'ready', websocket: device.websocket }));
      return;
    }
    const data = await register(device);
    const registerWs = data.websocket
      ? { url: data.websocket.url, token: data.websocket.token }
      : null;
    if (data.activation && data.activation.code) {
      ws.send(
        JSON.stringify({
          type: 'activation',
          code: data.activation.code,
          challenge: data.activation.challenge,
        }),
      );
      const result = await activate(device, data.activation.challenge, (state) => {
        ws.send(JSON.stringify({ type: 'status', state }));
      });
      if (result.success) {
        // 仅在此刻（激活成功）持久化 token
        markActivated(device, result.websocket || registerWs);
        ws.send(JSON.stringify({ type: 'ready', websocket: device.websocket }));
      } else {
        ws.send(
          JSON.stringify({
            type: 'error',
            code: 'OTA_ACTIVATION_TIMEOUT',
            message: '激活超时（10 分钟），请重试',
          }),
        );
      }
    } else if (registerWs && registerWs.token) {
      // 后端认为已注册（无 activation 字段）：直接标记并 ready
      markActivated(device, registerWs);
      ws.send(JSON.stringify({ type: 'ready', websocket: device.websocket }));
    } else {
      ws.send(
        JSON.stringify({
          type: 'error',
          code: 'DEVICE_NOT_READY',
          message: 'OTA 未返回激活信息',
        }),
      );
    }
  } catch (e) {
    console.error('[get_activation]', e.message);
    ws.send(JSON.stringify({ type: 'error', code: 'DEVICE_NOT_READY', message: e.message }));
  }
}

wssBridge.on('connection', (ws) => {
  console.log('[ws] 浏览器已连接');
  browserWs = ws;
  if (!bridge) {
    bridge = new XiaozhiBridge({
      device,
      flashhead,
      sendToBrowser,
      sessionId: crypto.randomUUID(),
    });
    bridge.setBinarySink(sendToBrowserBinary);
  }
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      bridge.handleClientBinary(Buffer.isBuffer(data) ? data : Buffer.from(data));
      return;
    }
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (_) {
      return;
    }
    if (msg.type === 'get_activation') {
      handleGetActivation(ws);
      return;
    }
    bridge.handleClientMessage(msg);
  });
  ws.on('close', () => {
    console.log('[ws] 浏览器断开');
    if (browserWs === ws) browserWs = null;
  });
  ws.on('error', (e) => console.error('[ws] 错误:', e.message));
});

// ============ /avatar FlashHead 视频帧通道 ============
// wssAvatar 已在上方与 wssBridge 一起声明（noServer 模式），此处直接挂连接处理器。
wssAvatar.on('connection', (ws) => {
  console.log('[avatar] 客户端已连接');
  avatarClients.add(ws);
  // 初始下发当前模式
  ws.send(JSON.stringify({ type: 'mode', mode: currentAvatarMode }));
  // 首次连接时初始化 FlashHead（人像可由后续 portrait 消息更新）
  if (!flashheadStarted) {
    flashhead.init(device.portrait || null);
    flashheadStarted = true;
  }
  ws.on('message', (data, isBinary) => {
    if (isBinary) return; // 后端 → 浏览器为二进制帧；浏览器 → 后端为控制
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (_) {
      return;
    }
    if (msg.type === 'portrait') {
      flashhead.setPortrait(msg.image);
    } else if (msg.type === 'mode' && msg.mode === '2d') {
      // 浏览器强制请求 2D 降级
      currentAvatarMode = '2d';
      broadcastAvatarControl({ type: 'mode', mode: '2d' });
    }
  });
  ws.on('close', () => avatarClients.delete(ws));
  ws.on('error', (e) => console.error('[avatar] 错误:', e.message));
});

// ============ 启动流程（async bootstrap）============
// 启动时先探测本地 FlashHead 推理服务是否可用：
//   - 可用 → 走本地推理（live 模式，等视频，以数字人为准）
//   - 不可用 → 实时播放语音（2d 模式，不等待视频）
// 启动阻塞最长 = FLASHHEAD_TIMEOUT（默认 10s，连不上则后端延迟该时长后 listen，属于可接受语义）。
async function bootstrap() {
  console.log(`[flashhead] 探测本地推理服务 ${FLASHHEAD_URL}（超时 ${FLASHHEAD_TIMEOUT}ms）…`);
  const localReady = await probeLocalFlashHead(FLASHHEAD_URL, FLASHHEAD_TIMEOUT);

  const onFrame = (buf) => broadcastAvatarFrame(buf);
  const onMode = (mode) => {
    currentAvatarMode = mode;
    broadcastAvatarControl({ type: 'mode', mode });
  };
  // 适配器 → 浏览器的 JSON 控制消息通道（如 GradioAdapter 下发的 {type:'video',url} HLS 流地址）
  const sendControl = (obj) => broadcastAvatarControl(obj);

  // 探测成功 → 本地推理适配器；失败 → TwoDAdapter（实时语音占位，onMode 发 '2d' → 前端实时播 TTS）
  flashhead = localReady
    ? createFlashHeadAdapter({ mode: FLASHHEAD_MODE, url: FLASHHEAD_URL, onFrame, onMode, sendControl })
    : new TwoDAdapter({ url: FLASHHEAD_URL, onFrame, onMode, sendControl });
  currentAvatarMode = localReady ? 'live' : '2d';
  // 探测通常早于 /avatar 客户端连接，但若已有客户端则主动下发最终模式（更稳）
  broadcastAvatarControl({ type: 'mode', mode: currentAvatarMode });
  console.log(localReady
    ? `[flashhead] 本地推理已连接，启用 live 模式（等视频，以数字人为准）`
    : `[flashhead] 本地推理不可用（超时 ${FLASHHEAD_TIMEOUT}ms），启用实时语音模式（不等待视频）`);

  server.listen(PORT, () => {
    console.log(`小智 Web 后端已启动: http://localhost:${PORT}`);
    console.log(`FlashHead 模式: ${FLASHHEAD_MODE}（${localReady ? 'live：本地推理等视频' : '2d：实时语音播放'}）`);
    console.log(`设备身份: ${device.device_id} / ${device.serial_number}`);
  });
}

bootstrap();
