# Site recorder (CLI)

The recorder itself lives in `backend/siteRecorder.js` and is exposed on the
live server as `POST /api/site-video` (see `backend/siteVideo.js`), which is
what `generate.html` drives (via `POST /api/generate-video`, `backend/generateVideo.js`, which writes the ad page and then queues a recording here). This folder is just a local command-line front end
for the same code:

    node SmartClipsBackend/site-recorder/record.js aquaforge
    node SmartClipsBackend/site-recorder/record.js https://example.com --duration 20
