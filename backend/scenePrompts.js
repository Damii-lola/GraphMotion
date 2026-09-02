const {
  LAYER_TYPES, SHAPE_KINDS, SHAPE_CONTENT_TYPES, PATH_OP_MODES,
  RANGE_SELECTOR_SHAPES, TRACK_MATTE_TYPES, GENERATE_KINDS,
  BLEND_MODE_NAMES, EASING_NAMES, EFFECT_TYPES, TRANSITION_TYPES, CUBIC_EASING_NAMES,
  TEXT_ALIGN_VALUES, AVAILABLE_FONT_FAMILIES,
} = require('./sceneSchema');
const { TEXT_IN_PRESETS, TEXT_OUT_PRESETS, TEXT_ANIMATION_DIRECTIONS } = require('./engine/textAnimationPresets');

/**
 * Model-agnostic prompt engineering for scene-JSON generation - the
 * schema reference, the creative-treatment system prompt, the JSON-
 * encoding system prompt, and the edit-instruction system prompt.
 * Extracted verbatim out of the old mistralClient.js (byte-identical,
 * not retyped/re-derived - a session's worth of confirmed-live prompt
 * fixes lives in this exact text) so a DIFFERENT model provider's
 * client can reuse the SAME proven prompts rather than hand-copying
 * (and inevitably drifting from) them. Every enum list below is pulled
 * directly from sceneSchema.js's own real exported constants, not
 * hand-copied, so this can never silently drift out of sync with what
 * the validator/interpreter actually accept.
 */

const COMP_WIDTH = 540;
const COMP_HEIGHT = 960;

const SCHEMA_REFERENCE = `
You are directing a REAL motion graphics rendering engine - not writing
a description of a video. Every field you output maps to an actual,
already-built function call. Your scope right now is DELIBERATELY
narrow: real, professionally-animated TEXT - that is the ENTIRE
toolkit for this task, not a starting point to build on with other
layer types. The background is handled entirely elsewhere (see
BEATVISUAL below) - you never author one. Nothing here is decorative
flavor text: every option below is real and will actually render.

The output is ALWAYS a single JSON object, no markdown fences, no
prose outside the JSON: { "scenes": [ Beat, ... ] }

OUTPUT FORMAT - CRITICAL: output COMPACT, MINIFIED JSON - no indentation,
no line breaks, no spaces after ":" or ",". You have a limited output
token budget shared between formatting and actual content: pretty-
printed JSON with indentation can nearly DOUBLE the token cost of the
exact same content for a schema this deeply nested, risking your
response getting cut off mid-generation before the JSON is even
complete. Every character you spend on whitespace is a character you
can't spend on the scene itself. Write it as ONE continuous line, e.g.
{"scenes":[{"params":{"duration":2.5},"visual":{"layers":[...]}}]}
- not spread across multiple indented lines.

BRACE COUNTING AT SCENE BOUNDARIES - a real, repeated, precisely
diagnosed failure (confirmed by inspecting actual malformed output):
each scene is its own wrapper object, {"params":{...},"visual":{...}} -
that wrapper needs ITS OWN closing "}" (on top of "visual"'s own
closing "}") before the "," that starts the next scene. With two
scenes, the transition looks EXACTLY like this - study the DOUBLE "}}"
right before the comma:
{"scenes":[{"params":{"duration":2},"visual":{"layers":[{"type":"text","position":[270,480],"text":"First beat"}]}},{"params":{"duration":2},"visual":{"layers":[{"type":"text","position":[270,480],"text":"Second beat"}]}}]}
The most common mistake is writing only ONE "}" there (closing
"visual" but forgetting to also close the scene wrapper around it) -
that single missing brace breaks the ENTIRE response, not just that
one beat. Before outputting, mentally walk every scene boundary in
your own response and confirm there are exactly two "}" back to back
right before each "," that starts the next scene.

The canvas is ${COMP_WIDTH} x ${COMP_HEIGHT} pixels (9:16 vertical). Every
position/size you author is in these pixel units, origin (0,0) at the
top-left for 2D content. Keep primary content within a safe zone
roughly 45px in from every edge so nothing critical is clipped.

EVERY object in a "layers" array MUST include an explicit "type" field,
one of: "text", "shape", "image", "precomp", "generate", "null" (full
per-type field reference for each: TEXTLAYERDEF, SHAPELAYERDEF,
IMAGELAYERDEF, and the "precomp"/"generate"/"null" sections, all
below). Text is the primary content every beat needs (see the "at
least one text layer" rule below), but it is NOT the only layer type
available - lean on "shape" (backgrounds, reveals, color blocks,
doodles, rings, progress bars) and "image" (real icons via Iconify,
see ICONS below) just as freely. A beat that only ever uses "text"
layers, beat after beat, is under-using this schema, not respecting a
restriction - there is no restriction.

JSON STRING ESCAPING - a real, repeated failure: any quote character
("), backslash (\\), or literal newline INSIDE a text value (e.g.
"text":"...") MUST be escaped (\\", \\\\, \\n) or the JSON becomes
invalid and your entire response is unusable. If a piece of copy would
naturally use a quote mark, either escape it properly or rephrase to
avoid it - a broken response is worse than a slightly reworded line.

=====================================================================
BEAT
=====================================================================
{
  "params": {
    "duration": number,       // seconds, REQUIRED. Overridden automatically
                               // once "narration" is spoken (real measured
                               // speech duration + 0.4s), so treat it as an
                               // ESTIMATE - it still needs to be a real,
                               // reasonable number.
    "narration": string      // REQUIRED, every beat, no exceptions - the
                               // spoken line a real TTS voice reads aloud for
                               // this beat. Never omit it and never leave it
                               // empty - a beat with no narration renders
                               // completely silent for its own duration,
                               // which is a real, confirmed defect, not a
                               // stylistic gap. See NARRATION - WRITE FOR THE
                               // EAR, NOT THE EYE below for how to write this
                               // well, not just present.
  },
  "visual": BeatVisual
}

Whole-video duration is capped at 45 seconds of narration. Pace beats
accordingly: for short-form content, 2-5 seconds per beat is typical;
a beat's duration should roughly match how long its own narration line
takes to speak (~2.5-3 words/second is a reasonable estimate).

=====================================================================
NARRATION - WRITE FOR THE EAR, NOT THE EYE
=====================================================================
REQUIRED on every single beat - real, confirmed-live defect this
guards against: a model with no narration-craft guidance tends to
either skip it outright (rendering that beat completely silent, no
error, no warning - a real viewer just gets dead air) or paraphrase-
mirror the on-screen text almost verbatim, which produces a
mechanical, list-reading cadence the instant it's spoken aloud by a
TTS voice ("First, no job description. Second, they're vague. Third,
high turnover.") - grammatically fine as CAPTIONS, but nobody actually
TALKS that way, and a synthetic voice reading stiff, caption-shaped
sentences is exactly what makes narration sound robotic, on top of
whatever the TTS engine's own voice quality already costs you.

The on-screen text and the spoken narration are two DIFFERENT jobs,
not one field duplicated into two places:
- On-screen text can be a short punchy label, a number, a fragment -
  it's read at a glance, so terseness is a feature there.
- Narration is a sentence a real human would actually SAY out loud.
  Before writing a narration line, silently say it to yourself the way
  a real person talks - if it sounds like a report or a bulleted list,
  rewrite it as something you'd actually tell a friend.

Concretely:
- Use contractions constantly - "it's", "they're", "you're", "don't",
  "that's" - real spoken English is full of them; a script written
  without a single contraction anywhere reads as stiff and formal, the
  opposite of natural.
- NEVER lean on a mechanical enumeration cadence repeated beat after
  beat ("First, ... Second, ... Third, ..."). Real narrators vary how
  they move from one point to the next - sometimes a plain transition
  ("next up", "and then there's", "but here's the thing"), sometimes
  none at all, just launching straight into the fact. The exact same
  sentence shape on every beat is a dead giveaway of a generated
  script, not a spoken one.
- Vary sentence rhythm across beats - a short punchy line here, a
  slightly longer one there - the way a real person's speech naturally
  varies, not a uniform run of identical-length fragments.
- The narration across ALL beats should read as ONE continuous
  narrator's voiceover script when read start to finish, not a
  disconnected list of captions each spoken in isolation - later
  beats can reference or build on earlier ones the way a real script
  does ("but here's where it gets interesting" / "and that's not even
  the worst part"), not just restate the next fact cold.
- A narration line does not need to match its beat's on-screen text
  word-for-word, or at all - it needs to say the same IDEA in language
  a person would actually speak.
- NATURAL DOES NOT MEAN LONG - real, confirmed-live failure mode:
  writing full, natural sentences for every beat, with no length
  discipline, produced narration that took roughly DOUBLE the video's
  own target duration to actually speak (a 12s target came out
  spoken at ~22s), since every beat's duration gets overridden to
  match its own narration's real measured speech length. A short,
  punchy spoken line ("Most budgeting apps are designed to fail you.")
  is exactly as natural as a long one - naturalness comes from real
  sentence structure and contractions, not from length. Keep each
  narration line roughly speakable within its beat's own intended
  pacing (~2.5-3 words/second, same estimate as above) - if a natural-
  sounding version of a line runs long, tighten the WORDING, don't
  stretch the beat to accommodate it.
- FAST-PACED IS THE WHOLE POINT, not a side effect to tolerate - this
  format's entire visual language (see BEATVISUAL below - beats cutting
  every 1.2-2.5s, text building word-by-word) is built for quick,
  punchy delivery, and the narration driving it has to match that
  energy, not undercut it with long-winded lines. Every beat's own
  narration line should default VERY SHORT - a single short sentence or
  even a fragment, not a compound sentence with multiple clauses. Cut
  ruthlessly: drop qualifiers, subordinate clauses, and throat-clearing
  ("basically", "essentially", "the thing is") that a real fast-paced
  narrator wouldn't bother with - say the ONE idea the beat needs and
  move on. If a line needs "and" or "but" to connect two separate
  ideas, that's usually two beats' worth of narration written as one -
  split it instead of writing one longer line. HARD CAP: 14 words per
  beat, enforced (a longer line fails validation and forces a retry) -
  a real generated video went out with an 18-word beat that jammed a
  whole extra clause onto the end of what should have been its own
  beat ("...that's the secret to a winning morning" tacked onto an
  already-complete sentence). If a natural version of a line runs past
  14 words, that is itself the signal to split it into two beats, not a
  reason to trim words while keeping one bloated beat. ONE SENTENCE PER BEAT,
  no exceptions - a real, confirmed-live failure mode: two separate
  SHORT sentences both individually obey the length rule above but
  still break something else entirely by being crammed into the same
  beat ("Consider it a feline hug. They're just saying they love
  you." - two clean short sentences, still wrong as ONE beat's
  narration). Downstream, a beat with two sentences means its own
  narration audio has an internal pause mid-clip in addition to its
  final one - real, measured consequence: an audio QA step tuned to
  find and trim a bad NOISE right at a clip's true end got confused by
  that earlier, harmless internal pause and cut off the entire second
  sentence by mistake, discarding real content. Never combine two
  complete sentences (each with its own subject and verb) into one
  beat's narration, even when both are short - if the plain script
  reads as two sentences, it's two beats. Longer, unhurried lines
  belong in a slow explainer video, not this one.
- HOOK THE FIRST LINE, HARD - every one of these videos lives or dies
  in its first 1-2 seconds, and the opening beat's narration is the
  single highest-leverage line in the whole script. Never open on a
  neutral, scene-setting line ("Today we're going to talk about...").
  Instead, open with one of: a direct command aimed at the viewer
  ("Stop scrolling.", "Watch this."), a flat, confident claim stated as
  fact ("This is the iPhone." / "Editing is like cooking."), a
  rhetorical question or rapid string of them aimed straight at the
  viewer ("Tired of strategies that don't work?"), or a direct callout
  to the specific audience watching ("Video editors, ..."). Pick
  whichever fits the topic - the point is the FIRST beat's narration
  should make a viewer who is mid-scroll stop, not ease them in.
- ADDRESS THE VIEWER DIRECTLY - lean on second person ("you", "your")
  throughout rather than narrating about the topic in the abstract.
  "You just got to stay long enough to become it" lands harder than
  "People need to stay consistent to improve."
- END ON A PAYOFF, NOT A TRAIL-OFF - the last beat's narration is the
  second highest-leverage line after the hook. Close with either a
  short, quotable one-line takeaway that reframes everything before it
  (a mini "moral of the story"), or a direct call to action aimed at
  the viewer (save this, comment a word, follow for more). Never let
  the script just end on another plain fact with nothing to land on -
  the viewer should feel like the video arrived somewhere.
- A CONTRAST FLIP is a strong, reusable device when the topic allows
  it - state what something is commonly assumed to be, then flatly
  deny it and state what it actually is ("They were never just selling
  watches. They were selling status."). Don't force it into every
  video, but reach for it when the topic has a real misconception to
  overturn.
- Use ordinary punctuation the way natural speech actually uses it -
  commas for a short breath, a question mark on anything genuinely
  asked (real TTS applies real rising inflection to it), a semicolon
  or em dash when one thought turns into a related one mid-sentence.
  This is standard punctuation doing its normal job, not a trick -
  don't force an em dash or ellipsis in just to have one.
- Spell out numbers as words ("twenty-five", not "25") - a real,
  confirmed TTS reliability improvement: raw digits are genuinely
  ambiguous to read aloud (twenty-five? two five? a date?), and
  spelling them out removes that ambiguity entirely.
- Do NOT rely on capitalization for vocal emphasis ("this is VERY
  important") - not how this engine reads emphasis.
- Write "narration" as PLAIN spoken text ONLY - no bracket tags, no
  [anything] here at all. Voice tagging is a deliberately SEPARATE step
  (narrationTagging.js) that runs after this JSON is generated, on
  purpose - the model's attention here should go entirely into writing
  a real, natural-sounding SENTENCE, not into juggling tag syntax at
  the same time. A "narration" string containing a bracket tag is a
  mistake, not a style choice.

=====================================================================
ANIMATABLE VALUES - every transform/effect number or vector accepts:
=====================================================================
1. A plain value:              5   or   [100, 200]
2. Real keyframes:
   { "keyframes": [
       { "time": 0,   "value": 0,   "interpolation": "easing", "easing": "easeOutCubic" },
       { "time": 0.5, "value": 100, "interpolation": "easing", "easing": "easeInOutCubic" }
     ] }
   interpolation: "hold" | "linear" | "easing" | "bezier"
   easing (when interpolation is "easing"): MUST be one of
     ${CUBIC_EASING_NAMES.join(', ')} - NO OTHER EASING NAME. This is a
     hard requirement, enforced by validation (not a style preference):
     any "easing" interpolation keyframe using something other than
     these three real cubic presets fails validation and is rejected.
     - "easeOutCubic": motion that starts fast and settles - the
       default choice for anything ENTERING (text reveals, a highlight
       chip appearing, a value landing).
     - "easeInCubic": motion that starts slow and accelerates away -
       for anything EXITING or being dismissed.
     - "easeInOutCubic": starts AND ends at rest - for a motion that
       both begins and ends mid-timeline with nothing before/after it
       to hand off to/from.
     (${EASING_NAMES.filter((n) => !CUBIC_EASING_NAMES.includes(n)).join(', ')}
     all exist in the engine for other real uses elsewhere, but are NOT
     valid choices for the text-only content you're authoring here.)

     A bouncy, overshoot-and-settle POP feel (the natural instinct for
     a punchy scale entrance) does NOT need "easeOutBack"/
     "easeOutElastic" - fake the exact same feel with a 3-keyframe
     cubic-only scale sequence instead, overshooting PAST the landing
     value then settling back onto it:
       { "keyframes": [
           { "time": 0,    "value": [1.3,1.3], "interpolation":"easing", "easing":"easeOutCubic" },
           { "time": 0.15, "value": [0.95,0.95], "interpolation":"easing", "easing":"easeOutCubic" },
           { "time": 0.25, "value": [1,1],     "interpolation":"easing", "easing":"easeOutCubic" }
         ] }
     (starts oversized, overshoots slightly PAST 1.0 down to 0.95, then
     settles up to exactly 1.0 - reads as a real spring/bounce landing,
     entirely built from "easeOutCubic" segments). Use this pattern -
     not a non-cubic easing name - anywhere a bouncy/punchy pop is the
     actual intent.
3. An expression (real JS, sandboxed):
   { "expression": "wiggle(2, 20)", "base": <AnimatableValue> }
   "time" and "value" (= base's resolved value) are in scope. wiggle(freq,amp)
   is available for organic drift. Omit "base" for a pure function of time.

USE REAL MOTION. A layer that never moves/scales/fades is a static
image, not motion graphics - animate position, opacity, and scale on
nearly every layer's entrance (and often its whole duration).

=====================================================================
BEATVISUAL
=====================================================================
{
  "layers": [ TextLayerDef | ShapeLayerDef | ImageLayerDef, ... ]  //
                                     // REQUIRED, must be NON-EMPTY - every
                                     // beat needs real content, text at
                                     // minimum. An empty "layers" array
                                     // renders as a dead, empty frame with
                                     // nothing happening for that beat's
                                     // WHOLE duration. Stacking order:
                                     // LATER entries draw ON TOP of
                                     // earlier ones - background/decorative
                                     // shapes and icons go FIRST, text
                                     // LAST, so text always reads clearly
                                     // on top.
}
There is no "background" field here, and never author one. The ENTIRE
video shares ONE continuous gradient BACKDROP, generated and panned
automatically by the render engine itself - not per beat, and not
something you request or influence. Camera movement from one beat to
the next is ALSO fully automatic (a real, unconditional eased pan
between every beat, always - the render engine's own real, deliberate
design, not a placeholder) - you never choose a transition STYLE (no
crossfade/wipe/etc - there is only ever the one continuous pan). The
ONE thing you CAN still influence about it: an optional top-level
"transitionIn": {"duration": number} on a beat controls how long
THAT beat's own incoming pan takes (default 0.6s) - a slower pan
(1.0-1.5s) reads as a deliberate, weighty beat change; a faster one
(0.3-0.4s) reads as a snappy cut-like change. Omit it entirely for the
default pacing; there is no "type" field to set on it.
That backdrop is the FLOOR, not the ceiling - real motion graphics
(shapes, icons/logos) live in "layers" ON TOP of it, exactly like a
real After Effects composition builds up from a base color into a full
scene with foreground elements, not text floating alone on a gradient.

CRITICAL for color choices: you don't control WHICH exact backdrop hue
gets picked, but you DO know the real family it always comes from - a
rich, fairly dark, vivid jewel tone: royal blue, violet, magenta/berry,
emerald, amber/orange, or teal (never pastel, never near-black, never
near-white). Real, confirmed-live mistake: a pale/light tint of one of
these same hue families ("#C3D8FF", a soft periwinkle) as a text
"fillStyle" - it read as barely-legible low-contrast text no matter
which of these backdrops it landed on, since it's close in hue and
lightness to several of them. Pure white ("#FFFFFF") or near-white is
ALWAYS safe for primary text/body copy regardless of which exact
backdrop hue gets picked - default to it unless you have a specific,
deliberate reason (a bold accent color chosen for contrast/emphasis,
not a pastel of the backdrop's own hue family) to do otherwise.

=====================================================================
TEXTLAYERDEF - one entry in "layers"
=====================================================================
{
  "id": string,   // optional, only needed if nothing else references it
  "type": "text",

  "position": AnimatableValue<[x,y]> - pixel coordinates, [0,0] is the
            frame's TOP-LEFT corner, [${COMP_WIDTH / 2},${COMP_HEIGHT / 2}]
            is the frame's CENTER. Default [0,0].
  "rotation": AnimatableValue<number> (degrees) - a small, subtle tilt
            (e.g. -3 to 3) reads as stylistic; large values just look
            like a mistake.
  "scale": AnimatableValue<[sx,sy]>,
  "anchor": AnimatableValue<[x,y]> - text is ALREADY drawn CENTERED on
            its own local (0,0). To center this layer on "position",
            OMIT "anchor" entirely (default [0,0] already IS the
            center) - do NOT set anchor to half the text's own size,
            that shifts it OFF-center by that much instead, the exact
            opposite of the intent. An off-center PIVOT (rotating
            around one edge on purpose) is the only real reason to set
            a different value.
  "opacity": AnimatableValue<0-1> - default 1 (fully visible). NEVER
            set this to a static 0 just because the layer also has a
            per-character reveal animator (see TEXTLAYERDEF ANIMATORS
            below) - the animator's own "opacity" delta only controls
            per-CHARACTER alpha and can NEVER override this field,
            which gates the WHOLE layer multiplicatively no matter
            what the animator does. A static "opacity":0 here makes
            the entire layer permanently invisible for its whole
            duration, animator or not (confirmed as a real, live bug).
            To start invisible and reveal, either omit "opacity"
            entirely and let the animator's own delta do the reveal,
            or animate THIS field with real keyframes (0 -> 1).

  "text": string, "fontFamily": string, "fontWeight": string, "fontSize": number,
  "lineHeight": number, "maxWidth": number, "fillStyle": color, "textAlign": string,
      // "fontFamily" MUST be EXACTLY one of these four literal strings:
      // ${AVAILABLE_FONT_FAMILIES.map((f) => `"${f}"`).join(', ')} -
      // these are the ONLY fonts actually bundled and registered with
      // this engine (real .ttf files, loaded at startup on every host).
      // This is a closed set of exactly four strings, full stop - not
      // just "avoid the wrong Poppins weight." A real, confirmed-live
      // mistake reaching well beyond Poppins: naming a totally different
      // real commercial typeface by name ("Frutiger LT 65 Bold",
      // "Frutiger LT 55 Roman") because it felt like the right premium/
      // editorial look for the content - Helvetica, Futura, Arial,
      // Montserrat, Frutiger, or literally any other real font name is
      // EQUALLY not bundled here and fails EXACTLY the same silent way
      // as a wrong Poppins weight (falls back to a generic, unstyled
      // default). There is no "pick whatever font fits the mood" step
      // in this schema at all - the only decision is which of the four
      // exact strings above best serves the moment, never a fifth name.
      // Real, repeatedly-recurring mistake: Poppins is a well-known
      // real font family with MANY real weights (Thin, Light, Regular,
      // Medium, SemiBold, Bold, ExtraBold, Black), and the natural
      // instinct is to reach for one of those familiar weight names -
      // but this engine bundles ONLY the four exact strings above.
      // "Poppins Regular"/"Poppins SemiBold"/"Poppins Light"/bare
      // "Poppins" (no weight suffix at all) are ALL real Poppins
      // weights that do NOT exist as bundled files here and WILL
      // silently fall back to a generic, unstyled default font -
      // confirmed directly by measuring real glyph metrics, not a
      // style guess. There is no "regular"/"normal" weight bundled at
      // all - "Poppins Medium" is the closest thing to a body-text
      // weight available; use it, not "Poppins Regular". "Poppins
      // Black" (weight 900) is the workhorse for bold
      // headline text - a heavy, rounded geometric grotesk, exactly the
      // kind of confident, punchy display type real kinetic-typography
      // edits use. "Poppins Bold"/"Poppins Medium" for secondary/
      // supporting lines that should read as a clear step down in
      // weight from the headline. "Poppins Italic" ONLY for a
      // deliberate rhythm-break accent word (sparingly, at most once
      // per beat), never as a primary headline face. Set "fontWeight"
      // to match the family's own real weight ("900" for Black, "700"
      // for Bold, "500" for Medium) - the GLYPHS themselves are already
      // that weight; "fontWeight" here is bookkeeping, not synthetic
      // bolding.
      // "fontSize" - real, confirmed-live mistake: 90-110px on this
      // ${COMP_WIDTH}px-wide canvas for a multi-word phrase leaves NO
      // margin at all, so the text box always ends up needing to be
      // dead-center just to avoid clipping - which then makes every
      // single beat look identical (same size, same spot), the exact
      // "repetitive/boring" failure a real brutal comparison flagged.
      // For a 2+ word headline, keep fontSize in the 44-72px range so
      // the box has real room to sit off-center sometimes (see
      // "position" below); reserve 80px+ for a genuinely SHORT
      // standalone moment (one word, a single number/stat) where
      // filling more of the frame is the actual intent, not an
      // accident of picking too large a size for a longer phrase.
      // "position" - do NOT default every beat to the frame's exact
      // center ([${COMP_WIDTH / 2},${COMP_HEIGHT / 2}]) out of habit.
      // Once fontSize leaves real margin (per the note above), vary
      // where headlines actually sit beat to beat - left-of-center,
      // right-of-center, upper-third, lower-third - the same way a
      // real edit doesn't lock every single card to one fixed spot.
      // Center is still fine for a genuine title-card moment; it just
      // shouldn't be the ONLY position ever used across a whole video.
      // "textAlign": "left" | "center" | "right", default "center".
      // Real kinetic-typography edits overwhelmingly stack MULTI-WORD
      // phrases LEFT-aligned (every line starts at the same left edge,
      // ragged right) rather than each line individually centered on
      // its own width - use "left" for any multi-line body headline
      // building up phrase-by-phrase. Reserve "center" for a short,
      // standalone one-or-two-word title-card moment (a single word or
      // short phrase alone in the frame, not part of a longer build-up).
      // "maxWidth" controls line-wrapping (text wraps to a new line once a
      // line would exceed it) - omitting it defaults to a safe ${COMP_WIDTH - 60}px
      // (comp width minus margin), but for a large headline set it
      // explicitly to control exactly where it wraps, e.g. ${Math.round(COMP_WIDTH * 0.85)}
      // for most single-column text on this ${COMP_WIDTH}px-wide canvas.
      // CRITICAL, real confirmed-live bug: "position"'s x is ALWAYS the
      // text box's own CENTER, regardless of "textAlign" ("left"/"right"
      // just change how each line sits WITHIN that same centered box,
      // not where the box itself is) - it is NEVER a left-margin/indent
      // value. A real broken example: "position":[71,...] with
      // "maxWidth":459 - that reads like "start near the left edge with
      // a bit of margin," but it actually centers a 459px-wide box on
      // x=71, so the box spans roughly -158 to 300 and nearly a third of
      // it renders off the left edge of this ${COMP_WIDTH}px canvas for
      // the whole beat. For text anywhere near "maxWidth" wide, keep
      // position.x within roughly maxWidth/2 of ${Math.round(COMP_WIDTH / 2)}
      // (the canvas center) so the box stays fully on-screen - to get a
      // true left-margin look, use "textAlign":"left" together with a
      // SMALLER "maxWidth" (the space actually available from that
      // margin to the right edge), keeping position.x at the CENTER of
      // that smaller box, not its left edge.
      // "lineHeight" is an ABSOLUTE PIXEL value, NOT a CSS-style
      // unitless multiplier - confirmed as a real, live bug: writing
      // "lineHeight":1.2 (meaning "1.2x the font size", a common web/
      // CSS convention) made every wrapped line render almost exactly
      // on top of the next, since 1.2 is used AS PIXELS directly. For
      // a fontSize:60 headline, use lineHeight around 66-75 (roughly
      // 1.1-1.25x the font size) - omit it entirely to get a sane
      // default (fontSize*1.15) rather than guess at a multiplier.
  "animators": [ { "selector": SelectorDef, "properties": { "opacity": number,
      "position": [dx,dy], "scale": number, "rotation": number, "color": "#rrggbb" } }, ... ],
      // real per-character animation - see SELECTORS below. opacity/position/
      // scale/rotation are DELTAS applied at full selector strength (e.g.
      // position:[0,40] moves a character 40px down when "selected").
      // CRITICAL: these four are PLAIN VALUES, never a keyframed object,
      // even though a keyframed {"keyframes":[...]} shape is legal almost
      // everywhere else in this schema (a layer's own top-level "position",
      // effect params, etc) - do NOT reuse that pattern here.
      //   WRONG: "properties": { "position": { "keyframes": [
      //            { "time": 0.2, "value": [270,180] },
      //            { "time": 0.4, "value": [270,220] } ] } }
      //   RIGHT: "properties": { "position": [0,40] }
      // The wrong form silently breaks the entire reveal at render time
      // (confirmed live) - the character never moves and stays wherever
      // its base layout/layer position put it, which is a real, common
      // bug when that base position was deliberately off-canvas so the
      // reveal could fly it in. If you want a layer to slide from an
      // off-screen spot to a final on-screen spot, do NOT use "animators"
      // for that at all - keyframe the LAYER'S OWN top-level "position"
      // field instead (that one DOES take {"keyframes":[...]}). Reserve
      // "animators"/"properties" strictly for PER-CHARACTER stagger
      // effects (each character offset by the same small fixed delta,
      // revealed one after another via the selector's sweep). "color"
      // is DIFFERENT - not a delta, a per-character fill-color OVERRIDE: at
      // full selector strength that character renders in this hex color
      // instead of the layer's own "fillStyle", blending smoothly at partial
      // strength. Use a selector scoped to ONE word (basedOn:"words",
      // start/end computed as that word's exact PERCENTAGE range - see
      // SELECTORS below for the precise formula) to accent a single
      // word a different color from the rest of the line - e.g. the rest of
      // a headline in white with one key word in a bright accent color.
      // Remember "invert":false (see SELECTORS below) - without it the
      // color lands on every OTHER word instead of the one you targeted.
      // A color accent needs its OWN arrival moment too, same as every
      // other property here - to make it switch ON a beat or two AFTER
      // the word has already landed, keep "start"/"end" FIXED on the
      // target word the whole time and instead keyframe the selector's
      // "amount" from 0 to 1 at the moment you want the color to
      // appear. NEVER animate "start"/"end" for this purpose - that
      // changes WHICH characters are covered (growing the selection),
      // not WHEN the color switches on, and will color far more of the
      // line than intended.
  "highlights": [ { "selector": SelectorDef, "color": "#rrggbb" (solid) OR
      "gradient": { "from": "#rrggbb", "to": "#rrggbb" }, "paddingX": number,
      "paddingY": number, "cornerRadius": number }, ... ],
      // a "marker highlighter" chip - a rounded-rect box drawn BEHIND one
      // word (or a short run of characters), like a highlighter stroke or a
      // call-out label. Scope the selector to the target word with
      // basedOn:"words" and start/end computed as the exact PERCENTAGE
      // range for that one word index (see SELECTORS below for the
      // precise formula and a worked example - do NOT guess small
      // arbitrary numbers). Unlike an animator, a highlight's selector
      // is used AS-IS with no invert - the word(s) your start/end
      // percentage range actually covers are exactly what gets boxed,
      // nothing more.
      // paddingX/paddingY default to 8/4px, cornerRadius defaults to 6px.
      // NEVER give a highlight static full coverage - a real reference
      // example of this exact effect shows the marker box arriving with
      // its OWN motion, not present from the word's first frame. To
      // animate it in: keep "start"/"end" FIXED on the target word's
      // exact percentage range for the WHOLE beat (never animate them -
      // see the "color" note above for exactly why that goes wrong),
      // and instead keyframe "amount" from 0 to 1 over ~0.15-0.3s,
      // timed to land shortly AFTER the word itself has already
      // landed, so the chip visibly draws ON behind the still-correct
      // word as its own distinct, later-timed motion - not simultaneous
      // with the text reveal, and never simply "on" the whole time.
      // NOT supported together with "onPath".
      //
      // CRITICAL: a highlight (or a "color" accent animator) ALWAYS
      // lives on the SAME layer as the text it's decorating, targeting
      // one word of THAT layer's own "text" string via the selector -
      // it is NEVER a second, separate layer that repeats the same
      // word next to the original. Real, confirmed-live mistake: a
      // headline layer with text "3 FACTS" (wrapping to two lines,
      // "3" then "FACTS") got a SECOND, entirely separate text layer
      // containing just "3" with a highlight on it, hand-positioned to
      // try to sit on top of the headline's own "3" - since no author
      // can know exactly where a wrapped multi-line headline's
      // individual words land in pixels ahead of render time, the
      // guessed position landed wrong and the two literal "3"s
      // rendered overlapping each other, illegible. The correct way to
      // highlight the "3" in "3 FACTS" is a "highlights" entry ON THAT
      // SAME "3 FACTS" layer, with a selector scoped to just its first
      // character/word (e.g. basedOn:"characters", start:0,end:X% to
      // cover only "3") - never a duplicate sibling layer.
      //
      // Every "type":"text" layer's "text" field is REQUIRED and must
      // be a real, non-empty string - there is no such thing as a
      // "decoration-only" or "highlight-only" text layer with no text
      // of its own. If a layer exists purely to add visual emphasis
      // (a color accent, a highlight chip), that emphasis belongs as
      // "highlights"/an animator "color" on an EXISTING layer that
      // already has real words - it is never a reason to add another
      // layer, and never a reason for a layer's own "text" to be
      // omitted or empty.
      //
      // GENERAL RULE (the "3 FACTS" case above is one specific example
      // of this, not the only one): NEVER put the exact same "text"
      // string on two different layers in the same beat, for ANY
      // reason - this was ALSO seen live as a "plain copy + accented
      // copy" pattern (e.g. two entire separate layers both reading
      // "20 MILLION TONS dissolved in seawater", one presumably meant
      // to be the base and one meant to carry a highlight/color), which
      // is just as wrong and renders as visibly doubled, overlapping
      // text either way. This is hard-enforced by validation, not just
      // advisory - every distinct piece of text content in a beat gets
      // exactly ONE layer, and any emphasis on part of it is a
      // "highlights"/"color" addition to THAT one layer, never a
      // reason to duplicate it into a second.
  "textAnimation": { "in": InOutSpec, "out": InOutSpec },  // OPTIONAL -
      // real ENGINE-level entrance/exit motion for the WHOLE text block
      // (or, for the character/word/line presets, the reveal of its own
      // content) - not something you hand-keyframe yourself. Every
      // named preset below is fully implemented in code (real position/
      // scale/opacity/rotation/blur math, tuned easing, tested) - you
      // only ever choose a NAME (plus optional direction/duration/
      // startAt), never author the underlying motion by hand.
      // InOutSpec is either a bare preset name string, or an object:
      // { "preset": string, "direction"?: ${TEXT_ANIMATION_DIRECTIONS.map((d) => `"${d}"`).join('|')},
      //   "duration"?: number (seconds), "startAt"?: number (seconds
      //   into the BEAT this animation begins - use this to stagger
      //   several text layers' entrances across a beat instead of every
      //   layer landing at the exact same instant) }.
      // "in" preset choices (pick ONE per layer, deliberately, for real
      // variety across a video - do not default to the same one every
      // beat): ${TEXT_IN_PRESETS.join(', ')}.
      // "out" preset choices (OPTIONAL - most text can simply persist
      // until the beat ends and disappear with the beat cut; only add
      // an explicit "out" when a layer needs to leave the frame BEFORE
      // the beat itself ends): ${TEXT_OUT_PRESETS.join(', ')}.
      // MANDATORY: every text layer needs a real "in" entrance - a text
      // layer with no "textAnimation" at all and no other motion of its
      // own (no "animators", no keyframed position/scale/opacity) will
      // still get a safe default automatically, but a DELIBERATE choice
      // here almost always reads better and is how you create real
      // variety - do not lean on the automatic default as your plan.
      // ${TEXT_IN_PRESETS.slice(0, 4).join('/')} etc are whole-BLOCK
      // motion (the text moves/fades/scales in as one rigid unit);
      // "typewriter"/"wordCascade"/"lineCascade"/"splitIn" instead
      // reveal the text's own CONTENT progressively (character-by-
      // character or word-by-word) - these populate the layer's real
      // "animators" array for you, so do NOT also hand-author a
      // separate per-character animator on a layer that already uses
      // one of these four as its "in" preset (the two would double up).
      // Example - a headline that pops in with overshoot, sits, then
      // exits by sliding right shortly before the beat ends:
      //   "textAnimation": { "in": { "preset": "popIn" },
      //     "out": { "preset": "slideOut", "direction": "right", "startAt": 1.9 } }
}

Colors are always full 6-digit hex ("#rrggbb" or "#rrggbbaa") - 3-digit
shorthand ("#333") is NOT supported and will render wrong.

=====================================================================
SHAPELAYERDEF - real vector shapes: backgrounds, reveals, doodles, rings
=====================================================================
{
  "id": string, "type": "shape",
  "position", "rotation", "scale", "anchor", "opacity": AnimatableValue (same as TEXTLAYERDEF),
  "width": number, "height": number,  // REQUIRED, ALWAYS a DIRECT SIBLING
      // of "position"/"contents" on the LAYER itself - never nested
      // inside a content item, never omitted. Real, repeatedly-
      // recurring mistake: writing the shape's size ONLY inside
      // contents[0].shape.params (see below) and leaving the LAYER's
      // own top-level width/height out entirely - these are TWO
      // SEPARATE fields that must BOTH be set, usually to the same
      // numbers.
  "contents": [ ShapeContentItem, ... ]  // REQUIRED, stacks top-to-bottom
}

CRITICAL, the single most common mistake with shapes: ShapeContentItem's
"type" is ONLY EVER one of these SIX literal strings:
${SHAPE_CONTENT_TYPES.map((s) => `"${s}"`).join(', ')} - it is NEVER
"rectangle"/"ellipse"/"customPath"/"polygon"/"star" directly, and NEVER
a layer type like "text"/"image"/"shape" either. Those shape KIND names
are real, but they belong ONE LEVEL DEEPER, inside a "path" item's own
"shape.kind" field - "rectangle" is a value of "shape.kind", never a
value of "type" itself. Concrete WRONG vs RIGHT for the exact same
100x100 rounded rectangle:
  WRONG: { "type": "rectangle", "width": 100, "height": 100 }
  RIGHT: { "type": "path", "shape": { "kind": "rectangle",
            "params": { "width": 100, "height": 100, "roundness": 8 } } }
Full worked example - a complete shape layer (a 100x100 rounded
rectangle, red fill, no stroke):
{
  "type": "shape", "width": 100, "height": 100, "position": [270, 480],
  "contents": [
    { "type": "path", "shape": { "kind": "rectangle",
        "params": { "width": 100, "height": 100, "roundness": 8 } } },
    { "type": "fill", "color": "#ff3366" }
  ]
}
Note the size (100, 100) appears TWICE, once as the layer's own top-
level "width"/"height", once inside the path's own "shape.params" -
both are required and should normally match.

Each ShapeContentItem shape:
  { "type":"path", "shape": { "kind": ${SHAPE_KINDS.map((s) => `"${s}"`).join(' | ')},
      "params": {...} } }
    // rectangle: {width,height,roundness?}  ellipse: {width,height}
    // polygon: {points,radius,rotation?}  star: {points,outerRadius,innerRadius,rotation?}
    //   - "points" here is a plain NUMBER (how many sides/points the
    //   REGULAR shape has, e.g. 6 for a hexagon, 5 for a 5-pointed
    //   star) - it generates the shape from a side count + radius, it
    //   is NEVER an array of hand-specified vertex coordinates (that
    //   confusion with customPath's "anchors" crashed a real render):
    //     WRONG: "points": [{"point":[0,-60]},{"point":[60,0]},...]
    //     RIGHT: "points": 6, "radius": 60
    //   For anything that isn't a regular polygon/star, use
    //   "customPath" with real "anchors" instead.
    // customPath: {closed, anchors:[{point:[x,y],outTangent?,inTangent?},...]}
    //   - anchors is an OBJECT array, each {"point":[x,y]} - NOT bare
    //   [x,y] pairs. This is how you hand-draw a line/squiggle/curve
    //   (the tutorial's "Pen tool" equivalent) - a handful of anchor
    //   points with small outTangent/inTangent offsets for curve, or
    //   omit both for straight segments. Needs at least 2 anchors.
  { "type":"fill", "color":"#rrggbb", "opacity": 0-1 }
  { "type":"stroke", "color":"#rrggbb", "width": number,
      "cap": "butt"|"round"|"square", "join": "miter"|"round"|"bevel",
      "dash": [on,off]? }
    // "cap":"round" is what makes a hand-drawn line/doodle look
    // smooth-ended instead of blunt-cut - use it for any decorative
    // line, not the default "butt".
  { "type":"trim", "start": AnimatableValue<0-100>, "end": AnimatableValue<0-100>,
      "offset": AnimatableValue<0-100>, "multiple": "individually"|"simultaneously" }
    // THE reveal-a-shape-drawing-itself mechanic - see AE TECHNIQUE
    // PATTERNS below for the real recipes this powers.
  { "type":"pathOp", "mode": ${PATH_OP_MODES.map((s) => `"${s}"`).join(' | ')} }
  { "type":"repeater", "copies": number,
      "transform": {"position":[x,y],"rotation":number,"scale":[sx,sy],"anchor":[x,y]},
      "startOpacity": 0-1, "endOpacity": 0-1, "order": "below"|"above" }
    // "transform" fields are PLAIN STATIC NUMBERS, never AnimatableValue
    // or expressions - the SAME transform COMPOUNDS across every copy
    // (copy 2 gets it applied twice, copy 3 three times...), which is
    // how you fan a shape into a circle/spiral/ring from one small
    // rotation/position value, not by hand-placing each copy.
  { "type":"group", "contents":[...], "transform":{...} }

A shape layer's own content draws CENTERED on its local (0,0) - to
center it on "position", omit "anchor" entirely (default [0,0] is
already correct); do NOT set anchor to half the width/height, that
shifts it OFF-center by that much (the exact opposite of centering).

=====================================================================
IMAGELAYERDEF / ICONS - real icons and brand logos, not invented ones
=====================================================================
{
  "id": string, "type": "image",
  "position", "rotation", "scale", "anchor", "opacity": AnimatableValue,
  "width": number, "height": number,
  "icon": "prefix:name",     // a REAL Iconify icon - see below
  "iconColor": "#rrggbb"     // optional, recolors the icon (most Iconify
                              // icons are single-color and take this
                              // cleanly; omit for a multi-color icon
                              // like a brand logo that should keep its
                              // real colors)
}
"icon" MUST be a real icon that actually exists in Iconify's open
library (api.iconify.design, ~200,000 icons, free, no key needed) -
never invent a plausible-sounding name. Reliable, generic-concept sets
to draw from (prefix "mdi:" = Material Design Icons, by far the
largest/safest general-purpose set - rocket, lightbulb, chart-line,
clock, star, heart, check-circle, alert, trending-up, and thousands
more genuinely exist under "mdi:"). For a REAL brand/product logo, use
the "simple-icons:" prefix with the lowercase product name (e.g.
"simple-icons:youtube", "simple-icons:instagram", "simple-icons:apple")
- this is a real, maintained set of actual brand marks, not something
to guess the shape of yourself. If you are not confident an exact icon
name is real, prefer a well-known "mdi:" concept icon over guessing at
a more specific or brand-specific one.
An image layer needs either "icon" or "src":"beatImage" (an AI-
generated hero photo for this beat) - never both, never neither.

=====================================================================
AE TECHNIQUE PATTERNS - real recipes, not abstract capability
=====================================================================
These are concrete constructions to actually use, adapted directly
from real professional motion-graphics technique - not a menu to
sample from lightly. A beat that only uses per-character text reveals
is not using this engine's real range; reach for these often.

1. STAGGERED COLOR-BLOCK REVEAL (a classic intro background build):
   2-3 rectangle shape layers, each FULL-FRAME size, each a different
   flat fill color, each with a "trim" whose "end" sweeps 0->100 (start
   fixed at 0, or set "offset" around -20 to -40 to angle the wipe in
   from a corner) - but stagger each layer's OWN reveal to begin a few
   frames (0.1-0.2s) after the previous one, so the colors stack in
   with a rhythmic cascade, not all at once. Draw them BELOW your text
   layers in "layers" order.
2. SCALE POP-IN (any shape/icon, not just text): "scale" keyframes
   [0,0] -> [1,1] (or a slight overshoot per the cubic-overshoot
   pattern in ANIMATABLE VALUES above) with easeOutCubic - the exact
   "text pops up" technique, equally real for an icon or a shape.
3. HAND-DRAWN LINE DOODLE: a "customPath" shape, NO fill, only a
   "stroke" (cap:"round", width 2-4px, a color that fits your palette),
   with a "trim" whose "start" AND "end" both sweep 0->100 but "start"
   trails "end" by a beat or two - the shape "grows" then the tail
   "catches up and disappears", reading as a lively traveling stroke,
   not a static line popping into place. Scatter 2-3 of these as small
   accents around a headline, never dominating it.
4. RIPPLE/PULSE CIRCLE: an ellipse shape, NO fill, only a stroke -
   keyframe the stroke's own "width" from a real value down to 0 (the
   ring thins out and vanishes) WHILE ALSO keyframing "scale" from
   [0,0] up past [1,1] with easeOutCubic (the ring grows outward) - a
   real expanding-ripple/pulse effect. Use sparingly as a small accent
   near an icon or a number, not a dominant element.
5. ICON + LABEL PAIR: an icon (scale pop-in, per #2) paired with a
   short supporting text label near it - a real, common motion-
   graphics pattern (a stat with its own icon, a feature with its own
   icon) that reads far more designed than a bare text-only stat.
6. TEXT DEPTH via drop shadow: give a primary headline layer an
   "effects": [{"type":"dropShadow","params":{"color":"#000000",
   "blur":6-10,"offsetX":0,"offsetY":4-8,"opacity":0.3-0.5}}] - real,
   confirmed-live comparison against professional reference work showed
   this is a large part of what makes flat text read as "designed" vs.
   "static/lifeless" - a headline with NO depth at all looks pasted-on.
   NOT OPTIONAL: every beat's single largest/dominant text layer gets
   this - a real brutal side-by-side against reference footage showed
   video after video with zero drop shadow anywhere, and flat text
   next to the reference's consistently-shadowed text is exactly what
   reads as "lifeless" vs "designed." Skip it only on a small
   secondary/supporting label, never on the beat's main headline.
7. TRAVELING ACCENT (not just revealing IN PLACE): a small decorative
   shape (a short dash/line, a small ring/circle) that starts at ONE
   position, near but not touching the text, then ANIMATES ITS OWN
   "position" (not just opacity/scale) to travel a real, visible
   distance (40-100px) to a final resting spot relative to the text
   (e.g. becoming an underline swoosh beneath a headline, or landing
   just after the last character) - arriving a beat AFTER the main
   text has already settled, per the separately-timed-arrival rule.
   This reads as a genuinely composed, lively flourish; a decorative
   shape that only fades/scales in without ever traveling reads as
   scattered set-dressing instead. Real, confirmed-live reference
   comparison: exactly this technique (a small dash + ring drifting
   into a final underline-and-accent position beneath a title) is what
   separates a professional title card from a flatter one.
8. TIGHT COMPOSITION: cluster a beat's elements (headline, accents,
   icon) around ONE shared focal point/region with real breathing room
   around the whole group, rather than spreading them to fill the
   entire frame independently - a professional title card reads as one
   deliberate, compact composition, not several unrelated elements each
   claiming their own patch of the frame.
9. TWO-TIER TYPOGRAPHY LOCKUP for a title-card-style beat (a name, a
   topic reveal, a CTA card - anywhere ONE headline IS the beat, not a
   fact building alongside other copy): a SMALL label line directly
   above/below a MUCH LARGER, heavier headline word/phrase, with
   NEAR-ZERO vertical gap between them (the small line's own descender
   almost touching the big line's cap-height) so they read as ONE
   cohesive lockup, not two independent floating text layers. Real
   confirmed-live reference comparison: this tight two-size pairing
   (e.g. a 32-40px "Poppins Medium" label sitting right above a
   90-140px "Poppins Black" headline) is a large part of what makes a
   reference title card read as one deliberate unit instead of loose,
   randomly-spaced lines - achieve the tight gap with each layer's own
   "position" y-values close together (roughly the small line's own
   fontSize*1.1 apart, not the usual generous beat-wide spacing).
10. CUMULATIVE LIST BUILD - USE THIS WHENEVER the treatment is a
    numbered/ranked countdown ("5 reasons...", "the top 4 mistakes...",
    "3 fonts you need") rather than a plain sequence of unrelated facts.
    Each beat in the countdown is NOT its own isolated composition -
    every earlier item STAYS on screen, already fully landed/static
    (no "animators", no "textAnimation" on it - it already finished
    animating in an EARLIER beat, so it must render motionless now),
    while ONLY the new item for THIS beat animates in below it. This
    means beat N's own "layers" array must re-include every item from
    beats 1..N-1 as plain static text layers (same text/fontSize/
    position as when they first appeared) PLUS the new Nth item as the
    one with real reveal animation. Reserve a fixed vertical list region
    up front (e.g. y=420 to y=820) and give each item its own fixed row
    inside it based on its rank, independent of which beat it belongs
    to (row height = region height / total item count from the
    treatment's own beat count) - so item 3 always renders at the same
    Y across every beat it appears in, items never shift position once
    placed. A real 3-beat worked skeleton (list of 3, rows at y=520/
    640/760):
    beat1: [{"type":"text","text":"1. FIRST ITEM","position":[270,520],...with reveal animator}]
    beat2: [{"type":"text","text":"1. FIRST ITEM","position":[270,520],... NO animator, static},{"type":"text","text":"2. SECOND ITEM","position":[270,640],...with reveal animator}]
    beat3: [{"type":"text","text":"1. FIRST ITEM","position":[270,520],... static},{"type":"text","text":"2. SECOND ITEM","position":[270,640],... static},{"type":"text","text":"3. THIRD ITEM","position":[270,760],...with reveal animator}]
    This is what makes a countdown read as one accumulating list
    (matching real reference footage) instead of the SAME single line
    of text being replaced beat after beat - a real, confirmed-live
    failure mode when this pattern isn't followed. Do NOT use this
    pattern for a beat sequence that isn't actually an enumerated list
    (a plain narrative walkthrough with no numbers/ranking) - forcing
    old content to persist there just clutters beats that were never
    meant to accumulate.

=====================================================================
EFFECTDEF - real per-layer post-processing (any "shape"/"image"/"text"
layer's own "effects": [EffectDef, ...] array, applied in order)
=====================================================================
28 real, working effect types exist - "dropShadow" (see AE TECHNIQUE
PATTERNS #6 above) is only ONE of them and should not be the only one
you ever reach for. Real reference footage leans on these constantly
(a glitchy digital feel, a punchy glow behind a stat, a soft blur
transition) - a video with dropShadow as its only effect, or NO effects
at all, is under-using this engine, the same way text-only layers are.
Each effect is {"type":"<name>","params":{...}} - every param below has
a real default (safe to omit any you don't need to change).

DEPTH/GLOW (layer styles - work on any shape/image/text layer):
- dropShadow {color,opacity,blur,offsetX,offsetY} - see AE PATTERN #6.
- outerGlow {color,opacity,blur,blendMode} - a soft light halo around
  the layer's own alpha edge (great behind a stat number/icon).
- innerGlow / innerShadow {color,opacity,blur,blendMode} - glow/shadow
  cast INWARD from the layer's own edge instead of outward.
- layerStroke {color,width,align} - a real, clean outline stroke around
  the layer's own silhouette (align: "center"|"inside"|"outside").

BLUR:
- gaussianBlur {radius} / boxBlur {radius,iterations} - general softening
  (a background element you want to visually recede, a soft focus pull).
- directionalBlur {length,angle} - a linear motion-streak blur (great on
  a fast-traveling accent shape).
- radialBlur {amount,center,mode:"zoom"|"spin",samples} - a zoom-burst
  or spin-blur radiating from a point - real impact-moment energy.

COLOR GRADE (subtle grading, not garish - small values read as
"professionally graded", large ones read as broken):
- curves {master,r,g,b} - each an array of [input0-255,output0-255]
  control points; omit a channel to leave it untouched.
- hueSaturation {hueShift(deg),saturationScale,lightnessShift}
- colorBalance {shadows:[r,g,b],midtones:[r,g,b],highlights:[r,g,b]} -
  each a small tone-targeted color push, AE's real 3-way color wheel.
- levels {inBlack,inWhite,gamma,outBlack,outWhite,channel}

GRAIN/NOISE (a real, subtle film/analog texture - small values only,
e.g. addGrain intensity 0.05-0.15 - large values just look broken):
- addGrain {intensity,size,seed} - addNoise {amount,monochrome,seed}

GLITCH/RETRO (real kinetic-typography energy - use as a brief accent on
an impact beat, e.g. a "WRONG"/reveal moment, not sustained every frame):
- rgbShift {redOffset:[dx,dy],greenOffset:[dx,dy],blueOffset:[dx,dy]} -
  the classic chromatic-aberration glitch look; animate the offsets in
  from a large split down to [0,0] for a "glitch resolving into focus"
  entrance.
- blockDisplace {bandHeight,maxShift,seed,probability} - real
  datamosh-style horizontal band jitter.
- scanLines {spacing,darkenAmount,lineWidth} - CRT/VHS scanline texture.
- pixelSort {direction:"horizontal"|"vertical",threshold:[lo,hi]} - the
  real glitch-art "pixel sorting" streak look.

STYLIZE:
- findEdges {invert} - posterize {levels} - mosaic {blockSize} - emboss
  {strength,angle} - real graphic/poster/glitch-adjacent looks, use
  sparingly as a deliberate stylistic choice for one specific beat, not
  a default.
- autoGlow {threshold,blurRadius,intensity} - blooms ONLY the layer's
  own brightest pixels (a real HDR-glow look on bright text/icons).

WARP/DISTORT (canvas-space warps - twirl/bulge/rippleWarp/waveWarp all
take an optional "center":[x,y], default the layer's own center):
- twirl {center,radius,angle(deg)} - a spinning vortex distortion.
- bulge {center,radius,power} - a lens-bulge/pinch (power>1 bulges out,
  <1 pinches in).
- rippleWarp {center,amplitude,wavelength,phase,decay} - concentric
  ripples radiating from a point, real water/impact-ripple energy.
- waveWarp {amplitude,wavelength,phase,direction:"horizontal"|"vertical"} -
  a "flag wave"/heat-shimmer ripple.
- displacementMap {map:GenerateDef,maxDisplacement,xChannel,yChannel} -
  an advanced per-pixel push using a second generated pattern (e.g. a
  "fractalNoise" GenerateDef) as the displacement source; reach for the
  simpler warps above first, this one is for real organic distortion.

=====================================================================
SELECTORS (per-character text animator drivers)
=====================================================================
{ "type": "range", "start": AnimatableValue<0-100>, "end": AnimatableValue<0-100>,
  "offset": AnimatableValue<0-100>, "shape": ${RANGE_SELECTOR_SHAPES.map((s) => `"${s}"`).join(' | ')},
  "smoothness": 0-100, "basedOn": "characters" | "words", "amount": AnimatableValue<number>,
  "randomizeOrder": boolean, "randomSeed": number }
  // THE standard reveal driver. For a classic left-to-right character
  // reveal: keep "start" fixed at 0 and animate "end" from 0 to 100 over
  // your reveal duration (shape:"square" is a clean per-character cutoff).
  //
  // "start"/"end" are PERCENTAGES OF POSITION THROUGH THE TEXT (0-100),
  // NEVER literal word/character indices - a real, confirmed-live
  // mistake: writing {"start":6,"end":22} trying to target "the 3rd
  // word" of an 8-word sentence actually selects almost nothing (word
  // index has to be converted to a percentage first). To target ONE
  // specific word at index i (0-indexed) out of N total words:
  //   start = (i / N) * 100
  //   end   = ((i + 1) / N) * 100
  // Concrete worked example: highlighting exactly the 3rd word ("HOME",
  // index 2) of "IT'S HOME TO SHARKS" (4 words total, N=4): start =
  // (2/4)*100 = 50, end = (3/4)*100 = 75. NEVER guess small arbitrary
  // numbers hoping they'll land near the right word - always compute
  // the percentage from the real word count and target index.
  //
  // "invert" (on the ANIMATOR wrapping this selector, not the selector
  // itself - see TEXTLAYERDEF's "animators" above) defaults to TRUE,
  // meaning by default an animator applies its "properties" delta to
  // the CHARACTERS NOT SELECTED by the range, not the ones selected -
  // this is the correct default for the classic reveal case (start
  // fixed at 0, end sweeping to 100: "not yet reached by the sweep" =
  // hidden/offset, "reached" = landed). But a "color" accent animator
  // is NOT a reveal - you want the color applied exactly where you
  // targeted, not its complement. A real, confirmed-live bug: a
  // "color" animator scoped to one word with no "invert" field ended
  // up coloring EVERY OTHER word in the sentence instead, because the
  // default invert flipped the selection. ALWAYS set "invert":false
  // explicitly on any "color" animator (or any other non-reveal
  // accent) targeting a specific word range - only leave "invert" at
  // its default (or explicitly true) for an actual entrance reveal.
  //
  // DEFAULT REVEAL STYLE: a real, fast-cut kinetic-typography edit does
  // NOT slowly wipe each character in one at a time - words/short
  // phrases POP IN as a unit, fast (~0.15-0.35s total), landing on the
  // very NEXT phrase before the last one has time to feel static. Use
  // "basedOn":"words" with "end" sweeping 0->100 over that short a
  // window as the DEFAULT (every word in the current phrase lands
  // within a fraction of a second of each other, not staggered letter
  // by letter) - reserve a slower "basedOn":"characters" sweep for the
  // rare deliberate exception, not the default assumption. Pair the
  // reveal with a small "scale" delta (e.g. properties.scale: 1.15-1.3)
  // in addition to opacity/position for a punchy pop-in landing feel,
  // not just a flat fade.
{ "type": "wiggly", "frequency": number, "seed": number, "correlation": 0-100,
  "minAmount": number, "maxAmount": number }
  // continuous organic per-character jitter, not a one-time reveal

An animator's "properties" are applied as DELTAS at full ("selected")
strength, inverted automatically for a natural reveal (unselected =
full delta applied = hidden/offset; selected = delta removed = landed).
So { "position":[0,40], "opacity":-1 } with a range selector sweeping
0->100 makes each character rise 40px and fade in as the sweep reaches it.

CRITICAL - keep "position" deltas SMALL, or text renders as garbled,
overlapping nonsense: each character sweeps into place INDIVIDUALLY, in
sequence, not all at once - while one character is still mid-transition
(offset by some fraction of your delta) the NEXT characters over may
have already landed. If your delta is large relative to a single
character's own width (roughly fontSize * 0.6), the still-moving
character's current position visually collides with already-landed
neighboring characters, and for a few frames the word reads as scrambled
garbage (e.g. "BUDGETING" briefly rendering as overlapping fragments
mid-reveal). This is not a hypothetical edge case - it is the single
most common way generated text looks broken. Concrete rule: keep
"position" deltas to roughly 15-40px for body/headline text at typical
sizes (40-80px fontSize) - large enough to read as motion, far too
small to overlap a neighboring character. Never use triple-digit
position deltas on a per-character text animator.

Selector choice for legibility-critical text (headlines, labels, short
badges the viewer needs to actually READ): use "range" with a ONE-TIME
sweep (start fixed, end animating 0->100, or vice versa) so the text
reaches a fully-landed, stable, readable state and STAYS there. NEVER
use "wiggly" as the ONLY animator on text meant to be read, especially
combined with a "position" property - wiggly is a continuous, NEVER-
SETTLING oscillation (every character is perpetually offset by some
amount, forever), so any text using it will look permanently glitched/
scrambled for its entire time on screen, not just during an entrance -
this is exactly the "text renders as unreadable garbage the whole time
it's visible" failure mode. Reserve "wiggly" (with modest amounts,
never combined with large position deltas) for decorative/ambient
motion on text that isn't the primary thing being read, or use it only
on "opacity"/"scale" with a small range, never on "position" for short
critical labels.

NEVER set a layer's own top-level "opacity" to a static 0 just because
it has a per-character reveal animator - the animator's "opacity"
DELTA only ever controls per-CHARACTER alpha inside the text draw
call, it has NO WAY to reach back and override the LAYER's own
opacity, which gates the entire composited layer multiplicatively no
matter what the animator does internally. A static "opacity":0 at the
layer level makes the WHOLE layer permanently invisible for its entire
duration, animator or not - confirmed as a real, live bug: a headline
with "opacity":0 plus a correctly-configured reveal animator rendered
as nothing at all, the whole beat through. To start a layer invisible
and reveal it, either OMIT "opacity" entirely (default 1) and let the
per-character animator's own "opacity" delta do the reveal, or animate
the LAYER's own "opacity" with real keyframes (0 -> 1) - never a plain
static 0.

=====================================================================
DESIGN QUALITY - this is the whole point, not an afterthought
=====================================================================
- Every beat should feel deliberately DESIGNED, not a plain slide: a
  real per-character text reveal, at minimum, every single beat (the
  background is already handled for you).
- Real motion graphics, not just text - reach for SHAPELAYERDEF/
  IMAGELAYERDEF often (see AE TECHNIQUE PATTERNS above): a staggered
  color-block reveal behind an early headline, an icon paired with a
  stat or label, a hand-drawn line accent near a callout, a ripple
  ring behind a number. A whole video that never uses a single shape
  or icon is under-using this engine's real range - aim for most beats
  having at least one non-text element, not as decoration bolted on
  but as a real part of the composition.
- NOTHING IS STATIC. Every single text layer needs a REAL entrance -
  either a per-character "animators" reveal, or a keyframed "opacity"/
  "scale"/"position"/"rotation" that actually moves it from an
  offset/hidden state to its landed one. A layer with none of these at
  all appears with an instant hard cut and never moves again - a real,
  confirmed-live failure found via direct JSON audit of a generated
  video, not a style guess. This is not just about the text reveal -
  EVERY element that has its own timing (the headline's entrance, a
  supporting label's entrance, a "color" accent switching on, a
  "highlights" chip drawing in) needs its OWN separately-timed
  animation, not all bundled into one simultaneous moment.
  IMPORTANT DISTINCTION, a real confirmed-live mistake: "landing
  roughly every 0.3-1s" below describes the STAGGER TIMING BETWEEN
  successive words/lines WITHIN a longer, multi-part beat - it is NOT
  a target for how short the WHOLE BEAT's own "duration" should be. A
  real generation read it that way for a short single-phrase beat and
  produced a 0.5s beat - barely enough time for its own entrance to
  finish settling, let alone be read, and it made the whole video feel
  like it was cutting too fast to follow. Every beat's own "duration"
  needs real room regardless of how few words it has - roughly 1.2-2.5s
  at minimum, even for a single short phrase, so its entrance can
  finish AND the words stay readable before the next beat replaces it.
  Build beats the way a real kinetic-typography edit is cut: short
  phrases building up word-by-word or line-by-line, each new piece of
  text landing roughly every 0.3-1s rather than one full sentence
  appearing and sitting there - and once text HAS landed, a color
  accent or highlight chip on it should still arrive its own beat later
  (a distinctly separate, later-timed animation), never baked in from
  that text's very first frame. A beat where everything animates in
  at once and then nothing moves again is exactly the "static" failure
  this rule exists to prevent, even if the initial reveal itself was
  well-animated.
- Use TEXT color with intent - a coherent palette across the whole
  video (related hues from beat to beat, not random unrelated ones).
  For the single most important word in a headline, consider an
  animator "color" accent or a "highlights" chip behind it instead of
  leaving the whole line one flat color - used sparingly (one accented
  word per beat, not every word), this is what makes a headline read
  as designed rather than a plain text dump.
- EVERY layer in "layers" needs its OWN "position" - a real, common
  live mistake: 2+ layers left at the same position (very often
  [${COMP_WIDTH / 2},${COMP_HEIGHT / 2}], the frame center, the natural
  default to reach for) stack fully on top of each other instead of
  reading as the intended composition. Before finishing a beat, scan
  every layer's "position" and make sure no two share an identical
  value (unless they're genuinely both meant to sit dead-center at
  different moments in time via animation).
- Prefer real keyframed motion with "easing" interpolation for primary
  text, and ALWAYS use one of ${CUBIC_EASING_NAMES.join(', ')} for it -
  no other easing name is valid here (see ANIMATABLE VALUES above);
  keep position-based per-character animator deltas small (15-40px) so
  characters don't visually overlap mid-reveal (see SELECTORS above
  for the full reasoning).
- FILL THE FRAME with intent. A tiny line of text confined to one
  corner while most of the ${COMP_WIDTH}x${COMP_HEIGHT} frame sits
  empty reads as unfinished - use font size, line breaks, and multiple
  text layers (a headline plus a supporting label/stat) to give the
  frame real visual weight, not just one small centered line.
- NEVER let a beat go visually static for more than a fraction of a
  second. A real per-character reveal should always be happening (or
  just landed) somewhere on screen - a beat that's just a single
  motionless line of text sitting there for its whole duration reads
  as dead air and is the single fastest way to lose a short-form
  viewer. Match each beat's duration to how much text/reveal is
  actually happening in it - don't stretch one short line across
  several empty seconds.
`.trim();

// through the design in free text first, unconstrained by structure,
// then translate an already-good plan into the schema as a second,
// separate step. This mirrors how a real studio actually works (a
// director's treatment exists before an animator opens After Effects)
// and is the direct, structural answer to "tell it to be an expert" vs
// "make it think like one" - the treatment pass has no JSON to produce
// at all, so nothing competes with the model actually reasoning about
// composition, hierarchy, and motion.
// ---------------------------------------------------------------------

function buildTreatmentSystemPrompt(targetDurationSeconds, creativeAngle) {
  // Real, confirmed-live gap: this used to hand the model a RANGE
  // ("roughly LO-HI beats") and let it pick freely within it - but the
  // downstream completeness check (both the JSON-encoding stage's own
  // "too short" gate and, for the training harvester, its separate
  // structural scorer) demands a single specific count. A model
  // legitimately picking the low end of a stated range (e.g. 3 out of a
  // stated "3-4") isn't wrong by the prompt's own words, yet gets
  // rejected outright by every downstream consumer expecting the exact
  // midpoint - confirmed live: 70+ real harvester attempts in a row, all
  // structurally rejected for exactly this, zero stored. Stating ONE
  // exact target (the same midpoint math every downstream consumer
  // already computes) removes the ambiguity at the source instead of
  // discovering the mismatch after a wasted generation.
  const beatLo = Math.max(3, Math.round(targetDurationSeconds / 3));
  const beatHi = Math.max(4, Math.round(targetDurationSeconds / 2.5));
  const targetBeatCount = Math.round((beatLo + beatHi) / 2);
  return `You are a world-class motion graphics director - the kind of
person clients pay a premium for because every single frame is
intentional, well-paced, and alive, not just the text but the whole
composition around it. You are planning (NOT building yet) a
${targetDurationSeconds}-second short-form vertical video
(${COMP_WIDTH}x${COMP_HEIGHT}px, 9:16) for the request below.

Your real toolkit: professionally-animated TEXT, real vector SHAPES
(rectangles/circles/hand-drawn lines - built and animated the way a
real After Effects artist would, trim-path reveals, staggered color
blocks, hand-drawn doodle accents, ripple/pulse rings), and real ICONS/
brand logos. The video's shared backdrop gradient is still handled
entirely by the render engine (not something you plan or describe) -
but everything IN FRONT of it - shapes, icons, text - is yours to
direct. This is a real motion-graphics toolkit, not text-only anymore -
plan compositions that actually use it: a staggered color-block reveal
behind a headline, an icon paired with a stat, a hand-drawn accent line
near a callout, not text floating alone on a plain backdrop.

Write a concrete, opinionated, beat-by-beat treatment - not mood words,
actual decisions a senior director would hand an animator to build
frame-for-frame:

1. THE HOOK: the exact words on screen in the first half-second and
   why they earn attention immediately (specific, not "an engaging
   headline") - AND what's visually happening around it (a color-block
   reveal building in, an icon popping in alongside).
2. PALETTE & MOOD: 2-4 specific colors (precise enough to pick real hex
   values from) used consistently across TEXT, shape fills/strokes, and
   icon colors alike - one coherent palette for the whole video, not a
   text-only concern anymore. Real, confirmed-live reference comparison:
   professional reference work is far more RESTRAINED than this
   consistently lands on - typically ONE dominant color plus white/black
   text plus at most ONE accent color used sparingly (a single small
   highlight, never competing for attention), not 3+ different
   saturated hues all active in the same beat. Within any ONE beat,
   pick ONE accent color and reuse that SAME one for every accent in
   that beat (a highlight chip, a decorative shape, an icon) rather
   than a different color for each - a beat mixing red AND lime-green
   AND teal all at once reads as busier and less "branded" than
   confidently committing to one.
3. BEAT BY BEAT (beats are typically 2.5-4s each - see the real,
   confirmed-live pacing note right below before planning how MANY):
   keep this section
   clearly structured - start each beat with its own line reading
   "===BEAT n=== duration:X.Xs" (n starting at 0, X.X the beat's own
   length in seconds, all beats summing to approximately
   ${targetDurationSeconds}s) on its own line, with nothing else on
   that line. Everything between one "===BEAT n===" line and the next
   is that beat's own full description - this is YOUR OWN plan, which
   YOU will encode into the final "scenes" JSON array yourself in the
   next step, so a clear, well-separated breakdown here directly makes
   that easier to get right.
   MANDATORY, every single beat, no exceptions: real, specific words on
   screen. An icon/logo/shape can be part of a beat's composition, but
   is NEVER the whole beat by itself - the next step's schema hard-
   rejects any beat without at least one real text layer, so a beat you
   plan here as "just an icon reveal" or "just the logo" with no actual
   words CANNOT be encoded and will burn every retry failing to do the
   impossible. If a beat's whole idea is visual (a logo appearing, an
   icon popping in), pair it with real accompanying text - a name, a
   label, a short line - never leave it wordless.
   Every beat covering ALL of:
   REAL, CONFIRMED-LIVE PACING NOTE: prefer FEWER, more complete beats
   over many rapid-fire ones for a given ${targetDurationSeconds}s total -
   plan EXACTLY ${targetBeatCount} beats total, not fewer, not more,
   and NOT 8-10+. This is not a loose suggestion - it's the exact count
   every later step checks your work against, so treat it as a hard
   target, not a range to pick freely within. A
   real user complaint traced directly to this: too many short beats
   cutting rapidly between each other read as chaotic and low-quality,
   even when each individual beat was well-made - a viewer never gets
   time to actually register one idea before the next replaces it.
   Every beat also needs enough of its own duration to let its text
   ACTUALLY finish revealing (a real per-character reveal takes real
   time - roughly 35ms per character at minimum for it to read as a
   genuine typewriter effect, not an instant pop) AND still sit fully
   visible for a moment afterward so it can be read, not just glimpsed
   mid-animation. A short phrase still needs real seconds, not a
   fraction of one.
   - The exact text/words on screen (a headline, a stat, a short
     label) - be specific about the actual copy, not just its topic.
     Favor SHORT phrases landing one after another (roughly every 0.3-
     1s of screen time each) over one long sentence appearing all at
     once - the pacing of a fast, well-cut kinetic-typography edit, not
     a static caption card.
   - The exact spoken NARRATION line for this beat - REQUIRED, every
     beat, a real sentence a human narrator would actually say out
     loud, NOT a restatement of the on-screen text in caption form
     (see NARRATION - WRITE FOR THE EAR, NOT THE EYE in the next step's
     schema for the full guidance - contractions, natural rhythm, no
     mechanical "First/Second/Third" cadence repeated every beat, reads
     as one continuous voiceover across the whole video rather than a
     list of captions read aloud). Decide this now, at the same time as
     the on-screen words, not as an afterthought once the visuals are
     already locked.
   - What SHAPES/ICONS are in this beat, if any - a specific real icon
     concept (not "an icon", name what it actually represents - a
     rocket, a lightbulb, a checkmark), where it sits relative to the
     text, and its own entrance (see AE TECHNIQUE PATTERNS in the next
     step's schema - scale pop-ins, ripple rings). Not every beat needs
     one, but a video with NONE anywhere is under-using the toolkit.
   - How the text reveals: a fast word-level pop-in (~0.15-0.35s, the
     default - see SELECTORS below), timing, any position/scale motion
     on the reveal - specific enough to actually author
   - Hierarchy when a beat has more than one element (which is the
     dominant headline vs. a smaller supporting label or icon, and
     roughly where each sits)
   - Where a color accent or highlight marker belongs, and WHEN it
     switches on relative to the text's own landing moment - it should
     always be its own later, separately-timed beat of motion, never
     simultaneous with (or baked into) the text reveal itself
   - How this beat's elements land and settle before the next beat -
     nothing in this beat should ever go fully motionless for more
     than a fraction of a second; something is always either still
     arriving, switching on, or settling
4. Fill the frame with intent every beat - real font size, shapes/icons
   where they earn their place, multiple elements (a headline plus a
   supporting stat/label/icon) - avoid one small line lost in a big
   empty frame. BUT cap it at roughly 4-5 total elements (text + shapes
   + icons combined) in any single beat - real, confirmed-live failure:
   beats crammed with 8-10 elements at once routinely came out with
   several of them visually overlapping, no matter how carefully
   they're positioned, simply because there isn't enough of a
   ${COMP_WIDTH}x${COMP_HEIGHT} frame to cleanly separate that many
   things at once. A clean beat with 3-4 well-placed elements always
   reads better than a busy one with 9 fighting for the same space -
   if you need more elements than that to land an idea, that idea
   deserves its own beat instead of being crammed into one.

Example of the beat-header format:
===BEAT 0=== duration:2.5s
<full description of beat 0 here>
===BEAT 1=== duration:3.0s
<full description of beat 1 here>

${creativeAngle ? `MANDATORY CREATIVE ANGLE FOR THIS SPECIFIC VIDEO: ${creativeAngle}
Real, confirmed-live problem this directly fixes: the exact same
request submitted more than once was producing near-identical scripts
every time - same hook, same handful of facts, same structure, just
reworded. Random sampling temperature alone doesn't reliably fix this
for a topic with a small set of "obvious" facts - a model asked the
same question twice tends to reach for the same most-associated
answer regardless, the way a person asked to "just pick a number"
usually reaches for the same few numbers. This angle was chosen
specifically to force a genuinely different take THIS time, the way a
real director assigned the same brief twice wouldn't hand back two
near-identical cuts. Commit to it fully - let it shape the hook, which
facts/points you lead with and which you leave out entirely, the
tone, and the overall structure, not just a surface-level word swap
on top of the same underlying plan. If this angle doesn't obviously
fit the request, adapt it rather than ignoring it - find the genuine
version of this angle for this specific topic.

` : ''}Be decisive and specific throughout, the way a real director committing
to real choices would - no hedging, no "could be" or "maybe", no
generic filler description. This treatment will be built EXACTLY as
written, so anything vague or missing here will be vague or missing in
the final video. Write the HOOK and PALETTE & MOOD sections as plain
prose before the first "===BEAT 0===" line; everything from there on
must follow the beat-header format above exactly, as long and detailed
as each beat needs to leave nothing for the next step to guess at.`;
}

function buildGenerationSystemPrompt(targetDurationSeconds) {
  return `${SCHEMA_REFERENCE}

=====================================================================
FINAL CHECKLIST - re-read this right before you write, and again for
EVERY beat after the first (rules stated once at the top of a long
generation are the ones most likely to slip by the last beat):
=====================================================================
- "easing" is ALWAYS one of ${CUBIC_EASING_NAMES.join(', ')} - never
  easeOutQuad/easeOutBack/easeInOutSine/etc, on ANY property
  (position/opacity/scale/rotation alike), on EVERY beat, not just the
  first one you write.
- "fontFamily" is ALWAYS EXACTLY one of ${AVAILABLE_FONT_FAMILIES.map((f) => `"${f}"`).join(', ')}
  - never "Poppins Regular"/"Poppins SemiBold"/bare "Poppins"/any other
  real Poppins weight name that sounds plausible but isn't bundled.
- A shape content item's "type" is ALWAYS one of
  ${SHAPE_CONTENT_TYPES.map((s) => `"${s}"`).join(', ')} - shape KIND
  names ("rectangle"/"ellipse"/"customPath"/etc) belong one level
  deeper, inside "shape.kind", never as the content item's own "type".
- No two layers in the same beat ever share identical "text".
- Every keyframe object has both a real "time" (number) and "value" -
  never omit either.
- A text layer's "animators[].properties" (opacity/position/scale/
  rotation) are ALWAYS plain values ("position":[dx,dy], the rest plain
  numbers) - NEVER a {"keyframes":[...]} object there, even though that
  shape is legal for a layer's own top-level "position". Putting
  keyframes inside "animators.properties" silently breaks the reveal at
  render time - the text stays frozen wherever its base position put
  it, which is a real, confirmed, common failure when that base
  position was deliberately off-canvas for a fly-in effect.
- A text layer's "position" x is ALWAYS the box's own CENTER, never a
  left-margin value - for anything near "maxWidth" wide, keep it within
  roughly maxWidth/2 of ${Math.round(COMP_WIDTH / 2)} or it renders
  clipped off one edge of the canvas for the whole beat.
- MANDATORY, every single beat, no exceptions: at least one "text" layer
  with real, non-empty words. A beat with only shapes/icons and no text
  conveys nothing and is REJECTED outright - this is not a style
  preference, it is a hard requirement checked on every beat you write.
- MANDATORY, every "image" layer: a real "icon" (Iconify "prefix:name")
  or "src":"beatImage" - one of the two, always. An image layer with
  neither has nothing to draw and is REJECTED outright.
- Every "type":"text" layer should carry its own deliberate
  "textAnimation.in" choice (see TEXTLAYERDEF above for the full preset
  list) - text should never simply BE there from the first frame with
  no arrival of its own. A layer that omits this still gets a safe
  automatic default rather than being rejected, but relying on that
  default for every layer produces flat, repetitive-feeling video -
  pick presets deliberately, and vary them across layers/beats the same
  way a real editor would reach for different CapCut/Canva/After
  Effects entrance styles rather than using the same one throughout.
- MANDATORY: encode EVERY beat the treatment planned, none skipped,
  merged, or summarized away - if the treatment planned N beats, your
  "scenes" array has EXACTLY N entries. Stopping after fewer is the
  single most common mistake on long generations; count your own
  "scenes" entries against the treatment's own beat headers before you
  consider the response finished.
- MANDATORY, every single beat, no exceptions: a non-empty
  "params.narration" string. A beat with no narration renders
  completely silent for its own duration - a real, confirmed defect,
  checked and REJECTED on every beat you write. It must also be
  written as a real spoken sentence (see NARRATION - WRITE FOR THE EAR,
  NOT THE EYE above), not a copy-pasted echo of that beat's on-screen
  text - re-read that section before writing the LAST few beats
  especially, where mechanically repeating the same sentence shape as
  every beat before it is the most common way this slips.

Generate a complete, valid scene JSON for a short-form vertical video
matching the user's request below. Target roughly ${targetDurationSeconds}
seconds total across all beats (sum of params.duration). Output ONLY the
JSON object - no markdown fences, no commentary before or after it.
Remember: COMPACT/MINIFIED JSON, one line, no indentation - this is not
optional, it directly determines whether your response fits before
being cut off.`;
}


function buildEditSystemPrompt(targetDurationSeconds) {
  return `${SCHEMA_REFERENCE}

=====================================================================
YOUR TASK
=====================================================================
You will be given the CURRENT complete scene JSON and an edit
instruction. Output the COMPLETE, updated scene JSON with that
instruction applied - not a diff, not just the changed beat. Preserve
every beat/field the instruction doesn't ask you to change. Keep the
total duration close to the original (~${targetDurationSeconds}s) unless
the instruction explicitly asks to add/remove/lengthen beats. Output
ONLY the JSON object - no markdown fences, no commentary.
Remember: COMPACT/MINIFIED JSON, one line, no indentation - this is not
optional, it directly determines whether your response fits before
being cut off.`;
}

// Matches the treatment's own "===BEAT n===" header lines - used below
// to list (not to split/parse the treatment into pieces the way the
// removed per-beat architecture used to) how many beats it planned and
// what each one is, as a structural sanity check on the whole-scene
// encoding step. Captures the WHOLE line, not just the "===...==="
// delimiter itself - the duration that follows on the same line
// ("===BEAT 0=== duration:2.5s") is real, useful identifying context
// for the model to check itself against, not just the bare number.
const BEAT_HEADER_RE = /===\s*BEAT\s+\d+\s*===[^\n]*/gi;

// Real, confirmed-live gap: "too short" was the single most common
// failure by far across a live run's own retries (roughly half of all
// attempts) - the model routinely wrote a full, well-formed BEAT 4 or
// BEAT 5 in its own treatment, then simply stopped encoding after 1-3
// scenes anyway, with no truncation error (it wasn't hitting
// max_tokens - it was choosing to stop early). A single generic
// "encode every beat" line among many other checklist items, and a
// retry message reporting only a bare COUNT ("only 2 of 5 encoded"),
// both give the model nothing concrete to act on - it has to somehow
// infer WHICH beats it dropped with no list to check itself against.
// Extracts each beat's own header line (its exact duration too) so
// both the fresh-attempt prompt and every retry can spell out a real,
// checkable list - "here are the N beats by name, your scenes array
// must have exactly N entries in this order" - rather than a single
// buried instruction and a bare number.
function listTreatmentBeatHeaders(treatment) {
  const matches = treatment.match(BEAT_HEADER_RE) || [];
  return matches.map((header, i) => `${i}. ${header.replace(/=+/g, ' ').replace(/\s+/g, ' ').trim()}`);
}

module.exports = {
  COMP_WIDTH,
  COMP_HEIGHT,
  buildTreatmentSystemPrompt,
  buildGenerationSystemPrompt,
  buildEditSystemPrompt,
  listTreatmentBeatHeaders,
};
