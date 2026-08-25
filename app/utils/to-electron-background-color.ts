// Packages
import Color from 'color';

// returns a background color that's in hex
// format including the alpha channel (e.g.: `#00000050`)
// input can be any css value (rgb, hsl, string…)
const toElectronBackgroundColor = (bgColor: string) => {
  let color;
  try {
    color = Color(bgColor);
  } catch {
    // An unparseable configured color (e.g. the string "null" from a bad
    // settings write) used to throw UNCAUGHT in the main process — an error
    // dialog on every config change and no repaint. Fall back to black.
    console.warn(`[config] unparseable backgroundColor ${JSON.stringify(bgColor)} — falling back to #000`);
    color = Color('#000');
  }

  if (color.alpha() === 1) {
    return color.hex().toString();
  }

  // http://stackoverflow.com/a/11019879/1202488
  const alphaHex = Math.round(color.alpha() * 255).toString(16);
  return `#${alphaHex}${color.hex().toString().slice(1)}`;
};

export default toElectronBackgroundColor;
