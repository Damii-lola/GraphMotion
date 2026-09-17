const { jsonrepair } = require('jsonrepair');
const fetch = require('node-fetch');
const { validateSceneJSON, buildMographBeatVisual, buildCtaOutroBeat } = require('./sceneSchema');
const { buildCompactGenerationSystemPrompt, pickRandomTemplates } = require('./scenePrompts');
const { callCloudflareRaw } = require('./cloudflareClient');

/**
 * OpenRouter REMOVED entirely (2026-09-16, direct user instruction: "remove
 * openrouter ai") - it was already down to exactly ONE real consumer by
 * this point (generateEditedSceneJSON below, the video-EDIT path), since
 * fresh-video generation moved onto Cloudflare Workers AI back on 2026-09-10
 * (see COMPACT_BASE_DURATION's own doc comment) and the OpenRouter-era
 * treatment/whole-scene-JSON/script-judge functions (generateCreativeTreatment,
 * generateWholeSceneJSON, judgeNarrationScript) were already dead code, never
 * called from generateSceneJSON, and have now been deleted outright rather
 * than left as unused history. The edit path's own OpenRouter transport
 * (callSceneJSONTransport/callSceneJSONForJSON) is gone too - moot anyway
 * since editing is separately disabled end-to-end (server.js's own
 * commented-out parentJobId handling, ai.html's own hardcoded
 * isInEditMode()===false) - generateEditedSceneJSON below now throws a
 * clear, explicit error instead of silently trying to reach a removed
 * provider, so re-enabling editing without ALSO giving it a real working
 * transport again fails loudly and obviously rather than with a confusing
 * "callOpenRouterRaw is not defined" crash.
 *
 * Mistral REMOVED entirely, direct user instruction (2026-09-05): "we
 * aint meant to be using mistral atalll, like i even removed the keys."
 * Groq REMOVED entirely, same day: its organization-wide daily quota
 * stayed exhausted long past when it should have reset ("Groq is still
 * not working, just remove it completely"). Gemini - the temporary
 * stand-in while that was being sorted out - then hit its OWN real
 * outage live in production the same session (repeated "Gemini server
 * error (503)" across all 3 keys) and was removed too.
 */

// Real, precisely diagnosed failure mode carried over unchanged from
// geminiClient.js - see that file's own doc comment for the full
// reasoning. Not Gemini-specific: any model generating this schema can
// drop the same closing brace at scene boundaries.
function fixMissingSceneCloseBrace(text) {
  return text.split('}]},{"params":').join('}]}},{"params":');
}

function extractJson(text) {
  const cleaned = text.replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON object found in the model response');
  const candidate = fixMissingSceneCloseBrace(cleaned.slice(start, end + 1));
  try {
    return JSON.parse(candidate);
  } catch (originalErr) {
    try {
      const repaired = jsonrepair(candidate);
      const result = JSON.parse(repaired);
      console.warn(`[sceneGenClient] JSON parse failed (${originalErr.message}) but jsonrepair recovered it locally - no retry needed`);
      return result;
    } catch (repairErr) {
      const posMatch = originalErr.message.match(/position (\d+)/);
      if (posMatch) {
        const pos = Number(posMatch[1]);
        const windowText = candidate.slice(Math.max(0, pos - 60), pos + 60);
        console.warn(`[sceneGenClient] JSON parse failure context (around position ${pos}): ...${windowText}...`);
      }
      throw originalErr;
    }
  }
}


// Direct user request: real, structural creative variation across
// repeated generations of the same prompt - see geminiClient.js's git
// history for the original reasoning (temperature alone wasn't enough).
// Carried over unchanged.
const CREATIVE_ANGLES = [
  'Lead with a surprising or counter-intuitive fact most people get wrong about this - open by correcting a common misconception, not with a neutral intro.',
  'Lead with a relatable "you have definitely experienced this" moment - open on the everyday scenario itself, second person, before explaining anything.',
  'Lead with a bold, opinionated claim stated flatly as fact - confident and a little provocative, not hedged.',
  'Structure this as a rapid-fire list or countdown - distinct, separately-numbered points building to a payoff, not one flowing explanation.',
  'Lead with a specific short scenario or mini-story (a particular moment, not a general statement) and use it as the throughline for the rest of the video.',
  'Lead with a direct question aimed straight at the viewer, second person, and treat the rest of the video as answering it conversationally.',
  'Lead with a surprising number or statistic as the hook, then build the explanation around why that number is true.',
  'Structure this as myth vs. reality - state the common assumption first, then dismantle it point by point.',
  'Frame this as letting the viewer in on an insider secret or something "they don\'t want you to know" - a behind-the-scenes reveal tone.',
  'Take a warm, personal, first-person-feeling tone throughout, like a friend explaining something they find genuinely delightful, not a neutral narrator.',
  'Lead with the single most surprising or weirdest fact available on this topic, saved-for-last normally - front-load it as the hook instead.',
  'Structure this around a clear before/after or problem/solution arc - what things looked like before, what changed, why it matters now.',
];

function pickRandomCreativeAngle() {
  return CREATIVE_ANGLES[Math.floor(Math.random() * CREATIVE_ANGLES.length)];
}

// Direct user re-scoping (2026-09-10): "the ai wont do much, it will
// just pick scenes that fit the prompt then give us the variables for
// the scenes" - replaces the old treatment-then-full-JSON-encode two-
// step process (generateCreativeTreatment/generateWholeSceneJSON below,
// kept defined but no longer called from generateSceneJSON - see their
// own doc comments) with ONE call against Cloudflare Workers AI's
// compact prompt (buildCompactGenerationSystemPrompt, scenePrompts.js -
// real, tokenizer-measured, kept under the user's own token ceiling,
// 750 -> 1000 as of 2026-09-10 - see that function's own doc comment
// for the current real count), then a pure-JS compile step into the
// real schema.

// No real narration-audio timing is available to size a beat's duration
// from (TTS is currently disabled - see narrationPrefetch.js), so each
// template gets a reasonable flat starting point; buildMographBeatVisual
// itself floors/extends several of these upward already (intro/outro
// text, nodeClusterExtended's own fixed runtime, textPopOut's word-
// count-driven minimum) - this is deliberately just a sane starting
// point for that machinery, not a real narration-derived duration.
const COMPACT_BASE_DURATION = {
  nodeCluster: 3.0,
  connectorList: 3.5,
  phoneSwap: 3.0,
  splitConverge: 2.5,
  mergeCluster: 3.0,
  nodeClusterExtended: 3.0,
  textPopOut: 3.0,
  // Deliberately tiny - this template's own real motion (3 squares pop
  // in, spin, land on a diamond) fully completes in ~1.4s
  // (SQUARE_SPIN_COMPLETE_TIME, sceneSchema.js, after the 2026-09-10
  // slow-down) - a bigger base here would just be clamped back down by
  // buildMographBeatVisual's own clampMographDuration anyway, so
  // starting close to the real value avoids relying on that clamp to do
  // all the work.
  squareSpin: 2.0,
  // Real motion (3 nodes slide in, settle, shrink, unblur) fully
  // completes in ~1.13s (TRIPLE_STACK_COMPLETE_TIME, sceneSchema.js) -
  // same "start close to the real value" reasoning as squareSpin above.
  tripleStack: 2.0,
  // Real motion (fly-in, icon-cycle, rise, 4-row cascade, a direct-user-
  // requested 1.5s pre-eat pause, sequential eat with a per-row dwell,
  // return-to-center) fully completes in ~4.0s (RETURN_END inside
  // buildNodeAbsorbLayers, sceneSchema.js) - same "start close to the real
  // value" reasoning as squareSpin/tripleStack above. Deliberately longer
  // than every other template here - the 1.5s pause is a real, explicit
  // user requirement for THIS beat's own internal pacing, not a violation
  // of the project's separate "≤1.5s hold after everything settles" rule
  // (MOGRAPH_MAX_HOLD_AFTER_SETTLE), which only governs time AFTER
  // RETURN_END, not motion still happening before it.
  nodeAbsorb: 4.0,
  // Immediately overwritten by textTiersMinDuration(wordCount) in
  // sceneSchema.js's own dispatch branch (same "resolve the real
  // duration before building" pattern textPopOut already established) -
  // this is just a reasonable seed, ~textTiersMinDuration(7) for a
  // typical 7-word phrase (bumped 2.0->3.2 alongside the hold's own
  // 0.5->2.0 increase, direct user ask for 1.5s more hold time).
  textTiers: 3.2,
  // Immediately overwritten by blueprintTextMinDuration(sentence1,
  // sentence2) in sceneSchema.js's own dispatch branch - this is just a
  // reasonable seed, ~blueprintTextMinDuration for two typical 4-word
  // sentences (matching the reference's own real word counts).
  blueprintText: 3.3,
  // Immediately overwritten by yearScrollerMinDuration(year, text) in
  // sceneSchema.js's own dispatch branch - this is just a reasonable
  // seed, ~yearScrollerMinDuration for a typical 16-year scroll + a
  // short reveal headline.
  yearScroller: 5.74,
  // Immediately overwritten by counterMinDuration(value, text) in
  // sceneSchema.js's own dispatch branch - this is just a reasonable
  // seed, ~counterMinDuration for a typical count-up + an 8-word
  // caption (real measured value, not guessed).
  counter: 6.07,
  // Immediately overwritten by lineRevealMinDuration() in sceneSchema.js's
  // own dispatch branch - this template's own pacing is entirely fixed
  // (doesn't depend on either text's length), so this seed is just that
  // same real, always-exact value.
  lineReveal: 4.41,
  // Immediately overwritten by typewriterLinkMinDuration(wordCount1) in
  // sceneSchema.js's own dispatch branch - this is just a reasonable
  // seed, ~typewriterLinkMinDuration for a typical 2-word line1.
  typewriterLink: 4.61,
  // Immediately overwritten by dotConstellationMinDuration() in
  // sceneSchema.js's own dispatch branch - this template's own pacing is
  // entirely fixed (doesn't depend on the caption's length), so this seed
  // is just that same real, always-exact value.
  dotConstellation: 4.635,
  // Immediately overwritten by buttonDrawMinDuration() in sceneSchema.js's
  // own dispatch branch - this template's own pacing is entirely fixed
  // (doesn't depend on the label's own length), so this seed is just that
  // same real, always-exact value.
  buttonDraw: 3.17,
  // Immediately overwritten by mouseWordDragMinDuration(beforeCount,
  // afterCount) in sceneSchema.js's own dispatch branch - this is just a
  // reasonable seed, ~mouseWordDragMinDuration(2, 2) for a typical
  // 2-word before-phrase + 2-word after-phrase (the "Work Smarter | With
  // AI | Every Day" reference shape).
  mouseWordDrag: 3.42,
};

/**
 * Pure translation, no AI involved - the compact {beats:[{template,
 * narration, vars, accentColor}]} shape the AI actually produces into
 * the real {scenes:[{params,mograph}]} shape buildMographBeatVisual/
 * validateSceneJSON expect. "vars" fields map directly onto each
 * template's own real mograph fields (icons, chosenIndex, items, etc.
 * - see buildMographBeatVisual's own dispatch for the authoritative
 * list), so this is mostly a straight spread - buildMographBeatVisual's
 * own existing type/shape checks are what actually validate them, not
 * duplicated here.
 */
function compileCompactSpecToSceneJSON(compact, chosenTemplates) {
  if (!compact || !Array.isArray(compact.beats) || compact.beats.length === 0) {
    throw new Error('compact spec is missing a real, non-empty "beats" array');
  }
  const fieldErrors = [];
  const scenes = compact.beats.map((beat, i) => {
    if (!beat || typeof beat.template !== 'string' || !beat.template.trim()) {
      fieldErrors.push(`beat[${i}] is missing its "template"`);
      return null;
    }
    const vars = isPlainObjectLocal(beat.vars) ? beat.vars : {};
    const fieldError = validateCompactBeatVars(beat.template, vars);
    if (fieldError) fieldErrors.push(`beat[${i}] (${beat.template}) ${fieldError}`);
    const mograph = { type: beat.template, ...vars };
    if (typeof beat.accentColor === 'string' && beat.accentColor.trim()) mograph.accentColor = beat.accentColor.trim();
    return {
      params: {
        duration: COMPACT_BASE_DURATION[beat.template] || 3.0,
        narration: typeof beat.narration === 'string' ? beat.narration.trim() : '',
      },
      mograph,
    };
  });

  // Real, direct user requirement (2026-09-10, after two separate live
  // incidents where the model's own template SELECTION was the
  // dominant failure cause): the 5-7 templates for this video are now
  // picked in CODE (pickRandomTemplates, scenePrompts.js) before the
  // model ever sees the prompt - it's just told which ones to write.
  // Verified here that it actually did, alongside the per-field errors
  // above (one combined retry message instead of ping-ponging between
  // error types across multiple retries) - this is what makes the whole
  // "wrong count/wrong distinctness" failure class structurally
  // impossible rather than just less likely.
  if (Array.isArray(chosenTemplates) && chosenTemplates.length > 0) {
    const used = compact.beats
      .map((b) => (b && typeof b.template === 'string' ? b.template.trim() : null))
      .filter(Boolean);
    const usedSet = new Set(used);
    const chosenSet = new Set(chosenTemplates);
    const missing = chosenTemplates.filter((t) => !usedSet.has(t));
    const extra = [...usedSet].filter((t) => !chosenSet.has(t));
    const dupes = [...usedSet].filter((t) => used.filter((u) => u === t).length > 1);
    if (missing.length > 0 || extra.length > 0 || dupes.length > 0) {
      const parts = [];
      if (missing.length) parts.push(`missing: ${missing.join(', ')}`);
      if (extra.length) parts.push(`not in your assigned list: ${extra.join(', ')}`);
      if (dupes.length) parts.push(`repeated: ${dupes.join(', ')}`);
      fieldErrors.push(`"beats" must use EXACTLY your assigned ${chosenTemplates.length} templates (${chosenTemplates.join(', ')}), one each - ${parts.join('; ')}`);
    }
  }

  // Thrown BEFORE handing anything to buildMographBeatVisual - see
  // validateCompactBeatVars' own doc comment for why: its silent-drop
  // behavior turns exactly this into an unhelpful generic error later,
  // so catching it here with specific per-beat reasons first is what
  // actually gives a retry something to fix.
  if (fieldErrors.length > 0) throw new Error(fieldErrors.join('; '));
  return { scenes };
}
function isPlainObjectLocal(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

// Same pattern sceneSchema.js's own MOGRAPH_ICON_RE uses (kept as a
// local copy rather than exported/imported - a one-line regex isn't
// worth wiring a new export through for).
const ICON_RE = /^[a-z0-9-]+:[a-z0-9-]+$/i;
function isRealIcon(v) { return typeof v === 'string' && ICON_RE.test(v); }

/**
 * Real, direct finding (2026-09-10): buildMographBeatVisual SILENTLY
 * drops a beat whose "vars" don't match its own dispatch conditions -
 * no per-field reason, it just never builds layers for it. A real local
 * test hit validateSceneJSON's own generic "every beat was dropped as
 * unusable" error with zero indication of WHICH field on WHICH beat was
 * wrong, giving the retry prompt nothing concrete to fix. This mirrors
 * buildMographBeatVisual's own per-template conditions EXACTLY (see its
 * own dispatch in sceneSchema.js) so a bad beat gets a specific,
 * actionable error instead - "beat[2] (mergeCluster): icons needs at
 * least 2 real Iconify names, got 1" is something a retry can actually
 * act on; "every beat was dropped" isn't.
 */
function validateCompactBeatVars(template, vars) {
  const icons = Array.isArray(vars.icons) ? vars.icons.filter(isRealIcon) : [];
  switch (template) {
    case 'nodeCluster':
      if (icons.length < 3) return `needs "icons": at least 3 real Iconify names (got ${icons.length} valid ones)`;
      return null;
    case 'connectorList': {
      // 2+ -> exactly 3 (2026-09-16, direct user requirement, "no
      // exceptions"): a 2-item connector line is mathematically straight
      // (no curve possible through only 2 points) - see sceneSchema.js's
      // own buildConnectorListLayers dispatch for the full reasoning.
      const items = Array.isArray(vars.items) ? vars.items.filter((it) => isPlainObjectLocal(it) && isRealIcon(it.icon) && typeof it.label === 'string' && it.label.trim()) : [];
      if (items.length !== 3) return `needs "items": EXACTLY 3 entries, each a real {icon,label} (got ${items.length} valid ones)`;
      return null;
    }
    case 'phoneSwap':
      if (typeof vars.text !== 'string' || !vars.text.trim()) return 'needs a non-empty "text" (the phone-screen headline)';
      if (!isRealIcon(vars.icon)) return 'needs a real Iconify "icon" to swap to';
      return null;
    case 'splitConverge':
      if (!isRealIcon(vars.icon)) return 'needs a real Iconify "icon"';
      return null;
    case 'mergeCluster':
      if (icons.length < 2) return `needs "icons": at least 2 real Iconify names (got ${icons.length} valid ones)`;
      if (!isRealIcon(vars.resultIcon)) return 'needs a real Iconify "resultIcon"';
      return null;
    case 'nodeClusterExtended':
      if (icons.length < 3) return `needs "icons": at least 3 real Iconify names (got ${icons.length} valid ones)`;
      if (!isRealIcon(vars.newIcon)) return 'needs a real Iconify "newIcon"';
      if (typeof vars.mergeText !== 'string' || !vars.mergeText.trim()) return 'needs a non-empty "mergeText"';
      return null;
    case 'textPopOut':
      if (typeof vars.text !== 'string' || !vars.text.trim()) return 'needs a non-empty "text"';
      return null;
    case 'squareSpin':
      if (typeof vars.text !== 'string' || !vars.text.trim()) return 'needs a non-empty "text"';
      if (!isRealIcon(vars.icon1)) return 'needs a real Iconify "icon1"';
      if (!isRealIcon(vars.icon2)) return 'needs a real Iconify "icon2"';
      return null;
    case 'tripleStack': {
      const items = Array.isArray(vars.items) ? vars.items.filter((it) => isPlainObjectLocal(it) && isRealIcon(it.icon) && typeof it.text === 'string' && it.text.trim()) : [];
      if (items.length !== 3) return `needs "items": exactly 3 entries, each a real {icon,text} (got ${items.length} valid ones)`;
      return null;
    }
    case 'nodeAbsorb': {
      if (!isRealIcon(vars.headerIcon)) return 'needs a real Iconify "headerIcon"';
      if (typeof vars.headerText !== 'string' || !vars.headerText.trim()) return 'needs a non-empty "headerText"';
      const items = Array.isArray(vars.items) ? vars.items.filter((it) => isPlainObjectLocal(it) && isRealIcon(it.icon) && typeof it.text === 'string' && it.text.trim()) : [];
      if (items.length !== 4) return `needs "items": exactly 4 entries, each a real {icon,text} (got ${items.length} valid ones)`;
      return null;
    }
    case 'textTiers': {
      // Real, confirmed-live failure (2026-09-11, a real local generation
      // for the topic "Money"): the model repeatedly missed the 5-10
      // word window on this specific field across 8+ separate attempts
      // (11, 3, 12, 16, 4, 29, 13, 4 words observed), exhausting the
      // whole retry budget and failing the generation outright. The
      // UPPER bound here was actively counterproductive: sceneSchema.js's
      // own dispatch branch already does `.slice(0, 10)` before ever
      // calling the builder, so an over-length phrase was ALWAYS
      // perfectly recoverable - this check was rejecting-and-retrying
      // something the builder could already handle for free. Dropped the
      // upper bound entirely; only the lower bound (a real correctness
      // requirement - splitTextTiersLines needs at least ~4-5 words to
      // produce a real, non-degenerate 3-line split) remains a hard
      // reject.
      const words = typeof vars.text === 'string' ? vars.text.trim().split(/\s+/).filter((w) => w.length > 0) : [];
      if (words.length < 5) return `needs "text": a real phrase of at least 5 words (got ${words.length} words) - it gets auto-split into 3 lines and auto-capped at 10 words if longer, no need to count precisely`;
      return null;
    }
    case 'blueprintText': {
      // Same "no redundant upper-bound reject" lesson as textTiers above
      // - sceneSchema.js's own dispatch branch already truncates each
      // sentence to 8 words, so only a real lower-bound floor (a single
      // word isn't a "sentence") is worth hard-rejecting here.
      const w1 = typeof vars.sentence1 === 'string' ? vars.sentence1.trim().split(/\s+/).filter((w) => w.length > 0) : [];
      const w2 = typeof vars.sentence2 === 'string' ? vars.sentence2.trim().split(/\s+/).filter((w) => w.length > 0) : [];
      if (w1.length < 2) return `needs "sentence1": at least 2 words (got ${w1.length})`;
      if (w2.length < 2) return `needs "sentence2": at least 2 words (got ${w2.length})`;
      return null;
    }
    case 'yearScroller': {
      // No upper-bound reject on "year" either - sceneSchema.js's own
      // dispatch branch already clamps to [1870,2040] and rounds, same
      // "the builder already tolerates it gracefully" lesson as above.
      if (!Number.isFinite(vars.year)) return 'needs "year": a real number (a specific year, e.g. 1969 or 2027)';
      const tw = typeof vars.text === 'string' ? vars.text.trim().split(/\s+/).filter((w) => w.length > 0) : [];
      if (tw.length < 1) return 'needs "text": a real headline (at least 1 word) revealed after the scroller lands';
      return null;
    }
    case 'counter': {
      // No upper-bound reject on "value" - sceneSchema.js's own dispatch
      // branch already clamps to [1, 999999999] and rounds.
      if (!Number.isFinite(vars.value)) return 'needs "value": a real number to count up to (e.g. 45355)';
      // Real lower-bound floor: splitCounterCaptionLines (sceneSchema.js)
      // needs enough words for a real 2-line split where line 2 has
      // more words than line 1 - a 1-2 word caption degenerates to a
      // single line instead.
      const tw = typeof vars.text === 'string' ? vars.text.trim().split(/\s+/).filter((w) => w.length > 0) : [];
      if (tw.length < 4) return `needs "text": a real caption of at least 4 words (got ${tw.length}) - it gets auto-split into 2 lines`;
      if (vars.icon !== undefined && !isRealIcon(vars.icon)) return `"icon" is optional, but if given must be a real "prefix:name" icon (got ${JSON.stringify(vars.icon)}) - omit it entirely if no icon is needed`;
      return null;
    }
    case 'lineReveal': {
      const w1 = typeof vars.text1 === 'string' ? vars.text1.trim().split(/\s+/).filter((w) => w.length > 0) : [];
      const w2 = typeof vars.text2 === 'string' ? vars.text2.trim().split(/\s+/).filter((w) => w.length > 0) : [];
      if (w1.length < 1) return 'needs "text1": a real bold headline (at least 1 word)';
      if (w2.length < 1) return 'needs "text2": a real secondary line (at least 1 word)';
      return null;
    }
    case 'typewriterLink': {
      // Real, measured finding (2026-09-16 production logs): a hard
      // >=2-words requirement on line1 (originally: the connector's own
      // opening drop spawns from the space between two words, a 1-word
      // line1 has no such gap) forced 6 wasted retries in a SINGLE job,
      // all on this one field - Cloudflare Workers AI doesn't reliably
      // honor it despite the prompt's own worked example already
      // showing 2 words. buildTypewriterLinkLayers (sceneSchema.js) has
      // ALWAYS had a real, deliberate fallback for exactly this case -
      // "a real 1-word line1... falls back to spawning dead-center
      // rather than crashing, same defensive spirit as every other
      // template's own isolated-input tolerance" - so this was blocking
      // a working, intentional code path, not preventing a broken one.
      // Relaxed to match line2/line3's own "at least 1 word" bar.
      const l1 = typeof vars.line1 === 'string' ? vars.line1.trim().split(/\s+/).filter((w) => w.length > 0) : [];
      const l2 = typeof vars.line2 === 'string' ? vars.line2.trim().split(/\s+/).filter((w) => w.length > 0) : [];
      const l3 = typeof vars.line3 === 'string' ? vars.line3.trim().split(/\s+/).filter((w) => w.length > 0) : [];
      if (l1.length < 1) return 'needs "line1": a real short opening phrase (at least 1 word)';
      if (l2.length < 1) return 'needs "line2": a real short connector phrase (at least 1 word)';
      if (l3.length < 1) return 'needs "line3": a real outcome phrase (at least 1 word)';
      return null;
    }
    case 'dotConstellation': {
      const tw = typeof vars.text === 'string' ? vars.text.trim().split(/\s+/).filter((w) => w.length > 0) : [];
      if (tw.length < 2) return `needs "text": a real short caption of at least 2 words (got ${tw.length})`;
      return null;
    }
    case 'buttonDraw': {
      const tw = typeof vars.text === 'string' ? vars.text.trim().split(/\s+/).filter((w) => w.length > 0) : [];
      if (tw.length < 1) return 'needs "text": a real short button label (e.g. "Get Started")';
      return null;
    }
    case 'mouseWordDrag': {
      const bw = typeof vars.before === 'string' ? vars.before.trim().split(/\s+/).filter((w) => w.length > 0) : [];
      const cw = typeof vars.chip === 'string' ? vars.chip.trim().split(/\s+/).filter((w) => w.length > 0) : [];
      const aw = typeof vars.after === 'string' ? vars.after.trim().split(/\s+/).filter((w) => w.length > 0) : [];
      if (bw.length < 1) return 'needs "before": at least 1 word of the sentence BEFORE the missing phrase (e.g. "Work Smarter")';
      if (cw.length < 1) return 'needs "chip": at least 1 word - the missing MAIN POINT a mouse drags in (e.g. "With AI")';
      if (aw.length < 1) return 'needs "after": at least 1 word of the sentence AFTER the missing phrase (e.g. "Every Day")';
      return null;
    }
    default:
      return `"${template}" is not one of the 19 real template names`;
  }
}

/**
 * Real, direct frame-inspection finding (2026-09-09, "trash" quality
 * complaint): validateCompactBeatVars/isRealIcon above only check an
 * icon's own STRING SHAPE ("prefix:name") - never whether that icon
 * actually exists. The 8B model regularly invents plausible-sounding
 * names that don't ("mdi:unlock" - the real one is "mdi:lock-open",
 * "mdi:balance-scale" - the real one is "mdi:scale-balance"), which
 * iconFetch.js's own render-time fetch then 404s on, silently dropping
 * the icon and leaving an empty circle/ring/dot in the final video -
 * confirmed via direct frame extraction, not assumed. Fixed by verifying
 * every icon a beat actually resolved to BEFORE accepting the spec, so a
 * hallucinated name becomes a normal, specific retry error (same
 * mechanism validateCompactBeatVars already uses) instead of a broken
 * render nobody catches until a human watches it. Iconify's own bulk
 * "does this exist" endpoint (one request per PREFIX, not per icon -
 * typically 1-3 requests total for a whole generation since most icons
 * share "mdi:") makes this cheap enough to run on every attempt; fails
 * OPEN on a transport hiccup (skips verification rather than blocking
 * generation on Iconify's own uptime) since the existing render-time
 * fallback still keeps a genuinely-unreachable check from crashing a job.
 */
function collectIconNamesFromScenes(scenes) {
  const names = [];
  const walk = (layers) => {
    if (!Array.isArray(layers)) return;
    for (const layer of layers) {
      if (!layer || typeof layer !== 'object') continue;
      if (layer.type === 'image' && typeof layer.icon === 'string' && layer.icon.trim()) names.push(layer.icon);
      if (layer.type === 'precomp') walk(layer.layers);
    }
  };
  for (const scene of scenes) walk(scene.visual?.layers);
  return names;
}

// Real gap found (2026-09-10, direct user follow-up after the
// splitConverge fallback fix: "have u fix this" re: icons still
// occasionally rendering blank): this used to silently give up
// verification for a whole prefix on ANY single failure (a transient
// 429/500, a timeout) via a bare `if (!res.ok) return`, no retry at
// all - a bad/hallucinated icon name hitting that exact moment would
// slip through completely unverified and only surface later as a blank
// icon at render time. Retries with the same backoff-with-jitter
// pattern fetchAndRasterizeIcon (iconFetch.js) already uses, so a
// transient hiccup here no longer means "skip verification entirely".
const ICON_EXISTENCE_CHECK_MAX_ATTEMPTS = 3;
async function findNonexistentIcons(iconNames) {
  const uniqueNames = [...new Set(iconNames)].filter(isRealIcon);
  if (uniqueNames.length === 0) return [];
  const byPrefix = new Map();
  for (const full of uniqueNames) {
    const [prefix, ...rest] = full.split(':');
    const name = rest.join(':');
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
    byPrefix.get(prefix).push(name);
  }
  const notFound = [];
  await Promise.all([...byPrefix.entries()].map(async ([prefix, names]) => {
    const url = `https://api.iconify.design/${encodeURIComponent(prefix)}.json?icons=${names.map(encodeURIComponent).join(',')}`;
    for (let attempt = 1; attempt <= ICON_EXISTENCE_CHECK_MAX_ATTEMPTS; attempt++) {
      try {
        const res = await fetch(url, { timeout: 8000 });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        for (const missing of data.not_found || []) notFound.push(`${prefix}:${missing}`);
        return;
      } catch (err) {
        if (attempt < ICON_EXISTENCE_CHECK_MAX_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, 300 * 2 ** (attempt - 1) + Math.random() * 200));
          continue;
        }
        // Fails OPEN only after exhausting real retries, not on the
        // first hiccup - a genuinely down Iconify shouldn't block
        // generation outright (the render-time fallback still catches
        // a truly-bad icon, just less gracefully than catching it here).
        console.warn(`[sceneGenClient] icon existence check failed for prefix "${prefix}" after ${attempt} attempt(s) (${err.message}) - skipping verification for these`);
      }
    }
  }));
  return notFound;
}

// Separate from TOTAL_STRUCTURAL_RETRY_BUDGET (3, tuned for the OLD,
// slow/paid OpenRouter path where every retry cost 60-100s+) - real
// local testing found the free 8B model occasionally needs more than 3
// attempts to land a fully valid spec (one real run hit "every beat
// dropped as unusable" 3 times in a row). Since a retry here costs
// single-digit seconds and nothing per call, a more generous budget is
// free real reliability, not a real latency tradeoff.
// 6 -> 10 -> 18 (2026-09-09): real local testing kept hitting full
// exhausted-budget failures even at 10, across a wide variety of
// DIFFERENT causes each time (narration hook style, a hallucinated icon
// name, an empty required field, a repeated-first-word mistake) - no
// single fix eliminates all of them, and a small 8B model landing every
// constraint at once is inherently probabilistic. A real timed run
// against this exact budget showed most individual retries fail fast
// (~2-3s each), so even a much larger budget stays well under the 220s+
// that drove the original move off OpenRouter - and outright failing the
// whole job is a strictly worse outcome than one more retry, for both
// the speed and quality complaints this pipeline exists to fix.
const COMPACT_RETRY_BUDGET = 18;

/**
 * The single Cloudflare call plus its own structural-retry loop -
 * mirrors generateWholeSceneJSON's own shape (parse -> build mograph ->
 * validate -> feed errors back -> retry) but against the much smaller
 * compact prompt/output, so a retry here is cheap (real measured speed:
 * 3-6s per call) rather than the 60-100s+ round trips the old OpenRouter
 * path paid for every retry.
 */
async function generateCompactBeatSpec(userPrompt, {
  retriesLeft = COMPACT_RETRY_BUDGET, priorErrors = null, chosenTemplates = null, topic = null, styleNotes = '',
} = {}) {
  // Picked ONCE per generation, not re-rolled per retry - a real,
  // direct user requirement: "make them randomize but make it that if
  // a scene is chosen at random it cant be chosen again." A retry
  // passes the SAME chosenTemplates back through (see every recursive
  // call below) so it only ever fixes narration/vars issues, never
  // re-picks the template set mid-generation. `chosenTemplates` itself
  // is now always pickRandomTemplates's own uniform pick, already
  // shuffled into its final order, from generateSceneJSON below -
  // pickRandomTemplates here only covers a caller that skips that (a
  // direct unit test, etc.) and never passes chosenTemplates at all.
  const templates = chosenTemplates || pickRandomTemplates();
  const systemPrompt = buildCompactGenerationSystemPrompt(templates);
  // `topic` defaults to the raw prompt for any caller that skips the
  // new split step (direct unit tests, etc.) - see splitPromptIntoTopic
  // AndStyle's own doc comment for why this is a SEPARATE small call
  // rather than folded into this one.
  const effectiveTopic = topic || userPrompt;
  let userMessage = `Topic: ${effectiveTopic}`;
  if (styleNotes) userMessage += `\nStyle & instructions: ${styleNotes}`;
  userMessage += `\n\nCreative angle for this generation: ${pickRandomCreativeAngle()}`;
  if (priorErrors) userMessage += `\n\nYour previous attempt was invalid:\n${priorErrors.join('\n')}\n\nFix these specific problems and output the complete, corrected JSON.`;

  // 1500 -> 3000 -> 4096 (2026-09-09): a real local test hit finish_reason:
  // "length" at 1500, then AGAIN at 3000, once the model tried to write
  // out 6+ full beats worth of JSON (icons arrays, labels, a retry's own
  // echoed prior-error text, etc.) - Cloudflare's free tier has no
  // per-token cost the way the earlier paid MiniMax path did, so there's
  // no real downside to generous headroom here; calls stay in the
  // single-digit seconds regardless.
  let raw;
  try {
    // 0.8 -> 0.5 (2026-09-09): real local testing found this small 8B
    // model's own format/constraint adherence (exact beat count, valid
    // JSON shape, no repeated templates) was the actual bottleneck, not
    // a lack of creative variety - a lower temperature is the standard,
    // well-established lever for exactly that failure mode on a small
    // model, at the cost of somewhat less varied phrasing, which matters
    // far less here than actually landing a valid spec.
    raw = await callCloudflareRaw(systemPrompt, userMessage, { jsonMode: true, maxTokens: 4096, temperature: 0.5 });
  } catch (err) {
    // Real, confirmed-live bug (2026-09-09): this call was never wrapped
    // in the retry loop at all - a transport failure (truncation, a
    // timeout, a Cloudflare hiccup) threw straight out of this whole
    // function regardless of how much retriesLeft budget remained,
    // killing the entire job on what should have just been one more
    // attempt. Retries are cheap here (single-digit seconds, free) -
    // there's no reason a transport blip should be fatal when a bad
    // JSON shape from the SAME call already gets retried below.
    if (retriesLeft > 0) {
      console.warn(`[sceneGenClient] Cloudflare call failed (${err.message}), retrying (${retriesLeft - 1} left)...`);
      return generateCompactBeatSpec(userPrompt, { retriesLeft: retriesLeft - 1, priorErrors, chosenTemplates: templates, topic, styleNotes });
    }
    throw err;
  }
  let compact;
  try {
    compact = extractJson(raw);
  } catch (err) {
    if (retriesLeft > 0) {
      console.warn(`[sceneGenClient] compact spec JSON parse failed (${err.message}), retrying (${retriesLeft - 1} left)...`);
      return generateCompactBeatSpec(userPrompt, { retriesLeft: retriesLeft - 1, priorErrors: [`Your last response was not valid JSON: ${err.message}`], chosenTemplates: templates, topic, styleNotes });
    }
    throw err;
  }

  let sceneJSON;
  try {
    sceneJSON = compileCompactSpecToSceneJSON(compact, templates);
  } catch (err) {
    if (retriesLeft > 0) {
      console.warn(`[sceneGenClient] compact spec shape invalid (${err.message}), retrying (${retriesLeft - 1} left)...`);
      return generateCompactBeatSpec(userPrompt, { retriesLeft: retriesLeft - 1, priorErrors: [err.message], chosenTemplates: templates, topic, styleNotes });
    }
    throw err;
  }

  sceneJSON.scenes.forEach(buildMographBeatVisual);
  const { valid, errors } = validateSceneJSON(sceneJSON);
  if (!valid) {
    if (retriesLeft > 0) {
      console.warn(`[sceneGenClient] compiled scene JSON failed validation (${errors.length} error(s)), retrying (${retriesLeft - 1} left): ${errors.slice(0, 3).join('; ')}`);
      return generateCompactBeatSpec(userPrompt, { retriesLeft: retriesLeft - 1, priorErrors: errors, chosenTemplates: templates, topic, styleNotes });
    }
    throw new Error(`Generated scene JSON failed schema validation after retries: ${errors.join('; ')}`);
  }

  const notFoundIcons = await findNonexistentIcons(collectIconNamesFromScenes(sceneJSON.scenes));
  if (notFoundIcons.length > 0) {
    if (retriesLeft > 0) {
      console.warn(`[sceneGenClient] ${notFoundIcons.length} icon(s) don't exist on Iconify (${notFoundIcons.join(', ')}), retrying (${retriesLeft - 1} left)...`);
      return generateCompactBeatSpec(userPrompt, {
        retriesLeft: retriesLeft - 1,
        priorErrors: [`These icon names don't exist on Iconify and must be replaced with real ones: ${notFoundIcons.join(', ')}`],
        chosenTemplates: templates,
        topic,
        styleNotes,
      });
    }
    console.warn(`[sceneGenClient] ${notFoundIcons.length} icon(s) don't exist after exhausting retries (${notFoundIcons.join(', ')}) - shipping anyway, render-time fallback will drop them`);
  }

  return sceneJSON;
}

// Direct user requirement (2026-09-15): "Add smart prompting, so the ai
// will better understand the user's instructions." The live app only
// ever has ONE free-text field (the topic prompt) - this splits it into
// a real subject/topic vs. any style/tone/format instructions the user
// mixed into the same string (e.g. "videos about X but keep it funny and
// casual"), BEFORE the real compact-generation call, so that call can
// address both explicitly instead of guessing from one blended string.
// A separate, small, cheap call on the SAME free Cloudflare Workers AI
// provider already used everywhere else in this file - this is a live
// product-architecture choice, not the kind of repeated dev-testing
// volume this project's own "keep API call batches small" rule is about.
// Fails SOFT: any error here just falls back to today's exact behavior
// (the whole raw prompt as the topic, no style notes) rather than ever
// blocking generation over this one extra step.
const PROMPT_SPLIT_SYSTEM_PROMPT = `You split a short-form video request into two parts. Respond with ONLY one valid JSON object - no markdown fences, no commentary.

The user's own text may mix a SUBJECT (what the video is about) with STYLE/TONE/FORMAT instructions (e.g. "funny", "casual", "for teenagers", "focus on X", "keep it serious", "target beginners") all in one string.

Output ONLY: {"topic": "the core subject, as a short phrase", "styleNotes": "any style/tone/audience/format instructions given, or an empty string if none were given"}`;

async function splitPromptIntoTopicAndStyle(userPrompt) {
  try {
    const raw = await callCloudflareRaw(PROMPT_SPLIT_SYSTEM_PROMPT, userPrompt, { jsonMode: true, maxTokens: 200, temperature: 0.3 });
    const parsed = extractJson(raw);
    const topic = typeof parsed.topic === 'string' && parsed.topic.trim() ? parsed.topic.trim() : userPrompt;
    const styleNotes = typeof parsed.styleNotes === 'string' ? parsed.styleNotes.trim() : '';
    return { topic, styleNotes };
  } catch (err) {
    console.warn(`[sceneGenClient] prompt split failed (${err.message}), using the raw prompt as the topic with no style notes`);
    return { topic: userPrompt, styleNotes: '' };
  }
}

/** Plain Fisher-Yates, same real algorithm scenePrompts.js's own pickRandomTemplates uses (not the "sort by random comparator" non-uniform trick) - reused here to randomize the ORDER of whichever 6 templates pickRandomTemplates just picked, a deliberately separate concern from the picking itself. */
function shuffleArray(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// pickTemplatesForTopic (an AI call asking the model to pick 6 templates
// by "genuine topical fit") REMOVED (2026-09-17, direct user demand: run
// REAL tests confirming every template has an equal, verifiable chance
// of being picked, "no strings attach to make it pick mainly these ones
// and forget the restttt"). A real 25-call test against this exact
// function found textPopOut picked 25/25 times (100%), counter 22/25
// (88%), connectorList 20/25 (80%), while phoneSwap, mergeCluster,
// typewriterLink and mouseWordDrag were picked ZERO times - "topical
// fit" in practice meant an LLM gravitating toward whichever templates
// read as generically-applicable to almost any topic, exactly the bias
// suspected. pickRandomTemplates (scenePrompts.js) - previously only the
// failsafe for when this AI call failed - is now the ONLY selection
// mechanism: a plain, proven-unbiased Fisher-Yates shuffle, mathematically
// guaranteeing every template an equal 1/COMPACT_TEMPLATE_NAMES.length
// chance per slot - see pickRandomTemplates' own doc comment for why
// that's a real property of the algorithm itself (derived from the live
// template count, never a hardcoded percentage anywhere) and not just
// true for today's specific count of 19, plus the real 100,000-iteration
// local test confirming it in practice, not just reasoned about. This
// does trade away the earlier "AI picks what actually fits the topic"
// behavior (a separate, direct user request from 2026-09-15) - the two
// requirements are fundamentally incompatible (genuine topical fit is,
// by definition, topic-dependent and can never be uniform), and this
// session's explicit, repeated instruction was to prioritize guaranteed
// equal probability.

// targetDurationSeconds kept as a parameter (callers still pass it) but
// not used yet - the compact flow assigns each beat a flat base
// duration (COMPACT_BASE_DURATION above) rather than deriving pacing
// from a target total. TTS re-enabled (2026-09-15, narrationPrefetch.js)
// DOES now override each beat's own duration to match real spoken audio
// length, but that happens downstream of scene generation (renderWorker.js
// calls prefetchNarration after this function returns), not here - worth
// revisiting whether this SHOULD feed back into per-beat base duration
// if a real need for duration targeting comes up.
async function generateSceneJSON(userPrompt, targetDurationSeconds = 12) {
  console.log('[sceneGenClient] generating compact beat spec (Cloudflare Workers AI)...');

  const { topic, styleNotes } = await splitPromptIntoTopicAndStyle(userPrompt);

  // Always a uniform random pick now (pickRandomTemplates's own doc
  // comment has the full reasoning/measured data) - selection and
  // ordering stay two separate concerns (shuffleArray here is a second,
  // independent shuffle of the ALREADY-chosen 6, not part of picking
  // which 6), same split as before.
  const chosenTemplates = shuffleArray(pickRandomTemplates());

  const sceneJSON = await generateCompactBeatSpec(userPrompt, { chosenTemplates, topic, styleNotes });

  // Guaranteed brand close on every fresh generation (direct user
  // requirement) - appended AFTER the AI's own beats are already fully
  // valid, deliberately OUTSIDE generateCompactBeatSpec's own retry loop
  // (see buildCtaOutroBeat's own doc comment in sceneSchema.js for why:
  // this content is fixed/hand-tuned, never AI-authored, so there's
  // nothing a retry could ever fix in it - keeping it out of that loop
  // means a validation hiccup in MY beat can never burn the AI's own
  // retry budget or get fed back to the model as a "fix this" prompt for
  // content it never wrote). One more validateSceneJSON pass over the
  // combined array is still real and cheap (pure JS, no AI call) - a
  // free safety net (off-canvas clamps, contrast fixes) for the new beat,
  // logged rather than thrown on failure since there's no AI retry that
  // could act on it anyway.
  sceneJSON.scenes.push(buildCtaOutroBeat());
  const ctaCheck = validateSceneJSON(sceneJSON);
  if (!ctaCheck.valid) {
    console.warn(`[sceneGenClient] scene JSON failed validation after appending the CTA outro beat (${ctaCheck.errors.length} error(s)) - shipping anyway: ${ctaCheck.errors.slice(0, 3).join('; ')}`);
  }

  return sceneJSON;
}

// Video editing is disabled end-to-end (2026-09-16 - see this file's own
// top-of-file doc comment) - server.js's own POST /api/generate never
// passes a real parentSceneJSON anymore, so renderWorker.js's own
// `parentSceneJSON ? await generateEditedSceneJSON(...) : ...` ternary
// never actually takes this branch in production. Kept as a real function
// (not deleted) so the signature/call site elsewhere stay valid and
// re-enabling is a clear, deliberate act - throws immediately rather than
// reaching for a transport that no longer exists, since OpenRouter (this
// function's only real provider, sized for buildEditSystemPrompt's own
// ~18,000-token prompt - far more than Cloudflare's compact-prompt path
// was ever built for) was removed project-wide the same day.
async function generateEditedSceneJSON() {
  throw new Error('Video editing is currently disabled (no AI provider wired up for it) - see sceneGenClient.js\'s own generateEditedSceneJSON for how to re-enable.');
}

// Real production incident this guards against: a hung generation call
// leaving a job stuck "processing" forever with no way for the user to
// tell it had actually died rather than just being slow.
// 8 -> 11 minutes (2026-09-06): a real 28s-target job hit this ceiling
// outright and failed, confirmed live. A genuinely successful generation
// earlier the same session took 5.3 minutes for a shorter (~12s target,
// fewer required beats) video against this same slow provider - a
// longer target needs more distinct templates to fill 3-6 beats, each
// beat's own encode/validate/retry cycle costing real time (MiniMax via
// OpenRouter runs 60-100s+ per call), so a longer video plausibly just
// needed more of that same real, working-as-designed retry time rather
// than being newly stuck. Raised rather than left to fail outright on
// exactly the videos users are more likely to actually want (a 12s
// default is already on the short end for real content).
const GENERATION_HARD_TIMEOUT_MS = 11 * 60 * 1000;

function withHardTimeout(promiseFactory, label) {
  return async (...args) => {
    let timeoutHandle;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error(`${label} exceeded its ${GENERATION_HARD_TIMEOUT_MS / 1000}s hard timeout - failing fast instead of leaving the job stuck "processing" indefinitely.`)),
        GENERATION_HARD_TIMEOUT_MS,
      );
    });
    try {
      return await Promise.race([promiseFactory(...args), timeoutPromise]);
    } finally {
      clearTimeout(timeoutHandle);
    }
  };
}

module.exports = {
  generateSceneJSON: withHardTimeout(generateSceneJSON, 'generateSceneJSON'),
  generateEditedSceneJSON: withHardTimeout(generateEditedSceneJSON, 'generateEditedSceneJSON'),
};
