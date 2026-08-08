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

const TEMPLATES = {
  kineticTextReveal: {
    description:
      'Bold statement text that punches in with scale overshoot and a glow pulse. Use for hooks, statements, questions.',
    params: {
      text: { type: 'string', required: true, maxLength: 90 },
      style: { type: 'enum', values: ['bold-glow', 'mixed-weight'], default: 'bold-glow' },
      duration: { type: 'number', min: 1.5, max: 5, default: 3 },
    },
  },

  rippleDrop: {
    description:
      'A glowing dot drops with eased motion, lands, and triggers expanding ripple rings, with caption text beneath. Use for "stop scrolling" style hooks, app-icon reveals, or attention-grabbing openers.',
    params: {
      caption: { type: 'string', maxLength: 60, default: '' },
      color: { type: 'string', default: '#FF5C1A' },
      duration: { type: 'number', min: 2, max: 4, default: 2.5 },
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

  iconCallout: {
    description:
      'Icon + short text that pops in with spring overshoot. Use for quick points/features.',
    params: {
      icon: { type: 'enum', values: ['alert', 'check', 'spark', 'clock', 'money', 'chart', 'lock', 'heart'], required: true },
      text: { type: 'string', required: true, maxLength: 60 },
      duration: { type: 'number', min: 1.5, max: 3.5, default: 2.2 },
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
    },
  },
};

const TRANSITIONS = {
  glitchWipe: { description: 'RGB-split glitch wipe between scenes. Default, punchy.' },
  lightStreakDrag: { description: 'A bright light streak drags across the screen between scenes.' },
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

  return `You are a short-form video director. Given a user's prompt, output ONLY valid JSON (no markdown, no prose, no code fences) describing a sequence of scenes for a 8-14 second vertical video (720x1280).

You may ONLY use these scene templates, choosing whichever best matches the user's intent even if not literal:

${templateDocs}

You may ONLY use these transitions between scenes:

${transitionDocs}

Rules:
- Always pick the closest matching template for any request, including abstract ones - never invent a new template.
- 2 to 4 scenes total for a 8-14s video. Keep it tight.
- Every scene needs a "transition" field (the transition used to enter that scene), except the first scene.
- Output strictly this JSON shape:

{
  "title": "short internal title",
  "scenes": [
    { "template": "kineticTextReveal", "transition": null, "params": { "text": "...", "style": "bold-glow", "duration": 3 } },
    { "template": "statCounter", "transition": "glitchWipe", "params": { "label": "...", "fromValue": 0, "toValue": 73, "suffix": "%", "duration": 2.5 } }
  ]
}

Respond with ONLY the JSON object.`;
}

function validateSceneJSON(json) {
  if (!json || !Array.isArray(json.scenes) || json.scenes.length === 0) {
    throw new Error('scene JSON missing non-empty "scenes" array');
  }
  if (json.scenes.length > 6) {
    throw new Error('too many scenes (max 6)');
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
