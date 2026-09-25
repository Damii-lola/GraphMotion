# The clip-making logic of the SmartClips video worker. The notebook (kaggle_worker.py) is a tiny loader that downloads THIS file from the server for every
# job, so changing how clips are made needs only a server redeploy - never a notebook restart. It runs inside the notebook's own namespace and uses:
# pipe, torch, Image, io, base64, np, LTXVideoCondition, export_to_video, TIMESTEPS (all defined by the loader).
HANDLER_VERSION = 3


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
    return open("/tmp/clip.mp4", "rb").read()
