# Site recorder

Records a scroll-driven website in a phone viewport and encodes a vertical
1080x1920 H.264 MP4 (TikTok / Reels / Shorts ready).

```
cd SmartClipsBackend/site-recorder
node record.js --dir ../../aquaforge --out ../out/aquaforge.mp4          # local folder
node record.js --url https://smartclips.org/aquaforge/ --scene-seconds 6  # live site
node record.js --url https://any.site --duration 30                       # any page: plain scroll
node record.js --dir ../../aquaforge --audio music.mp3                    # add a soundtrack
```

Frames are captured one at a time against a virtual clock (the page's
requestAnimationFrame / performance.now are driven by the recorder), so the
video is smooth and identical on any machine. Expect ~10 capture frames/s:
a 40 s video at 30 fps takes about 2 minutes. Needs Chrome/Chromium
(set `CHROME_PATH` if it isn't auto-detected); ffmpeg comes from `ffmpeg-static`.

Pages built with the SmartClips scroll engine expose `window.__BEATS` and
`window.__jumpToProgress(0..1)`, and optionally `window.__assetsReady()`;
the recorder plays each scene for `--scene-seconds`. See `node record.js --help`.
