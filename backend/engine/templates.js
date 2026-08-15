const { Property } = require('./keyframes');
const { rectanglePath } = require('./shapePrimitives');
const { ShapeLayer } = require('./shapeLayer');
const { renderAnimatedText } = require('./textAnimator');
const { rangeSelector } = require('./selectors');
const { gradientRamp } = require('./generateEffects');

/**
 * Essential Graphics / motion graphics templates: AE's real Essential
 * Graphics panel exposes specific, named, typed properties of a
 * composition (a text field, a color, a slider) so someone without AE
 * can drop in their own content without touching the underlying
 * animation. The equivalent here - and the genuine capstone of this
 * whole session - is a Template: a named set of typed, validated
 * parameters plus a `build()` function that constructs a REAL scene
 * from them using the engine's own actual primitives (shapes, text
 * animators, selectors, generate effects - everything built across
 * every prior batch), not a separate templating micro-language. This
 * is architecturally exactly what the project's original pivot this
 * whole session was aimed at: an engine the AI (or any caller) can
 * DRIVE with parameters, rather than a fixed library of pre-baked
 * scenes - a Template is just a reusable, named, validated way to call
 * the engine with structure, not a step backward toward hardcoded
 * templates.
 */

class TemplateParam {
  constructor(name, {
    type = 'text', default: defaultValue = undefined, required = false, min, max,
  } = {}) {
    this.name = name;
    this.type = type; // 'text' | 'color' | 'number' | 'duration' | 'image'
    this.default = defaultValue;
    this.required = required;
    this.min = min;
    this.max = max;
  }

  validate(value) {
    if (value === undefined || value === null) {
      if (this.required) return { valid: false, error: `Parameter "${this.name}" is required` };
      return { valid: true, value: this.default };
    }
    if (this.type === 'number' || this.type === 'duration') {
      if (typeof value !== 'number' || Number.isNaN(value)) return { valid: false, error: `Parameter "${this.name}" must be a number` };
      if (this.min !== undefined && value < this.min) return { valid: false, error: `Parameter "${this.name}" must be >= ${this.min}` };
      if (this.max !== undefined && value > this.max) return { valid: false, error: `Parameter "${this.name}" must be <= ${this.max}` };
      return { valid: true, value };
    }
    if (this.type === 'text') {
      if (typeof value !== 'string') return { valid: false, error: `Parameter "${this.name}" must be a string` };
      return { valid: true, value };
    }
    if (this.type === 'color') {
      if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) return { valid: false, error: `Parameter "${this.name}" must be a hex color like #ff8800` };
      return { valid: true, value };
    }
    return { valid: true, value };
  }
}

/**
 * A Template: `paramDefs` (array of {name,type,default,required,min,max})
 * defines the exposed controls, `buildFn(resolvedParams, {width,height})`
 * is a real function returning `{ duration, render(ctx, t) }` - a
 * genuine renderable scene built from concrete parameter values.
 */
class Template {
  constructor(name, paramDefs, buildFn) {
    this.name = name;
    this.params = paramDefs.map((def) => new TemplateParam(def.name, def));
    this.buildFn = buildFn;
  }

  validateParams(values) {
    const resolved = {};
    const errors = [];
    for (const param of this.params) {
      const result = param.validate(values[param.name]);
      if (!result.valid) errors.push(result.error);
      else resolved[param.name] = result.value;
    }
    return { valid: errors.length === 0, errors, values: resolved };
  }

  build(values, sceneOpts = {}) {
    const validation = this.validateParams(values);
    if (!validation.valid) throw new Error(`Template "${this.name}" validation failed: ${validation.errors.join('; ')}`);
    return this.buildFn(validation.values, sceneOpts);
  }
}

/**
 * Lower Third: a slide-in accent bar (shapePrimitives.js's real
 * rounded-rectangle generator + a ShapeLayer, batch 6) with a name and
 * title revealed via a real per-character sweep (textAnimator.js's
 * renderAnimatedText + selectors.js's rangeSelector, batch 5) - the
 * exact same primitives a hand-authored scene would use, just wired up
 * behind 4 named parameters.
 */
const lowerThirdTemplate = new Template('lowerThird', [
  { name: 'name', type: 'text', required: true },
  { name: 'title', type: 'text', default: '' },
  { name: 'accentColor', type: 'color', default: '#3b6fd6' },
  { name: 'duration', type: 'duration', default: 3, min: 0.5 },
], (params, { width = 1080, height = 1920 } = {}) => {
  const {
    name, title, accentColor, duration,
  } = params;
  const barWidth = Math.min(700, width * 0.7);
  const barHeight = title ? 150 : 100;
  const barX = 40;
  const barY = height - 320;

  const barShape = rectanglePath({
    width: barWidth, height: barHeight, position: [barX + barWidth / 2, barY + barHeight / 2], roundness: 14,
  });

  const slideIn = new Property([
    { time: 0, value: -(barWidth + 60), interpolation: 'easing', easing: 'easeOutBack' },
    { time: 0.55, value: 0, interpolation: 'easing', easing: 'easeOutBack' },
  ]);

  const textReveal = {
    selector: (unit) => 1 - rangeSelector({
      start: 0,
      end: new Property([{ time: 0.15, value: 0, interpolation: 'easing', easing: 'easeOutCubic' }, { time: 0.75, value: 100, interpolation: 'easing', easing: 'easeOutCubic' }]),
      shape: 'square',
      smoothness: 4,
    })(unit),
    properties: { opacity: -1, position: [0, 10] },
  };

  return {
    duration,
    render(ctx, t) {
      const offsetX = slideIn.valueAt(t);
      ctx.save();
      ctx.translate(offsetX, 0);
      new ShapeLayer({
        contents: [
          { type: 'path', anchors: barShape.anchors, closed: true },
          { type: 'fill', color: accentColor },
        ],
      }).render(ctx, 0);

      renderAnimatedText(ctx, name, t, {
        fontFamily: 'sans-serif',
        fontWeight: '800',
        fontSize: 36,
        lineHeight: 40,
        maxWidth: barWidth - 40,
        centerX: barX + barWidth / 2,
        centerY: barY + (title ? barHeight * 0.36 : barHeight / 2),
        fillStyle: '#ffffff',
        animators: [textReveal],
      });
      if (title) {
        renderAnimatedText(ctx, title, t, {
          fontFamily: 'sans-serif',
          fontWeight: '500',
          fontSize: 22,
          lineHeight: 26,
          maxWidth: barWidth - 40,
          centerX: barX + barWidth / 2,
          centerY: barY + barHeight * 0.72,
          fillStyle: '#eef2ff',
          animators: [textReveal],
        });
      }
      ctx.restore();
    },
  };
});

/**
 * Title Card: a generated gradient backdrop (generateEffects.js's real
 * gradientRamp, batch 8) behind a centered headline + subhead, both
 * revealed via the same real per-character sweep mechanism as the
 * Lower Third above - demonstrating the SAME underlying animator
 * primitive reused across two structurally different templates,
 * rather than each template inventing its own bespoke reveal logic.
 */
const titleCardTemplate = new Template('titleCard', [
  { name: 'headline', type: 'text', required: true },
  { name: 'subhead', type: 'text', default: '' },
  { name: 'startColor', type: 'color', default: '#141c33' },
  { name: 'endColor', type: 'color', default: '#03050c' },
  { name: 'duration', type: 'duration', default: 3, min: 0.5 },
], (params, { width = 1080, height = 1920 } = {}) => {
  const {
    headline, subhead, startColor, endColor, duration,
  } = params;
  const background = gradientRamp(width, height, {
    startPoint: [width / 2, 0], endPoint: [width / 2, height], startColor, endColor,
  });

  const reveal = {
    selector: (unit) => 1 - rangeSelector({
      start: 0,
      end: new Property([{ time: 0.2, value: 0, interpolation: 'easing', easing: 'easeOutCubic' }, { time: 1.1, value: 100, interpolation: 'easing', easing: 'easeOutCubic' }]),
      shape: 'square',
      smoothness: 3,
    })(unit),
    properties: { opacity: -1, scale: 1.4 },
  };

  return {
    duration,
    render(ctx, t) {
      ctx.drawImage(background, 0, 0);
      renderAnimatedText(ctx, headline, t, {
        fontFamily: 'sans-serif',
        fontWeight: '900',
        fontSize: 64,
        lineHeight: 70,
        maxWidth: width * 0.82,
        centerX: width / 2,
        centerY: height / 2 - (subhead ? 30 : 0),
        fillStyle: '#ffffff',
        animators: [reveal],
      });
      if (subhead) {
        renderAnimatedText(ctx, subhead, t, {
          fontFamily: 'sans-serif',
          fontWeight: '500',
          fontSize: 28,
          lineHeight: 34,
          maxWidth: width * 0.75,
          centerX: width / 2,
          centerY: height / 2 + 55,
          fillStyle: '#c9d3f0',
          animators: [reveal],
        });
      }
    },
  };
});

module.exports = {
  Template, TemplateParam, lowerThirdTemplate, titleCardTemplate,
};
