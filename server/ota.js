'use strict';

const crypto = require('crypto');

const OTA_URL = process.env.XIAOZHI_OTA_URL || 'https://api.tenclass.net/xiaozhi/ota/';
// 激活端点 = OTA_URL 去尾斜杠 + /activate
const ACTIVATE_URL = OTA_URL.replace(/\/$/, '') + '/activate';
const WS_URL = process.env.XIAOZHI_WS_URL || 'wss://api.tenclass.net/xiaozhi/v1/';

/** HMAC-SHA256(challenge, hmacKey) -> hex */
function hmacOf(challenge, hmacKey) {
  return crypto.createHmac('sha256', hmacKey).update(challenge).digest('hex');
}

/**
 * OTA 注册：POST {OTA_URL}
 * Headers: Device-Id / Client-Id / Content-Type / User-Agent
 * Body: application(board) 信息
 * 返回包含 activation(未注册) 或 websocket(已注册) 的数据
 */
async function register(device) {
  const body = {
    application: { version: '1.0.0', elf_sha256: 'unknown' },
    board: { type: 'flutter', name: 'xiaozhi-flutter', ip: '', mac: device.device_id },
  };
  const headers = {
    'Device-Id': device.device_id,
    'Client-Id': device.client_id,
    'Content-Type': 'application/json',
    'User-Agent': 'flutter/xiaozhi-flutter-1.0.0',
  };
  const resp = await fetch(OTA_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error(`OTA 注册失败: HTTP ${resp.status}`);
  }
  return await resp.json();
}

/**
 * OTA 激活轮询：POST {ACTIVATE_URL}
 * Headers: Activation-Version:2 / Device-Id / Client-Id / Content-Type
 * Body: { Payload: { algorithm, serial_number, challenge, hmac } }
 * 轮询：每 5 秒一次，200=成功，202=继续，最长 10 分钟。
 */
async function activate(device, challenge, onProgress) {
  const hmac = hmacOf(challenge, device.hmac_key);
  const payload = {
    Payload: {
      algorithm: 'hmac-sha256',
      serial_number: device.serial_number,
      challenge: challenge,
      hmac: hmac,
    },
  };
  const headers = {
    'Activation-Version': '2',
    'Device-Id': device.device_id,
    'Client-Id': device.client_id,
    'Content-Type': 'application/json',
  };
  const deadline = Date.now() + 10 * 60 * 1000; // 10 分钟
  let attempts = 0;
  while (Date.now() < deadline) {
    attempts += 1;
    try {
      if (onProgress) onProgress(`正在轮询激活（第 ${attempts} 次）…`);
      const resp = await fetch(ACTIVATE_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
      if (resp.status === 200) {
        let ws = null;
        try {
          const d = await resp.json();
          ws = d.websocket ? { url: d.websocket.url || WS_URL, token: d.websocket.token } : null;
        } catch (_) {
          /* ignore */
        }
        return { success: true, websocket: ws };
      }
      if (resp.status === 202) {
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      // 其它状态码：稍后重试
      await new Promise((r) => setTimeout(r, 5000));
    } catch (e) {
      if (onProgress) onProgress(`激活轮询异常：${e.message}`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  return { success: false };
}

module.exports = { register, activate, hmacOf, OTA_URL, ACTIVATE_URL, WS_URL };
