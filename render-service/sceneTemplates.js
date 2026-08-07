/**
 * SCENE TEMPLATE REGISTRY
 * ------------------------------------------------------------------
 * This is the single source of truth for:
 *   1. What Mistral is allowed to output (the prompt is generated FROM this file)
 *   2. What we validate Mistral's JSON response against before rendering
 *   3. What scenes.tsx reads to know how to render each scene
 *
 * Mistral NEVER writes animation code. It only picks a template name
 * and fills in these params. All motion/easing/"flair" choreography
 * lives in scenes.tsx and is identical no matter what content is passed in.
 */

const TEMPLATES = {
  kineticTextReveal: {
    description:
      'Bold statement text that punches in with blur->sharp, scale overshoot, and a light-sweep pulse. Use for hooks, statements, questions.',
    params: {
      text: { type: 'string', required: true, maxLength: 90 },
      style: { type: 'enum', values: ['bold-glow', 'glitch', 'mixed-weight'], default: 'bold-glow' },
      duration: { type: 'number', min: 1.5, max: 5, default: 3 },
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
    },
  },

  splitCompare: {
    description:
      'Two-sided split screen sliding in from opposite edges with parallax, for before/after or A-vs-B beats.',
    params: {
      leftLabel: { type: 'string', required: true, maxLength: 40 },
      rightLabel: { type: 'string', required: true, maxLength: 40 },
      leftText: { type: 'string', required: true, maxLength: 80 },
      rightText: { type: 'string', required: true, maxLength: 80 },
      duration: { type: 'number', min: 2, max: 5, default: 3.5 },
    },
  },

  iconCallout: {
    description:
      'Icon + short text that pops in with spring overshoot and a trailing glow. Use for quick points/features.',
    params: {
      icon: { type: 'enum', values: ['alert', 'check', 'spark', 'clock', 'money', 'chart', 'lock', 'heart'], required: true },
      text: { type: 'string', required: true, maxLength: 60 },
      position: { type: 'enum', values: ['left', 'right', 'center'], default: 'center' },
      duration: { type: 'number', min: 1.5, max: 3.5, default: 2.2 },
    },
  },

  shapeReveal: {
    description:
      'Abstract shape (circle/square/blob/line) with pulse/grow/orbit/morph motion, ambient light trail. Use for transitions, emphasis, or literal "shape" requests.',
    params: {
      shape: { type: 'enum', values: ['circle', 'square', 'blob', 'line'], default: 'circle' },
      motion: { type: 'enum', values: ['pulse', 'grow', 'orbit', 'morph'], default: 'pulse' },
      color: { type: 'string', default: '#FF5C1A' },
      duration: { type: 'number', min: 1.5, max: 4, default: 2.5 },
    },
  },

  imageRevealZoom: {
    description:
      'Background image/photo with slow parallax dolly-zoom and caption text overlay. Use when a scene needs a photographic backdrop.',
    params: {
      imageQuery: { type: 'string', required: true, maxLength: 60, description: 'Search term used to fetch a stock photo/video (Pexels).' },
      caption: { type: 'string', maxLength: 80, default: '' },
      duration: { type: 'number', min: 2, max: 5, default: 3 },
    },
  },
};

const TRANSITIONS = {
  glitchWipe: { description: 'RGB-split glitch wipe between scenes. Default, punchy.' },
  lightStreakDrag: { description: 'A light streak drags the outgoing scene off and drags the incoming scene on.' },
  morphCut: { description: 'Shared shape morphs from outgoing element into incoming element.' },
  whipPanBlur: { description: 'Fast directional blur pan, like a whip-pan camera move.' },
};

function buildMistralSystemPrompt() {
  const templateDocs = Object.entries(TEMPLATES)
    .map(([name, t]) => {
      const paramDocs = Object.entries(t.params)
        .map(([pname, p]) => {
          const constraint = p.type === 'enum' ? `one of [${p.values.join(', ')}]` : p.type;
          return `      - ${pname} (${constraint}${p.required ? ', required' : `, default: ${JSON.stringify(p.default)}`})`;
        })
        .join('\n');
      return `  ${name}: ${t.description}\n${paramDocs}`;
    })
    .join('\n\n');

  const transitionDocs = Object.entries(TRANSITIONS)
    .map(([name, t]) => `  ${name}: ${t.description}`)
    .join('\n');

  return `You are a short-form video director. Given a user's prompt, output ONLY valid JSON (no markdown, no prose, no code fences) describing a sequence of scenes for a 10-16 second vertical video (720x1280).

You may ONLY use these scene templates, choosing whichever best matches the user's intent even if not literal:

${templateDocs}

You may ONLY use these transitions between scenes:

${transitionDocs}

Rules:
- Always pick the closest matching template for any request, including abstract ones like "make a dynamic circle" (-> shapeReveal) or "heist movie vibe" (-> pick style/color params that evoke it, do not invent new templates).
- 3 to 5 scenes total for a 10-16s video. Keep it tight - this is deliberately shorter than a typical short-form video right now to reduce total render workload on constrained infrastructure.
- Every scene needs a "transition" field (the transition used to enter that scene), except the first scene.
- Output strictly this JSON shape:

{
  "title": "short internal title",
  "totalDurationEstimate": 22,
  "scenes": [
    { "template": "kineticTextReveal", "transition": null, "params": { "text": "...", "style": "bold-glow", "duration": 3 } },
    { "template": "statCounter", "transition": "glitchWipe", "params": { "label": "...", "fromValue": 0, "toValue": 73, "suffix": "%", "duration": 2.5 } }
  ]
}

Respond with ONLY the JSON object.`;
}

/**
 * Validates + fills defaults on Mistral's parsed JSON.
 * Throws with a descriptive message on any violation (caller should
 * catch this and either retry the Mistral call or fail the job).
 */
function validateSceneJSON(json) {
  if (!json || !Array.isArray(json.scenes) || json.scenes.length === 0) {
    throw new Error('scene JSON missing non-empty "scenes" array');
  }
  if (json.scenes.length > 8) {
    throw new Error('too many scenes (max 8)');
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

      cleanParams[pname] = val;
    }

    return {
      template: scene.template,
      transition: i === 0 ? null : (scene.transition || 'glitchWipe'),
      params: cleanParams,
    };
  });

  return {
    title: (json.title || 'Untitled').slice(0, 80),
    scenes: cleanScenes,
  };
}

module.exports = {
  TEMPLATES,
  TRANSITIONS,
  buildMistralSystemPrompt,
  validateSceneJSON,
};
