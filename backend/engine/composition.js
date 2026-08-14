const { createCanvas } = require('@napi-rs/canvas');
const { Node } = require('./node');
const { toCanvasArgs } = require('./matrix2d');
const { identityRemap } = require('./timeRemap');

/**
 * A self-contained, reusable timeline of Nodes - what "precomposing" a
 * group of layers actually produces in After Effects: its own width/
 * height/duration, its own render order, usable as a single unit
 * wherever a normal layer could go. All children attach to an
 * internal root Node (itself just a null object) so a Composition can
 * be treated uniformly by PrecompNode below regardless of how many
 * top-level children it has.
 */
class Composition {
  constructor({ width, height, duration, children = [] } = {}) {
    this.width = width;
    this.height = height;
    this.duration = duration;
    this.root = new Node({ name: 'compositionRoot' });
    children.forEach((c) => this.root.addChild(c));
  }

  addChild(node) {
    return this.root.addChild(node);
  }

  render(ctx, t) {
    this.root.render(ctx, t);
  }
}

/**
 * Instantiates a Composition as a single Node within a LARGER scene
 * graph - it extends Node, so it has its own position/rotation/scale/
 * anchor/opacity and can be parented like anything else (a precomp is
 * just another kind of layer, not a special case the hierarchy needs
 * to know about). Two independent things it adds beyond a plain Node:
 *
 * - `timeRemap` (a TimeRemap from timeRemap.js, defaults to identity):
 *   decouples what MOMENT of the precomp's own internal timeline is
 *   showing from the parent's time entirely - the precomp can freeze,
 *   loop, or speed-ramp its own content while everything around it
 *   keeps running at normal speed.
 *
 * - `isolate` (default true, matching AE's real default - "precompose"
 *   literally means pre-*compose*, i.e. flatten in advance): renders
 *   the whole inner composition to its own offscreen buffer FIRST,
 *   then composites that flattened result as one unit. This is what
 *   makes a whole-group opacity/effect apply to the composited result
 *   uniformly, and what makes overlapping semi-transparent children
 *   inside the precomp blend against EACH OTHER correctly before the
 *   whole thing lands on the parent scene, instead of each child
 *   re-blending individually into whatever's already behind the
 *   precomp. `isolate: false` ("collapsed", AE's opt-out) skips the
 *   extra canvas allocation when no whole-group treatment is needed.
 */
class PrecompNode extends Node {
  constructor({ composition, timeRemap = null, isolate = true, ...nodeOpts }) {
    super(nodeOpts);
    this.composition = composition;
    this.timeRemap = timeRemap || identityRemap(composition.duration);
    this.isolate = isolate;
  }

  render(ctx, t) {
    const worldOpacity = this.getWorldOpacity(t);
    if (worldOpacity <= 0.001) return;
    const innerT = this.timeRemap.at(t);

    if (this.isolate) {
      const buffer = createCanvas(this.composition.width, this.composition.height);
      const bufferCtx = buffer.getContext('2d');
      this.composition.render(bufferCtx, innerT);

      const worldMatrix = this.getWorldMatrix(t);
      ctx.save();
      ctx.setTransform(...toCanvasArgs(worldMatrix));
      ctx.globalAlpha = worldOpacity;
      ctx.drawImage(buffer, 0, 0);
      ctx.restore();
    } else {
      // Collapsed path: rather than manually setting an outer canvas
      // transform (which a nested Node.render's OWN ctx.setTransform
      // calls would silently clobber - setTransform is absolute, not
      // multiplicative, so two of them fighting over the same context
      // is a real, easy-to-miss bug, not a hypothetical one), thread
      // this PrecompNode in as the composition's internal root's
      // parent for the duration of this render call. Every descendant
      // then composes its world matrix/opacity through THIS node's own
      // getWorldMatrix/getWorldOpacity via ordinary recursion - pure
      // math, no dependence on canvas's mutable transform-stack state
      // or the order draw calls happen to occur in.
      const originalParent = this.composition.root.parent;
      this.composition.root.parent = this;
      this.composition.render(ctx, innerT);
      this.composition.root.parent = originalParent;
    }
  }
}

module.exports = { Composition, PrecompNode };
