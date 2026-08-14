const { lookAt4, transformPoint4 } = require('./matrix4');
const { resolve } = require('./node');

/**
 * An animatable AE-style camera: Position + Point of Interest + Zoom -
 * the three properties that cover the overwhelming majority of real
 * camera animation (a push-in, an orbit, a pan/reveal). Position and
 * Point of Interest each accept a plain [x,y,z] or a keyframes.js
 * Property (via resolve(), batch 2's node.js helper - reused directly
 * rather than re-deriving "accept a Property or a plain value" a
 * second time).
 *
 * Deliberately SCOPED to this - no separate Orientation/rotation
 * control, no depth of field, no per-pixel 3D intersections. AE's own
 * Orientation control exists specifically to break the "camera always
 * faces its Point of Interest" assumption (e.g. for a camera roll) -
 * genuinely useful, but a distinct, larger control (arbitrary 3-axis
 * camera rotation) intentionally left for a future batch rather than
 * silently half-supported here. The fixed up=[0,-1,0] below means this
 * camera has NO ROLL and hits the well-known lookAt gimbal-lock case
 * if pointOfInterest sits directly above/below position (up and the
 * view direction become parallel) - a real, documented limitation of
 * this scope, not a hidden bug.
 *
 * up=[0,-1,0], not [0,1,0]: EMPIRICALLY verified (not assumed) before
 * writing the projection formula below - matrix4.js's lookAt4 uses a
 * standard right-handed "camera looks down -Z" construction, and with
 * this engine's Y-DOWN world convention, [0,-1,0] is the up vector
 * that keeps camera-space X unflipped (right stays right) - confirmed
 * directly: cross(up,zaxis) with up=[0,1,0] instead mirrors X entirely
 * (a right-side world point would project to the LEFT of screen
 * center). The projection formula's explicit Y-negation below is the
 * OTHER half of that same empirical finding: this lookAt construction
 * always produces a Y-up camera space (a graphics-library convention),
 * so converting to this engine's Y-down SCREEN space needs one
 * explicit sign flip on Y that X does not need - confirmed by directly
 * projecting known test points (a point above target landed at a
 * LARGER, not smaller, screen Y without this flip) before relying on
 * it for anything real.
 */
class Camera {
  constructor({
    position = [0, 0, -1000], pointOfInterest = [0, 0, 0], zoom = 1000,
  } = {}) {
    this.position = position;
    this.pointOfInterest = pointOfInterest;
    this.zoom = zoom;
  }

  /** The view matrix at time t - world space -> this camera's local space. */
  viewMatrix(t) {
    const eye = resolve(this.position, t);
    const target = resolve(this.pointOfInterest, t);
    return lookAt4(eye, target, [0, -1, 0]);
  }

  /**
   * Projects a WORLD-space point to screen space at time t, given the
   * composition's own pixel center (compWidth/2, compHeight/2 -
   * AE's camera is defined relative to the comp's own center, not an
   * arbitrary origin). Returns {x, y, depth} - depth is the point's
   * distance IN FRONT of the camera along its view direction (positive
   * = visible/in front, <=0 = behind the camera, the trivial near-
   * plane clipping test callers use to skip content behind them).
   *
   * screenX = centerX + (cx/depth)*zoom  (unflipped - camera-space X
   *   already matches screen-right thanks to the up-vector choice above)
   * screenY = centerY - (cy/depth)*zoom  (FLIPPED - see the class-level
   *   doc comment: this lookAt construction is inherently Y-up)
   * `zoom` plays the role of AE's own Zoom/focal-length control -
   * larger zoom narrows the field of view (more telephoto/magnified),
   * smaller zoom widens it (more wide-angle) for the same depth.
   */
  project(worldPoint, t, compWidth, compHeight) {
    const view = this.viewMatrix(t);
    const zoom = resolve(this.zoom, t);
    const [cx, cy, cz] = transformPoint4(view, worldPoint);
    const depth = -cz;
    const centerX = compWidth / 2, centerY = compHeight / 2;
    if (depth <= 0) return { x: centerX, y: centerY, depth };
    return {
      x: centerX + (cx / depth) * zoom,
      y: centerY - (cy / depth) * zoom,
      depth,
    };
  }
}

module.exports = { Camera };
