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
};

const TEMPLATES = {
  kineticTextReveal: {
    description:
      'Bold statement text that punches in with scale overshoot and a glow pulse. Use for hooks, statements, questions.',
    params: {
      text: { type: 'string', required: true, maxLength: 90 },
      style: { type: 'enum', values: ['bold-glow', 'mixed-weight'], default: 'bold-glow' },
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
      duration: { type: 'number', min: 1.5, max: 4, default: 2.5 },
      ...SHARED_PARAMS,
    },
  },

  iconCallout: {
    description:
      'Icon + short text that pops in with spring overshoot. Use for quick points/features.',
    params: {
      icon: { type: 'enum', values: ['alert', 'check', 'spark', 'clock', 'money', 'chart', 'lock', 'heart'], required: true },
      text: { type: 'string', required: true, maxLength: 60 },
      duration: { type: 'number', min: 1.5, max: 3.5, default: 2.2 },
      ...SHARED_PARAMS,
    },
  },

  shapeReveal: {
    description:
      'Abstract shape (circle/square) with pulse/grow motion and glow. Use for transitions, emphasis, or literal shape requests.',
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
};

const TRANSITIONS = {
  luminanceFlashCut: { description: 'The outgoing scene glows to a full white flash and the next scene emerges from it. Use as the default - a match cut through light.' },
  irisMorph: { description: 'A glowing circular iris closes to a point then reopens into the next scene. Use for a more deliberate, dramatic beat change.' },
  shapeMorph: { description: 'A square rotates while scaling up to cover the frame, then continues rotating as it scales back down. Angular, geometric feel - use for a punchier, more energetic beat change.' },
  slideDisplace: { description: 'Two panes slide across horizontally at different speeds (parallax depth) with a bright leading edge. Directional feel - use when the content itself implies forward motion or progression.' },
};

function buildMistralSystemPrompt(targetDurationSeconds = 12) {
  const duration = Math.max(8, Math.min(120, targetDurationSeconds));
  // Roughly: each scene averages ~3s of content + a 0.55s transition
  // between scenes (~3.55s per scene-unit). Min/max scene count is a
  // guide, not a hard instruction to hit exactly - Mistral should
  // still pace scenes by content, not pad to a number.
  const approxScenes = Math.round(duration / 3.55);
  const minScenes = Math.max(2, Math.round(approxScenes * 0.75));
  const maxScenes = Math.min(40, Math.max(minScenes + 1, Math.round(approxScenes * 1.25)));

  const templateDocs = Object.entries(TEMPLATES)
    .map(([name, t]) => {
      const paramDocs = Object.entries(t.params)
        .map(([pname, p]) => {
          const constraint = p.type === 'enum'
            ? `one of [${p.values.join(', ')}]`
            : p.type === 'stringArray'
              ? `array of strings, max ${p.maxItems || 10} items, each under ${p.maxItemLength || 60} chars`
              : p.type;
          const desc = p.description ? ` - ${p.description}` : '';
          return `      - ${pname} (${constraint}${p.required ? ', required' : `, default: ${JSON.stringify(p.default)}`})${desc}`;
        })
        .join('\n');
      return `  ${name}: ${t.description}\n${paramDocs}`;
    })
    .join('\n\n');

  const transitionDocs = Object.entries(TRANSITIONS)
    .map(([name, t]) => `  ${name}: ${t.description}`)
    .join('\n');

  return `You are a short-form video director. Given a user's prompt, output ONLY valid JSON (no markdown, no prose, no code fences) describing a sequence of scenes for a ${duration} second vertical video (720x1280).

You may ONLY use these scene templates, choosing whichever best matches the user's intent even if not literal:

${templateDocs}

You may ONLY use these transitions between scenes:

${transitionDocs}

Rules:
- Always pick the closest matching template for any request, including abstract ones - never invent a new template.
- Roughly ${minScenes} to ${maxScenes} scenes total for a ${duration}s video - pace scenes by content, don't pad with filler just to hit a number, and don't rush past ${maxScenes} scenes either.
- Every scene needs a "transition" field (the transition used to enter that scene), except the first scene.
- Every scene's params MUST include "tag" and "accentShape" (documented under every template above) - pick values specific to that scene's content, not the same tag/shape repeated on every scene. A video about budgeting failures might use tags like "WARNING", "FACT", "DATA" across its scenes, not "INSIGHT" three times in a row.
- Pick ONE "visualSystem" for the WHOLE video (not per scene) from: "hudTerminal" (dark, glowing, data/HUD chrome - fits finance, tech, data, insider-info, urgency), "softEditorial" (light, calm, serif, no glow/chrome - fits reflective, lifestyle, psychology, personal-essay tones), "boldGraphic" (flat saturated color blocks, high contrast, no glow - fits punchy hooks, bold claims, hot takes). Choose based on the PROMPT's tone, not a default.
- Output strictly this JSON shape:

{
  "title": "short internal title",
  "visualSystem": "hudTerminal",
  "scenes": [
    { "template": "kineticTextReveal", "transition": null, "params": { "text": "...", "style": "bold-glow", "duration": 3, "tag": "WARNING", "accentShape": "triangle" } },
    { "template": "statCounter", "transition": "luminanceFlashCut", "params": { "label": "...", "fromValue": 0, "toValue": 73, "suffix": "%", "duration": 2.5, "tag": "DATA", "accentShape": "crosshair" } },
    { "template": "listReveal", "transition": "shapeMorph", "params": { "items": ["...", "...", "..."], "duration": 4, "tag": "GUIDE", "accentShape": "dots" } },
    { "template": "quoteCallout", "transition": "slideDisplace", "params": { "quote": "...", "attribution": "...", "duration": 3.5, "tag": "QUOTE", "accentShape": "plus" } }
  ]
}

Respond with ONLY the JSON object.`;
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
    if (i > 0 && scene.transition && !TRANSITIONS[scene.transition]) {
      throw new Error(`scene[${i}] uses unknown transition "${scene.transition}"`);
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

      cleanParams[pname] = val;
    }

    return {
      template: scene.template,
      transition: i === 0 ? null : (scene.transition || 'luminanceFlashCut'),
      params: cleanParams,
    };
  });

  const VALID_SYSTEMS = Object.keys(VISUAL_SYSTEMS);
  const visualSystem = VALID_SYSTEMS.includes(json.visualSystem) ? json.visualSystem : 'hudTerminal';

  return {
    title: (json.title || 'Untitled').slice(0, 80),
    visualSystem,
    scenes: cleanScenes,
  };
}

module.exports = {
  TEMPLATES,
  TRANSITIONS,
  buildMistralSystemPrompt,
  validateSceneJSON,
};
