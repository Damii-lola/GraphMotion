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
// Playfair Display added (2026-09-03) after a direct reference-video
// analysis request - a real, recurring pattern across at least 3 of the
// 9 reference videos: an elegant serif (italic for a soft kicker line,
// bold/black for an emphasized brand word) paired against a heavy
// grotesque sans for the punchy main headline, never the same single
// typeface family doing both jobs the way this project's own output
// always has (Poppins-only, every weight). The font FILES were already
// sitting in assets/fonts/ (OFL-licensed, same as Poppins) but never
// actually registered here or added to sceneSchema.js's
// AVAILABLE_FONT_FAMILIES - this finishes wiring them in.
//
// 6 more sans+serif PAIRINGS added (2026-09-11), direct user ask ("add
// more fine fonts... have it randomize the font FAMILIES, the scenes
// just pick the fonts inside the chosen family") - all fetched as real
// static TTF instances (not the variable-font files Google's own repo
// now defaults to) from Google Fonts' own CSS API using an old-Safari
// user agent (the well-known trick for getting genuine .ttf back instead
// of .woff/.woff2 - matches this project's existing all-.ttf convention,
// since @napi-rs/canvas's GlobalFonts registry needs an sfnt file, not a
// compressed web font), all OFL-licensed same as Poppins/Playfair.
const FONT_REGISTRATIONS = [
  ['Poppins-Black.ttf', 'Poppins Black'],
  ['Poppins-Bold.ttf', 'Poppins Bold'],
  ['Poppins-Medium.ttf', 'Poppins Medium'],
  ['Poppins-Italic.ttf', 'Poppins Italic'],
  ['PlayfairDisplay-Black.ttf', 'Playfair Display Black'],
  ['PlayfairDisplay-Bold.ttf', 'Playfair Display Bold'],
  ['PlayfairDisplay-Regular.ttf', 'Playfair Display Regular'],
  ['PlayfairDisplay-Italic.ttf', 'Playfair Display Italic'],
  ['Montserrat-Black.ttf', 'Montserrat Black'],
  ['Montserrat-Bold.ttf', 'Montserrat Bold'],
  ['Montserrat-Regular.ttf', 'Montserrat Regular'],
  ['Montserrat-Italic.ttf', 'Montserrat Italic'],
  ['CormorantGaramond-Bold.ttf', 'Cormorant Garamond Bold'],
  ['CormorantGaramond-Regular.ttf', 'Cormorant Garamond Regular'],
  ['CormorantGaramond-Italic.ttf', 'Cormorant Garamond Italic'],
  ['BebasNeue-Regular.ttf', 'Bebas Neue Regular'],
  ['LibreBaskerville-Bold.ttf', 'Libre Baskerville Bold'],
  ['LibreBaskerville-Regular.ttf', 'Libre Baskerville Regular'],
  ['LibreBaskerville-Italic.ttf', 'Libre Baskerville Italic'],
  ['ArchivoBlack-Regular.ttf', 'Archivo Black'],
  ['EBGaramond-Bold.ttf', 'EB Garamond Bold'],
  ['EBGaramond-Regular.ttf', 'EB Garamond Regular'],
  ['EBGaramond-Italic.ttf', 'EB Garamond Italic'],
  ['Anton-Regular.ttf', 'Anton Regular'],
  ['Fraunces-Black.ttf', 'Fraunces Black'],
  ['Fraunces-Bold.ttf', 'Fraunces Bold'],
  ['Fraunces-Regular.ttf', 'Fraunces Regular'],
  ['Fraunces-Italic.ttf', 'Fraunces Italic'],
  ['Oswald-Bold.ttf', 'Oswald Bold'],
  ['Oswald-Regular.ttf', 'Oswald Regular'],
  ['Cardo-Bold.ttf', 'Cardo Bold'],
  ['Cardo-Regular.ttf', 'Cardo Regular'],
  ['Cardo-Italic.ttf', 'Cardo Italic'],
  ['SpaceGrotesk-Bold.ttf', 'Space Grotesk Bold'],
  ['SpaceGrotesk-Regular.ttf', 'Space Grotesk Regular'],
  ['Newsreader-Bold.ttf', 'Newsreader Bold'],
  ['Newsreader-Regular.ttf', 'Newsreader Regular'],
  ['Newsreader-Italic.ttf', 'Newsreader Italic'],
];
for (const [file, alias] of FONT_REGISTRATIONS) {
  const fontPath = path.join(FONTS_DIR, file);
  if (fs.existsSync(fontPath)) {
    GlobalFonts.registerFromPath(fontPath, alias);
  } else {
    console.warn(`[fonts] font file missing, "${alias}" will fall back to a host default: ${fontPath}`);
  }
}

// One entry per sans+serif PAIRING - `sans`/`serif` each expose the SAME
// 4 normalized keys (heavy/bold/regular/italic) regardless of how many
// real weights that particular family actually ships, so template code
// can pick a random pairing and then just address `.sans.bold` etc
// without caring which family it landed on. Families that only exist as
// a single static weight (Bebas Neue, Archivo Black, Anton) point every
// key at that same one real file - not a bug, that single weight IS the
// whole personality of those display faces. Families missing a real
// italic (Oswald, Space Grotesk) fall back to `regular` for that key
// rather than a fabricated slant.
const FONT_PAIRINGS = [
  {
    sans: {
      heavy: 'Poppins Black', bold: 'Poppins Bold', regular: 'Poppins Medium', italic: 'Poppins Italic',
    },
    serif: {
      heavy: 'Playfair Display Black', bold: 'Playfair Display Bold', regular: 'Playfair Display Regular', italic: 'Playfair Display Italic',
    },
  },
  {
    sans: {
      heavy: 'Montserrat Black', bold: 'Montserrat Bold', regular: 'Montserrat Regular', italic: 'Montserrat Italic',
    },
    serif: {
      heavy: 'Cormorant Garamond Bold', bold: 'Cormorant Garamond Bold', regular: 'Cormorant Garamond Regular', italic: 'Cormorant Garamond Italic',
    },
  },
  {
    sans: {
      heavy: 'Bebas Neue Regular', bold: 'Bebas Neue Regular', regular: 'Bebas Neue Regular', italic: 'Bebas Neue Regular',
    },
    serif: {
      heavy: 'Libre Baskerville Bold', bold: 'Libre Baskerville Bold', regular: 'Libre Baskerville Regular', italic: 'Libre Baskerville Italic',
    },
  },
  {
    sans: {
      heavy: 'Archivo Black', bold: 'Archivo Black', regular: 'Archivo Black', italic: 'Archivo Black',
    },
    serif: {
      heavy: 'EB Garamond Bold', bold: 'EB Garamond Bold', regular: 'EB Garamond Regular', italic: 'EB Garamond Italic',
    },
  },
  {
    sans: {
      heavy: 'Anton Regular', bold: 'Anton Regular', regular: 'Anton Regular', italic: 'Anton Regular',
    },
    serif: {
      heavy: 'Fraunces Black', bold: 'Fraunces Bold', regular: 'Fraunces Regular', italic: 'Fraunces Italic',
    },
  },
  {
    sans: {
      heavy: 'Oswald Bold', bold: 'Oswald Bold', regular: 'Oswald Regular', italic: 'Oswald Regular',
    },
    serif: {
      heavy: 'Cardo Bold', bold: 'Cardo Bold', regular: 'Cardo Regular', italic: 'Cardo Italic',
    },
  },
  {
    sans: {
      heavy: 'Space Grotesk Bold', bold: 'Space Grotesk Bold', regular: 'Space Grotesk Regular', italic: 'Space Grotesk Regular',
    },
    serif: {
      heavy: 'Newsreader Bold', bold: 'Newsreader Bold', regular: 'Newsreader Regular', italic: 'Newsreader Italic',
    },
  },
];

module.exports = { FONT_REGISTRATIONS, FONT_PAIRINGS };
