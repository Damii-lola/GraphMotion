'use strict';
/*
 * MORPH FILM: six full-screen AI pictures (the hero object is INSIDE each picture) joined by wireframe morphs (siteTemplate/ad.html, morph mode).
 * A scene is "a hero in a world seen from a shot". The script AI writes 3 heroes, 3 worlds and, per scene, which hero, which world and which shot;
 * which of hero / world stays between two scenes decides the kind of transition:
 *     same hero, new world  -> move  (the whole frame morphs while the hero settles into its new place)
 *     same world, new hero  -> sweep (the morph travels from the top-left corner to the bottom-right)
 *     everything new        -> all   (the whole frame morphs at once)
 * Pictures for repeated heroes / worlds are EDITS of the previous picture, so a hero that stays really is the same hero.
 */
const nodeFilm = require('./nodeFilm');

const RELEVANCE = nodeFilm.NODE_FLOW.slice(0, nodeFilm.NODE_FLOW.indexOf('MOTION-GRAPHICS FILM')).trim();

const MORPH_FLOW = `${RELEVANCE}

IMAGE FILM (the most important part). The picture of this ad is six full-screen AI pictures joined by wireframe morphs: a picture turns into a glowing wireframe grid and the next picture forms out of it. Each picture is ONE clear HERO in ONE WORLD, seen from a SHOT. The hero is part of the picture (never a floating cut-out).
(1) THE HEROES. Write 3 heroes {"name": "2-3 words", "prompt": "what it is and how it looks, max 22 words"}. Each hero is one of your motifs as a real, recognisable thing that a camera could photograph: the client's product in use, what it makes, a tool of the trade, or the result it creates. For SOFTWARE, apps, websites and AI tools the hero is the product shown on a SCREEN (a phone or laptop whose screen glows with a colourful interface made of blocks and shapes, no readable words) or the real-world RESULT it produces - NEVER a physical box, package, gift or parcel, and never the company name printed on an object. No text, no letters, no logos anywhere.
(2) THE WORLDS. Write 3 worlds {"name": "2-3 words", "prompt": "the place, the light, the mood, max 25 words"}: the environments where the client's things are made, used or lived with (a coffee brand: a rustic roastery at dawn with steam and burlap sacks; an app builder: a founder's desk by a city window at night; a shoe brand: a dawn trail through trees). Bright or moody, but always a real, specific place.
(3) SIX SCENES, each with "hero" (0-2), "world" (0-2) and a "shot" (the camera distance, angle and small action, max 14 words: "extreme close-up, hand tapping the screen", "wide, low angle, light streaming in"). The picture of a scene is its hero in its world seen from its shot. Across the 5 changes between scenes use ALL THREE kinds: SAME hero in a NEW world (the frame morphs while the hero settles in its new place); SAME world with a DIFFERENT hero (the morph sweeps across from the top-left corner to the bottom-right); EVERYTHING different (the whole frame morphs). Never the same kind twice in a row. The hook (scene 1) must be the most striking picture: a tight, bold, high-contrast shot of the hero. The end card (scene 6) is a calm, clean shot of the hero with plenty of empty space.`;

const MORPH_KEYS = `Return ONE JSON object with these keys:
"brand", "motifs": EXACTLY 6 short strings (see RELEVANCE IS EVERYTHING - write these first), "tagline" (max 7 words), "look" (metal = heavy-metal / punk / gothic / dark-humour brands; luxury; tech; playful; clean), "accent" (ONE bold signature colour #RRGGBB - the brand's own if the brief names one; never grey), "bg" (near-black #RRGGBB), "cta" (button label, 2-4 words), "link" (website or @handle ONLY if it appears in the brief, else ""),
"heroes": EXACTLY 3 objects {"name","prompt"}, "worlds": EXACTLY 3 objects {"name","prompt"} (see IMAGE FILM),
"scenes": EXACTLY 6 objects, each: "id", "tag" (a 1-3 word LABEL pill like "POV", "Real talk", "The proof" - a label, not the start of a sentence, never ending in "..."; "" for cta), "headline" (an ARRAY of 2-6 word strings, ONE WORD PER ELEMENT, using the client's own product words - a headline a stranger could not tie to THIS company is a failure, e.g. ["Your","*idea*","starts","|","to","glow"]; a lone "|" element is a line break; wrap the 1-2 key words in *asterisks*), "sub" (optional line, max 8 words, else ""), "sticker" ({"n":"number or word, max 7 chars","l":"label, max 3 words"} for solution/feature/proof only when the brief gives a real number or fact, else null), "hero" (0-2), "world" (0-2), "shot" (max 14 words), "pos" ("bm" bottom centre, "bl" bottom left, "br" bottom right, "tl" top left, "tm" top centre - never the middle; vary it), "tone" ("dark"),
"transitions": EXACTLY 5 objects, each just {"sfx": a whoosh id from SOUND}@@SND@@.
Output the JSON object only.`;

const CINE_FLOW = `${RELEVANCE}

FILM (the most important part). The ad is ONE continuous AI-filmed take: six keyframe pictures, and an AI video model films the camera travelling from each keyframe into the next, so the whole ad is one unbroken shot with real camera movement and nothing cut. Each keyframe is ONE clear HERO in ONE WORLD seen from a SHOT.
(1) THE HEROES. Write 3 heroes {"name": "2-3 words", "prompt": "what it is and how it looks, max 22 words"}. Each hero is one of your motifs as a real, recognisable thing a camera could photograph: the client's product in use, what it makes, a tool of the trade, or the result it creates. For SOFTWARE, apps, websites and AI tools the hero is the product shown on a SCREEN (a phone or laptop whose screen glows with a colourful, bright interface made of blocks and shapes, no readable words, never a blank grey screen) or the real-world RESULT it produces - NEVER a physical box, package, gift or parcel, and never the company name printed on an object. No text, no letters, no logos anywhere.
(2) THE WORLDS. Write 3 worlds {"name": "2-3 words", "prompt": "the place, the light, the mood, max 25 words"}: real, specific, beautiful environments where the client's things are made, used or lived with (a coffee brand: a rustic roastery at dawn with steam and burlap sacks; an app builder: a founder's desk by a city window at golden hour; a shoe brand: a dawn trail through trees). Cinematic light: golden hour, blue hour, neon at night, soft window light.
(3) SIX SCENES, each with "hero" (0-2), "world" (0-2), a "shot" (camera distance, angle and small action, max 14 words: "extreme close-up, finger tapping the screen", "wide, low angle, light streaming in") and a "motion": ONE sentence (max 24 words) filming the move from THIS keyframe into the NEXT: the camera move (dolly in, orbit, crane up, push through the screen, pull back, whip pan) plus what physically happens (the screen lights up, steam rises, the hand slides in, the light shifts). CONSECUTIVE SCENES MUST SHARE EITHER THE HERO OR THE WORLD (never both different): a video model can film a believable move between two views of the same thing, and cannot film one between two unrelated pictures. Vary it: keep the hero and change the world; keep the world and change the hero; or keep both and change only the shot. The hook (scene 1) is bold, tight and high-contrast. The last scene is a calm, clean shot with empty space, and its "motion" is a slow push in.`;

const CINE_KEYS = null;   // built from MORPH_KEYS below

const PIC_STYLE = 'cinematic vertical 9:16 photograph, bright natural light, shallow depth of field, rich colour, sharp focus, no text, no letters, no logos, no watermark';
const MORE_BANNED = ['box', 'boxes', 'package', 'packaging', 'parcel', 'gift', 'crate'];

/** Validate the plan: 3 heroes, 3 worlds (grounded in the client's motifs), and per scene a hero / world / shot with all three kinds of change. */
function applyMorphPlan(spec, S, briefText, opts = {}) {
  const motifs = (Array.isArray(S.motifs) ? S.motifs : []).map((m) => String(m || '').replace(/["<>]/g, '').trim().slice(0, 90)).filter(Boolean).slice(0, 6);
  spec.motifs = motifs;
  const mStems = nodeFilm.stems(motifs.join(' '));
  const clean = (v, n) => String(v || '').replace(/["<>]/g, '').trim().slice(0, n);
  const ground = (name, prompt, i, kind) => {
    const bad = MORE_BANNED.some((w) => nodeFilm.flat(name + ' ' + prompt).includes(' ' + w + ' ') && !nodeFilm.flat(briefText).includes(' ' + w + ' '));
    if ((bad || !nodeFilm.grounded(name + ' ' + prompt, briefText, mStems)) && motifs.length) {
      const m = motifs[(kind === 'world' ? i * 2 : i) % motifs.length];
      console.warn('[relevance] ' + kind + ' ' + (i + 1) + ' was not about this company: using "' + m + '"');
      return kind === 'world' ? { name: m.split(' ').slice(0, 3).join(' '), prompt: 'a softly lit, atmospheric place where ' + m + ' is used, deep soft focus' } : { name: m.split(' ').slice(0, 3).join(' '), prompt: m + ', shown as a real photographed subject' };
    }
    return { name, prompt };
  };
  const heroesIn = Array.isArray(S.heroes) ? S.heroes : [], worldsIn = Array.isArray(S.worlds) ? S.worlds : [];
  spec.heroes = [0, 1, 2].map((i) => { const h = heroesIn[i] && typeof heroesIn[i] === 'object' ? heroesIn[i] : {}; return ground(clean(h.name, 30), clean(h.prompt, 220), i, 'hero'); });
  spec.worlds = [0, 1, 2].map((i) => { const w = worldsIn[i] && typeof worldsIn[i] === 'object' ? worldsIn[i] : {}; return ground(clean(w.name, 30), clean(w.prompt, 260), i, 'world'); });
  const sceneIn = Array.isArray(S.scenes) ? S.scenes : [];
  spec.scenes.forEach((sc, k) => {
    const s = sceneIn.find((x) => x && x.id === sc.id) || sceneIn[k] || {};
    sc.hero = Math.max(0, Math.min(2, Number.isInteger(+s.hero) ? +s.hero : k % 3)); sc.world = Math.max(0, Math.min(2, Number.isInteger(+s.world) ? +s.world : k % 3));
    sc.motion = clean(s.motion, 200) || (k === spec.scenes.length - 1 ? 'the camera slowly pushes in on the scene' : 'the camera glides smoothly toward the next view as the light shifts');
    sc.shot = clean(s.shot, 120) || ['tight bold close-up', 'medium shot, slight angle', 'wide shot, low angle', 'over the shoulder, shallow depth', 'macro detail, glowing light', 'calm wide shot, empty space'][k];
  });
  const kind = (a, b) => (a.hero === b.hero && a.world !== b.world ? 'move' : a.hero !== b.hero && a.world === b.world ? 'sweep' : 'all');
  const kinds = spec.scenes.slice(1).map((sc, i) => kind(spec.scenes[i], sc));
  if (opts.cine) {
    // a video model can only film a believable move between two views of the SAME hero or the SAME world: no 'all new' cut is allowed, and the plan must not be static
    const bad = kinds.some((k) => k === 'all') || new Set(spec.scenes.map((sc) => sc.hero + '-' + sc.world)).size < 4;
    if (bad) { const plan = [[0, 0], [0, 1], [1, 1], [1, 2], [2, 2], [2, 0]]; spec.scenes.forEach((sc, k) => { sc.hero = plan[k][0]; sc.world = plan[k][1]; }); }
  } else if (new Set(kinds).size < 3 || kinds.some((k, i) => i && k === kinds[i - 1])) {   // the plan must contain all three kinds of change and never repeat one: the code varies it
    const plan = [[0, 0], [0, 1], [1, 1], [2, 2], [2, 0], [0, 0]];
    spec.scenes.forEach((sc, k) => { sc.hero = plan[k][0]; sc.world = plan[k][1]; });
  }
  spec.scenes.forEach((sc, k) => { sc.imagePrompt = pictureAsk(spec, k).fresh || pictureAsk(spec, k).prompt; });     // the plain picture prompt of every scene (also used if the film has to fall back to still pictures)
  return spec;
}

/**
 * The picture for scene k. Returns { mode, prompt, edit }: 'fresh' (a new picture), or an edit of the previous one that keeps the hero (new world),
 * keeps the world (new hero), or just changes the camera. Edits keep a repeated hero / world genuinely the same.
 */
function pictureAsk(spec, k) {
  const sc = spec.scenes[k], prev = spec.scenes[k - 1], hero = spec.heroes[sc.hero], world = spec.worlds[sc.world];
  const fresh = `${sc.shot}. ${hero.prompt}, in ${world.prompt}. ${PIC_STYLE}`;
  if (!prev) return { mode: 'fresh', prompt: fresh };
  const sameHero = prev.hero === sc.hero, sameWorld = prev.world === sc.world;
  if (sameHero && !sameWorld) return { mode: 'edit', prompt: `Keep the exact same ${hero.name} - same object, same design and colours - but place it in a completely different environment: ${world.prompt}. ${sc.shot}. ${PIC_STYLE}`, fresh };
  if (!sameHero && sameWorld) return { mode: 'edit', prompt: `Keep the exact same environment, light and colours, but replace the main subject with: ${hero.prompt}. ${sc.shot}. ${PIC_STYLE}`, fresh };
  if (sameHero && sameWorld) return { mode: 'edit', prompt: `The same scene from a clearly different camera position: ${sc.shot}. Keep the same hero and place. ${PIC_STYLE}`, fresh };
  return { mode: 'fresh', prompt: fresh };
}

const CINE_KEYS_TEXT = MORPH_KEYS.replace('"shot" (max 14 words),', '"shot" (max 14 words), "motion" (max 24 words, see FILM),');

module.exports = { MORPH_FLOW, MORPH_KEYS, CINE_FLOW, CINE_KEYS: CINE_KEYS_TEXT, applyMorphPlan, pictureAsk, PIC_STYLE };
