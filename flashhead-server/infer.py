"""FlashHead 模型加载与推理（参考实现）。

说明：
- FlashHead 约为 1.3B 参数的实时数字人（说话头像）模型，需 PyTorch + CUDA(GPU)。
- 真实权重为专有/需授权，此处仅给出接口骨架与占位实现，
  请在具备 GPU 与权重后补全 load_weights 与 step 的真实逻辑。
"""
from typing import Optional
import base64
import numpy as np


class FlashHeadModel:
    def __init__(self, model_path: str = "checkpoints/flashhead", device: str = "cuda"):
        self.model_path = model_path
        self.device = device
        self.portrait: Optional[bytes] = None
        self._model = None
        # TODO: 加载真实权重（需 GPU + 专有权重）
        #   from torch import load
        #   self._model = load(model_path, map_location=device)
        print(f"[FlashHeadModel] 初始化（占位）。model_path={model_path}, device={device}")

    def set_portrait(self, portrait) -> None:
        """设置/更新人像（base64 / dataURL / 原始 bytes）。"""
        if portrait is None:
            self.portrait = None
            return
        if isinstance(portrait, str):
            # 去掉 dataURL 前缀（如 data:image/png;base64,）
            if portrait.startswith("data:"):
                portrait = portrait.split(",", 1)[1]
            self.portrait = base64.b64decode(portrait)
        else:
            self.portrait = portrait

    def step(self, pcm_bytes: bytes) -> Optional[bytes]:
        """输入一段 16k/16bit/单声道 PCM，输出一帧 JPEG（bytes）或 None。

        TODO: 调用真实 FlashHead 推理：音频特征 → 口型同步的人像帧。
        当前为占位：返回 None（不产出帧），生产环境请替换为真实推理。
        """
        # 仅做形状校验示例（确保上游传入的是合法 PCM）
        if len(pcm_bytes) % 2 != 0:
            return None
        int16 = np.frombuffer(pcm_bytes, dtype="<i2")
        if int16.size == 0:
            return None
        # TODO: 真实推理 -> jpeg_bytes = self._model.infer(self.portrait, int16)
        # 占位返回 None，表示本帧无输出（前端将保持上一帧或 2D 降级）
        return None


if __name__ == "__main__":
    m = FlashHeadModel()
    m.set_portrait("data:image/png;base64,AAAA")
    out = m.step(np.zeros(320, dtype="<i2").tobytes())
    print("step output:", out)
