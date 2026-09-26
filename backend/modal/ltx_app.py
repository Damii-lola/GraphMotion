"""
SmartClips image-to-video on Modal: open LTX-Video 0.9.8 (13B, distilled) behind ONE authenticated web endpoint.

  POST  <url>   header  x-api-key: <MODAL_VIDEO_SECRET>
        json    { "image": "<base64 png/jpg>", "prompt": "...", "width": 512, "height": 1024, "frames": 89, "seed": 1 }
        reply   video/mp4 bytes (24 fps)

Deploy (secrets are read from the environment, never from files in the repo):
  MODAL_VIDEO_SECRET=<random string>  python -m modal deploy backend/modal/ltx_app.py
"""
import base64
import io
import os

import modal

MODEL = "Lightricks/LTX-Video-0.9.8-13B-distilled"
CACHE = "/models"

image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("ffmpeg")
    .pip_install(
        "torch==2.7.1", "diffusers==0.35.2", "transformers==4.55.4", "accelerate==1.10.1", "sentencepiece==0.2.1",
        "protobuf", "pillow", "imageio", "imageio-ffmpeg", "numpy", "fastapi[standard]", "huggingface_hub",
    )
    .env({"HF_HOME": CACHE, "HF_HUB_ENABLE_HF_TRANSFER": "0"})
)

app = modal.App("smartclips-ltx", image=image)
weights = modal.Volume.from_name("smartclips-ltx-weights", create_if_missing=True)
secret = modal.Secret.from_dict({"MODAL_VIDEO_SECRET": os.environ.get("MODAL_VIDEO_SECRET", "")})

# distilled model: guidance 1, a short fixed schedule (from the model card)
TIMESTEPS = [1000, 993, 987, 981, 975, 909, 725, 0.03]
NEGATIVE = "worst quality, inconsistent motion, blurry, jittery, distorted, text, letters, watermark, subtitles"


@app.cls(gpu="L40S", volumes={CACHE: weights}, secrets=[secret], scaledown_window=120, timeout=600)
class Ltx:
    @modal.enter()
    def load(self):
        import torch
        from huggingface_hub import snapshot_download
        from diffusers import LTXConditionPipeline

        path = snapshot_download(
            MODEL, cache_dir=CACHE,
            allow_patterns=["model_index.json", "scheduler/*", "tokenizer/*", "text_encoder/*", "transformer/*", "vae/config.json", "vae/diffusion_pytorch_model.safetensors"],
        )
        weights.commit()
        self.pipe = LTXConditionPipeline.from_pretrained(path, torch_dtype=torch.bfloat16).to("cuda")
        self.pipe.vae.enable_tiling()

    @modal.fastapi_endpoint(method="POST")
    def clip(self, body: dict, request: "fastapi.Request"):  # noqa: F821
        import fastapi
        import torch
        from PIL import Image
        from diffusers.pipelines.ltx.pipeline_ltx_condition import LTXVideoCondition
        from diffusers.utils import export_to_video

        want = os.environ.get("MODAL_VIDEO_SECRET", "")
        if not want or request.headers.get("x-api-key") != want:
            raise fastapi.HTTPException(status_code=401, detail="unauthorized")

        w = int(body.get("width", 512)) // 32 * 32
        h = int(body.get("height", 1024)) // 32 * 32
        n = int(body.get("frames", 89))
        n = (n - 1) // 8 * 8 + 1                                     # frames must be 8k+1
        img = Image.open(io.BytesIO(base64.b64decode(body["image"]))).convert("RGB").resize((w, h))
        prompt = str(body.get("prompt", ""))[:600]

        cond = [LTXVideoCondition(image=img, frame_index=0)]
        frames = self.pipe(
            conditions=cond, prompt=prompt, negative_prompt=NEGATIVE, width=w, height=h, num_frames=n,
            timesteps=TIMESTEPS, decode_timestep=0.05, decode_noise_scale=0.025, image_cond_noise_scale=0.0,
            guidance_scale=1.0, guidance_rescale=0.7, generator=torch.Generator("cuda").manual_seed(int(body.get("seed", 1))),
            output_type="pil",
        ).frames[0]
        out = "/tmp/clip.mp4"
        export_to_video(frames, out, fps=24)
        with open(out, "rb") as f:
            data = f.read()
        return fastapi.Response(content=data, media_type="video/mp4")
