// Genera los iconos de la app (PNG por densidad) a partir de un dibujo SVG.
// Uso: node make-icons.js <carpeta res de Android> <fuente woff2> [carpeta de vista previa]
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const RES = process.argv[2], FONT = process.argv[3], PREVIEW = process.argv[4];

const BG = '#151515';
const fontB64 = fs.readFileSync(FONT).toString('base64');

// Arco de anillo entre dos ángulos (grados, 0 = arriba, sentido horario)
function arc(cx, cy, r, a0, a1) {
  const pt = (a) => { const t = (a - 90) * Math.PI / 180; return [cx + r * Math.cos(t), cy + r * Math.sin(t)]; };
  const [x0, y0] = pt(a0), [x1, y1] = pt(a1);
  return `M ${x0.toFixed(3)} ${y0.toFixed(3)} A ${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(3)} ${y1.toFixed(3)}`;
}

// El motivo: un anillo (gastos / ahorro / diezmo) con "Bs" en el centro.
// c = centro, r = radio del anillo, w = grosor
function motif(c, r, w) {
  const gap = 9; // separación entre tramos, en grados
  const segs = [[0, 216, '#e9b949'], [216, 306, '#5cc98a'], [306, 360, '#a78bfa']];
  const arcs = segs.map(([a0, a1, color]) =>
    `<path d="${arc(c, c, r, a0 + gap / 2, a1 - gap / 2)}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round"/>`).join('');
  const fs_ = r * 0.86;
  return `${arcs}<text x="${c}" y="${c + fs_ * 0.35}" text-anchor="middle" font-family="DM Sans" font-weight="700" font-size="${fs_}" letter-spacing="${-fs_ * 0.03}" fill="#f4f1ec">Bs</text>`;
}

const page_ = (size, body) => `<!doctype html><html><head><style>
@font-face{font-family:'DM Sans';font-weight:100 1000;src:url(data:font/woff2;base64,${fontB64}) format('woff2')}
html,body{margin:0;background:transparent}svg{display:block}</style></head>
<body><svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${body}</svg></body></html>`;

const VARIANTS = {
  // Capa frontal del icono adaptable: 108dp, lo visible seguro es el círculo central de 66dp
  ic_launcher_foreground: { size: 108, body: motif(54, 22.5, 6.2) },
  // Iconos clásicos (Android 7): 48dp ya con fondo
  ic_launcher: { size: 48, body: `<rect x="2" y="2" width="44" height="44" rx="10" fill="${BG}"/>${motif(24, 14, 3.9)}` },
  ic_launcher_round: { size: 48, body: `<circle cx="24" cy="24" r="22.5" fill="${BG}"/>${motif(24, 13.4, 3.7)}` },
};
const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };

(async () => {
  const browser = await chromium.launch();
  for (const [name, v] of Object.entries(VARIANTS)) {
    for (const [density, scale] of Object.entries(DENSITIES)) {
      const ctx = await browser.newContext({ viewport: { width: v.size, height: v.size }, deviceScaleFactor: scale });
      const page = await ctx.newPage();
      await page.setContent(page_(v.size, v.body));
      await page.evaluate(() => document.fonts.ready);
      const out = path.join(RES, 'mipmap-' + density, name + '.png');
      await page.screenshot({ path: out, omitBackground: true });
      await ctx.close();
    }
  }
  if (PREVIEW) {
    // Vista previa: cómo se vería recortado en círculo y en "squircle", sobre fondo claro y oscuro
    const fg = VARIANTS.ic_launcher_foreground.body;
    const tile = (x, y, clip, bgPage) => `<g transform="translate(${x},${y})"><rect width="140" height="140" fill="${bgPage}"/>
      <g transform="translate(16,16) scale(1.5)"><g clip-path="url(#${clip})"><rect x="18" y="18" width="72" height="72" fill="${BG}"/><g>${fg}</g></g></g></g>`;
    const body = `<defs><clipPath id="circ"><circle cx="54" cy="54" r="36"/></clipPath><clipPath id="sq"><rect x="18" y="18" width="72" height="72" rx="20"/></clipPath></defs>
      ${tile(0, 0, 'circ', '#e8e8ee')}${tile(140, 0, 'sq', '#e8e8ee')}${tile(280, 0, 'circ', '#101014')}${tile(420, 0, 'sq', '#101014')}`;
    const ctx = await browser.newContext({ viewport: { width: 560, height: 140 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    await page.setContent(page_(560, body).replace('height="560" viewBox="0 0 560 560"', 'height="140" viewBox="0 0 560 140"'));
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(PREVIEW, 'icon-preview.png') });
    await ctx.close();
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
