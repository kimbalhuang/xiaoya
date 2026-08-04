"""FlashHead 本地实时数字人推理服务（FastAPI 参考实现）。

接口契约：
- WS 连接: ws://<host>:<port>/ws
  客户端 → 服务:
    {"type": "init", "portrait": "<base64 或 dataURL 人像图，可选>"}
    {"type": "audio", "pcm": "<base64 编码的 16k/16bit/单声道 PCM 小端>"}
    {"type": "portrait", "image": "<base64 人像>"}
  服务 → 客户端:
    {"type": "frame", "image": "<base64 编码的 JPEG 帧>"}   或
    {"type": "video", "webm_chunk": "<base64 编码的视频块>"}
    {"type": "mode", "mode": "2d"}   # 不可用时降级信号
- REST:
    GET /init   健康检查 / 初始化
"""
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
import base64
import asyncio

from infer import FlashHeadModel  # 推理封装（见 infer.py）

app = FastAPI(title="FlashHead Local Inference Server", version="0.1.0")

# 全局模型实例（懒加载）
_model: FlashHeadModel | None = None


def get_model() -> FlashHeadModel:
    global _model
    if _model is None:
        _model = FlashHeadModel()  # 加载权重（需 GPU + 专有权重，见 infer.py）
    return _model


@app.get("/init")
async def init():
    return {"status": "ok", "model_loaded": _model is not None}


@app.websocket("/ws")
async def ws_endpoint(websocket: WebSocket):
    await websocket.accept()
    model = get_model()
    await websocket.send_json({"type": "mode", "mode": "live"})
    try:
        while True:
            data = await websocket.receive_json()
            if data.get("type") == "init":
                model.set_portrait(data.get("portrait"))
            elif data.get("type") == "portrait":
                model.set_portrait(data.get("image"))
            elif data.get("type") == "audio":
                pcm_b64 = data.get("pcm", "")
                pcm_bytes = base64.b64decode(pcm_b64)
                # 推理生成一帧（或若干帧）
                frame = model.step(pcm_bytes)
                if frame is not None:
                    await websocket.send_json(
                        {"type": "frame", "image": base64.b64encode(frame).decode("ascii")}
                    )
            else:
                print(f"[flashhead] 忽略未知消息: {data.get('type')}")
    except WebSocketDisconnect:
        print("[flashhead] 客户端断开")
    except Exception as e:  # noqa: BLE001
        print(f"[flashhead] 异常: {e}")
        try:
            await websocket.send_json({"type": "mode", "mode": "2d"})
        except Exception:  # noqa: BLE001
            pass


if __name__ == "__main__":
    import uvicorn

    # 默认 8000 端口（与 .env FLASHHEAD_URL=http://localhost:8000 对齐）；
    # 可通过环境变量 FLASHHEAD_HOST / FLASHHEAD_PORT 覆盖。
    uvicorn.run(app, host="0.0.0.0", port=int(__import__("os").environ.get("FLASHHEAD_PORT", "8000")))
