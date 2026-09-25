'use strict';
/*
 * RELEVANCE: everything the ad shows must come from the client's own world.
 *  - The script AI first writes "motifs": photographable things taken from the brief; every keyframe is built from them.
 *  - The code then checks every keyframe prompt: it must share vocabulary with the motifs, and may not use generic decoration or invented subjects
 *    (cars, mugs, boxes, faces...) the brief never mentions. A prompt that fails is REPLACED by one built from the client's own motifs.
 *  - The photographic style (chosen by the AI) is cleaned of looks that damage every picture ("circular lens", vignette, fisheye...).
 */

const RELEVANCE = `RELEVANCE IS EVERYTHING. A viewer must know within one second what THIS company is from the pictures alone. So before anything else you READ THE BRIEF and write "motifs": 6 short, concrete, PHOTOGRAPHABLE things that belong to THIS client's real world, each taken from words or facts in the brief: the product itself, what it is made of or does, the place where it is made or used, the tools of the trade, the customer's moment, the result. A motif is always something a camera could film - never an abstract word, an app name or a brand (not "TikTok" but "a phone playing a vertical video"; not "AI" but "a laptop showing a video editing timeline"). Example for a coffee roaster: green coffee beans, a copper roasting drum, a steaming espresso cup, a burlap sack, a barista's hands pouring, morning light in a cafe window. Example for an app builder that turns typed descriptions into working apps: a laptop with a chat box typing a prompt, a phone showing a finished app, a monitor with colourful code, a founder's desk at night. EVERY keyframe and every headline must be built from these motifs and the client's own words. Anything that has nothing to do with what the client makes or does is FORBIDDEN: no invented subjects, no decoration, no random objects, no random people.`;

const MOVIE_FLOW = `${RELEVANCE}

KEYFRAME FILM. The picture of this ad is ONE continuous AI-made film. You are its director and you write SIX KEYFRAMES, one per scene. An image AI paints each keyframe from your text; then a video AI films the camera travelling from each keyframe INTO the next one, so the whole ad is a single unbroken shot. Nothing is cut, nothing is a slide.
(1) EVERY KEYFRAME IS ABOUT THIS COMPANY, built from your motifs: the product itself, the exact moment it is used, the tool of the trade, or the result it creates. For SOFTWARE, apps, websites and AI tools show real screens (a phone, a laptop or a monitor) whose screen glows with a colourful, bright interface made of blocks and shapes with no readable words, or the real-world result it produces - never a blank grey screen. NEVER show a physical box, package, gift, mug or parcel for a software company, and never print the company name on an object; if a brand name appears at all it is only on the top bar of a screen. For a company that sells physical goods, show the goods themselves. No text, letters, logos, code or numbers anywhere else (image AIs draw them as gibberish).
(2) SIX DIFFERENT SCENES, ONE FILM. Every keyframe is a different picture (a new shot type: extreme close-up of a detail, wide view of the place, low angle, over-the-shoulder view of a screen, high angle, calm final wide) but CONSECUTIVE keyframes share the same subject or the same place, so the video AI can film a believable camera move from one to the next: it cannot film a believable move between two unrelated pictures. Keyframe 1 is the hook: the most striking, beautifully lit picture of the client's product or of a screen showing it, bold colour, one clear subject, shot close and tight. Keyframe 6 is the END CARD background: a calm, clean shot of the product or its result with plenty of empty space and NO text. Bright, colourful, natural light by default (dark moody looks only for luxury, gothic, metal or security brands). Each keyframe prompt is 30-45 words: subject, place, light, camera angle. NO faces, no portraits, no close-ups of people; hands or a person seen from behind are allowed only as small parts of the picture, never the subject. Family-friendly.
(3) MOTION BETWEEN KEYFRAMES. "motion" of scene N is ONE sentence (max 26 words) describing what happens on screen while keyframe N turns into keyframe N+1: the camera move (dolly in, orbit, tilt, crane, pull back, push through the screen) and what physically happens (the screen fills with colour, the light shifts, a video starts playing). Concrete physical verbs only. The last scene's "motion" is a slow push in on the end card picture.`;

const MOVIE_KEYS = `Return ONE JSON object with these keys:
"brand", "motifs": EXACTLY 6 short strings (see RELEVANCE IS EVERYTHING - write these first), "tagline" (max 7 words), "look" (metal = heavy-metal / punk / gothic / dark-humour brands; luxury; tech; playful; clean), "accent" (ONE bold signature colour #RRGGBB - the brand's own if the brief names one; never grey), "bg" (near-black #RRGGBB), "imageStyle" (8-14 words: the ONE shared look of all six keyframes - light, colour palette, mood; never mention lenses, vignettes or camera gear), "cta" (button label, 2-4 words), "link" (website or @handle ONLY if it appears in the brief, else ""),
"scenes": EXACTLY 6 objects, each: "id", "tag" (a 1-3 word LABEL pill like "POV", "Real talk", "The proof" - a label, not the start of a sentence, never ending in "..."; "" for cta), "headline" (an ARRAY of 2-6 word strings, ONE WORD PER ELEMENT, using the client's own product words - a headline a stranger could not tie to THIS company is a failure, e.g. ["Your","*idea*","starts","|","to","glow"]; a lone "|" element is a line break; wrap the 1-2 key words in *asterisks*), "sub" (optional line, max 8 words, else ""), "sticker" ({"n":"number or word, max 7 chars","l":"label, max 3 words"} for solution/feature/proof only when the brief gives a real number or fact, else null), "imagePrompt" (the KEYFRAME, 30-45 words, see KEYFRAME FILM), "motion" (see KEYFRAME FILM), "pos" ("bm" bottom centre, "bl" bottom left, "br" bottom right, "tl" top left, "tm" top centre - never the middle; vary it), "tone" ("dark"),
"transitions": EXACTLY 5 objects, each just {"sfx": a whoosh id from SOUND}@@SND@@.
Output the JSON object only.`;

// ------------------------------------------------------------------ the check
const STOP = new Set('with that this from have your they will what when them then than into over also just make made more most such only very about would could their there which while where being been were does done each other some these those after before because under again against between through during without within like onto upon ours mine here shot view close bright light soft warm colour color scene camera angle wide frame sharp glowing'.split(' '));
const BANNED = ['car', 'cars', 'tesla', 'truck', 'vehicle', 'planet', 'galaxy', 'star', 'stars', 'moon', 'sun', 'microphone', 'globe', 'trophy', 'lightbulb', 'robot', 'unicorn', 'diamond', 'crown', 'mug', 'cup', 'box', 'boxes', 'package', 'packaging', 'parcel', 'gift', 'crate', 'apple', 'plant', 'plants', 'flower', 'flowers', 'coffee', 'tea', 'face', 'faces', 'portrait', 'man', 'woman', 'smiling', 'person', 'people'];
const flat = (t) => ' ' + String(t || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).join(' ') + ' ';
const stems = (t) => new Set(flat(t).split(' ').filter((w) => w.length >= 4 && !STOP.has(w)).map((w) => w.slice(0, 5)));

/** true when the prompt is about the client: no invented subject, and it shares vocabulary with the client's motifs. */
function grounded(prompt, briefText, motifs) {
  const p = flat(prompt), b = flat(briefText);
  if (p.trim() === '') return false;
  for (const w of BANNED) { if (p.includes(' ' + w + ' ') && !b.includes(' ' + w + ' ')) return false; }
  const ref = motifs.length ? stems(motifs.join(' ')) : stems(b);
  for (const s of stems(p)) { if (ref.has(s)) return true; }
  return false;
}

const SHOTS = ['extreme close-up, bold colour', 'wide view of the place, low angle', 'over-the-shoulder view of a screen', 'macro detail in soft focus', 'high angle looking down', 'calm wide shot with empty space'];
/** A keyframe prompt built only from the client's motifs (used when the AI's own prompt was not about the client). */
function motifPrompt(motifs, k, style) {
  const m = motifs[k % motifs.length], n = motifs[(k + 1) % motifs.length];
  return `${SHOTS[k % SHOTS.length]}: ${m}, with ${n} nearby, bright real-world setting, ${style}`;
}

/** The AI's photographic style, minus looks that damage every picture. */
function cleanStyle(style, fallback) {
  const BAD = /(lens|vignett|fisheye|fish-eye|porthole|circular|round|distort|blur|grain|noise|tilt|dutch|wide-angle|anamorphic|bokeh ball|dark|dim|moody)/i;
  const parts = String(style || '').split(/[,;]/).map((s) => s.trim()).filter((s) => s && !BAD.test(s));
  return parts.length >= 2 ? parts.join(', ') : fallback;
}

module.exports = { RELEVANCE, MOVIE_FLOW, MOVIE_KEYS, grounded, motifPrompt, cleanStyle, stems, flat };
