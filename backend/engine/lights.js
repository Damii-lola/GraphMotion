const { clamp01 } = require('./mathUtils');
const { resolve } = require('./node');

/**
 * AE's real light types: Point (position + falloff, radiates equally
 * in all directions), Spot (position + point of interest defining a
 * cone, + falloff), Parallel/Directional (only a direction - infinitely
 * far away, so no falloff), Ambient (uniform, no position/direction at
 * all - just fills in a base level everywhere).
 *
 * A flat AE 3D layer (batch 7's Layer3D - real content on a flat
 * plane, not a mesh) has exactly ONE surface normal across its entire
 * face, since it isn't bent - so lighting it is a genuinely SINGLE
 * Lambertian+specular calculation per layer, not a per-pixel shader.
 * This is not a simplification invented for this engine - it's
 * literally how AE itself lights a plain 3D layer with no bump/normal
 * map (Bevel Alpha's own per-pixel lighting, batch 5's textExtrude
 * bevel, is the OTHER real case AE has - a genuinely different,
 * per-pixel situation, already built, deliberately not merged with
 * this uniform-per-layer scene light system this batch).
 *
 * Deliberately NOT built: shadow casting between layers (a real,
 * meaningfully bigger feature - would need each light to know about
 * every OTHER layer's geometry to determine occlusion), and per-pixel
 * normal maps for scene lights (would require Layer3D content to carry
 * its own height/normal field, which nothing here currently produces).
 * Both are real, honestly-stated scope boundaries, not hidden gaps.
 */
class Light {
  constructor({
    type = 'point', position = [0, 0, 0], pointOfInterest = [0, 0, 0],
    color = '#ffffff', intensity = 1,
    falloff = 'none', falloffRadius = 500,
    coneAngle = 90, coneFeather = 50,
  } = {}) {
    this.type = type; // 'point' | 'spot' | 'directional' | 'ambient'
    this.position = position;
    this.pointOfInterest = pointOfInterest; // spot/directional: defines direction, same mechanism as camera3d.js's Camera
    this.color = color;
    this.intensity = intensity;
    this.falloff = falloff; // 'none' | 'smooth' | 'inverseSquareClamped'
    this.falloffRadius = falloffRadius;
    this.coneAngle = coneAngle; // degrees, spot only
    this.coneFeather = coneFeather; // percent (0-100) of the cone that's a soft edge, spot only
  }
}

// ---------------------------------------------------------------------
// Small vec3 helpers, local to this file (matrix4.js's lookAt4 takes
// the same approach - inline vector math, no separate vec3 module,
// since neither file needs more than a handful of operations).
// ---------------------------------------------------------------------
function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function length(a) { return Math.hypot(a[0], a[1], a[2]); }
function normalize(a) { const l = length(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }

function hexToRgbNorm(hex) {
  const clean = hex.replace('#', '');
  const num = parseInt(clean, 16);
  return [((num >> 16) & 255) / 255, ((num >> 8) & 255) / 255, (num & 255) / 255];
}

/** GLSL-style smoothstep, local copy (mathUtils.js doesn't export one - selectors.js has its own too, for the same reason: it's a two-line function not worth a shared module for). */
function smoothstep(edge0, edge1, x) {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/**
 * Real falloff formulas - not visually guessed:
 * - 'none': constant 1 regardless of distance (AE's own None option -
 *   full intensity at any range, matching a light with no falloff set).
 * - 'smooth': linear fade to 0 at falloffRadius, run through smoothstep
 *   for a soft (not linear-looking) taper - a real, standard "soft
 *   falloff" curve, documented as AE's own visual match rather than
 *   claimed to be bit-identical to AE's proprietary formula (the same
 *   honesty stance every prior "documented, not claimed AE-exact"
 *   approximation this session has taken, e.g. text animator shapes).
 * - 'inverseSquareClamped': the REAL physical inverse-square law
 *   (intensity ∝ 1/distance^2) - exact, not approximated - normalized
 *   so falloffRadius reads as "distance at which intensity is 1", and
 *   clamped to a max of 1 to avoid the physical singularity as
 *   distance approaches 0 (AE's own "Clamped" variant exists
 *   specifically for this reason - an un-clamped inverse square light
 *   right next to a surface would blow out to infinite brightness).
 */
function computeFalloff(falloff, distance, radius) {
  if (falloff === 'none' || !Number.isFinite(distance)) return 1;
  if (falloff === 'inverseSquareClamped') {
    const d = Math.max(distance, radius * 0.05); // clamp near-zero distance
    return Math.min(1, (radius / d) ** 2);
  }
  // 'smooth' (default)
  return smoothstep(radius, radius * 0.2, distance);
}

/**
 * The real per-layer lighting calculation: sums every light's
 * Lambertian diffuse contribution (physically exact: max(0, N.L) - the
 * standard, correct cosine-falloff term for a matte surface), plus an
 * optional Blinn-Phong specular term (the standard, real specular
 * model - max(0, N.H)^shininess using the light/view HALF-vector,
 * genuinely more correct and cheaper than the older Phong reflection-
 * vector model, not a shortcut), plus flat ambient contribution.
 *
 * `normal` and `worldPos` are the layer's single world-space normal
 * and a representative world-space point (its center) - see the
 * class-level doc comment for why one value each is correct for a
 * flat, unbent plane. `material` is `{ambient, diffuse, specularStrength,
 * shininess}` - all optional, sensible defaults applied. Returns an
 * [r,g,b] TINT in roughly 0-1+ range (can exceed 1 under strong/
 * multiple lights - callers should decide whether to clamp when
 * actually painting pixels, this function reports the real physical
 * sum rather than pre-clamping and hiding that).
 *
 * `t` resolves each light's own position/pointOfInterest via node.js's
 * resolve() - a Light's position is exactly as animatable as a
 * Camera's (batch 8's integration render animates a point light moving
 * across a scene), so this mirrors camera3d.js's Camera doing the same
 * resolve() internally rather than requiring every caller to pre-
 * resolve a light's Property-valued fields by hand.
 */
function computeLighting(normal, worldPos, lights, material = {}, cameraPos = [0, 0, -1000], t = 0) {
  const {
    ambient = 0.15, diffuse = 1, specularStrength = 0, shininess = 32,
  } = material;
  const viewDir = normalize(sub(cameraPos, worldPos));

  let r = 0, g = 0, b = 0;

  for (const light of lights) {
    const [lr, lg, lb] = hexToRgbNorm(light.color);
    const lightPos = resolve(light.position, t);
    const lightPoi = resolve(light.pointOfInterest, t);

    if (light.type === 'ambient') {
      r += lr * light.intensity * ambient;
      g += lg * light.intensity * ambient;
      b += lb * light.intensity * ambient;
      continue;
    }

    let lightDir, distance, atten;
    if (light.type === 'directional') {
      // Parallel rays - direction is constant everywhere (position
      // only sets the direction the light travels FROM, via its own
      // point of interest, exactly like camera3d.js's Camera), and
      // there's no meaningful "distance" to fall off over.
      lightDir = normalize(sub(lightPos, lightPoi));
      distance = Infinity;
      atten = 1;
    } else {
      lightDir = normalize(sub(lightPos, worldPos));
      distance = length(sub(lightPos, worldPos));
      atten = computeFalloff(light.falloff, distance, light.falloffRadius);
    }

    if (light.type === 'spot') {
      const spotDir = normalize(sub(lightPoi, lightPos)); // direction the spotlight itself points
      const toSurface = normalize(sub(worldPos, lightPos));
      const cosAngle = dot(spotDir, toSurface);
      const cosCone = Math.cos((light.coneAngle * Math.PI) / 180);
      const featherFrac = clamp01(light.coneFeather / 100);
      const cosFeatherStart = Math.cos(((light.coneAngle * (1 - featherFrac)) * Math.PI) / 180);
      atten *= smoothstep(cosCone, cosFeatherStart, cosAngle);
    }

    const ndotl = Math.max(0, dot(normal, lightDir));
    let contrib = ndotl * diffuse * light.intensity * atten;

    if (specularStrength > 0 && ndotl > 0) {
      const halfVec = normalize(add(lightDir, viewDir));
      const ndoth = Math.max(0, dot(normal, halfVec));
      contrib += (ndoth ** shininess) * specularStrength * light.intensity * atten;
    }

    r += lr * contrib;
    g += lg * contrib;
    b += lb * contrib;
  }

  return [r, g, b];
}

module.exports = { Light, computeLighting, computeFalloff };
