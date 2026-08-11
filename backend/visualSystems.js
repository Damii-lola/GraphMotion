/**
 * THE FIX for "every video looks the same regardless of topic." Up to
 * now, drawAtmosphere()/drawComposition() were called identically for
 * every scene, every video, every topic - same dark HUD-terminal look
 * whether the prompt was about finance, a recipe, or a breakup. That's
 * a provable, real weakness (any two outputs are visually the same
 * shell with different words on them).
 *
 * This doesn't build three separate codebases - it defines three
 * CONFIGURATIONS of the same underlying primitives (particles, grain,
 * vignette, camera push, grid, chips, accents), so each system stays
 * cheap and safe (reuses everything already benchmarked/leak-tested),
 * while actually looking different: different backgrounds, different
 * typography treatment, different presence/absence of the HUD chrome
 * (grid/scanlines/timestamp), different hero-content rendering (glow
 * vs flat).
 *
 * One system is chosen per VIDEO (not per scene) - a video should
 * commit to one visual identity throughout, not mix looks scene to
 * scene.
 */

const VISUAL_SYSTEMS = {
  /**
   * The look every video has had until now: dark, glowing, HUD/
   * terminal chrome (grid, scan-lines, REC timestamp, waveform,
   * data-chip UI cards). Fits finance, tech, data, "insider info"
   * tones.
   */
  hudTerminal: {
    name: 'hudTerminal',
    bgColorInner: '#141416',
    bgColorOuter: '#08080A',
    dynamicBackground: true,
    heroTextColor: '#F5F5F5',
    mutedTextColor: '#B5B5B8',
    fontFamily: 'sans-serif',
    fontWeight: 'bold',
    heroUsesGlow: true,
    showGrid: true,
    showScanlines: true,
    showTimestamp: true,
    showDataChips: true,
    showParticles: true,
    showGlowBlob: true,
    vignetteStrength: 0.55,
  },

  /**
   * Light, calm, editorial - no grid/scanline/HUD chrome at all, no
   * neon glow on hero text. Serif type, generous whitespace, muted
   * single-accent color used sparingly. Fits reflective, lifestyle,
   * psychology, personal-essay tones - the opposite register from
   * hudTerminal, not a recolor of it.
   */
  softEditorial: {
    name: 'softEditorial',
    bgColorInner: '#F5F2ED',
    bgColorOuter: '#E8E3D9',
    heroTextColor: '#2A2622',
    mutedTextColor: '#6B655C',
    fontFamily: 'serif',
    fontWeight: 'normal',
    heroUsesGlow: false,
    showGrid: false,
    showScanlines: false,
    showTimestamp: false,
    showDataChips: false,
    showParticles: true,
    showGlowBlob: false,
    vignetteStrength: 0.2,
  },

  /**
   * Flat, saturated, poster-graphic - no glow, no soft gradients, no
   * particles. Hard-edged blocks of color, high contrast, bold flat
   * type. Fits punchy hooks, bold claims, hot-take tones - reads as
   * a completely different production, not a dimmer/brighter variant
   * of the other two.
   */
  boldGraphic: {
    name: 'boldGraphic',
    bgColorInner: '#1A1A1A',
    bgColorOuter: '#1A1A1A',
    heroTextColor: '#FFFFFF',
    mutedTextColor: '#D8D8D8',
    fontFamily: 'sans-serif',
    fontWeight: '900',
    heroUsesGlow: false,
    showGrid: false,
    showScanlines: false,
    showTimestamp: false,
    showDataChips: false,
    showParticles: false,
    showGlowBlob: false,
    vignetteStrength: 0,
    flatBlockAccent: true,
  },
};

const DEFAULT_SYSTEM = 'hudTerminal';

function getVisualSystem(name) {
  return VISUAL_SYSTEMS[name] || VISUAL_SYSTEMS[DEFAULT_SYSTEM];
}

module.exports = { VISUAL_SYSTEMS, getVisualSystem, DEFAULT_SYSTEM };
