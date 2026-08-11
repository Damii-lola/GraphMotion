/**
 * Real graded footage almost never uses exactly one color - it uses
 * one dominant accent plus a quiet secondary. This derives that
 * secondary automatically from whatever primary accentColor a video
 * picked, via a hue shift, so it's always harmonious with the primary
 * rather than a second arbitrary color that might clash.
 */

function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const num = parseInt(full, 16);
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s;
  const l = (max + min) / 2;
  if (max === min) {
    h = s = 0;
  } else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4;
    }
    h /= 6;
  }
  return { h: h * 360, s, l };
}

function hslToRgb(h, s, l) {
  h /= 360;
  let r, g, b;
  if (s === 0) {
    r = g = b = l;
  } else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
}

function rgbToHex(r, g, b) {
  const toHex = (v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
}

/**
 * Shifts hue by a fixed offset while keeping saturation/lightness
 * close to the original, so the secondary reads as "related to" the
 * primary rather than a random different color.
 */
function deriveSecondaryColor(primaryHex, hueShiftDegrees = 40) {
  // parseInt on an invalid hex string doesn't throw - it silently
  // returns NaN, which bitwise-coerces to 0, producing black instead
  // of hitting the catch block below. Confirmed by testing malformed
  // input directly: it returned '#000000', not the intended fallback.
  // An explicit format check catches what the try/catch alone missed.
  if (typeof primaryHex !== 'string' || !/^#?[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(primaryHex)) {
    return primaryHex || '#FF5C1A';
  }
  try {
    const { r, g, b } = hexToRgb(primaryHex);
    const { h, s, l } = rgbToHsl(r, g, b);
    const newHue = (h + hueShiftDegrees) % 360;
    const { r: nr, g: ng, b: nb } = hslToRgb(newHue, s, l);
    return rgbToHex(nr, ng, nb);
  } catch (err) {
    return primaryHex;
  }
}

/**
 * Derives a dark, desaturated background tint from the video's own
 * accent color - genuinely different moods per video (dark blue,
 * dark green, dark purple...) instead of the exact same near-black
 * background every single time regardless of what color was chosen.
 * Deliberately keeps lightness very low (5-8%) so white text stays
 * legible on top regardless of which hue comes out - only the hue
 * itself varies, not the fundamental dark/readable character.
 */
function deriveDarkBackgroundTint(primaryHex) {
  if (typeof primaryHex !== 'string' || !/^#?[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(primaryHex)) {
    return { inner: '#141416', outer: '#08080A' };
  }
  try {
    const { r, g, b } = hexToRgb(primaryHex);
    const { h } = rgbToHsl(r, g, b);
    const innerRgb = hslToRgb(h, 0.35, 0.08);
    const outerRgb = hslToRgb(h, 0.4, 0.035);
    return {
      inner: rgbToHex(innerRgb.r, innerRgb.g, innerRgb.b),
      outer: rgbToHex(outerRgb.r, outerRgb.g, outerRgb.b),
    };
  } catch (err) {
    return { inner: '#141416', outer: '#08080A' };
  }
}

module.exports = { deriveSecondaryColor, deriveDarkBackgroundTint };
