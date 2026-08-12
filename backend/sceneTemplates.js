/**
 * SCENE TEMPLATE REGISTRY
 * ------------------------------------------------------------------
 * Same architecture as before: this is the single source of truth for
 * what Mistral is allowed to output, and what we validate its JSON
 * against before rendering. Mistral never writes rendering code - it
 * picks a template name and fills in params defined here.
 *
 * v1 of the Skia-based engine ships with 5 templates + 2 transitions -
 * a deliberately smaller set than the old Revideo version, built and
 * verified working rather than a larger set built blind. More get
 * added the same way (one at a time, rendered and checked) as this
 * matures.
 */

const { VISUAL_SYSTEMS } = require('./visualSystems');
const { validateShapeRecipe } = require('./shapeRecipe');

/**
 * These two apply to EVERY template regardless of which hero content
 * it draws, since the composition layer (background motif + corner
 * tag + secondary accent) wraps every scene universally, not per-
 * template. Merged into each template's own params below so the
 * existing per-template validation loop handles them with zero
 * special-casing.
 */
const SHARED_PARAMS = {
  tag: {
    type: 'string',
    maxLength: 16,
    default: 'INSIGHT',
    description: 'Short 1-2 word punchy label for the corner tag badge, relating to THIS scene\'s specific content (e.g. "WARNING", "FACT", "DATA", "TIP") - not generic filler.',
  },
  accentShape: {
    type: 'enum',
    values: ['bracket', 'crosshair', 'dots', 'arrow', 'plus', 'triangle'],
    default: 'bracket',
    description: 'Which secondary background accent shape best complements this scene\'s meaning.',
  },
  heroVisual: {
    type: 'enum',
    values: ['ribbon', 'halo', 'mark', 'burst', 'alert', 'check', 'spark', 'clock', 'money', 'chart', 'lock', 'heart', 'watch', 'phone', 'house', 'car', 'gift', 'trophy', 'rocket', 'camera', 'briefcase', 'coffee'],
    default: 'mark',
    description: 'A LARGE bold shape/icon shown above this scene\'s text - the dominant visual, not decoration. Pick a concrete icon (watch, rocket, house, etc.) when the content names that literal thing; pick an abstract mark (ribbon, halo, mark, burst) otherwise. Every scene needs one - this is what makes the video eye-catching, not just text on a background.',
  },
  carBodyStyle: {
    type: 'enum',
    values: ['sedan', 'suv', 'sports'],
    default: 'sedan',
    description: 'ONLY relevant when heroVisual or an icon param is "car" - the vehicle\'s body silhouette. Match the ACTUAL vehicle named in the prompt: a Maybach/S-Class/luxury sedan should be "sedan", a Range Rover/SUV/truck should be "suv", a Ferrari/sports car/supercar should be "sports". Ignore this field entirely for non-car content.',
  },
  carBadgeText: {
    type: 'string',
    maxLength: 2,
    default: '',
    description: 'ONLY relevant when heroVisual or an icon param is "car" - 1-2 letter initials for a badge/emblem stamped on the car (e.g. "M" for Mercedes, "B" for BMW, "T" for Tesla). Pick this from the ACTUAL brand/model named in the prompt so the same car template reads as that specific vehicle. Leave empty ("") for generic/unbranded car content.',
  },
  carBadgeShape: {
    type: 'enum',
    values: ['circle', 'shield'],
    default: 'circle',
    description: 'ONLY relevant when carBadgeText is set - the badge\'s outline shape.',
  },
  customShapeRecipe: {
    type: 'shapeRecipe',
    default: [],
    description: 'For heroVisual (or icon) content that has NO good match in the fixed lists above (a guitar, a pizza, a plant, an animal, literally anything) - build it yourself from safe geometric primitives instead of forcing it into a mismatched fixed shape. An array of up to 14 primitives, each one: {"type": "circle"|"rect"|"triangle"|"polygon"|"arc"|"line", "x": -1 to 1, "y": -1 to 1, plus type-specific fields}. circle/arc need "r" (0.03-1.2). rect needs "w","h" (and optional "rx" for rounded corners). triangle/polygon need "points": array of [x,y] pairs (3-8 points). arc needs "startAngle"/"endAngle" in degrees. line needs "x2","y2". All coordinates are relative to center (0,0), roughly -1 to 1 covering the icon\'s bounds. COMPOSITION TECHNIQUE (this is what separates a good result from a blob): use TWO overlapping circles of different sizes for anything with an organic waisted curve (a guitar body, a bottle, a vase) rather than one plain circle - a single circle reads as a ball, not the object. A worked example, a guitar: [{"type":"circle","x":0,"y":0.45,"r":0.4},{"type":"circle","x":0,"y":0.05,"r":0.28},{"type":"rect","x":0,"y":-0.5,"w":0.14,"h":0.85,"rx":0.04},{"type":"circle","x":0,"y":0.3,"r":0.12,"fill":false}] - two circles for the waisted body, a rect for the neck, a hollow circle for the sound hole. Only use this when heroVisual\'s fixed list genuinely has nothing close - prefer the fixed icons/marks when one actually fits, they render faster and more reliably.',
  },
};

const TEXT_FRAME_PARAM = { type: 'enum', values: ['none', 'card', 'gradient'], default: 'none', description: 'Visual framing for the text/number itself: none (plain glow), card (a soft rounded card background), gradient (fill sweeps from white to the accent color). Vary this across beats in the same video - don\'t use the same one every time.' };
const TEXT_FRAME_PARAM_CARD_ONLY = { type: 'enum', values: ['none', 'card'], default: 'none', description: 'Visual framing: none (plain glow) or card (a soft rounded card background). This template already has its own dynamic color behavior, so gradient isn\'t offered here - would compete with it.' };

const TEMPLATES = {
  kineticTextReveal: {
    description:
      'Bold statement text that punches in with scale overshoot and a glow pulse. Use for hooks, statements, questions.',
    params: {
      text: { type: 'string', required: true, maxLength: 90 },
      style: { type: 'enum', values: ['bold-glow', 'mixed-weight'], default: 'bold-glow' },
      textFrame: { type: 'enum', values: ['none', 'card', 'gradient'], default: 'none', description: 'Visual framing for the text itself: none (plain glow), card (a soft rounded card background behind the text), gradient (text fill sweeps from white to the accent color). Vary this across beats in the same video - don\'t use the same one every time.' },
      duration: { type: 'number', min: 1.5, max: 5, default: 3 },
      ...SHARED_PARAMS,
    },
  },

  rippleDrop: {
    description:
      'A glowing dot drops with eased motion, lands, and triggers expanding ripple rings, with caption text beneath. Use for "stop scrolling" style hooks, app-icon reveals, or attention-grabbing openers.',
    params: {
      caption: { type: 'string', maxLength: 60, default: '' },
      color: { type: 'string', default: '#FF5C1A' },
      duration: { type: 'number', min: 2, max: 4, default: 2.5 },
      ...SHARED_PARAMS,
    },
  },

  statCounter: {
    description:
      'Animated number count-up with glow pulse on landing. Use for stats, percentages, comparisons.',
    params: {
      label: { type: 'string', required: true, maxLength: 60 },
      fromValue: { type: 'number', required: true },
      toValue: { type: 'number', required: true },
      suffix: { type: 'string', default: '' },
      textFrame: TEXT_FRAME_PARAM,
      duration: { type: 'number', min: 1.5, max: 4, default: 2.5 },
      ...SHARED_PARAMS,
    },
  },

  iconCallout: {
    description:
      'Icon + short text that pops in with spring overshoot. Use for quick points/features, or when the prompt names a concrete everyday object (a watch, phone, house, car, gift, trophy, rocket, camera, briefcase, coffee) - these render as real hand-drawn vector objects, not abstract icons, and are the closest thing this system has to depicting a literal object without image generation.',
    params: {
      icon: { type: 'enum', values: ['alert', 'check', 'spark', 'clock', 'money', 'chart', 'lock', 'heart', 'watch', 'phone', 'house', 'car', 'gift', 'trophy', 'rocket', 'camera', 'briefcase', 'coffee'], required: true },
      text: { type: 'string', required: true, maxLength: 60 },
      duration: { type: 'number', min: 1.5, max: 3.5, default: 2.2 },
      ...SHARED_PARAMS,
    },
  },

  shapeReveal: {
    description:
      'Abstract shape (circle/square) with pulse/grow motion and glow. Use for emphasis, or literal shape requests.',
    params: {
      shape: { type: 'enum', values: ['circle', 'square'], default: 'circle' },
      motion: { type: 'enum', values: ['pulse', 'grow'], default: 'pulse' },
      color: { type: 'string', default: '#FF5C1A' },
      duration: { type: 'number', min: 1.5, max: 4, default: 2.5 },
      ...SHARED_PARAMS,
    },
  },

  splitCompare: {
    description:
      'Two labeled columns side by side (a short label + short text each), sliding in from opposite edges with a divider that locks in after. Use for before/after, this-vs-that, or any two-option comparison.',
    params: {
      leftLabel: { type: 'string', required: true, maxLength: 20 },
      rightLabel: { type: 'string', required: true, maxLength: 20 },
      leftText: { type: 'string', required: true, maxLength: 40 },
      rightText: { type: 'string', required: true, maxLength: 40 },
      duration: { type: 'number', min: 2, max: 5, default: 3.5 },
      ...SHARED_PARAMS,
    },
  },

  listReveal: {
    description:
      'A numbered list of 2-4 short items that build up cumulatively, each with its own number badge. Use for "tips", "reasons", "steps", or any enumerated list content.',
    params: {
      items: { type: 'stringArray', required: true, maxItems: 4, maxItemLength: 50 },
      duration: { type: 'number', min: 2.5, max: 6, default: 4 },
      ...SHARED_PARAMS,
    },
  },

  quoteCallout: {
    description:
      'A large stylized quote with a growing accent bar and an optional attribution line. Use for a notable statement, testimonial, or a striking claim worth setting apart typographically from normal statement text.',
    params: {
      quote: { type: 'string', required: true, maxLength: 100 },
      attribution: { type: 'string', maxLength: 40, default: '' },
      textFrame: TEXT_FRAME_PARAM,
      duration: { type: 'number', min: 2.5, max: 5, default: 3.5 },
      ...SHARED_PARAMS,
    },
  },

  progressBar: {
    description:
      'A horizontal fill bar with a percentage counting up in sync, a glowing leading edge. Use for progress, completion, "how close you are", or any percent-based metric that benefits from a fill visual instead of a bare number.',
    params: {
      label: { type: 'string', required: true, maxLength: 30 },
      toPercent: { type: 'number', required: true, min: 0, max: 100 },
      duration: { type: 'number', min: 2, max: 4, default: 3 },
      ...SHARED_PARAMS,
    },
  },

  countdownTimer: {
    description:
      'A number counts DOWN to zero with rising urgency - color and glow shift warmer as it approaches zero. Use for deadlines, limited-time framing, or building urgency.',
    params: {
      label: { type: 'string', required: true, maxLength: 30 },
      fromValue: { type: 'number', required: true, min: 1, max: 999 },
      textFrame: TEXT_FRAME_PARAM_CARD_ONLY,
      duration: { type: 'number', min: 2.5, max: 5, default: 4 },
      ...SHARED_PARAMS,
    },
  },

  gridReveal: {
    description:
      'A 2x2 grid of 4 short labeled cells, each revealing with its own stagger. Use for "4 features", "4 reasons", or any content that benefits from a dense grid layout instead of a single column.',
    params: {
      items: { type: 'stringArray', required: true, maxItems: 4, maxItemLength: 24 },
      duration: { type: 'number', min: 3, max: 6, default: 4 },
      ...SHARED_PARAMS,
    },
  },

  checklistTick: {
    description:
      'A list where each item appears, then gets checked off with a checkmark and strikethrough - a genuine "completion" motion. Use for a sequence of steps being completed or a satisfying "done, done, done" beat, as opposed to listReveal which just builds up without completing.',
    params: {
      items: { type: 'stringArray', required: true, maxItems: 4, maxItemLength: 40 },
      duration: { type: 'number', min: 3, max: 6, default: 4 },
      ...SHARED_PARAMS,
    },
  },

  bigNumberStat: {
    description:
      'One massive hero number with minimal supporting chrome and a dramatic glow bloom - use for the single biggest, most important stat in the whole video, the "impact moment" scene, not a routine number (use statCounter for those).',
    params: {
      value: { type: 'number', required: true },
      suffix: { type: 'string', default: '' },
      caption: { type: 'string', maxLength: 50, default: '' },
      textFrame: TEXT_FRAME_PARAM,
      duration: { type: 'number', min: 2, max: 4, default: 3 },
      ...SHARED_PARAMS,
    },
  },

  pieChartReveal: {
    description:
      'An animated donut/pie arc sweeping to a target percentage with a center readout. Use for any percentage where a radial data-viz feel suits better than a bar (progressBar) or bare number (statCounter).',
    params: {
      label: { type: 'string', required: true, maxLength: 30 },
      toPercent: { type: 'number', required: true, min: 0, max: 100 },
      duration: { type: 'number', min: 2.5, max: 4.5, default: 3 },
      ...SHARED_PARAMS,
    },
  },

  duoStatCompare: {
    description:
      'Two numbers side by side BOTH counting up simultaneously, each with its own label. Use when the comparison IS the animation (e.g. before/after metrics), unlike splitCompare which is static text.',
    params: {
      leftLabel: { type: 'string', required: true, maxLength: 20 },
      leftValue: { type: 'number', required: true },
      rightLabel: { type: 'string', required: true, maxLength: 20 },
      rightValue: { type: 'number', required: true },
      duration: { type: 'number', min: 2.5, max: 4.5, default: 3 },
      ...SHARED_PARAMS,
    },
  },

  badgeUnlock: {
    description:
      'A celebratory badge/achievement pop with a radiating burst and checkmark. Use for a reward, milestone, "you did it" moment - a genuinely different, celebratory register from every information-delivery template.',
    params: {
      label: { type: 'string', required: true, maxLength: 40 },
      duration: { type: 'number', min: 2.5, max: 4, default: 3 },
      ...SHARED_PARAMS,
    },
  },

  tickerScroll: {
    description:
      'A continuously horizontally-scrolling ticker of 2-5 short words/phrases, never settling for the whole scene. Use as a rhythm/texture beat, a rapid-fire list of keywords, or between heavier information scenes - NOT for anything that needs to be read carefully (it never stops moving).',
    params: {
      items: { type: 'stringArray', required: true, maxItems: 5, maxItemLength: 20 },
      duration: { type: 'number', min: 2, max: 4, default: 3 },
      ...SHARED_PARAMS,
    },
  },

  statGrid: {
    description:
      'A 2x2 grid of 4 small numbers, each counting up independently with its own label - use for a cluster of related metrics shown together (unlike bigNumberStat which is ONE hero number, or duoStatCompare which is only 2).',
    params: {
      stats: { type: 'statArray', required: true, maxItems: 4 },
      duration: { type: 'number', min: 3, max: 6, default: 4 },
      ...SHARED_PARAMS,
    },
  },

  arrowFlow: {
    description:
      'A horizontal sequence of 2-3 numbered steps connected by arrows, entering left to right - use for a process, workflow, or "how it works" content, distinct from listReveal\'s vertical list (this is explicitly a FLOW/sequence, not a list of independent items).',
    params: {
      steps: { type: 'stringArray', required: true, maxItems: 3, maxItemLength: 30 },
      duration: { type: 'number', min: 3, max: 6, default: 4 },
      ...SHARED_PARAMS,
    },
  },

  calloutBubble: {
    description:
      'A speech-bubble callout with a tail pointer and optional speaker attribution - conversational framing, use for testimonials, quotes from a specific person in dialogue form, or "what people are saying" content. Distinct register from quoteCallout\'s more formal accent-bar treatment.',
    params: {
      text: { type: 'string', required: true, maxLength: 100 },
      speaker: { type: 'string', maxLength: 40, default: '' },
      duration: { type: 'number', min: 2.5, max: 5, default: 3.5 },
      ...SHARED_PARAMS,
    },
  },

  barChartCompare: {
    description:
      'Vertical animated bars (2-4) comparing values, each with a label - use for a genuine Cartesian bar-chart comparison (e.g. month over month, category comparison). Distinct from pieChartReveal (radial/percentage) and statGrid (independent numbers, not a proportional chart).',
    params: {
      bars: { type: 'statArray', required: true, maxItems: 4 },
      duration: { type: 'number', min: 3, max: 6, default: 4 },
      ...SHARED_PARAMS,
    },
  },

  avatarStack: {
    description:
      'Overlapping circular avatars with initials plus a caption - a social-proof visual ("12k people use this"). Use for community size, user count, or "join others" framing - a genuinely different content register (people/community) from data, process, or feature templates.',
    params: {
      initials: { type: 'stringArray', required: true, maxItems: 5, maxItemLength: 3 },
      caption: { type: 'string', maxLength: 50, default: '' },
      duration: { type: 'number', min: 2.5, max: 4.5, default: 3 },
      ...SHARED_PARAMS,
    },
  },
  visualMoment: {
    description:
      'A GENUINELY TEXT-FREE beat - just the heroVisual shape/icon, large and centered, nothing else on screen (no caption, no body text). Use when the prompt is asking for a pure visual, or when a beat should just BE the thing rather than describe it - a prompt that\'s simply an object name ("a car", "a watch") with no other context is exactly when this fits. Every other template pairs a visual with text; this is the only one that doesn\'t, and forcing text onto a request that never asked for any is exactly the kind of generic filler to avoid.',
    params: {
      duration: { type: 'number', min: 2, max: 5, default: 3.5 },
      ...SHARED_PARAMS,
    },
  },
};

/**
 * Extracted so both the fresh-generation prompt AND the edit prompt
 * can share this without duplicating a large, template-count-scaling
 * block that would otherwise drift out of sync between the two the
 * moment a template's schema changes.
 */
function buildTemplateDocs() {
  return Object.entries(TEMPLATES)
    .map(([name, t]) => {
      const paramDocs = Object.entries(t.params)
        .map(([pname, p]) => {
          const constraint = p.type === 'enum'
            ? `one of [${p.values.join(', ')}]`
            : p.type === 'stringArray'
              ? `array of strings, max ${p.maxItems || 10} items, each under ${p.maxItemLength || 60} chars`
              : p.type === 'statArray'
                ? `array of up to ${p.maxItems || 4} objects, each shaped {"value": number, "suffix": string, "label": string}`
                : p.type;
          const desc = p.description ? ` - ${p.description}` : '';
          return `      - ${pname} (${constraint}${p.required ? ', required' : `, default: ${JSON.stringify(p.default)}`})${desc}`;
        })
        .join('\n');
      return `  ${name}: ${t.description}\n${paramDocs}`;
    })
    .join('\n\n');
}

function buildMistralSystemPrompt(targetDurationSeconds = 12) {
  const duration = Math.max(8, Math.min(120, targetDurationSeconds));
  // Roughly: each scene averages ~3s of content + a 0.55s transition
  // between scenes (~3.55s per scene-unit). Min/max scene count is a
  // guide, not a hard instruction to hit exactly - Mistral should
  // still pace scenes by content, not pad to a number.
  const approxScenes = Math.round(duration / 3.55);
  const minScenes = Math.max(2, Math.round(approxScenes * 0.75));
  const maxScenes = Math.min(40, Math.max(minScenes + 1, Math.round(approxScenes * 1.25)));

  const templateDocs = buildTemplateDocs();

  return `You are a short-form video director. Given a user's prompt, output ONLY valid JSON (no markdown, no prose, no code fences) describing a sequence of BEATS for a ${duration} second vertical video (720x1280).

This is rendered as ONE continuous world, not a slideshow - a single camera pans smoothly between each beat's position, arriving to reveal it and leaving to reveal the next. There is no cut and no transition effect between beats - do not think in terms of "scene 1 ends, scene 2 begins with an effect." Each beat is simply the next thing the camera arrives at.

You may ONLY use these beat templates, choosing whichever best matches the user's intent even if not literal:

${templateDocs}

Rules:
- Always pick the closest matching template for any request, including abstract ones - never invent a new template.
- Roughly ${minScenes} to ${maxScenes} beats total for a ${duration}s video - pace beats by content, don't pad with filler just to hit a number, and don't rush past ${maxScenes} either.
- Match the video's scope to what the prompt actually gives you - do NOT force every prompt into the same hook-statistic-detail-quote shape regardless of content. A short or single-word prompt (just naming an object, a brand, a single concept) deserves a short, direct video - even ONE beat is completely fine if that's all the content supports. Never invent a specific statistic, percentage, or quote that the prompt didn't imply just to fill out a template - a made-up "73% of X" about a topic the user gave you almost no information on is fabricated content, not insight, and it's exactly the kind of generic filler this whole system exists to avoid. If you don't have a real basis for a number or a quote, don't include a stat or quote beat at all - use a template that doesn't require inventing one.
- NEVER reproduce a real company's actual ad slogan, tagline, or marketing copy (e.g. "The Ultimate Driving Machine", "Just Do It") even if it comes to mind as an obvious association for a brand named in the prompt - that's someone else's copyrighted material, not something to insert unprompted. Write original text every time.
- When a LONG duration is requested for a prompt that's genuinely content-sparse (just an object or brand name, nothing else), do NOT fill the extra time by inventing facts, specs, or claims about it - that produces exactly the fabricated "so fast that it can..." kind of filler this whole system exists to avoid. Instead, fill the duration with VISUAL VARIATION on the same subject: multiple "visualMoment" beats, like a mood/hype reel rather than a documentary script. Repetition-with-variation is honest; invented facts are not.
- CRITICAL, NON-NEGOTIABLE RULE when you use multiple "visualMoment" (or any repeated-subject) beats back to back: consecutive beats of the same subject MUST differ in at least THREE of the following - never just the tag text alone, that alone is not variation and produces the exact same image on a loop with different captions, which is worse than no variation at all:
  - carBodyStyle (if a car): rotate sedan / suv / sports, never repeat the same one twice in a row
  - heroVisual itself: alternate between the literal icon AND an abstract mark that evokes a different facet of the subject (e.g. the car itself, then "burst" for speed/energy, then "halo" for prestige, then back to the car in a different body style) - do not show the identical shape in every single beat
  - accentShape: pick a different one each beat
  - carBadgeShape (if applicable): alternate circle/shield
  Before finalizing a multi-beat visual reel, check your own output: if two consecutive beats would render as literally the same shape in the same position with only the tag word different, that is a failure - go back and vary something real. This has produced genuinely broken-looking output before (the exact same car icon repeated across 4+ beats with only the tag changing) - do not repeat that mistake.
- If the prompt is just naming a single object with no other context ("a car", "a watch"), use the "visualMoment" template - a real visual with no text forced onto it, not a fabricated caption or tagline standing in for content that was never asked for.
- Every beat's params MUST include "tag", "accentShape", and "heroVisual" (documented under every template above) - pick values specific to that beat's content, not the same ones repeated every time. A video about budgeting failures might use tags like "WARNING", "FACT", "DATA" across its beats, not "INSIGHT" three times in a row. For heroVisual specifically: if the prompt names a real, concrete thing (a car, a watch, a house, a specific product), you MUST use the matching concrete icon for at least the beats about that thing - do NOT default to an abstract mark just because it feels safer. A video about a Mercedes S-Class should show the "car" icon, not "ribbon" or "halo". Only use abstract marks (ribbon, halo, mark, burst) when the content genuinely has no literal object to depict.
- Pick ONE "visualSystem" for the WHOLE video (not per beat) from: "hudTerminal" (dark, glowing, data/HUD chrome - fits finance, tech, data, insider-info, urgency), "softEditorial" (light, calm, serif, no glow/chrome - fits reflective, lifestyle, psychology, personal-essay tones), "boldGraphic" (flat saturated color blocks, high contrast, no glow - fits punchy hooks, bold claims, hot takes). Choose based on the PROMPT's tone, not a default.
- Pick ONE "videoColor" (a hex string) for the WHOLE video, based on THIS SPECIFIC prompt's subject and mood - never default to orange out of habit. This single choice drives the background tint, every accent, every glow in the whole video, so it matters. Examples of mapping content to color (pick what actually fits, don't copy these verbatim every time): luxury/premium/automotive -> a deep gold (#C9A24B) or platinum-silver (#B8BCC2) or near-black with a warm edge; danger/warning/failure -> red (#EF4444) or orange (#FF5C1A); trust/finance/professional -> blue (#3B82F6) or navy; growth/health/wellness -> green (#22C55E) or teal; creative/fun/youthful -> purple (#A855F7) or pink (#EC4899); calm/minimal/reflective -> muted sage or warm neutral. A video about a Mercedes should NOT end up the same color as a video about budgeting apps failing - if your last few outputs used orange, deliberately pick something else this time unless the content truly calls for red/orange specifically.
- Pick ONE "backgroundMood" for the WHOLE video from: "dark" (moody, deep, glowing - fits night, tech, urgency, drama), "light" (bright, airy, clean - fits morning, wellness, minimal, fresh, everyday-product content), "bold" (saturated and punchy, richer than dark but not pastel - fits confident claims, energy, premium/luxury). This is independent of videoColor - the hue comes from videoColor, the brightness/mood comes from this. Do NOT default to "dark" out of habit - a wellness or morning-routine video genuinely calling for "light" should get "light", not the same dark glow every other video gets. If unset, each visualSystem falls back to its own natural default, but you should actively choose based on the prompt's actual mood rather than always leaving it unset.
- Output strictly this JSON shape - note these three examples are STRUCTURALLY DIFFERENT from each other (different beat counts, different template choices, different narrative shapes) because that variety is exactly the point: never let your own output settle into one repeated arc regardless of topic.

Example 1 (a claim worth backing with a real stat):
{
  "title": "short internal title",
  "visualSystem": "hudTerminal",
  "videoColor": "#EF4444",
  "scenes": [
    { "template": "kineticTextReveal", "params": { "text": "...", "style": "bold-glow", "duration": 3, "tag": "WARNING", "accentShape": "triangle", "heroVisual": "halo" } },
    { "template": "statCounter", "params": { "label": "...", "fromValue": 0, "toValue": 73, "suffix": "%", "duration": 2.5, "tag": "DATA", "accentShape": "crosshair", "heroVisual": "burst" } }
  ]
}

Example 2 (a single concrete thing, nothing to prove or quantify - kept simple, one beat):
{
  "title": "short internal title",
  "visualSystem": "boldGraphic",
  "videoColor": "#C9A24B",
  "scenes": [
    { "template": "iconCallout", "params": { "icon": "car", "text": "...", "carBodyStyle": "sedan", "carBadgeText": "M", "duration": 3, "tag": "ICONIC", "accentShape": "dots", "heroVisual": "car" } }
  ]
}

Example 3 (a process or list, no stats or quotes involved at all):
{
  "title": "short internal title",
  "visualSystem": "softEditorial",
  "videoColor": "#22C55E",
  "scenes": [
    { "template": "arrowFlow", "params": { "steps": ["...", "...", "..."], "duration": 4, "tag": "GUIDE", "accentShape": "arrow", "heroVisual": "mark" } },
    { "template": "checklistTick", "params": { "items": ["...", "..."], "duration": 3.5, "tag": "STEPS", "accentShape": "check", "heroVisual": "spark" } }
  ]
}

Respond with ONLY the JSON object.`;
}

/**
 * The actual code-level backstop for consecutive-beat sameness. Walks
 * scenes in order; whenever two consecutive beats would render as
 * literally the same visual (same heroVisual, same carBodyStyle, same
 * accentShape), deterministically rotates the LATER one's params so
 * they can never be identical, regardless of what Mistral actually
 * output. Mutates cleanScenes in place.
 */
function enforceConsecutiveVisualVariation(cleanScenes) {
  const CAR_BODY_ROTATION = ['sedan', 'suv', 'sports'];
  const ACCENT_SHAPE_ROTATION = ['bracket', 'crosshair', 'dots', 'arrow', 'plus', 'triangle'];
  const HERO_MARK_ROTATION = ['halo', 'burst', 'mark', 'ribbon'];

  // Find RUNS of consecutive beats sharing the same subject (same
  // heroVisual), not just reactively fix pairwise sameness against
  // the immediate predecessor. The pairwise-only version of this fix
  // still let beat[i] land back on exactly beat[i-2]'s values (no
  // ADJACENT duplicate, but still an obvious repeat one beat later) -
  // confirmed directly by testing it. Rotating every beat in a run by
  // its position WITHIN the run, starting from 0, guarantees a full
  // clean cycle with no repeats until the rotation list itself wraps.
  let runStart = 0;
  for (let i = 1; i <= cleanScenes.length; i++) {
    const endOfRun = i === cleanScenes.length || cleanScenes[i].params.heroVisual !== cleanScenes[runStart].params.heroVisual;
    if (endOfRun) {
      const runLength = i - runStart;
      if (runLength >= 2) {
        for (let j = 0; j < runLength; j++) {
          const params = cleanScenes[runStart + j].params;
          if (params.carBodyStyle !== undefined) {
            params.carBodyStyle = CAR_BODY_ROTATION[j % CAR_BODY_ROTATION.length];
          } else if (j > 0) {
            // Only the icon/mark itself alternates from the SECOND
            // beat in a run onward - the first beat keeps whatever
            // subject Mistral actually chose for it.
            params.heroVisual = HERO_MARK_ROTATION[(j - 1) % HERO_MARK_ROTATION.length];
          }
          params.accentShape = ACCENT_SHAPE_ROTATION[j % ACCENT_SHAPE_ROTATION.length];
        }
      }
      runStart = i;
    }
  }
}

/**
 * The edit path - fundamentally different framing from
 * buildMistralSystemPrompt above. That one is "design something new
 * from a description." This one is "here is an EXISTING, already-
 * validated video - apply exactly this one change and leave
 * everything else untouched." Getting the "preserve everything else"
 * instruction genuinely emphatic matters a lot here: without it, an
 * edit request risks regenerating an entirely different video that
 * happens to also satisfy the new instruction, which is not what
 * "change the car to blue" means to a user who already has a video
 * they like except for that one detail.
 */
function buildMistralEditSystemPrompt(previousSceneJSON, targetDurationSeconds = 12) {
  const templateDocs = buildTemplateDocs();
  const previousJson = JSON.stringify(previousSceneJSON, null, 2);

  return `You are editing an EXISTING short-form video, not creating a new one. Below is the CURRENT scene JSON for this video. The user will describe ONE change they want. Your job is to output a REVISED version of this exact JSON that applies ONLY that change - not a new video that happens to also satisfy the instruction.

THE INSTRUCTION WILL OFTEN BE VERY SHORT - just a word or two, like "blue car" or "faster" or "add urgency". A short instruction is NOT a new topic to design a video around - it describes the DELTA from what already exists below. Read it as shorthand for "change this one thing about the CURRENT video", never as "here is a new subject, start over".

Worked example of exactly this: if the current video (below) is about a red car, and the instruction is just "blue car" - that means "change the car's color to blue in this same video", NOT "make a new video about a blue car". You would change ONLY videoColor (and any matching params.color fields) and leave every single beat, template, tag, and piece of text EXACTLY as it already is. The beat count stays the same. The templates stay the same. The tag text stays the same. Only the color changes.

CURRENT SCENE JSON:
${previousJson}

CRITICAL RULES:
- Preserve EVERYTHING else exactly as it currently is: same beat count and order, same templates, same tag text, same accentShape, same heroVisual, same durations, same videoColor, same visualSystem, same backgroundMood - UNLESS the user's instruction specifically implies changing that particular thing.
- A short instruction naming just a color, a style, or a single word is describing a targeted change to what's already here, never a brand new video topic - see the worked example above.
- Common edit patterns and what they actually mean:
  - "change the color to X" / "make it blue" / just "blue" -> update ONLY "videoColor" (and any params.color fields that mirror it) to the new color. Do not touch templates, text, beat count, or anything else.
  - "make the car a suv" / "change the car style" -> update ONLY carBodyStyle (and carBadgeText/carBadgeShape if the instruction implies changing those specifically). Leave every other beat and every other field untouched.
  - "add a scene about X" -> APPEND one new beat for X, keep every existing beat completely unchanged.
  - "remove the Nth scene" / "remove the part about X" -> remove that one beat, keep every other beat completely unchanged, don't renumber or otherwise alter what remains.
  - "make the background light" / "make it feel calmer" -> update ONLY backgroundMood (or visualSystem if the tone genuinely calls for a different one), leave content untouched.
  - "change the text to say X" -> update ONLY that beat's text/label/quote field, leave its template, tag, shape, and every other beat untouched.
- If the instruction is genuinely ambiguous about scope, prefer the SMALLEST change that satisfies it - never regenerate more than the instruction actually asks for.
- If the instruction is VAGUE DISSATISFACTION with no concrete change identifiable in it at all ("that doesn't look right", "that's not what I asked for", "fix it", "no", "try again") - this is NOT a request for a full redesign, even though it might feel like one. You have no specific target to change, so making a large change here would almost certainly be the WRONG large change. In this case, output the JSON completely UNCHANGED from what's shown above, byte-for-byte identical in every field - do not alter anything. A vague complaint deserves a follow-up question in the real world, and since you can't ask one here, doing nothing is far less wrong than guessing at a redesign the user never actually described.
- Still follow the full template schema below for whatever fields you do touch - values must stay valid for whichever template each beat uses.
- Output STRICTLY the same JSON shape as the input above (title, visualSystem, videoColor, backgroundMood if present, scenes array) - the complete revised object, not a diff or a partial patch.

The available templates and their valid params, for reference on whatever fields you touch:

${templateDocs}
`;
}

function validateSceneJSON(json) {
  if (!json || !Array.isArray(json.scenes) || json.scenes.length === 0) {
    throw new Error('scene JSON missing non-empty "scenes" array');
  }
  if (json.scenes.length > 42) {
    throw new Error('too many scenes (max 42)');
  }

  const cleanScenes = json.scenes.map((scene, i) => {
    const tmpl = TEMPLATES[scene.template];
    if (!tmpl) {
      throw new Error(`scene[${i}] uses unknown template "${scene.template}"`);
    }

    const cleanParams = {};
    for (const [pname, pdef] of Object.entries(tmpl.params)) {
      let val = scene.params ? scene.params[pname] : undefined;

      if (val === undefined || val === null) {
        if (pdef.required) {
          throw new Error(`scene[${i}] (${scene.template}) missing required param "${pname}"`);
        }
        val = pdef.default;
      }

      if (pdef.type === 'enum' && !pdef.values.includes(val)) {
        val = pdef.default || pdef.values[0];
      }
      if (pdef.type === 'number') {
        val = Number(val);
        if (Number.isNaN(val)) val = pdef.default;
        if (pdef.min !== undefined) val = Math.max(pdef.min, val);
        if (pdef.max !== undefined) val = Math.min(pdef.max, val);
      }
      if (pdef.type === 'string' && pdef.maxLength) {
        val = String(val).slice(0, pdef.maxLength);
      }
      if (pdef.type === 'stringArray') {
        if (!Array.isArray(val)) val = pdef.default || [];
        val = val
          .filter((item) => typeof item === 'string' || typeof item === 'number')
          .map((item) => String(item).slice(0, pdef.maxItemLength || 60))
          .slice(0, pdef.maxItems || 10);
        if (val.length === 0 && pdef.required) {
          throw new Error(`scene[${i}] (${scene.template}) param "${pname}" needs at least one item`);
        }
      }
      if (pdef.type === 'statArray') {
        if (!Array.isArray(val)) val = pdef.default || [];
        val = val
          .filter((item) => item && typeof item === 'object')
          .map((item) => ({
            value: Number(item.value) || 0,
            suffix: typeof item.suffix === 'string' ? item.suffix.slice(0, 6) : '',
            label: typeof item.label === 'string' ? item.label.slice(0, 20) : '',
          }))
          .slice(0, pdef.maxItems || 4);
        if (val.length === 0 && pdef.required) {
          throw new Error(`scene[${i}] (${scene.template}) param "${pname}" needs at least one stat object`);
        }
      }
      if (pdef.type === 'shapeRecipe') {
        // Delegates to the same validator shapeRecipe.js itself uses -
        // one real security boundary, not two copies that could drift
        // out of sync with each other.
        val = validateShapeRecipe(val);
      }

      cleanParams[pname] = val;
    }

    return {
      template: scene.template,
      params: cleanParams,
    };
  });

  // Code-level guarantee, not just a prompt request - a prose
  // instruction already failed once in exactly this spot (confirmed
  // directly: the same car icon repeated across 4+ beats with only
  // the tag word changing). This forces real variation whenever
  // consecutive beats would otherwise render identically, regardless
  // of whether Mistral actually complied with the instruction above.
  enforceConsecutiveVisualVariation(cleanScenes);

  const VALID_SYSTEMS = Object.keys(VISUAL_SYSTEMS);
  const visualSystem = VALID_SYSTEMS.includes(json.visualSystem) ? json.visualSystem : 'hudTerminal';

  const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
  const videoColor = (typeof json.videoColor === 'string' && HEX_COLOR_RE.test(json.videoColor))
    ? json.videoColor.toUpperCase()
    : '#FF5C1A';

  const VALID_MOODS = ['dark', 'light', 'bold'];
  const backgroundMood = VALID_MOODS.includes(json.backgroundMood) ? json.backgroundMood : undefined;

  return {
    title: (json.title || 'Untitled').slice(0, 80),
    visualSystem,
    videoColor,
    backgroundMood,
    scenes: cleanScenes,
  };
}

module.exports = {
  TEMPLATES,
  buildMistralSystemPrompt,
  buildMistralEditSystemPrompt,
  validateSceneJSON,
};
