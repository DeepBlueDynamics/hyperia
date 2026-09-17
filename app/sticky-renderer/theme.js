// Colors, code themes, font-size persistence, zoom keys.
'use strict';

const CODE_THEMES = {
  'code:light': {bg: '#f8f8f2', text: '#383a42', css: 'atom-one-light.min.css'},
  'code:dark': {bg: '#1e1e2e', text: '#cdd6f4', css: 'atom-one-dark.min.css'}
};

function textColorForBg(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const L = 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
  return L > 0.25 ? '#1a1a1a' : '#f0f0f0';
}

function applyBgColor(doc, colorOrCode) {
  const theme = CODE_THEMES[colorOrCode];
  const hl = doc.getElementById('hlTheme');
  if (theme) {
    doc.body.style.background = theme.bg;
    doc.body.style.color = theme.text;
    if (hl) hl.href = theme.css;
  } else {
    doc.body.style.background = colorOrCode;
    doc.body.style.color = textColorForBg(colorOrCode);
    if (hl) hl.href = 'atom-one-light.min.css';
  }
}

function loadFonts(persist) {
  let stickyFontSize = 22;
  let stickyTitleFontSize = 14;
  try {
    let d = {};
    if (persist.fs.existsSync(persist.stickyDefaultsPath)) {
      try {
        d = JSON.parse(persist.fs.readFileSync(persist.stickyDefaultsPath, 'utf8')) || {};
      } catch (_) {
        d = {};
      }
    }
    if (typeof d.fontSize === 'number') stickyFontSize = d.fontSize;
    if (typeof d.titleFontSize === 'number') stickyTitleFontSize = d.titleFontSize;
    if (d.fontSize == null && persist.fs.existsSync(persist.cfgPath)) {
      const configData = JSON.parse(persist.fs.readFileSync(persist.cfgPath, 'utf8'));
      if (configData && configData.config) {
        if (configData.config.stickyFontSize) stickyFontSize = configData.config.stickyFontSize;
        if (configData.config.stickyTitleFontSize) stickyTitleFontSize = configData.config.stickyTitleFontSize;
      }
    }
  } catch (e) {
    console.error('Failed to load stickyFontSize and stickyTitleFontSize:', e);
  }
  return {stickyFontSize, stickyTitleFontSize};
}

function saveStickyFontSize(persist, size) {
  try {
    let d = {};
    if (persist.fs.existsSync(persist.stickyDefaultsPath)) {
      try {
        d = JSON.parse(persist.fs.readFileSync(persist.stickyDefaultsPath, 'utf8')) || {};
      } catch (_) {
        d = {};
      }
    }
    d.fontSize = size;
    persist.fs.writeFileSync(persist.stickyDefaultsPath, JSON.stringify(d), 'utf8');
  } catch (e) {
    console.error('Failed to save stickyFontSize:', e);
  }
}

function start(ctx) {
  const {persist, ipc, doc} = ctx;
  const fonts = loadFonts(persist);
  ctx.state.stickyFontSize = fonts.stickyFontSize;
  const titleSize = ctx.state.isSearchMode ? Math.max(fonts.stickyTitleFontSize + 3, 13) : fonts.stickyTitleFontSize;
  doc.documentElement.style.setProperty('--sticky-font-size', `${ctx.state.stickyFontSize}px`);
  doc.documentElement.style.setProperty('--sticky-title-font-size', `${titleSize}px`);

  ctx.win.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'T' || e.key === 't')) {
      e.preventDefault();
      ipc.send('sticky-toggle-seethrough');
      return;
    }
    const isPlus = e.key === '=' || e.key === '+';
    const isMinus = e.key === '-';
    const isZero = e.key === '0';
    if ((e.ctrlKey || e.metaKey) && isPlus) {
      e.preventDefault();
      try {
        ctx.state.stickyFontSize = Math.min(ctx.state.stickyFontSize + 2, 48);
        doc.documentElement.style.setProperty('--sticky-font-size', `${ctx.state.stickyFontSize}px`);
        saveStickyFontSize(persist, ctx.state.stickyFontSize);
      } catch (err) {
        console.error(err);
      }
    } else if ((e.ctrlKey || e.metaKey) && isMinus) {
      e.preventDefault();
      try {
        ctx.state.stickyFontSize = Math.max(ctx.state.stickyFontSize - 2, 10);
        doc.documentElement.style.setProperty('--sticky-font-size', `${ctx.state.stickyFontSize}px`);
        saveStickyFontSize(persist, ctx.state.stickyFontSize);
      } catch (err) {
        console.error(err);
      }
    } else if ((e.ctrlKey || e.metaKey) && isZero) {
      e.preventDefault();
      try {
        ctx.state.stickyFontSize = 22;
        doc.documentElement.style.setProperty('--sticky-font-size', `${ctx.state.stickyFontSize}px`);
        saveStickyFontSize(persist, ctx.state.stickyFontSize);
      } catch (err) {
        console.error(err);
      }
    }
  });
}

module.exports = {
  CODE_THEMES,
  textColorForBg,
  applyBgColor,
  loadFonts,
  saveStickyFontSize,
  start
};
