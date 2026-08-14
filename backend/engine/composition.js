const { createCanvas } = require('@napi-rs/canvas');
const { Node } = require('./node');
const { toCanvasArgs } = require('./matrix2d');
const { identityRemap } = require('./timeRemap');
const { renderLayerStack } = require('./layerStack');

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

  /**
   * Delegates to layerStack.js - a Composition's children are a real
   * ordered layer stack (blend modes, track mattes, adjustment layers
   * all meaningful here), not just a parenting group. This is the
   * ISOLATED render path: layerStack.js allocates its working buffers
   * at exactly this.width x this.height, which is only correct when
   * this composition is being rendered into ITS OWN local space (a
   * fresh offscreen buffer, as PrecompNode's isolate:true path does) -
   * see renderCollapsed() below for why that assumption breaks for the
   * non-isolated case, and why that's not just a limitation here but a
   * genuine, faithful echo of a real AE nuance.
   */
  render(ctx, t) {
    renderLayerStack(ctx, this.width, this.height, this.root.children, t);
  }

  /**
   * The pre-batch-3 simple recursive render, kept as the explicit
   * "collapsed" path: draws each child directly via its own render()
   * with no accumulator buffer, no size assumption, no blend-mode/
   * matte/adjustment-layer support. This is a real, deliberate
   * capability split, not an oversight - it's the same one AE itself
   * has: "Collapse Transformations" lets a precomp's content pass
   * through without being pre-rendered to a flat buffer, but that pass-
   * through explicitly forfeits the compositing guarantees a genuinely
   * isolated buffer provides (which is exactly what a layer stack's
   * blend modes and track mattes depend on to be well-defined at all -
   * they need a real "everything below, already composited" buffer to
   * blend against, and a collapsed precomp never produces one).
   */
  renderCollapsed(ctx, t) {
    for (const child of this.root.children) child.render(ctx, t);
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
      //
      // Uses renderCollapsed(), NOT render() - render() now goes
      // through layerStack.js, whose per-layer buffers are sized to
      // the composition's OWN small width/height, which is wrong here
      // (children compose through the injected parent, so their real
      // world position can land anywhere in the OUTER scene, not just
      // within this composition's own local bounds - confirmed
      // directly: using render() here clipped/lost all content outside
      // that small buffer). Real consequence, not just an
      // implementation detail: a collapsed precomp's children do not
      // get blend-mode/track-matte/adjustment-layer treatment - only
      // an isolated one does, which is a faithful match for the real
      // AE limitation, not an artificial one introduced here.
      const originalParent = this.composition.root.parent;
      this.composition.root.parent = this;
      this.composition.renderCollapsed(ctx, innerT);
      this.composition.root.parent = originalParent;
    }
  }
}

module.exports = { Composition, PrecompNode };
