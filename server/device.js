'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const DEVICE_FILE = path.join(DATA_DIR, 'device.json');

/** 生成随机 MAC 风格地址 xx:xx:xx:xx:xx:xx */
function randomMac() {
  const bytes = crypto.randomBytes(6);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(':');
}

/** 生成设备身份四元组（一次性） */
function generateDevice() {
  const deviceId = randomMac();
  const clientId = crypto.randomUUID();
  const macClean = deviceId.replace(/:/g, '').toLowerCase();
  const md5 = crypto.createHash('md5').update(macClean).digest('hex');
  const serialNumber = `SN-${md5.slice(0, 8).toUpperCase()}-${macClean}`;
  const hmacKey = crypto.createHash('sha256').update(`${deviceId}||${clientId}`).digest('hex');
  return {
    device_id: deviceId,
    client_id: clientId,
    mac: deviceId,
    serial_number: serialNumber,
    hmac_key: hmacKey,
    activated: false,
  };
}

/** 加载设备身份；不存在则生成并持久化 */
function loadDevice() {
  try {
    if (fs.existsSync(DEVICE_FILE)) {
      const raw = fs.readFileSync(DEVICE_FILE, 'utf8');
      const dev = JSON.parse(raw);
      if (dev && dev.device_id && dev.client_id && dev.serial_number && dev.hmac_key) {
        // 兜底默认值：旧版 device.json 可能缺少 activated / websocket 字段，
        // 补默认值避免 undefined 语义歧义（激活分支判断更稳健）
        dev.activated = !!dev.activated;
        dev.websocket = dev.websocket || null;
        return dev;
      }
    }
  } catch (e) {
    console.warn('[device] 读取设备身份失败，将重新生成:', e.message);
  }
  const dev = generateDevice();
  saveDevice(dev);
  return dev;
}

/** 持久化设备身份 */
function saveDevice(dev) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DEVICE_FILE, JSON.stringify(dev, null, 2), 'utf8');
  } catch (e) {
    console.error('[device] 持久化设备身份失败:', e.message);
  }
}

/** 写入/更新聊天 WebSocket 端点（激活后） */
function setWebsocket(dev, ws) {
  dev.websocket = ws;
  saveDevice(dev);
}

/** 标记设备已激活并持久化聊天端点（仅在激活成功后调用） */
function markActivated(dev, ws) {
  dev.websocket = ws;
  dev.activated = true;
  saveDevice(dev);
}

module.exports = { loadDevice, saveDevice, setWebsocket, markActivated, generateDevice };
