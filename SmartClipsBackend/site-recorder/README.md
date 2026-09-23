# Site recorder (CLI)

The recorder itself lives in `backend/siteRecorder.js` and is exposed on the
live server as `POST /api/site-video` (see `backend/siteVideo.js`), which is
what `record.html` calls. This folder is just a local command-line front end
for the same code:

    node SmartClipsBackend/site-recorder/record.js aquaforge
    node SmartClipsBackend/site-recorder/record.js https://example.com --duration 20
