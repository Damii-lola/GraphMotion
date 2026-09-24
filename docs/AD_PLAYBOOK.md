# SmartClips ad playbook

SmartClips turns a company's details into a **marketing video for TikTok / Instagram Reels / YouTube Shorts**. The video is
made by having the AI write a *page*, then filming that page. This document records (1) what the research says a good
short-form ad is, (2) what was wrong with the old generator, and (3) how the new generator (`backend/siteGenerator.js` +
`backend/siteTemplate/ad.html`) applies it. Change the generator → keep this file true.

## 1. What the research says

| Topic | Finding | Source |
|---|---|---|
| Hook | Viewers decide in ~1.2 s whether to keep watching; the first 2–3 s decide it. TikTok: put the content proposition in the first 3 s and the hook in the first 6 s. A logo animation, black screen or slow establishing shot loses the audience before the ad starts. Text that appears after the 1 s mark means about half of viewers are already gone. | [TikTok creative best practices](https://ads.tiktok.com/help/article/creative-best-practices), [AdLibrary Reels ads](https://adlibrary.com/posts/reels-ads), [Coinis TikTok ad guide](https://coinis.com/how-to/design-tiktok-video-ad) |
| Pattern interrupt | A visual/sonic mismatch in the first second (bold claim, surprising image, scene change, captions) raises engagement; "reaction first, context second". | [TikTok: pattern interrupt](https://www.tiktok.com/discover/pattern-interrupt-method-for-ads), [Zeely](https://zeely.ai/blog/what-works-on-tiktok-in-2026-20-ad-examples/) |
| Structure | Hook 0–3 s → value proposition 3–15 s → proof/demo → CTA in the last ~5 s. AIDA and PAS (problem → agitate → solution) compress well into 15–30 s. | copywriting-framework research (AIDA / PAS for short video) |
| Length | 15–30 s is the sweet spot (<10 s is weak, >45 s drops off). | [AdLibrary](https://adlibrary.com/posts/meta-ads-creative-best-practices), [Benly](https://benly.ai/learn/meta-ads/meta-ads-reels-ads-guide) |
| Text | 5–10 words per second of on-screen text; 5–7 words per line / overlay; one idea per card; >10 words per card and people stop reading. Captions add ~12 % view time. Text supports the visual story, it does not replace it (text on a static background is a static image). | TikTok best practices, [RocketShip HQ](https://www.rocketshiphq.com/text-overlays-video-ads-mobile/), [Benly](https://benly.ai/learn/ad-creative/meta-ads-creative-specs-2026) |
| Legibility | White text over bright footage without a stroke or panel is unreadable on 40 %+ of frames. Use a stroke/shadow or a solid panel; highlight the keyword. | [Coinis](https://coinis.com/how-to/design-tiktok-video-ad), [Mallary](https://mallary.ai/blog/tiktok-captions-that-go-viral) |
| Sound | ~60 % of Reels viewers have sound on but 35–40 % of TikTok users browse muted: the ad must be **compelling with sound and comprehensible without it**. TikTok: sound and music are a fundamental element. | [AdLibrary Reels](https://adlibrary.com/posts/reels-ads), TikTok best practices |
| Safe zones (9:16, 1080×1920) | Meta: top ≈14 % (~270 px) is covered by the account name/audio label, the bottom ≈35 % (~670 px) by caption/buttons/CTA bar, sides ≈6 % (~65 px). TikTok: profile bottom-left, buttons right. Anything important outside the safe zone is hidden by the platform's own UI. | [Coinis Reels](https://coinis.com/how-to/design-facebook-reels-ad), [TikAdSuite](https://tikadsuite.com/blog/tiktok-ad-safe-zones/) |
| Brand | Logo inside the first 3 s (not in the lower-centre crop zone); visual **and** spoken/on-screen CTA at the end beats either alone ("Tap to shop", "Order now"). | Coinis, [eMarketSelect](https://www.emarketselect.com/blog/the-ultimate-guide-to-meta-ad-specs-design-2025-edition-meta-safe-zones-formats-cta-buttons-best-practices) |
| Native look | Ads that look like something a user would post outperform ads that look like commercials; use transitions, stickers and graphics to keep attention. | TikTok best practices, [Zeely native ads](https://zeely.ai/blog/native-ads-examples/) |
| Motion | Kinetic typography works muted and lifts performance ~15–25 % over static text. | motion-graphics trend research |

## 2. Audit of the old generator ("website in a video")

The previous "classic" engine generated a **six-section marketing website** (kicker → headline → paragraph → stats) and scrolled it.
Measured against the playbook it failed almost everywhere:

1. **Website, not an ad.** Eyebrow labels, a 22-word body paragraph, footer-style stats, a "Scroll" cue: reading material, not captions.
2. **No hook.** Scene 1 was "the brand promise" with the company name; text only appeared after a 1.2 s frozen intro.
3. **Text too small and too much of it** (15 px body on a 540 px phone; headlines up to 9 words + a body sentence).
4. **Layout ignored platform UI.** Copy sat in the bottom third – exactly where Reels/TikTok put their caption + buttons.
5. **Scrims made for a wide website** (left/right gradients) – contrast on a phone was accidental.
6. **No logo, no client photos.** Every scene was AI-painted, even when the client supplied product shots; no end card.
7. **No CTA that looks like a CTA.** A text link in the last section.
8. **Fixed brand colour was cyan** in the WebGL transitions regardless of the brand.
9. **Silent.** No music or effects (the cinema engine had them, the default engine did not).
10. **Structure was "about us"** (hero / story / product / product / proof / join), not persuasion.

## 3. What the new generator does

`ad.html` is a 9:16 ad that happens to be HTML, so the recorder can film it. All of it is generated on the spot – no templates for the content, only a template for the *engine*.

* **Ad script, not a site plan.** The model writes hook → pain → solution → feature → proof → CTA (AIDA/PAS compressed), six scenes × 3.5 s = 21 s (+1 s on the end card). Each scene is **one idea**: 2–7 word headline (code enforces the limit), an optional ≤ 9-word line, an optional sticker badge, a 1–3 word pill label ("Real talk", "The proof"). The prompt forbids invented statistics; a link is only shown if the client's own text contained it.
* **Hook from frame 1.** No frozen intro (`holdStart: 0`), words start revealing at t = 0, brand chip visible immediately, the first scene has the largest type.
* **Kinetic captions, word by word** (masked slide-up per word, never per letter) with the key word in an accent-colour highlight block – the TikTok caption look – and a hard shadow for legibility.
* **Safe zones.** Headline block lives between ~19 % and ~62 % of the height, sides 6 %; the bottom third is left to the photo and the platform UI. Type is auto-fitted so the longest word fits and the block stays inside the zone.
* **Native social chrome.** A brand chip (logo + name) under the top zone, sticker-style proof badges rotated −3°, a pill CTA button that breathes.
* **Logo + end card.** The client's logo sits in the chip from second one and becomes the big end-card logo on a light/dark plate chosen from the logo's own pixels; the CTA button carries the model's 2–4 word action, plus the client's link/handle if they gave one.
* **Client photos first.** Uploaded images fill the product scene, then the hook, then the rest; Flux only paints the remaining scenes. That both looks more real and saves Cloudflare neurons (each free scene = 92 neurons saved).
* **Brand-coloured motion.** The WebGL transition glows / "scan-in" wash use the brand accent instead of cyan; light/dark scrims run top-down under the copy.
* **Sound on and off.** Every caption lands with a soft tick, stickers pop, scene changes get a filtered whoosh, the end card gets riser + impact + sub; a bed picked from the brand's look (`tense` metal, `pulse` tech/playful, `warm pad` luxury/clean). Everything is readable muted.
* **Contrast.** Text is white with shadow on a dark top scrim, or dark on a light scrim for the one optional light scene; accent blocks always use the WCAG-best ink colour (`accentInk`).
* **Constants.** 720×1280, 60 fps, 3.5 s per scene; the user has no options.

## 4. Product flow

`generate.html` (company name, details, main focus, notes, logo, images) → `POST /api/generate-video` → numeric job id →
AI writes the ad (Cloudflare) → page stored at `/preview/<id>/` (local disk + Supabase `site_previews` + storage bucket) →
recorder films it → MKV/MP4. The visitor only sees "Cloudflare is generating your video" and "Rendering video".
`/preview/<id>` on smartclips.org (via `404.html` → `preview.html`) shows the page playing in a phone frame.

## 5. Ideas not built yet

* Voice-over / TTS of the hook line and CTA (spoken CTA beats text-only).
* A/B variants: TikTok recommends 3–5 creatives per ad group – generate 3 hooks from one brief and render the best.
* Real screen-capture / UGC-style scenes (phone-in-hand, reaction shot) – needs footage the client does not have yet.
* Per-platform export (safe zone variants: Meta 14/35/6, TikTok right-rail).
* Learning loop: store hook + retention per job and feed the winners back into the prompt.

## 6. The flow engine (added after the first user review)

The first version had five fixed shader transitions, a frozen "calm" phase in the middle of every scene and a scroll-driven timeline whose smoothing lagged the picture. Reference shorts (an aeroplane window the camera flies *into* until the sky becomes the next scene; a face of strands that swirls into a ring; one mountain island whose light changes while the camera glides) share one idea: **nothing stops and nothing cuts – the end of a scene is the beginning of the next.** `siteTemplate/ad.html` now works like that:

* **One camera, one timeline.** Everything is a pure function of film progress `p` (`__jumpToProgress(p)`), linear in time, rendered synchronously. No scrolling, no smoothing lag. (Verified frame by frame: no frame-to-frame jump anywhere, including the scene boundaries.)
* **No calm phase.** Each scene has its own AI-chosen camera `move` (push/pull, drift, roll) defined for *all* times, so the next scene is already moving while it opens.
* **Transitions are points in a continuous space, not a catalogue.** The AI chooses, per transition, where the camera dives (`focus`), how hard it rushes (`zoom`), `spin`, motion `blur`, liquid `warp`, `glow`, colour split (`chroma`), edge `soft`ness, how long it lasts (`overlap`) and optionally writes the opening's *mask expression* itself (a GLSL float expression over `p`, `q`, `t`). `backend/flowSpec.js` only clamps ranges and rejects unsafe expressions; the page compile-tests each expression and falls back to a plain circular opening. Whatever the model writes, the opening starts closed and ends fully open, so it cannot cause a snap.
* **Chained images.** The prompt tells the model to write every image as the continuation of the previous one so the dive point of scene N is where scene N+1's subject sits.
* **Captions travel with the camera:** the outgoing caption is carried off by the same dive (scale + blur), the incoming caption starts landing while the camera is still arriving.
* **Sound:** real CC0 sound-effect recordings (`backend/sfx/`, picked by a person via `audition.html`, installed with `buildLibrary.js`), placed by `adMix.js`. The AI picks which recording to use for each transition and moment from the menu in its prompt. Transition whooshes are fixed at 20 % volume. With no library installed the synthesised fallback is used (whoosh 9 %).
