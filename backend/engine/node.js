const { fromTRS, multiply, transformPoint, toCanvasArgs } = require('./matrix2d');
const { Property } = require('./keyframes');

/** Accepts either a plain value or a Property (from keyframes.js) transparently. */
function resolve(propOrValue, t) {
  return propOrValue instanceof Property ? propOrValue.valueAt(t) : propOrValue;
}

/**
 * A node in a transform HIERARCHY - this is what "parenting" and "null
 * objects" actually are underneath the After Effects terminology: a
 * scene graph. A child's transform is expressed relative to its
 * parent's, so animating (or just repositioning) the parent moves
 * every descendant automatically, without touching a single one of
 * their own keyframes - "rig a whole scene from one control."
 *
 * A Null Object is nothing special architecturally: it's just a Node
 * with no `draw` function - a transform that exists purely for other
 * nodes to parent to. Nothing else needs to know or care that it's
 * "a null" versus a node that happens to draw something.
 *
 * position/rotation/scale/anchor each accept a plain value OR a
 * Property instance from keyframes.js interchangeably (via resolve()
 * above) - a node doesn't need keyframes on every transform component
 * just because ONE of them is animated.
 */
class Node {
  constructor({ position = [0, 0], rotation = 0, scale = [1, 1], anchor = [0, 0], opacity = 1, draw = null, name = null } = {}) {
    this.position = position;
    this.rotation = rotation;
    this.scale = scale;
    this.anchor = anchor;
    this.opacity = opacity;
    this.draw = draw; // (ctx, t, localTime) => void, drawing in this node's own local space. null for a pure transform/null object.
    this.name = name;
    this.parent = null;
    this.children = [];
  }

  addChild(child) {
    if (child.parent) child.parent.removeChild(child);
    child.parent = this;
    this.children.push(child);
    return child;
  }

  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i !== -1) this.children.splice(i, 1);
    child.parent = null;
  }

  /** This node's own transform, in its parent's local space - no ancestry involved. */
  localMatrix(t) {
    return fromTRS({
      position: resolve(this.position, t),
      rotation: resolve(this.rotation, t),
      scale: resolve(this.scale, t),
      anchor: resolve(this.anchor, t),
    });
  }

  /**
   * The actual point of the whole hierarchy: this node's FULL transform
   * in the root's coordinate space, found by composing every ancestor's
   * local transform with this one's, root-to-leaf. A node with no
   * parent just returns its own local matrix - there's no special-case
   * "root" type, a root is simply a Node whose .parent is null.
   */
  getWorldMatrix(t) {
    const local = this.localMatrix(t);
    return this.parent ? multiply(this.parent.getWorldMatrix(t), local) : local;
  }

  /** Combined opacity down the chain - a parent fading out fades every descendant with it. */
  getWorldOpacity(t) {
    const own = resolve(this.opacity, t);
    return this.parent ? this.parent.getWorldOpacity(t) * own : own;
  }

  worldPosition(t) {
    return transformPoint(this.getWorldMatrix(t), [0, 0]);
  }

  /**
   * Renders this node (if it has a draw function) and every descendant,
   * each under its own correctly-composed world transform. Uses
   * ctx.setTransform with the ABSOLUTE world matrix at every node
   * (not ctx.translate/rotate/scale chained via save/restore) so this
   * matches getWorldMatrix()'s own math exactly - the render path and
   * the query path can never silently disagree with each other.
   */
  render(ctx, t) {
    const worldMatrix = this.getWorldMatrix(t);
    const worldOpacity = this.getWorldOpacity(t);
    if (this.draw && worldOpacity > 0.001) {
      ctx.save();
      ctx.setTransform(...toCanvasArgs(worldMatrix));
      ctx.globalAlpha = worldOpacity;
      this.draw(ctx, t);
      ctx.restore();
    }
    for (const child of this.children) {
      child.render(ctx, t);
    }
  }
}

module.exports = { Node, resolve };
