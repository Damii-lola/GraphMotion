const { GlobalFonts } = require('@napi-rs/canvas');
const path = require('path');
const fs = require('fs');

/**
 * Font registration, pulled out of renderEngine.js into its own module
 * so any file that needs REAL text metrics (not just renderEngine.js
 * itself) can require this and get the identical registered glyphs -
 * @napi-rs/canvas's GlobalFonts registry is process-wide, so requiring
 * this from two different files is safe (registerFromPath is a no-op
 * the second time) and guarantees whichever one measures text first
 * still measures against the real bundled Poppins files, not a host
 * fallback. See sceneSchema.js's fixFramingBoxSize for why a SECOND
 * consumer of real metrics (beyond rendering itself) came up: a repair
 * pass predicting how text will wrap has to wrap it exactly the way
 * the real renderer will, and that's only possible against the same
 * registered fonts.
 */
const FONTS_DIR = path.join(__dirname, '..', 'assets', 'fonts');
const FONT_REGISTRATIONS = [
  ['Poppins-Black.ttf', 'Poppins Black'],
  ['Poppins-Bold.ttf', 'Poppins Bold'],
  ['Poppins-Medium.ttf', 'Poppins Medium'],
  ['Poppins-Italic.ttf', 'Poppins Italic'],
];
for (const [file, alias] of FONT_REGISTRATIONS) {
  const fontPath = path.join(FONTS_DIR, file);
  if (fs.existsSync(fontPath)) {
    GlobalFonts.registerFromPath(fontPath, alias);
  } else {
    console.warn(`[fonts] font file missing, "${alias}" will fall back to a host default: ${fontPath}`);
  }
}

module.exports = { FONT_REGISTRATIONS };
