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
   * Dark and glowing, but NOT a surveillance/hacker-dashboard anymore -
   * the grid overlay, scanline sweep, "REC 00:00" timestamp+waveform,
   * and floating data-chip UI cards were a generic "tech HUD" cliche
   * that appears in NONE of the reference videos this system was
   * actually compared against, and kept making every video read as
   * "the same AI-generated dashboard thing" regardless of what else
   * improved. Fits finance, tech, data, "insider info" tones through
   * color/glow/mood alone now, not literal terminal chrome.
   */
  hudTerminal: {
    name: 'hudTerminal',
    bgColorInner: '#141416',
    bgColorOuter: '#08080A',
    supportsBackgroundMood: true,
    defaultBackgroundMood: 'dark',
    heroTextColor: '#F5F5F5',
    mutedTextColor: '#B5B5B8',
    fontFamily: 'sans-serif',
    fontWeight: 'bold',
    heroUsesGlow: true,
    showGrid: false,
    showScanlines: false,
    showTimestamp: false,
    showDataChips: false,
    showParticles: true,
    showGlowBlob: true,
    showDriftLines: true,
    driftLineCount: 3,
    driftLineOpacity: 0.13,
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
    supportsBackgroundMood: true,
    defaultBackgroundMood: 'light',
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
    showDriftLines: true,
    driftLineCount: 3,
    driftLineOpacity: 0.1,
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
    supportsBackgroundMood: true,
    defaultBackgroundMood: 'bold',
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
    // Flat/hard-edged is the whole identity here, so floaty soft
    // particles are still deliberately off - but that previously left
    // this system with ZERO continuous motion anywhere except camera
    // drift, reading as the most static of the three despite being the
    // "punchy/energetic" one. Bolder, more visible drift lines (not
    // particles) fit the hard-edged register while fixing that.
    showDriftLines: true,
    driftLineCount: 4,
    driftLineOpacity: 0.16,
    vignetteStrength: 0,
    flatBlockAccent: false,
  },

  /**
   * FIRST NEW SYSTEM built specifically off real 2026 short-form
   * reference footage (not a recolor of the three above) - closest
   * match was a video built almost entirely from motion graphics
   * (no live footage needed, so genuinely reproducible here): near-
   * black background, one saturated neon accent with real glow, and
   * two identity devices neither of the older systems had at all:
   * a giant, near-invisible "ghost" echo of each beat's own tag
   * looming behind its content (real depth/layering, not a flat
   * card), and a small signature mark that holds the SAME screen
   * position for the entire video (not per-beat like accentShape),
   * giving continuous brand identity the way a real creator's channel
   * watermark does. Heaviest font weight of any system on purpose -
   * the reference this was built from stakes its whole hook on text
   * that's unmissably, aggressively bold.
   */
  neonPulse: {
    name: 'neonPulse',
    bgColorInner: '#0E0E11',
    bgColorOuter: '#020203',
    supportsBackgroundMood: true,
    defaultBackgroundMood: 'dark',
    heroTextColor: '#FFFFFF',
    mutedTextColor: '#84848C',
    fontFamily: 'sans-serif',
    fontWeight: '800',
    heroUsesGlow: true,
    showGrid: false,
    showScanlines: false,
    showTimestamp: false,
    showDataChips: false,
    showParticles: true,
    showGlowBlob: true,
    showDriftLines: true,
    driftLineCount: 3,
    driftLineOpacity: 0.15,
    vignetteStrength: 0.62,
    showGhostText: true,
    ghostTextOpacity: 0.06,
    showSignatureMotif: true,
  },
};

const DEFAULT_SYSTEM = 'hudTerminal';

function getVisualSystem(name) {
  return VISUAL_SYSTEMS[name] || VISUAL_SYSTEMS[DEFAULT_SYSTEM];
}

module.exports = { VISUAL_SYSTEMS, getVisualSystem, DEFAULT_SYSTEM };
