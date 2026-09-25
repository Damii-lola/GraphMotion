# SmartClips free GPU video worker (Kaggle / Colab notebook).
#
# It has no public address, so it CALLS the SmartClips server: it asks /api/vworker/next for a clip job, makes the clip with the open
# LTX-Video 2B distilled model, and posts the mp4 to /api/vworker/done/<id>. Keep the notebook running while you test.
#
# Kaggle setup (once): New Notebook -> right panel: Session options -> Accelerator = GPU T4 x2 (or P100), Internet = On.
#   Add-ons -> Secrets -> add  VIDEO_WORKER_SECRET  (same value as the Render env var), attach it to the notebook.
#   Paste this whole file into ONE cell and run it.
import base64, io, os, subprocess, sys, time, traceback

SERVER = os.environ.get("SMARTCLIPS_SERVER", "https://graphmotion.onrender.com").rstrip("/")


def secret():
    s = os.environ.get("VIDEO_WORKER_SECRET", "")
    if s:
        return s
    try:
        from kaggle_secrets import UserSecretsClient
        return UserSecretsClient().get_secret("VIDEO_WORKER_SECRET")
    except Exception:
        pass
    try:
        from google.colab import userdata
        return userdata.get("VIDEO_WORKER_SECRET")
    except Exception:
        return ""


subprocess.run([sys.executable, "-m", "pip", "install", "-q", "diffusers>=0.35", "transformers>=4.50", "accelerate", "sentencepiece", "imageio", "imageio-ffmpeg", "requests"], check=True)

import requests
import torch
from PIL import Image
from diffusers import AutoencoderKLLTXVideo, LTXConditionPipeline, LTXVideoTransformer3DModel
from diffusers.pipelines.ltx.pipeline_ltx_condition import LTXVideoCondition
from diffusers.utils import export_to_video

REPO = "https://huggingface.co/Lightricks/LTX-Video/blob/main/ltxv-2b-0.9.8-distilled.safetensors"
cap = torch.cuda.get_device_capability(0)
DTYPE = torch.bfloat16 if cap[0] >= 8 else torch.float16          # T4 / P100 have no fast bfloat16
print("GPU:", torch.cuda.get_device_name(0), "dtype:", DTYPE, flush=True)

print("loading the model (first time downloads ~15 GB, a few minutes)...", flush=True)
transformer = LTXVideoTransformer3DModel.from_single_file(REPO, torch_dtype=DTYPE)
vae = AutoencoderKLLTXVideo.from_single_file(REPO, torch_dtype=DTYPE)
pipe = LTXConditionPipeline.from_pretrained("Lightricks/LTX-Video-0.9.5", transformer=transformer, vae=vae, torch_dtype=DTYPE)
pipe.enable_model_cpu_offload()
pipe.vae.enable_tiling()
print("model ready", flush=True)

TIMESTEPS = [1000, 993, 987, 981, 975, 909, 725, 0.03]


def make_clip(job):
    w, h = int(job.get("width", 512)) // 32 * 32, int(job.get("height", 1024)) // 32 * 32
    n = (int(job.get("frames", 81)) - 1) // 8 * 8 + 1
    img = Image.open(io.BytesIO(base64.b64decode(job["image"]))).convert("RGB").resize((w, h))
    conds = [LTXVideoCondition(image=img, frame_index=0)]
    if job.get("imageEnd"):                              # keyframe-to-keyframe: the clip must ARRIVE at the next picture
        end = Image.open(io.BytesIO(base64.b64decode(job["imageEnd"]))).convert("RGB").resize((w, h))
        conds.append(LTXVideoCondition(image=end, frame_index=n - 1, strength=float(job.get("endStrength", 1.0))))
    frames = pipe(
        conditions=conds, prompt=str(job.get("prompt", ""))[:600],
        negative_prompt=str(job.get("negative", "worst quality, inconsistent motion, blurry, jittery, distorted")),
        width=w, height=h, num_frames=n, timesteps=TIMESTEPS, decode_timestep=0.05, decode_noise_scale=0.025,
        image_cond_noise_scale=0.0, guidance_scale=1.0, guidance_rescale=0.7,
        generator=torch.Generator().manual_seed(int(job.get("seed", 1))), output_type="pil",
    ).frames[0]
    export_to_video(frames, "/tmp/clip.mp4", fps=24)
    global LAST_FRAME
    LAST_FRAME = frames[-1]
    return open("/tmp/clip.mp4", "rb").read()


S = secret()
if not S:                                              # no server secret: just prove the model works
    print("No VIDEO_WORKER_SECRET found - running a self-test only.")
    b64 = os.environ.get("SELFTEST_IMAGE_B64") or ""
    if not b64:
        Image.new("RGB", (512, 1024), (60, 90, 140)).save("/tmp/t.png")
        b64 = base64.b64encode(open("/tmp/t.png", "rb").read()).decode()
    prompts = [x for x in os.environ.get("SELFTEST_PROMPTS", "the camera slowly pushes in").split("|") if x]
    os.makedirs("/kaggle/working", exist_ok=True)
    for k, p in enumerate(prompts):                    # chained: the last frame of one clip starts the next
        t = time.time()
        data = make_clip({"image": b64, "prompt": p, "frames": 81, "seed": 100 + k})
        open("/kaggle/working/test%d.mp4" % k, "wb").write(data)
        buf = io.BytesIO(); LAST_FRAME.convert("RGB").save(buf, "PNG"); b64 = base64.b64encode(buf.getvalue()).decode()
        print("self-test clip", k, "ok:", len(data), "bytes in", round(time.time() - t), "s", flush=True)
    raise SystemExit

H = {"Authorization": "Bearer " + S}
print("worker running, waiting for jobs from", SERVER, flush=True)
while True:
    try:
        r = requests.post(SERVER + "/api/vworker/next", headers=H, timeout=90)
        if r.status_code == 204:
            continue
        if r.status_code != 200:
            print("server said", r.status_code, r.text[:120], flush=True)
            time.sleep(5)
            continue
        job = r.json()
        t = time.time()
        try:
            data = make_clip(job)
            requests.post(SERVER + "/api/vworker/done/" + job["id"], headers={**H, "Content-Type": "application/octet-stream"}, data=data, timeout=120)
            print("clip", job["id"], "done in", round(time.time() - t), "s,", len(data) // 1024, "KB", flush=True)
        except Exception as e:
            traceback.print_exc()
            requests.post(SERVER + "/api/vworker/done/" + job["id"], headers={**H, "X-Error": str(e)[:200].replace("\n", " ")}, data=b"", timeout=60)
        torch.cuda.empty_cache()
    except Exception as e:
        print("worker loop:", str(e)[:150], flush=True)
        time.sleep(5)
