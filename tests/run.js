// Pruebas de Mis Finanzas en un navegador real (Chromium), a tamaño de teléfono
// y con la hora de Bolivia. Uso: node tests/run.js
// Para correr solo algunas: ONLY="préstamo" node tests/run.js
// Requiere Playwright instalado en el sistema.
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { fakeNativeBridge } = require('./fake-native');

const ROOT = path.resolve(process.env.WWW_DIR || path.join(__dirname, '..', 'www'));
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.woff2': 'font/woff2', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
};

function startServer() {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// Movimiento tal como lo guarda la app
const mk = (id, date, amount, cat, detail) => ({ id, amount, detail, cat, date: date + 'T12:00:00' });

async function main() {
  const server = await startServer();
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch();
  const results = [];

  // Abre la app con una fecha/hora fija y datos guardados de antemano.
  // native: true, o un objeto { captured, enabled, apps } con lo que "tiene guardado" Android
  async function open({ now = '2026-11-11T10:00:00-04:00', seed = {}, native = false, serviceWorker = false } = {}) {
    const ctx = await browser.newContext({
      timezoneId: 'America/La_Paz', locale: 'es-BO',
      viewport: { width: 412, height: 915 }, acceptDownloads: true,
      serviceWorkers: serviceWorker ? 'allow' : 'block',
    });
    // Sin internet: la app no debe necesitar nada de fuera
    const external = [];
    await ctx.route('**/*', (route) => {
      const url = route.request().url();
      if (url.startsWith(base)) return route.continue();
      external.push(url);
      return route.abort();
    });
    const page = await ctx.newPage();
    await page.clock.install({ time: new Date(now) });
    if (native) await page.addInitScript(fakeNativeBridge, native === true ? {} : native);
    await page.addInitScript((s) => {
      // Solo la primera vez: si la página se recarga, se conserva lo que haya guardado
      if (sessionStorage.getItem('__seeded')) return;
      sessionStorage.setItem('__seeded', '1');
      for (const [k, v] of Object.entries(s)) localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
    }, seed);
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(base + '/');
    return { ctx, page, errors, external };
  }

  const only = process.env.ONLY ? new RegExp(process.env.ONLY, 'i') : null;
  async function test(name, fn) {
    if (only && !only.test(name)) return;
    const opened = [];
    const openTracked = async (opts) => { const o = await open(opts); opened.push(o); return o; };
    try {
      await fn(openTracked);
      for (const o of opened) {
        assert.deepStrictEqual(o.errors, [], 'errores de JavaScript en la página');
        assert.deepStrictEqual(o.external, [], 'la app intentó conectarse a internet');
      }
      results.push({ name, ok: true });
      console.log('  ✓ ' + name);
    } catch (e) {
      results.push({ name, ok: false });
      console.log('  ✗ ' + name + '\n      ' + String(e.message || e).split('\n').join('\n      '));
    } finally {
      for (const o of opened) await o.ctx.close();
    }
  }

  const listItems = (page) => page.$$eval('#list .item-detail', (els) => els.map((e) => e.textContent));
  // Cambia de modo como lo hace la persona: ⚙ y la tarjeta del modo
  const goMode = async (page, mode) => { await page.click('#gear-btn'); await page.click('#mcard-' + mode); };
  const stored = (page, key) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) || 'null'), key);
  const toastText = (page) => page.textContent('#toast');
  // Espera a que aparezca un aviso con ese texto (leer un archivo no es instantáneo)
  async function expectToast(page, regex) {
    try {
      await page.waitForFunction((src) => new RegExp(src).test(document.getElementById('toast').textContent), regex.source, { timeout: 3000 });
    } catch (e) {
      assert.fail(`se esperaba un aviso con ${regex}, pero dice: "${await toastText(page)}"`);
    }
  }
  // Espera a que se abra la confirmación de importar y devuelve su texto
  async function importSummary(page) {
    await page.waitForSelector('#import-modal.show', { timeout: 3000 });
    return page.textContent('#import-detail');
  }
  const nativeCalls = (page, plugin, method) =>
    page.evaluate(([p, m]) => window.__native.calls.filter((c) => c.plugin === p && c.method === m), [plugin, method]);
  const pressBack = (page) => page.evaluate(() => window.__native.listeners['App:backButton']({ canGoBack: false }));

  console.log('Fechas y períodos');

  await test('de noche, la fecha por defecto sigue siendo la de hoy', async (open) => {
    const a = await open({ now: '2026-11-10T21:30:00-04:00' });
    assert.strictEqual(await a.page.inputValue('#inp-date'), '2026-11-10');
    const b = await open({ now: '2026-11-30T22:00:00-04:00' });
    assert.strictEqual(await b.page.inputValue('#inp-date'), '2026-11-30');
  });

  await test('un gasto registrado de noche queda en el día correcto', async (open) => {
    const { page } = await open({ now: '2026-11-30T23:10:00-04:00' });
    await page.fill('#inp-amount', '25');
    await page.fill('#inp-detail', 'Cena');
    await page.click('#btn-submit');
    const gastos = await stored(page, 'gastos-app-v1');
    assert.strictEqual(gastos.length, 1);
    assert.strictEqual(gastos[0].date, '2026-11-30T12:00:00');
  });

  const noviembre = [
    mk(1, '2026-11-01', 10, 'Alimentación', 'DOM-01'), mk(2, '2026-11-02', 20, 'Alimentación', 'LUN-02'),
    mk(3, '2026-11-07', 30, 'Alimentación', 'SAB-07'), mk(4, '2026-11-08', 40, 'Alimentación', 'DOM-08'),
    mk(5, '2026-11-09', 50, 'Alimentación', 'LUN-09'), mk(6, '2026-11-15', 60, 'Alimentación', 'DOM-15'),
    mk(7, '2026-11-29', 70, 'Alimentación', 'DOM-29'), mk(8, '2026-11-30', 80, 'Alimentación', 'LUN-30'),
  ];

  await test('el filtro por semana incluye domingos y el último día del mes', async (open) => {
    const { page } = await open({ seed: { 'gastos-app-v1': noviembre } });
    await page.click('#tab-list');
    const all = await listItems(page);
    assert.strictEqual(all.length, 8);
    const chips = page.locator('#list-week-chips .week-chip');
    const perWeek = [];
    for (let i = 1; i < await chips.count(); i++) {
      await chips.nth(i).click();
      perWeek.push((await listItems(page)).sort());
    }
    assert.deepStrictEqual(perWeek, [
      ['DOM-01'], ['DOM-08', 'LUN-02', 'SAB-07'], ['DOM-15', 'LUN-09'], [], ['DOM-29'], ['LUN-30'],
    ]);
  });

  await test('"Esta semana" suma bien cuando hoy es domingo', async (open) => {
    const { page } = await open({ now: '2026-11-15T10:00:00-04:00', seed: { 'gastos-app-v1': noviembre } });
    await page.click('#tab-stats');
    assert.strictEqual(await page.textContent('#s-month'), 'Bs. 360,00');
    assert.strictEqual(await page.textContent('#s-week'), 'Bs. 110,00');
  });

  await test('el histórico lista los meses del más reciente al más antiguo', async (open) => {
    const ingresos = ['05', '06', '07', '08', '09', '10', '11', '12'].map((m, i) => mk(100 + i, `2026-${m}-05`, 1000, 'Sueldos', 'Sueldo'));
    ingresos.push(mk(200, '2027-01-05', 1000, 'Sueldos', 'Sueldo'));
    const { page } = await open({ now: '2027-01-11T10:00:00-04:00', seed: { 'ingresos-app-v1': ingresos, 'app-mode': 'analisis' } });
    await page.click('#antab-hist');
    const meses = await page.$$eval('#an-hist-content .an-section:last-child > div > div:first-child > div:first-child', (els) => els.map((e) => e.textContent));
    assert.deepStrictEqual(meses, [
      'Enero 2027', 'Diciembre 2026', 'Noviembre 2026', 'Octubre 2026', 'Septiembre 2026',
      'Agosto 2026', 'Julio 2026', 'Junio 2026', 'Mayo 2026',
    ]);
  });

  console.log('Pantalla');

  await test('las tipografías vienen dentro de la app', async (open) => {
    const { page } = await open();
    await page.evaluate(() => document.fonts.ready);
    assert.strictEqual(await page.evaluate(() => document.fonts.check('500 14px "DM Sans"')), true);
    assert.strictEqual(await page.evaluate(() => document.fonts.check('500 14px "Geist Mono"')), true);
  });

  await test('un detalle con símbolos se muestra tal cual', async (open) => {
    const detail = 'Cable <usb> & cargador "rápido"';
    const { page } = await open({ seed: { 'gastos-app-v1': [mk(1, '2026-11-03', 15, 'Otro', detail)] } });
    await page.click('#tab-list');
    assert.deepStrictEqual(await listItems(page), [detail]);
    await page.click('#cat-chips .chip >> text=Otro');
    assert.deepStrictEqual(await listItems(page), [detail]);
  });

  await test('en un teléfono angosto el formulario no se sale de su tarjeta', async (open) => {
    const { page } = await open();
    await page.setViewportSize({ width: 360, height: 740 });
    const box = await page.evaluate(() => ({
      fecha: document.getElementById('inp-date').getBoundingClientRect().right,
      tarjeta: document.getElementById('form-card').getBoundingClientRect().right,
      pagina: document.documentElement.scrollWidth,
    }));
    assert.ok(box.fecha <= box.tarjeta, `el campo de fecha llega a ${box.fecha} y la tarjeta a ${box.tarjeta}`);
    assert.ok(box.pagina <= 360, 'la página no debe desplazarse hacia los lados');
  });

  await test('al volver a Análisis solo queda marcada una pestaña', async (open) => {
    const { page } = await open({ seed: { 'app-mode': 'analisis' } });
    await page.click('#antab-hist');
    await page.click('#gear-btn'); await page.click('#mcard-gastos');
    await page.click('#gear-btn'); await page.click('#mcard-analisis');
    assert.strictEqual(await page.locator('#tabs-analisis .tab.active').count(), 1);
  });

  await test('versión web: después de abrirla una vez, funciona sin internet', async (open) => {
    const { ctx, page } = await open({ serviceWorker: true, seed: { 'gastos-app-v1': [mk(1, '2026-11-03', 15, 'Otro', 'Pan')] } });
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await page.evaluate(() => document.fonts.ready);
    await ctx.setOffline(true);
    await page.reload();
    await page.click('#tab-list');
    assert.deepStrictEqual(await listItems(page), ['Pan']);
    await page.evaluate(() => document.fonts.ready);
    assert.strictEqual(await page.evaluate(() => document.fonts.check('500 14px "DM Sans"')), true);
  });

  await test('versión web: el service worker borra las cachés de versiones anteriores', async (open) => {
    const { page } = await open({ serviceWorker: true });
    await page.evaluate(async () => {
      const vieja = await caches.open('mis-finanzas-v1');
      await vieja.put('/index.html', new Response('versión vieja'));
    });
    await page.evaluate(() => navigator.serviceWorker.ready);
    // Fuerza una activación nueva del service worker
    await page.evaluate(async () => {
      for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
      await navigator.serviceWorker.register('sw.js');
      await navigator.serviceWorker.ready;
    });
    await page.waitForFunction(async () => !(await caches.keys()).includes('mis-finanzas-v1'));
  });

  console.log('Copia de seguridad');

  const datos = {
    'gastos-app-v1': [mk(1, '2026-11-03', 100, 'Alimentación', 'Mercado'), mk(2, '2026-10-20', 50.5, 'Transporte', 'Taxi')],
    'ingresos-app-v1': [mk(9, '2026-11-05', 3000, 'Sueldos', 'Sueldo')],
    'analisis-pcts': { gastos: 60, ahorro: 30, diezmo: 10 },
  };

  async function exportWeb(page) {
    await page.click('#gear-btn');
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#btn-export')]);
    return { name: download.suggestedFilename(), data: JSON.parse(fs.readFileSync(await download.path(), 'utf8')) };
  }
  async function importFile(page, content, name = 'copia.json') {
    await page.click('#gear-btn');
    const buffer = Buffer.from(typeof content === 'string' ? content : JSON.stringify(content));
    await page.setInputFiles('#import-file', { name, mimeType: 'application/json', buffer });
  }

  await test('exportar descarga un archivo con gastos, ingresos y metas', async (open) => {
    const { page } = await open({ seed: datos });
    const { name, data } = await exportWeb(page);
    assert.strictEqual(name, 'mis-finanzas-2026-11-11.json');
    assert.strictEqual(data.app, 'mis-finanzas');
    assert.deepStrictEqual(data.gastos, datos['gastos-app-v1']);
    assert.deepStrictEqual(data.ingresos, datos['ingresos-app-v1']);
    assert.deepStrictEqual(data.pcts, datos['analisis-pcts']);
  });

  await test('sin datos, exportar avisa y no descarga nada', async (open) => {
    const { page } = await open();
    await page.click('#gear-btn');
    await page.click('#btn-export');
    await expectToast(page, /no hay datos/);
  });

  await test('lo exportado se puede importar en una app vacía y queda igual', async (open) => {
    const a = await open({ seed: datos });
    const { data } = await exportWeb(a.page);
    const b = await open();
    await importFile(b.page, data);
    assert.strictEqual(await importSummary(b.page), 'Se añadirán 2 gastos y 1 ingreso.');
    await b.page.click('#btn-import-confirm');
    await expectToast(b.page, /3 movimientos importados/);
    assert.deepStrictEqual(await stored(b.page, 'gastos-app-v1'), datos['gastos-app-v1']);
    assert.deepStrictEqual(await stored(b.page, 'ingresos-app-v1'), datos['ingresos-app-v1']);
    assert.deepStrictEqual(await stored(b.page, 'analisis-pcts'), datos['analisis-pcts']);
    // Y se ve en pantalla sin recargar
    assert.match(await b.page.textContent('#topbar-sub'), /1 gastos en Noviembre · Bs\. 100,00/);
    await b.page.click('#tab-list');
    assert.deepStrictEqual(await listItems(b.page), ['Mercado']);
  });

  await test('importar añade lo nuevo, omite lo repetido y descarta lo ilegible', async (open) => {
    const { page } = await open({ seed: { 'gastos-app-v1': [mk(1, '2026-11-03', 100, 'Alimentación', 'Mercado')] } });
    await importFile(page, {
      gastos: [
        mk(1, '2026-11-03', 100, 'Alimentación', 'Mercado'), // repetido
        mk(2, '2026-11-04', 20, 'Transporte', 'Micro'),
        { amount: '35.5', detail: 'Sin id', cat: 'Otro', date: '2026-11-05' }, // sin id y con otro formato
        { id: 3, amount: -5, detail: 'Monto inválido', cat: 'Otro', date: '2026-11-06T12:00:00' },
        { id: 4, amount: 10, detail: 'Fecha inválida', cat: 'Otro', date: 'ayer' },
        'basura',
      ],
      ingresos: [mk(9, '2026-11-05', 3000, 'Sueldos', 'Sueldo')],
    });
    assert.strictEqual(
      await importSummary(page),
      'Se añadirán 2 gastos y 1 ingreso. 1 ya lo tienes y se omite. 3 no se pudieron leer.'
    );
    await page.click('#btn-import-confirm');
    const gastos = await stored(page, 'gastos-app-v1');
    assert.deepStrictEqual(gastos.map((g) => g.detail).sort(), ['Mercado', 'Micro', 'Sin id']);
    const sinId = gastos.find((g) => g.detail === 'Sin id');
    assert.strictEqual(sinId.amount, 35.5);
    assert.strictEqual(sinId.date, '2026-11-05T12:00:00');
    assert.strictEqual(typeof sinId.id, 'number');
    assert.strictEqual(new Set(gastos.map((g) => g.id)).size, 3);
    assert.strictEqual((await stored(page, 'ingresos-app-v1')).length, 1);
  });

  await test('importar dos veces la misma copia no duplica nada', async (open) => {
    const { page } = await open();
    const copia = { gastos: datos['gastos-app-v1'].concat([{ amount: 7, detail: 'Sin id', cat: 'Otro', date: '2026-11-05' }]), ingresos: [] };
    await importFile(page, copia);
    await importSummary(page);
    await page.click('#btn-import-confirm');
    await importFile(page, copia);
    await expectToast(page, /no trae nada nuevo/);
    assert.strictEqual(await page.locator('#import-modal.show').count(), 0);
    assert.strictEqual((await stored(page, 'gastos-app-v1')).length, 3);
  });

  await test('importar no cambia las metas que ya estaban guardadas', async (open) => {
    const { page } = await open({ seed: { 'analisis-pcts': { gastos: 50, ahorro: 30, diezmo: 20 } } });
    await importFile(page, { gastos: datos['gastos-app-v1'], ingresos: [], pcts: { gastos: 70, ahorro: 20, diezmo: 10 } });
    await importSummary(page);
    await page.click('#btn-import-confirm');
    await expectToast(page, /2 movimientos importados/);
    assert.deepStrictEqual(await stored(page, 'analisis-pcts'), { gastos: 50, ahorro: 30, diezmo: 20 });
  });

  await test('cancelar la importación no guarda nada', async (open) => {
    const { page } = await open();
    await importFile(page, { gastos: datos['gastos-app-v1'], ingresos: [] });
    await importSummary(page);
    await page.click('#import-modal .modal-btn.cancel');
    assert.strictEqual(await stored(page, 'gastos-app-v1'), null);
    assert.strictEqual(await page.locator('#import-modal.show').count(), 0);
  });

  await test('un archivo que no es una copia se rechaza con un aviso', async (open) => {
    const { page } = await open({ seed: datos });
    for (const contenido of ['esto no es json', '{"otra":"cosa"}', '[1,2,3]', 'null']) {
      await page.evaluate(() => { document.getElementById('toast').textContent = ''; });
      await importFile(page, contenido, 'foto.jpg');
      await expectToast(page, /no es una copia de Mis Finanzas/);
      assert.strictEqual(await page.locator('#import-modal.show').count(), 0);
      await page.evaluate(() => closeSettings());
    }
    assert.deepStrictEqual(await stored(page, 'gastos-app-v1'), datos['gastos-app-v1']);
  });

  await test('importar estando en Análisis actualiza el histórico', async (open) => {
    const { page } = await open({ seed: { 'app-mode': 'analisis' } });
    await page.click('#antab-hist');
    assert.match(await page.textContent('#an-hist-content'), /Sin datos históricos/);
    await importFile(page, { gastos: datos['gastos-app-v1'], ingresos: datos['ingresos-app-v1'] });
    await importSummary(page);
    await page.click('#btn-import-confirm');
    assert.match(await page.textContent('#an-hist-content'), /Noviembre 2026/);
  });

  console.log('Dentro de la app Android (puente nativo simulado)');

  await test('exportar guarda el archivo y abre "Compartir"', async (open) => {
    const { page } = await open({ seed: datos, native: true });
    await page.click('#gear-btn');
    await page.click('#btn-export');
    await page.waitForFunction(() => window.__native.calls.some((c) => c.plugin === 'Share'));
    const [write] = await nativeCalls(page, 'Filesystem', 'writeFile');
    assert.strictEqual(write.options.path, 'mis-finanzas-2026-11-11.json');
    assert.strictEqual(write.options.directory, 'CACHE');
    assert.strictEqual(write.options.encoding, 'utf8');
    assert.deepStrictEqual(JSON.parse(write.options.data).gastos, datos['gastos-app-v1']);
    const [share] = await nativeCalls(page, 'Share', 'share');
    assert.deepStrictEqual(share.options.files, ['file:///cache/mis-finanzas-2026-11-11.json']);
    assert.strictEqual(await page.locator('#settings-modal.show').count(), 0);
  });

  await test('cerrar "Compartir" sin elegir nada no muestra error', async (open) => {
    const { page } = await open({ seed: datos, native: true });
    await page.evaluate(() => { window.__native.shareFails = 'Share canceled'; });
    await page.click('#gear-btn');
    await page.click('#btn-export');
    await page.waitForFunction(() => window.__native.calls.some((c) => c.plugin === 'Share'));
    await page.waitForTimeout(100);
    assert.strictEqual(await page.locator('#toast.show').count(), 0);
  });

  await test('muestra la versión instalada en Ajustes', async (open) => {
    const { page } = await open({ native: true });
    await page.waitForFunction(() => document.getElementById('app-version').textContent !== '');
    assert.strictEqual(await page.textContent('#app-version'), 'Versión 1.0 (7)');
  });

  await test('el botón atrás cierra ventanas, vuelve a la primera pestaña y al final minimiza', async (open) => {
    const { page } = await open({ seed: datos, native: true });
    const minimized = async () => (await nativeCalls(page, 'App', 'minimizeApp')).length;
    await page.waitForFunction(() => !!window.__native.listeners['App:backButton']);

    // Ajustes abierto → lo cierra
    await page.click('#gear-btn');
    await pressBack(page);
    assert.strictEqual(await page.locator('#settings-modal.show').count(), 0);

    // Selector de categoría abierto → lo cierra
    await page.click('#inp-cat');
    await pressBack(page);
    assert.strictEqual(await page.locator('#csel-overlay.show').count(), 0);

    // Editando un gasto → cancela y vuelve al historial; luego a "Agregar"
    await page.click('#tab-list');
    await page.click('#list .btn-action.edit');
    assert.strictEqual(await page.locator('#edit-banner.show').count(), 1);
    await pressBack(page);
    assert.strictEqual(await page.locator('#edit-banner.show').count(), 0);
    assert.strictEqual(await page.locator('#view-list').isVisible(), true);

    // Confirmación de borrado abierta → la cierra sin borrar
    await page.click('#list .btn-action.del');
    await pressBack(page);
    assert.strictEqual(await page.locator('#del-modal.show').count(), 0);
    assert.strictEqual((await stored(page, 'gastos-app-v1')).length, 2);

    await pressBack(page);
    assert.strictEqual(await page.locator('#view-add').isVisible(), true);
    assert.strictEqual(await minimized(), 0);

    // Ya en la primera pantalla → la app pasa a segundo plano
    await pressBack(page);
    assert.strictEqual(await minimized(), 1);
  });

  await test('en Análisis, atrás vuelve a la primera pestaña antes de minimizar', async (open) => {
    const { page } = await open({ seed: { ...datos, 'app-mode': 'analisis' }, native: true });
    await page.waitForFunction(() => !!window.__native.listeners['App:backButton']);
    await page.click('#antab-chart');
    await pressBack(page);
    assert.strictEqual(await page.locator('#view-analisis-config').isVisible(), true);
    assert.strictEqual((await nativeCalls(page, 'App', 'minimizeApp')).length, 0);
    await pressBack(page);
    assert.strictEqual((await nativeCalls(page, 'App', 'minimizeApp')).length, 1);
  });


  console.log('Pagos detectados: lectura de avisos');

  // Los casos están en tests/notices.tsv: los mismos que prueba la lectura en segundo plano de Android
  const notices = fs.readFileSync(path.join(__dirname, 'notices.tsv'), 'utf8').split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => { const [title, text, kind, amount, detail] = l.split('\t'); return { title, text, kind, amount, detail }; });

  await test(`lee ${notices.length} avisos de ejemplo: monto, tipo y nombre (tests/notices.tsv)`, async (open) => {
    const { page } = await open();
    const results = await page.evaluate((list) => list.map((n) => parsePaymentNotice({ title: n.title, text: n.text })), notices);
    notices.forEach((n, i) => {
      const r = results[i];
      if (n.kind === '-') { assert.strictEqual(r, null, 'no es un pago: ' + JSON.stringify(n.text)); return; }
      assert.ok(r, 'sin resultado: ' + JSON.stringify(n.text));
      assert.strictEqual(r.kind, n.kind, 'tipo: ' + n.text);
      assert.strictEqual(r.amount, Number(n.amount), 'monto: ' + n.text);
      if (n.detail !== '*') assert.strictEqual(r.detail, n.detail, 'nombre: ' + n.text);
    });
  });

  console.log('Pagos detectados: en la app');

  const aviso = (id, text, when = '2026-11-10T15:30:00-04:00', title = 'Banco Ejemplo') =>
    ({ id, pkg: 'com.banco.ejemplo', app: 'Banco Ejemplo', title, text, when: new Date(when).getTime() });
  const bancoApps = [{ pkg: 'com.banco.ejemplo', label: 'Banco Ejemplo' }, { pkg: 'com.mensajes', label: 'Mensajes' }, { pkg: 'com.otra', label: 'Ñandú Mapas' }];
  const waitSynced = (page) => page.waitForFunction(() => window.__native.calls.some((c) => c.method === 'removeCaptured'));

  await test('un aviso de pago se anota solo como gasto por revisar', async (open) => {
    const { page } = await open({ native: { enabled: true, captured: [aviso('n1', 'Pago QR realizado por Bs 50.00 a JUAN PEREZ'), aviso('n2', 'Tu clave dinámica es 1234')] } });
    await waitSynced(page);
    await expectToast(page, /1 pago detectado/);
    const gastos = await stored(page, 'gastos-app-v1');
    assert.strictEqual(gastos.length, 1);
    assert.strictEqual(gastos[0].amount, 50);
    assert.strictEqual(gastos[0].detail, 'Pago a JUAN PEREZ');
    assert.strictEqual(gastos[0].cat, 'Otro');
    assert.strictEqual(gastos[0].date, '2026-11-10T12:00:00');
    assert.strictEqual(gastos[0].pending, true);
    // Android ya puede olvidar los dos avisos (el que era un pago y el que no)
    assert.deepStrictEqual((await nativeCalls(page, 'PaymentCapture', 'removeCaptured'))[0].options.ids, ['n1', 'n2']);
    assert.strictEqual(await page.textContent('#review-bar-text'), '1 pago por revisar');
    assert.match(await page.textContent('#topbar-sub'), /1 gastos en Noviembre · Bs\. 50,00/);
    await page.click('#tab-list');
    assert.strictEqual(await page.locator('#list .tag-pending').count(), 1);
  });

  await test('revisar: poner nombre y categoría deja el gasto como uno normal', async (open) => {
    const { page } = await open({ native: { enabled: true, captured: [aviso('n1', 'Pago QR realizado por Bs 50.00 a JUAN PEREZ'), aviso('n2', 'Pago QR realizado por Bs 12.00 a KIOSCO')] } });
    await waitSynced(page);
    await page.click('#review-bar');
    assert.strictEqual(await page.locator('#review-list .rv-card').count(), 2);
    const card = page.locator('#review-list .rv-card', { hasText: 'JUAN PEREZ' });
    assert.strictEqual(await card.locator('.rv-name').inputValue(), 'Pago a JUAN PEREZ');
    await card.locator('.rv-name').fill('Almuerzo con Juan');
    await card.locator('.chip', { hasText: 'Alimentación' }).click();
    await card.locator('.rv-save').click();
    assert.strictEqual(await page.locator('#review-list .rv-card').count(), 1);
    const guardado = (await stored(page, 'gastos-app-v1')).find((g) => g.amount === 50);
    assert.strictEqual(guardado.detail, 'Almuerzo con Juan');
    assert.strictEqual(guardado.cat, 'Alimentación');
    assert.strictEqual('pending' in guardado, false);
    assert.strictEqual(await page.textContent('#review-bar-text'), '1 pago por revisar');
    // Al revisar el último, la hoja se cierra y la barra desaparece
    await page.locator('#review-list .rv-save').click();
    assert.strictEqual(await page.locator('#review-sheet.show').count(), 0);
    assert.strictEqual(await page.locator('#review-bar.show').count(), 0);
  });

  await test('revisar: descartar pide confirmación y borra el movimiento', async (open) => {
    const { page } = await open({ native: { enabled: true, captured: [aviso('n1', 'Pago QR realizado por Bs 50.00 a JUAN PEREZ')] } });
    await waitSynced(page);
    await page.click('#review-bar');
    await page.click('#review-list .rv-discard');
    assert.strictEqual((await stored(page, 'gastos-app-v1')).length, 1, 'un solo toque no debe borrar');
    assert.strictEqual(await page.textContent('#review-list .rv-discard'), '¿Descartar?');
    await page.click('#review-list .rv-discard');
    assert.deepStrictEqual(await stored(page, 'gastos-app-v1'), []);
    assert.strictEqual(await page.locator('#review-sheet.show').count(), 0);
  });

  await test('revisar: no se puede guardar sin nombre', async (open) => {
    const { page } = await open({ native: { enabled: true, captured: [aviso('n1', 'Débito de Bs 20.00')] } });
    await waitSynced(page);
    await page.click('#review-bar');
    await page.fill('#review-list .rv-name', '   ');
    await page.click('#review-list .rv-save');
    await expectToast(page, /Ponle un nombre/);
    assert.strictEqual((await stored(page, 'gastos-app-v1'))[0].pending, true);
  });

  await test('editar a mano un gasto detectado también lo da por revisado', async (open) => {
    const { page } = await open({ native: { enabled: true, captured: [aviso('n1', 'Débito de Bs 20.00', '2026-11-11T09:00:00-04:00')] } });
    await waitSynced(page);
    await page.click('#tab-list');
    await page.click('#list .btn-action.edit');
    await page.fill('#inp-detail', 'Fotocopias');
    await page.click('#btn-submit');
    const g = (await stored(page, 'gastos-app-v1'))[0];
    assert.strictEqual(g.detail, 'Fotocopias');
    assert.strictEqual('pending' in g, false);
    assert.strictEqual(await page.locator('#review-bar.show').count(), 0);
  });

  await test('un dinero recibido se anota como ingreso por revisar', async (open) => {
    const { page } = await open({ native: { enabled: true, captured: [aviso('n1', 'Recibiste Bs 120 de Carlos Mamani'), aviso('n2', 'Pagaste Bs 8 a TRUFI')] } });
    await waitSynced(page);
    const ingresos = await stored(page, 'ingresos-app-v1');
    assert.strictEqual(ingresos.length, 1);
    assert.strictEqual(ingresos[0].amount, 120);
    assert.strictEqual(ingresos[0].cat, 'Otros');
    assert.strictEqual(await page.textContent('#review-bar-text'), '2 movimientos por revisar');
    await page.click('#review-bar');
    const card = page.locator('#review-list .rv-card', { hasText: 'Carlos Mamani' });
    assert.strictEqual(await card.locator('.rv-amount').textContent(), '+Bs. 120,00');
    assert.deepStrictEqual(await card.locator('.chip').allTextContents(), ['💼 Sueldos', '📋 Encuestas', '↩️ Devolución', '📦 Otros']);
  });


  // Pasar 1 Bs del BNB al BMSC: llegan los dos avisos casi a la vez (nombre y cuenta inventados)
  const bnb = (id, monto, when) => ({ id, pkg: 'com.bnb.movil', app: 'BNB', title: 'Transferencia Interbancaria Simple', text: `Tu transferencia de ${monto} bolivianos ha sido procesada`, when: new Date(when).getTime() });
  const bmsc = (id, monto, when) => ({ id, pkg: 'com.bmsc.movil', app: 'BMSC Movil', title: 'Notificaciones', text: `Recibio transferencia de la cuenta 1234567890 JUAN PEREZ AL BANCO NACIONAL DE BOLIVIA S.A., por Bs. ${monto} Concepto sin especificar`, when: new Date(when).getTime() });

  await test('pasar dinero entre tus cuentas: se pregunta y, si confirmas, no se cuenta', async (open) => {
    const { page } = await open({ native: { enabled: true, captured: [bnb('n1', '1.00', '2026-11-12T10:16:00-04:00'), bmsc('n2', '1.00', '2026-11-12T10:16:20-04:00')] } });
    await waitSynced(page);
    await expectToast(page, /2 movimientos detectados/);
    assert.strictEqual(await page.textContent('#review-bar-text'), '1 transferencia por revisar');
    await page.click('#review-bar');
    assert.strictEqual(await page.locator('#review-list .rv-card').count(), 1);
    const card = page.locator('#review-list .rv-pair');
    assert.match(await card.textContent(), /¿Pasaste dinero entre tus cuentas\?/);
    assert.deepStrictEqual(await card.locator('.rv-amount').allTextContents(), ['−Bs. 1,00', '+Bs. 1,00']);
    await card.locator('.rv-transfer').click();
    await expectToast(page, /no se cuenta/);
    assert.deepStrictEqual(await stored(page, 'gastos-app-v1'), []);
    assert.deepStrictEqual(await stored(page, 'ingresos-app-v1'), []);
    assert.strictEqual(await page.locator('#review-sheet.show').count(), 0);
    assert.strictEqual(await page.locator('#review-bar.show').count(), 0);
  });

  await test('pasar dinero entre cuentas: "son distintos" los deja como un pago y un ingreso', async (open) => {
    const { page } = await open({ native: { enabled: true, captured: [bnb('n1', '50.00', '2026-11-12T10:16:00-04:00'), bmsc('n2', '50.00', '2026-11-12T10:18:00-04:00')] } });
    await waitSynced(page);
    await page.click('#review-bar');
    await page.click('#review-list .rv-unpair');
    assert.strictEqual(await page.locator('#review-list .rv-pair').count(), 0);
    assert.strictEqual(await page.locator('#review-list .rv-card').count(), 2);
    assert.strictEqual(await page.textContent('#review-bar-text'), '2 movimientos por revisar');
    // Aunque se vuelva a sincronizar, no se vuelven a juntar
    await page.evaluate(() => linkTransfers());
    await page.evaluate(() => closeReview());
    await page.click('#review-bar');
    assert.strictEqual(await page.locator('#review-list .rv-pair').count(), 0);
    assert.strictEqual((await stored(page, 'gastos-app-v1'))[0].amount, 50);
    assert.strictEqual((await stored(page, 'ingresos-app-v1'))[0].amount, 50);
  });

  await test('pasar dinero entre cuentas: se juntan aunque los avisos lleguen en momentos distintos', async (open) => {
    const { page } = await open({ native: { enabled: true, captured: [bnb('n1', '20.00', '2026-11-12T09:00:00-04:00')] } });
    await waitSynced(page);
    assert.strictEqual(await page.textContent('#review-bar-text'), '1 pago por revisar');
    await page.evaluate((a) => { window.__native.captured.push(a); window.__native.listeners['PaymentCapture:captured']({}); }, bmsc('n2', '20.00', '2026-11-12T09:05:00-04:00'));
    await page.waitForFunction(() => document.getElementById('review-bar-text').textContent === '1 transferencia por revisar');
  });

  await test('no se juntan si el monto es distinto o pasó mucho tiempo', async (open) => {
    const { page } = await open({ native: { enabled: true, captured: [
      bnb('n1', '20.00', '2026-11-12T09:00:00-04:00'), bmsc('n2', '25.00', '2026-11-12T09:01:00-04:00'),
      bnb('n3', '10.00', '2026-11-12T09:00:00-04:00'), bmsc('n4', '10.00', '2026-11-12T09:30:00-04:00'),
    ] } });
    await waitSynced(page);
    assert.strictEqual(await page.textContent('#review-bar-text'), '4 movimientos por revisar');
    await page.click('#review-bar');
    assert.strictEqual(await page.locator('#review-list .rv-pair').count(), 0);
  });

  await test('si Android vuelve a entregar un aviso ya anotado, no se duplica', async (open) => {
    const { page } = await open({ native: { enabled: true, captured: [aviso('n1', 'Pago QR realizado por Bs 50.00 a JUAN PEREZ')] } });
    // Simula un fallo justo al confirmar: Android conserva el aviso y lo entrega otra vez
    await page.evaluate(() => { window.__native.removeFails = true; });
    await page.waitForFunction(() => (JSON.parse(localStorage.getItem('gastos-app-v1') || '[]')).length === 1);
    await page.evaluate(() => { window.__native.removeFails = false; });
    await page.evaluate(() => window.__native.listeners['App:resume']());
    await page.waitForFunction(() => window.__native.captured.length === 0);
    assert.strictEqual((await stored(page, 'gastos-app-v1')).length, 1);
  });

  await test('un pago que llega con la app abierta aparece al momento', async (open) => {
    const { page } = await open({ native: { enabled: true } });
    await page.waitForFunction(() => !!window.__native.listeners['PaymentCapture:captured']);
    assert.strictEqual(await page.locator('#review-bar.show').count(), 0);
    await page.evaluate((a) => { window.__native.captured.push(a); window.__native.listeners['PaymentCapture:captured']({}); }, aviso('n9', 'Compra por Bs 33,50 en LIBRERIA'));
    await page.waitForSelector('#review-bar.show');
    assert.strictEqual((await stored(page, 'gastos-app-v1'))[0].amount, 33.5);
  });

  await test('configurar: elegir la app del banco y ver el estado del permiso', async (open) => {
    const { page } = await open({ native: { enabled: false, apps: bancoApps } });
    await page.click('#gear-btn');
    assert.strictEqual(await page.locator('#capture-section').isVisible(), true);
    assert.strictEqual(await page.textContent('#capture-summary'), 'Desactivado');
    await page.click('#capture-card');
    assert.strictEqual(await page.locator('#settings-modal.show').count(), 0);
    assert.strictEqual(await page.textContent('#capture-permission'), 'Falta dar el permiso');

    // Paso 1: buscar (sin tildes ni mayúsculas) y elegir la app
    await page.click('#capture-body [data-act="pick"]');
    await page.waitForSelector('#picker-list [data-pkg]');
    assert.strictEqual(await page.locator('#picker-list [data-pkg]').count(), 3);
    await page.fill('#picker-search', 'nandu');
    assert.deepStrictEqual(await page.locator('#picker-list [data-pkg]').allTextContents(), ['Ñandú Mapas']);
    await page.fill('#picker-search', 'banco');
    await page.click('#picker-list [data-pkg="com.banco.ejemplo"]');
    await page.waitForSelector('#picker-list .sel');
    await page.click('#picker-sheet .sheet-close');
    assert.deepStrictEqual(await page.evaluate(() => window.__native.watched), ['com.banco.ejemplo']);
    assert.deepStrictEqual(await page.locator('#capture-body .app-chip span').allTextContents(), ['Banco Ejemplo']);

    // Paso 2: el botón abre los ajustes de Android; al volver con el permiso dado, se refleja
    await page.click('#capture-body [data-act="access"]');
    assert.strictEqual((await nativeCalls(page, 'PaymentCapture', 'openAccessSettings')).length, 1);
    await page.click('#capture-body [data-act="appinfo"]');
    assert.strictEqual((await nativeCalls(page, 'PaymentCapture', 'openAppInfo')).length, 1);
    await page.evaluate(() => { window.__native.captureEnabled = true; window.__native.listeners['App:resume'](); });
    await page.waitForFunction(() => document.getElementById('capture-permission').textContent.includes('concedido'));
    assert.strictEqual(await page.locator('#capture-body [data-act="appinfo"]').count(), 0);
    await page.click('#capture-sheet .sheet-close');
    await page.click('#gear-btn');
    assert.strictEqual(await page.textContent('#capture-summary'), 'Activo · Banco Ejemplo · falta permitir el aviso');

    // Quitar la app deja de vigilarla
    await page.click('#capture-card');
    await page.click('#capture-body [data-remove]');
    await page.waitForFunction(() => window.__native.watched.length === 0);
    assert.strictEqual(await page.locator('#capture-body .app-chip').count(), 0);
  });

  await test('al abrir, Android vigila las apps que quedaron elegidas', async (open) => {
    const { page } = await open({ seed: { 'capture-apps': [bancoApps[0]] }, native: { enabled: true, apps: bancoApps } });
    await page.waitForFunction(() => window.__native.watched.length === 1);
    assert.deepStrictEqual(await page.evaluate(() => window.__native.watched), ['com.banco.ejemplo']);
  });

  await test('la configuración muestra los últimos avisos leídos y permite compartirlos', async (open) => {
    const { page } = await open({ seed: { 'capture-apps': [bancoApps[0]] }, native: { enabled: true, captured: [aviso('n1', 'Pago QR realizado por Bs 50.00 a JUAN PEREZ'), aviso('n2', 'Tu clave dinámica es 1234')] } });
    await waitSynced(page);
    await page.click('#gear-btn');
    await page.click('#capture-card');
    const filas = page.locator('#capture-body .log-item');
    assert.strictEqual(await filas.count(), 2);
    assert.deepStrictEqual((await page.locator('#capture-body .log-result').allTextContents()).sort(), ['Gasto Bs. 50,00', 'Sin monto en Bs']);
    await page.click('#capture-body [data-act="share-log"]');
    const [share] = await nativeCalls(page, 'Share', 'share');
    assert.match(share.options.text, /Pago QR realizado por Bs 50\.00 a JUAN PEREZ/);
    assert.match(share.options.text, /sin monto/);
  });

  await test('el botón atrás cierra las hojas de pagos detectados', async (open) => {
    const { page } = await open({ native: { enabled: true, apps: bancoApps, captured: [aviso('n1', 'Pago por Bs 5')] } });
    await waitSynced(page);
    await page.click('#review-bar');
    await pressBack(page);
    assert.strictEqual(await page.locator('#review-sheet.show').count(), 0);
    await page.click('#gear-btn');
    await page.click('#capture-card');
    await page.click('#capture-body [data-act="pick"]');
    await page.waitForSelector('#picker-sheet.show');
    await pressBack(page);
    assert.strictEqual(await page.locator('#picker-sheet.show').count(), 0);
    assert.strictEqual(await page.locator('#capture-sheet.show').count(), 1);
    await pressBack(page);
    assert.strictEqual(await page.locator('#capture-sheet.show').count(), 0);
    assert.strictEqual((await nativeCalls(page, 'App', 'minimizeApp')).length, 0);
  });

  await test('en el navegador no aparece la opción de pagos automáticos', async (open) => {
    const { page } = await open();
    await page.click('#gear-btn');
    assert.strictEqual(await page.locator('#capture-section').isVisible(), false);
  });

  await test('los movimientos por revisar viajan en la copia de seguridad', async (open) => {
    const a = await open({ native: { enabled: true, captured: [aviso('n1', 'Pago QR realizado por Bs 50.00 a JUAN PEREZ')] } });
    await waitSynced(a.page);
    const copia = await a.page.evaluate(() => buildBackup());
    const b = await open();
    await importFile(b.page, copia);
    await importSummary(b.page);
    await b.page.click('#btn-import-confirm');
    await b.page.waitForSelector('#review-bar.show');
    assert.strictEqual(await b.page.textContent('#review-bar-text'), '1 pago por revisar');
  });



  console.log('Aviso al detectar un pago');

  await test('abrir la app desde el aviso muestra «Por revisar»', async (open) => {
    const { page } = await open({ native: { enabled: true, openReviewOnStart: true, captured: [aviso('n1', 'Tu transferencia de 50.00 bolivianos ha sido procesada')] } });
    await page.waitForSelector('#review-sheet.show');
    assert.strictEqual(await page.locator('#review-list .rv-card').count(), 1);
    assert.match(await page.textContent('#review-list .rv-amount'), /Bs\. 50,00/);
  });

  await test('tocar el aviso con la app en segundo plano también abre «Por revisar»', async (open) => {
    const { page } = await open({ native: { enabled: true } });
    await page.waitForFunction(() => !!window.__native.listeners['PaymentCapture:openReview']);
    await page.click('#gear-btn');
    await page.evaluate((a) => { window.__native.captured.push(a); window.__native.listeners['PaymentCapture:openReview']({}); }, aviso('n2', 'Pagaste Bs 12 a KIOSCO'));
    await page.waitForSelector('#review-sheet.show');
    assert.strictEqual(await page.locator('#settings-modal.show').count(), 0);
    assert.strictEqual(await page.inputValue('#review-list .rv-name'), 'Pago a KIOSCO');
  });

  await test('si no queda nada por revisar, tocar el aviso no abre nada', async (open) => {
    const { page } = await open({ native: { enabled: true, openReviewOnStart: true } });
    await page.waitForFunction(() => window.__native.calls.some((c) => c.method === 'getCaptured'));
    await page.waitForTimeout(200);
    assert.strictEqual(await page.locator('#review-sheet.show').count(), 0);
  });

  await test('con la detección activa, se pide permiso para el aviso una sola vez', async (open) => {
    const { page } = await open({ seed: { 'capture-apps': [{ pkg: 'com.bnb', label: 'BNB' }] }, native: { enabled: true } });
    await page.waitForFunction(() => window.__native.calls.some((c) => c.method === 'requestNotifyPermission'));
    await page.click('#gear-btn');
    await page.waitForFunction(() => /^Activo · BNB$/.test(document.getElementById('capture-summary').textContent));
    await page.reload();
    await page.waitForFunction(() => window.__native.calls.some((c) => c.method === 'getStatus'));
    await page.waitForTimeout(300);
    assert.strictEqual((await nativeCalls(page, 'PaymentCapture', 'requestNotifyPermission')).length, 0);
  });

  await test('sin la detección activa no se pide el permiso del aviso', async (open) => {
    const { page } = await open({ native: { enabled: false } });
    await page.waitForFunction(() => window.__native.calls.some((c) => c.method === 'getStatus'));
    await page.waitForTimeout(300);
    assert.strictEqual((await nativeCalls(page, 'PaymentCapture', 'requestNotifyPermission')).length, 0);
  });

  await test('paso 3: permitir, desactivar y volver a activar el aviso', async (open) => {
    const { page } = await open({ native: { enabled: false } });
    await page.click('#gear-btn');
    await page.click('#capture-card');
    await page.waitForFunction(() => document.getElementById('notify-status'));
    assert.strictEqual(await page.textContent('#notify-status'), 'Falta permitir las notificaciones');
    await page.click('#capture-body [data-act="notify-on"]');
    await page.waitForFunction(() => document.getElementById('notify-status').textContent === '✓ Activado');
    await page.click('#capture-body [data-act="notify-off"]');
    await page.waitForFunction(() => document.getElementById('notify-status').textContent === 'Desactivado');
    assert.deepStrictEqual((await nativeCalls(page, 'PaymentCapture', 'setNotifyEnabled')).map((c) => c.options.enabled), [false]);
    await page.click('#capture-body [data-act="notify-on"]');
    await page.waitForFunction(() => document.getElementById('notify-status').textContent === '✓ Activado');
  });

  await test('si Android bloqueó las notificaciones, el paso 3 lleva a sus ajustes', async (open) => {
    const { page } = await open({ native: { enabled: true, notify: { enabled: true, permission: 'denied' } } });
    await page.click('#gear-btn');
    await page.click('#capture-card');
    await page.waitForFunction(() => document.getElementById('notify-status'));
    assert.match(await page.textContent('#notify-status'), /bloqueadas/);
    await page.click('#capture-body [data-act="notify-settings"]');
    assert.strictEqual((await nativeCalls(page, 'PaymentCapture', 'openNotifySettings')).length, 1);
  });

  await test('Ajustes avisa si falta permitir el aviso', async (open) => {
    const { page } = await open({ seed: { 'capture-apps': [{ pkg: 'com.bnb', label: 'BNB' }], 'notify-asked': '1' }, native: { enabled: true } });
    await page.click('#gear-btn');
    await page.waitForFunction(() => /falta permitir el aviso/.test(document.getElementById('capture-summary').textContent));
  });


  console.log('Fijos');

  // Plantillas de fijos tal como se guardan
  const fijo = (id, kind, name, cat, day, start, amounts, upTo = null) =>
    ({ id, kind, name, cat, day, start, amounts: amounts.map(([from, amount]) => ({ from, amount })), upTo });
  const fixedOf = (list, fixedId) => (list || []).filter((e) => e.fixedId === fixedId).map((e) => [e.fixedMonth, e.amount, e.date.slice(0, 10)]).sort();

  await test('un gasto fijo se anota solo y aparece en «Fijos»', async (open) => {
    const { page } = await open();
    await goMode(page, 'fijos');
    assert.match(await page.textContent('#fixed-content'), /Anota aquí lo que se repite cada mes/);
    await page.click('#fixed-content [data-add="gastos"]');
    assert.strictEqual(await page.textContent('#fixed-sheet-title'), 'Nuevo gasto fijo');
    // Préstamo no es una categoría para un fijo
    assert.strictEqual(await page.locator('#fx-cats .chip:has-text("Préstamo")').count(), 0);
    await page.fill('#fx-name', 'Micro');
    await page.fill('#fx-amount', '120');
    await page.fill('#fx-day', '1');
    await page.click('#fx-cats .chip:has-text("Transporte")');
    await page.click('#fx-save');
    await expectToast(page, /Gasto fijo guardado · anotado en noviembre/);
    const g = (await stored(page, 'gastos-app-v1'))[0];
    assert.deepStrictEqual([g.amount, g.detail, g.cat, g.date, g.fixedMonth, g.fixedAuto], [120, 'Micro', 'Transporte', '2026-11-01T12:00:00', '2026-11', true]);
    const text = (await page.innerText('#fixed-content')).replace(/\s+/g, ' ');
    assert.match(text, /Gastos fijos −Bs\. 120,00/);
    assert.match(text, /Quedan −Bs\. 120,00/);
    assert.match(text, /Micro Transporte día 1 Bs\. 120,00 ✓ Anotado el 01\/11\/2026/);
    // En Mis Gastos cuenta como un gasto más, con la etiqueta «Fijo»
    await goMode(page, 'gastos');
    assert.match(await page.textContent('#topbar-sub'), /1 gastos en Noviembre · Bs\. 120,00/);
    await page.click('#tab-list');
    assert.match(await page.textContent('#list'), /Fijo/);
  });

  await test('un ingreso fijo se anota recién cuando llega su día', async (open) => {
    const seed = { 'app-mode': 'ingresos', 'fijos-app-v1': [fijo(7, 'ingresos', 'Sueldo', 'Sueldos', 30, '2026-11', [['2026-11', 2880.57]])] };
    const a = await open({ seed });
    assert.strictEqual(await stored(a.page, 'ingresos-app-v1'), null);
    await goMode(a.page, 'fijos');
    assert.match(await a.page.textContent('#fixed-content'), /Se anota el 30 de noviembre/);
    const b = await open({ seed, now: '2026-11-30T08:00:00-04:00' });
    assert.deepStrictEqual(fixedOf(await stored(b.page, 'ingresos-app-v1'), 7), [['2026-11', 2880.57, '2026-11-30']]);
    assert.match(await b.page.textContent('#topbar-sub'), /1 ingresos en Noviembre · Bs\. 2\.880,57/);
  });

  await test('se ponen al día los meses en que no se abrió la app', async (open) => {
    const { page } = await open({ seed: {
      'fijos-app-v1': [fijo(7, 'gastos', 'Micro', 'Transporte', 1, '2026-09', [['2026-09', 120]], '2026-09')],
      'gastos-app-v1': [{ ...mk(1, '2026-09-01', 120, 'Transporte', 'Micro'), fixedId: 7, fixedMonth: '2026-09', fixedAuto: true }],
    } });
    assert.deepStrictEqual(fixedOf(await stored(page, 'gastos-app-v1'), 7), [
      ['2026-09', 120, '2026-09-01'], ['2026-10', 120, '2026-10-01'], ['2026-11', 120, '2026-11-01'],
    ]);
  });

  await test('un fijo del día 31 se anota el último día en los meses cortos', async (open) => {
    const { page } = await open({ now: '2027-02-28T09:00:00-04:00', seed: { 'fijos-app-v1': [fijo(7, 'gastos', 'Alquiler', 'Hogar', 31, '2027-02', [['2027-02', 1500]])] } });
    assert.deepStrictEqual(fixedOf(await stored(page, 'gastos-app-v1'), 7), [['2027-02', 1500, '2027-02-28']]);
  });

  const conSueldo = {
    'app-mode': 'ingresos',
    'fijos-app-v1': [fijo(7, 'ingresos', 'Sueldo', 'Sueldos', 1, '2026-10', [['2026-10', 2880.57]], '2026-11')],
    'ingresos-app-v1': [
      { ...mk(1, '2026-11-01', 2880.57, 'Sueldos', 'Sueldo'), fixedId: 7, fixedMonth: '2026-11', fixedAuto: true },
      { ...mk(2, '2026-10-01', 2880.57, 'Sueldos', 'Sueldo'), fixedId: 7, fixedMonth: '2026-10', fixedAuto: true },
    ],
  };

  await test('un aumento de sueldo desde el próximo mes no cambia los meses anteriores', async (open) => {
    const a = await open({ seed: conSueldo });
    await goMode(a.page, 'fijos');
    await a.page.click('#fixed-content .fx-card');
    assert.strictEqual(await a.page.isVisible('#fx-from-field'), false);
    await a.page.fill('#fx-amount', '3100');
    assert.strictEqual(await a.page.isVisible('#fx-from-field'), true);
    await a.page.click('#fx-from .chip:has-text("Desde diciembre")');
    await a.page.click('#fx-save');
    await expectToast(a.page, /Bs\. 3\.100,00 desde diciembre/);
    assert.deepStrictEqual(fixedOf(await stored(a.page, 'ingresos-app-v1'), 7), [['2026-10', 2880.57, '2026-10-01'], ['2026-11', 2880.57, '2026-11-01']]);
    assert.match(await a.page.textContent('#fixed-content'), /Desde diciembre: Bs\. 3\.100,00/);
    // En diciembre ya se anota con el nuevo monto
    const fijos = await stored(a.page, 'fijos-app-v1');
    const b = await open({ now: '2026-12-02T09:00:00-04:00', seed: { ...conSueldo, 'fijos-app-v1': fijos, 'ingresos-app-v1': await stored(a.page, 'ingresos-app-v1') } });
    assert.deepStrictEqual(fixedOf(await stored(b.page, 'ingresos-app-v1'), 7).map((x) => x[1]), [2880.57, 2880.57, 3100]);
  });

  await test('un cambio de monto desde este mes actualiza el de este mes', async (open) => {
    const { page } = await open({ seed: conSueldo });
    await goMode(page, 'fijos');
    await page.click('#fixed-content .fx-card');
    await page.fill('#fx-amount', '3100');
    assert.match(await page.textContent('#fx-note'), /El de noviembre, si ya se anotó, pasa al nuevo monto/);
    await page.click('#fx-save');
    assert.deepStrictEqual(fixedOf(await stored(page, 'ingresos-app-v1'), 7).map((x) => x[1]), [2880.57, 3100]);
  });

  await test('si borras el de un mes, no vuelve a aparecer', async (open) => {
    const { page } = await open({ seed: { 'fijos-app-v1': [fijo(7, 'gastos', 'Micro', 'Transporte', 1, '2026-11', [['2026-11', 120]])] } });
    await page.click('#tab-list');
    await page.click('#list .btn-action.del');
    await page.click('#del-modal .modal-btn.confirm');
    await page.reload();
    assert.deepStrictEqual(await stored(page, 'gastos-app-v1'), []);
    await goMode(page, 'fijos');
    assert.match(await page.textContent('#fixed-content'), /Este mes no se cuenta/);
  });

  await test('eliminar un fijo deja los meses anotados y no anota más', async (open) => {
    const a = await open({ seed: { 'fijos-app-v1': [fijo(7, 'gastos', 'Micro', 'Transporte', 1, '2026-11', [['2026-11', 120]])] } });
    await goMode(a.page, 'fijos');
    await a.page.click('#fixed-content .fx-card');
    await a.page.click('#fx-delete');
    assert.deepStrictEqual(await stored(a.page, 'fijos-app-v1') && (await stored(a.page, 'fijos-app-v1')).length, 1);
    await a.page.click('#fx-delete');
    await expectToast(a.page, /Fijo eliminado/);
    assert.deepStrictEqual(await stored(a.page, 'fijos-app-v1'), []);
    const gastos = await stored(a.page, 'gastos-app-v1');
    assert.strictEqual(gastos.length, 1);
    const b = await open({ now: '2026-12-05T09:00:00-04:00', seed: { 'fijos-app-v1': [], 'gastos-app-v1': gastos } });
    assert.strictEqual((await stored(b.page, 'gastos-app-v1')).length, 1);
  });

  // El aviso del BMSC por el sueldo (nombre y cuenta inventados)
  const sueldoBanco = (id, when, monto = '2,880.57') => ({ id, pkg: 'com.bmsc', app: 'BMSC Movil', title: 'Notificaciones',
    text: `Recibio transferencia de la cuenta 1234567890 EMPRESA EJEMPLO SRL AL BANCO NACIONAL DE BOLIVIA S.A., por Bs. ${monto} Concepto Sueldo`, when: new Date(when).getTime() });
  const sueldoFijo = { 'fijos-app-v1': [fijo(7, 'ingresos', 'Sueldo', 'Sueldos', 30, '2026-11', [['2026-11', 2880.57]])] };

  await test('el aviso del banco por tu sueldo se reconoce y no se cuenta dos veces', async (open) => {
    const { page } = await open({ now: '2026-11-30T10:05:00-04:00', seed: { ...sueldoFijo, 'app-mode': 'ingresos' },
      native: { enabled: true, captured: [sueldoBanco('n1', '2026-11-30T10:00:00-04:00')] } });
    await waitSynced(page);
    // Antes de confirmar hay dos: el anotado solo y el del aviso
    assert.strictEqual((await stored(page, 'ingresos-app-v1')).length, 2);
    await page.click('#review-bar');
    const card = page.locator('#review-list .rv-fixed');
    assert.match(await card.textContent(), /¿Es tu ingreso fijo «Sueldo» de noviembre\?/);
    await card.locator('.rv-isfixed').click();
    await expectToast(page, /Anotado como tu fijo «Sueldo»/);
    const ingresos = await stored(page, 'ingresos-app-v1');
    assert.strictEqual(ingresos.length, 1);
    assert.deepStrictEqual([ingresos[0].detail, ingresos[0].cat, ingresos[0].fixedMonth, 'pending' in ingresos[0], 'fixedAuto' in ingresos[0]], ['Sueldo', 'Sueldos', '2026-11', false, false]);
    assert.match(await page.textContent('#topbar-sub'), /1 ingresos en Noviembre · Bs\. 2\.880,57/);
    await goMode(page, 'fijos');
    assert.match(await page.textContent('#fixed-content'), /con el aviso del banco/);
  });

  await test('si el sueldo llega antes de su día, después no se anota otra vez', async (open) => {
    const a = await open({ now: '2026-11-28T10:05:00-04:00', seed: sueldoFijo, native: { enabled: true, captured: [sueldoBanco('n1', '2026-11-28T10:00:00-04:00', '2,900.00')] } });
    await waitSynced(a.page);
    await a.page.click('#review-bar');
    await a.page.click('#review-list .rv-isfixed');
    const ingresos = await stored(a.page, 'ingresos-app-v1');
    assert.deepStrictEqual(fixedOf(ingresos, 7), [['2026-11', 2900, '2026-11-28']]);
    const b = await open({ now: '2026-11-30T12:00:00-04:00', seed: { ...sueldoFijo, 'fijos-app-v1': await stored(a.page, 'fijos-app-v1'), 'ingresos-app-v1': ingresos } });
    assert.deepStrictEqual(fixedOf(await stored(b.page, 'ingresos-app-v1'), 7), [['2026-11', 2900, '2026-11-28']]);
  });

  await test('«No, es otro» lo deja como un ingreso más', async (open) => {
    const { page } = await open({ now: '2026-11-30T10:05:00-04:00', seed: sueldoFijo, native: { enabled: true, captured: [sueldoBanco('n1', '2026-11-30T10:00:00-04:00')] } });
    await waitSynced(page);
    await page.click('#review-bar');
    await page.click('#review-list .rv-notfixed');
    assert.strictEqual(await page.locator('#review-list .rv-fixed').count(), 0);
    assert.strictEqual(await page.locator('#review-list .rv-card').count(), 1);
    assert.strictEqual((await stored(page, 'ingresos-app-v1')).length, 2);
  });

  await test('no se propone como fijo un monto muy distinto', async (open) => {
    const { page } = await open({ now: '2026-11-30T10:05:00-04:00', seed: sueldoFijo, native: { enabled: true, captured: [sueldoBanco('n1', '2026-11-30T10:00:00-04:00', '1,500.00')] } });
    await waitSynced(page);
    await page.click('#review-bar');
    assert.strictEqual(await page.locator('#review-list .rv-fixed').count(), 0);
  });

  await test('Fijos resume lo que entra y sale cada mes', async (open) => {
    const { page } = await open({ seed: { 'fijos-app-v1': [
      fijo(7, 'ingresos', 'Sueldo', 'Sueldos', 30, '2026-11', [['2026-11', 2880.57]]),
      fijo(8, 'gastos', 'Micro', 'Transporte', 1, '2026-11', [['2026-11', 120]]),
      fijo(9, 'gastos', 'Alquiler', 'Hogar', 5, '2026-12', [['2026-12', 1500]]),
    ] } });
    await goMode(page, 'fijos');
    const text = (await page.innerText('#fixed-content')).replace(/\s+/g, ' ');
    assert.match(text, /Ingresos fijos \+Bs\. 2\.880,57 Gastos fijos −Bs\. 120,00 Quedan Bs\. 2\.760,57/);
    assert.match(text, /Alquiler Hogar día 5 Bs\. 1\.500,00 Empieza en diciembre/);
  });

  await test('la copia de seguridad incluye los fijos y no los duplica', async (open) => {
    const a = await open({ seed: { 'fijos-app-v1': [fijo(7, 'gastos', 'Micro', 'Transporte', 1, '2026-11', [['2026-11', 120]])] } });
    const { data } = await exportWeb(a.page);
    assert.strictEqual(data.fijos.length, 1);
    const b = await open();
    await importFile(b.page, data);
    assert.strictEqual(await importSummary(b.page), 'Se añadirán 1 gasto y 0 ingresos, y 1 fijo.');
    await b.page.click('#btn-import-confirm');
    assert.strictEqual((await stored(b.page, 'fijos-app-v1')).length, 1);
    assert.strictEqual((await stored(b.page, 'gastos-app-v1')).length, 1);
    await b.page.reload();
    assert.strictEqual((await stored(b.page, 'gastos-app-v1')).length, 1);
  });

  await test('el botón atrás cierra la hoja de fijos', async (open) => {
    const { page } = await open({ native: true });
    await page.waitForFunction(() => !!window.__native.listeners['App:backButton']);
    await goMode(page, 'fijos');
    await page.click('#fixed-content [data-add="ingresos"]');
    assert.strictEqual(await page.textContent('#fixed-sheet-title'), 'Nuevo ingreso fijo');
    await pressBack(page);
    assert.strictEqual(await page.locator('#fixed-sheet.show').count(), 0);
  });

  await test('Mis Préstamos y Mis Fijos están en el panel, no como pestañas', async (open) => {
    const { page } = await open();
    assert.deepStrictEqual(await page.$$eval('#tabs-normal .tab', (els) => els.map((e) => e.textContent.trim())), ['+ Agregar', 'Historial', 'Resumen']);
    await goMode(page, 'prestamos');
    assert.strictEqual(await page.textContent('#topbar-title'), '🤝 Mis Préstamos');
    assert.strictEqual(await page.isVisible('#tabs-normal'), false);
    assert.strictEqual(await page.isVisible('#view-loans'), true);
    await goMode(page, 'fijos');
    assert.strictEqual(await page.textContent('#topbar-title'), '📌 Mis Fijos');
    assert.strictEqual(await page.isVisible('#view-fixed'), true);
    assert.strictEqual(await page.isVisible('#view-loans'), false);
    // El modo se recuerda al volver a abrir la app
    await page.reload();
    assert.strictEqual(await page.textContent('#topbar-title'), '📌 Mis Fijos');
    assert.strictEqual(await page.isVisible('#view-fixed'), true);
    // De vuelta a Mis Gastos, con sus tres pestañas
    await goMode(page, 'gastos');
    assert.strictEqual(await page.isVisible('#view-add'), true);
  });

  await test('el panel de modos cabe en una pantalla chica (se desplaza si hace falta)', async (open) => {
    const { page } = await open();
    await page.setViewportSize({ width: 360, height: 600 });
    await page.click('#gear-btn');
    const box = await page.$eval('#settings-modal .modal-box', (b) => ({ top: b.getBoundingClientRect().top, scroll: b.scrollHeight > b.clientHeight }));
    assert.ok(box.top >= 0, 'el panel no se sale por arriba');
    await page.click('#mcard-fijos');
    assert.strictEqual(await page.textContent('#topbar-title'), '📌 Mis Fijos');
  });

  await test('Mis Fijos: el resumen arriba muestra lo de cada mes', async (open) => {
    const { page } = await open({ seed: { 'fijos-app-v1': [
      fijo(7, 'ingresos', 'Sueldo', 'Sueldos', 30, '2026-11', [['2026-11', 2880.57]]),
      fijo(8, 'gastos', 'Micro', 'Transporte', 1, '2026-11', [['2026-11', 120]]),
    ] } });
    await goMode(page, 'fijos');
    assert.strictEqual(await page.textContent('#topbar-sub'), 'Cada mes: +Bs. 2.880,57 · −Bs. 120,00');
    const text = (await page.innerText('#fixed-content')).replace(/\s+/g, ' ');
    assert.match(text, /INGRESOS FIJOS 💼 Sueldo .* \+ Agregar ingreso fijo GASTOS FIJOS 🚌 Micro .* \+ Agregar gasto fijo/);
  });



  console.log('Para gastar en el mes');

  const p45 = { 'analisis-pcts': { gastos: 45, ahorro: 45, diezmo: 10 } };
  const cardText = (page, id = '#add-budget') => page.$eval(id, (el) => el.innerText.replace(/\s+/g, ' ').trim());
  // Noviembre: sueldo 2.880,57; gastos 620; además un préstamo, su devolución y el diezmo (no cuentan)
  const mesNormal = {
    ...p45,
    'ingresos-app-v1': [mk(9, '2026-11-05', 2880.57, 'Sueldos', 'Sueldo'), { ...mk(10, '2026-11-09', 100, 'Devolución', 'Devolución: Juan'), loanId: 3 }],
    'gastos-app-v1': [
      mk(1, '2026-11-03', 500, 'Alimentación', 'Mercado'), mk(2, '2026-11-06', 120, 'Transporte', 'Taxi'),
      mk(3, '2026-11-02', 300, 'Préstamo', 'Juan'), mk(4, '2026-11-04', 288, 'Diezmo', 'Diezmo'),
    ],
  };

  await test('para gastar: el porcentaje de gastos sobre los ingresos del mes, menos lo gastado', async (open) => {
    const { page } = await open({ seed: mesNormal });
    // 45 % de 2.880,57 = 1.296,26; gastado 620 (sin préstamo ni diezmo); hoy es 11 → quedan 20 días
    assert.strictEqual(await cardText(page),
      'PARA GASTAR EN NOVIEMBRE 45 % de Bs. 2.880,57 Te quedan Bs. 676,26 Gastaste Bs. 620,00 de Bs. 1.296,26 Quedan 20 días: Bs. 33,81 por día.');
    assert.strictEqual(await page.$eval('#add-budget .bg-bar div', (d) => d.style.width), '48%');
  });

  await test('para gastar: se actualiza al anotar o borrar un gasto', async (open) => {
    const { page } = await open({ seed: mesNormal });
    await page.fill('#inp-amount', '76.26');
    await page.fill('#inp-detail', 'Cena');
    await page.click('#btn-submit');
    assert.match(await cardText(page), /Te quedan Bs\. 600,00 Gastaste Bs\. 696,26 de Bs\. 1\.296,26/);
    await page.click('#tab-list');
    await page.locator('#list .expense-item', { hasText: 'Mercado' }).locator('.btn-action.del').click();
    await page.click('#del-modal .modal-btn.confirm');
    await page.click('#tab-add');
    assert.match(await cardText(page), /Te quedan Bs\. 1\.100,00 Gastaste Bs\. 196,26/);
  });

  await test('para gastar: cuenta el sueldo fijo por llegar y descuenta los gastos fijos que faltan', async (open) => {
    const seed = { ...p45, 'fijos-app-v1': [
      fijo(7, 'ingresos', 'Sueldo', 'Sueldos', 30, '2026-11', [['2026-11', 2880.57]]),
      fijo(8, 'gastos', 'Micro', 'Transporte', 1, '2026-11', [['2026-11', 120]]),
      fijo(9, 'gastos', 'Alquiler', 'Hogar', 20, '2026-11', [['2026-11', 500]]),
      fijo(10, 'gastos', 'Diezmo', 'Diezmo', 25, '2026-11', [['2026-11', 288]]),
    ] };
    // Día 11: el micro ya se anotó (120); el alquiler (500) y el sueldo aún no
    const a = await open({ seed });
    assert.strictEqual(await cardText(a.page),
      'PARA GASTAR EN NOVIEMBRE 45 % de Bs. 2.880,57 Te quedan Bs. 676,26 Gastaste Bs. 120,00 de Bs. 1.296,26 '
      + 'Ya descuenta Bs. 500,00 de gastos fijos que faltan este mes. Cuenta Bs. 2.880,57 de ingresos fijos que aún no llegan. Quedan 20 días: Bs. 33,81 por día.');
    assert.strictEqual(await a.page.$eval('#add-budget .bg-bar div', (d) => d.style.width), '48%');
    // Día 21: el alquiler ya está anotado; lo que queda es lo mismo
    const b = await open({ seed, now: '2026-11-21T10:00:00-04:00' });
    assert.strictEqual(await cardText(b.page),
      'PARA GASTAR EN NOVIEMBRE 45 % de Bs. 2.880,57 Te quedan Bs. 676,26 Gastaste Bs. 620,00 de Bs. 1.296,26 '
      + 'Cuenta Bs. 2.880,57 de ingresos fijos que aún no llegan. Quedan 10 días: Bs. 67,63 por día.');
    // Día 30: llegó el sueldo; ya nada está "por llegar"
    const c = await open({ seed, now: '2026-11-30T10:00:00-04:00' });
    assert.strictEqual(await cardText(c.page),
      'PARA GASTAR EN NOVIEMBRE 45 % de Bs. 2.880,57 Te quedan Bs. 676,26 Gastaste Bs. 620,00 de Bs. 1.296,26 Hoy es el último día del mes.');
  });

  await test('para gastar: avisa cuando falta poco y cuando te pasaste', async (open) => {
    const base = { ...p45, 'ingresos-app-v1': [mk(9, '2026-11-05', 1000, 'Sueldos', 'Sueldo')] };
    const a = await open({ seed: { ...base, 'gastos-app-v1': [mk(1, '2026-11-03', 400, 'Otro', 'Varios')] } });
    assert.strictEqual(await a.page.$eval('#add-budget .budget-card', (c) => c.className), 'budget-card warn');
    assert.match(await cardText(a.page), /Te quedan Bs\. 50,00 Gastaste Bs\. 400,00 de Bs\. 450,00/);
    const b = await open({ seed: { ...base, 'gastos-app-v1': [mk(1, '2026-11-03', 520.5, 'Otro', 'Varios')] } });
    assert.strictEqual(await b.page.$eval('#add-budget .budget-card', (c) => c.className), 'budget-card over');
    assert.strictEqual(await cardText(b.page), 'PARA GASTAR EN NOVIEMBRE 45 % de Bs. 1.000,00 Te pasaste por Bs. 70,50 Gastaste Bs. 520,50 de Bs. 450,00');
    assert.strictEqual(await b.page.$eval('#add-budget .bg-bar div', (d) => d.style.width), '100%');
  });

  await test('para gastar: sin ingresos en el mes explica qué anotar; en Mis Ingresos no aparece', async (open) => {
    const { page } = await open({ seed: { ...p45, 'gastos-app-v1': [mk(1, '2026-11-03', 50, 'Otro', 'Algo')] } });
    assert.match(await cardText(page), /^PARA GASTAR EN NOVIEMBRE Para ver cuánto te queda, anota lo que ganas este mes/);
    await goMode(page, 'ingresos');
    assert.strictEqual(await page.$eval('#add-budget', (el) => el.innerHTML), '');
    // Al anotar el sueldo y volver a Mis Gastos, ya calcula
    await page.fill('#inp-amount', '1000');
    await page.fill('#inp-detail', 'Sueldo');
    await page.click('#btn-submit');
    await goMode(page, 'gastos');
    assert.match(await cardText(page), /Te quedan Bs\. 400,00 Gastaste Bs\. 50,00 de Bs\. 450,00/);
  });

  await test('para gastar: sin reparto guardado usa el 70 % inicial y lo dice; al guardarlo, lo usa', async (open) => {
    const { page } = await open({ seed: { 'ingresos-app-v1': [mk(9, '2026-11-05', 1000, 'Sueldos', 'Sueldo')] } });
    assert.match(await cardText(page), /70 % de Bs\. 1\.000,00 Te quedan Bs\. 700,00/);
    assert.match(await cardText(page), /Usa 70 % para gastos \(el valor inicial\)\. Cámbialo en ⚙ → Mis Análisis → Config\./);
    await goMode(page, 'analisis');
    await page.fill('#in-gastos', '45');
    await page.fill('#in-ahorro', '45');
    await page.click('.pct-save-btn');
    await goMode(page, 'gastos');
    assert.match(await cardText(page), /45 % de Bs\. 1\.000,00 Te quedan Bs\. 450,00/);
    assert.doesNotMatch(await cardText(page), /valor inicial/);
  });

  await test('para gastar: en Resumen sigue al mes elegido; los meses pasados dicen lo que sobró', async (open) => {
    const { page } = await open({ seed: {
      ...p45,
      'ingresos-app-v1': [mk(8, '2026-10-05', 2000, 'Sueldos', 'Sueldo'), mk(9, '2026-11-05', 1000, 'Sueldos', 'Sueldo')],
      'gastos-app-v1': [mk(1, '2026-10-10', 500, 'Otro', 'Octubre'), mk(2, '2026-11-03', 100, 'Otro', 'Noviembre')],
    } });
    await page.click('#tab-stats');
    assert.match(await cardText(page, '#stats-budget'), /^PARA GASTAR EN NOVIEMBRE 45 % de Bs\. 1\.000,00 Te quedan Bs\. 350,00 Gastaste Bs\. 100,00 de Bs\. 450,00 Quedan 20 días/);
    const prevMonth = '#view-stats .period-row:nth-child(2) .period-nav button:first-child';
    const nextMonth = '#view-stats .period-row:nth-child(2) .period-nav button:last-child';
    await page.click(prevMonth);
    assert.strictEqual(await cardText(page, '#stats-budget'), 'PARA GASTAR EN OCTUBRE 45 % de Bs. 2.000,00 Te sobraron Bs. 400,00 Gastaste Bs. 500,00 de Bs. 900,00');
    // Con una semana elegida no se muestra (es una cuenta del mes entero)
    await page.locator('#stats-week-chips .week-chip').nth(1).click();
    assert.strictEqual(await page.$eval('#stats-budget', (el) => el.innerHTML), '');
    // Un mes sin ingresos ni gastos, y un mes futuro: nada
    await page.click(prevMonth);
    assert.strictEqual(await page.$eval('#stats-budget', (el) => el.innerHTML), '');
    await page.click(nextMonth); await page.click(nextMonth); await page.click(nextMonth);
    assert.strictEqual(await page.textContent('#stats-month-val'), 'Diciembre');
    assert.strictEqual(await page.$eval('#stats-budget', (el) => el.innerHTML), '');
  });

  await test('si la app queda abierta de un día para otro, la fecha y la cuenta se ponen al día', async (open) => {
    const { page } = await open({ now: '2026-11-10T23:50:00-04:00', seed: { ...p45, 'ingresos-app-v1': [mk(9, '2026-11-05', 1000, 'Sueldos', 'Sueldo')] } });
    assert.strictEqual(await page.inputValue('#inp-date'), '2026-11-10');
    assert.match(await cardText(page), /Quedan 21 días/);
    // Pasa la medianoche y se vuelve a la app
    await page.clock.setSystemTime(new Date('2026-11-11T00:10:00-04:00'));
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    assert.strictEqual(await page.inputValue('#inp-date'), '2026-11-11');
    assert.match(await cardText(page), /Quedan 20 días/);
  });

  await test('al volver a la app no se cambia una fecha que elegiste a mano', async (open) => {
    const { page } = await open({ now: '2026-11-10T23:50:00-04:00' });
    await page.fill('#inp-date', '2026-11-03');
    await page.clock.setSystemTime(new Date('2026-11-11T00:10:00-04:00'));
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    assert.strictEqual(await page.inputValue('#inp-date'), '2026-11-03');
  });

  console.log('Diezmo');

  // Noviembre: mercado Bs 1.000 y el diezmo de octubre (Bs 300) pagado el 4/11
  const conDiezmo = {
    'gastos-app-v1': [mk(1, '2026-11-03', 1000, 'Alimentación', 'Mercado'), mk(2, '2026-11-04', 300, 'Diezmo', 'Diezmo')],
    'ingresos-app-v1': [mk(9, '2026-10-05', 3000, 'Sueldos', 'Sueldo'), mk(8, '2026-11-05', 3000, 'Sueldos', 'Sueldo')],
  };

  await test('el diezmo no se suma a los gastos del mes y el desglose suma 100 %', async (open) => {
    const { page } = await open({ seed: conDiezmo });
    assert.strictEqual(await page.textContent('#topbar-sub'), '1 gastos en Noviembre · Bs. 1.000,00');
    await page.click('#tab-stats');
    assert.strictEqual(await page.textContent('#s-month'), 'Bs. 1.000,00');
    assert.strictEqual(await page.textContent('#s-count'), '1');
    const rows = await page.$$eval('#cat-breakdown > div', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
    assert.deepStrictEqual(rows, [
      '⛪ Diezmo pagado en este período: Bs. 300,00 (corresponde a octubre). Es aparte: no se suma a los gastos.',
      '🍽 Alimentación 1 gastos · 100% Bs. 1.000,00',
    ]);
    await page.click('#tab-list');
    assert.match(await page.textContent('#list'), /Aparte · de octubre/);
  });

  await test('el histórico muestra el diezmo aparte y lo descuenta del ahorro', async (open) => {
    const { page } = await open({ seed: { ...conDiezmo, 'app-mode': 'analisis', 'analisis-pcts': { gastos: 45, ahorro: 45, diezmo: 10 } } });
    await page.click('#antab-hist');
    const hist = (await page.innerText('#an-hist-content')).replace(/\s+/g, ' ');
    assert.match(hist, /INGRESOS TOTALES Bs\. 6\.000,00 GASTOS TOTALES Bs\. 1\.000,00 DIEZMO TOTAL \(APARTE\) Bs\. 300,00/);
    assert.match(hist, /TENGO EN LA CUENTA Bs\. 4\.700,00/);
    // Ahorro: 6.000 − 1.000 − 300 = 4.700, frente a la meta del 45 % (2.700)
    assert.match(hist, /DEBERÍA TENER \(45% DE AHORRO\) Bs\. 2\.700,00/);
    assert.match(hist, /OBJETIVO CUMPLIDO \+Bs\. 2\.000,00 por encima/);
    // El gráfico mensual sigue igual: el diezmo pagado en noviembre cuenta para octubre
    await page.click('#antab-chart');
    await page.click('.an-period-picker .period-row:nth-child(2) .period-nav button:first-child');
    assert.match((await page.innerText('#an-chart-content')).replace(/\s+/g, ' '), /Octubre 2026 INGRESOS Bs\. 3\.000,00 GASTOS Bs\. 0,00 DIEZMO Bs\. 300,00/);
  });

  await test('en Mis Fijos, un diezmo fijo va en su propia fila', async (open) => {
    const { page } = await open({ seed: { 'fijos-app-v1': [
      fijo(7, 'ingresos', 'Sueldo', 'Sueldos', 30, '2026-11', [['2026-11', 2880.57]]),
      fijo(8, 'gastos', 'Micro', 'Transporte', 1, '2026-11', [['2026-11', 120]]),
      fijo(9, 'gastos', 'Diezmo', 'Diezmo', 5, '2026-11', [['2026-11', 288.06]]),
    ] } });
    await goMode(page, 'fijos');
    const text = (await page.innerText('#fixed-content')).replace(/\s+/g, ' ');
    assert.match(text, /Ingresos fijos \+Bs\. 2\.880,57 Gastos fijos −Bs\. 120,00 Diezmo \(aparte\) −Bs\. 288,06 Quedan Bs\. 2\.472,51/);
    assert.strictEqual(await page.textContent('#topbar-sub'), 'Cada mes: +Bs. 2.880,57 · −Bs. 120,00');
  });

  console.log('Préstamos');

  // Un préstamo de 500 a Juan (y un gasto normal de 100) en noviembre
  const conPrestamo = {
    'gastos-app-v1': [mk(1, '2026-11-03', 100, 'Alimentación', 'Mercado'), mk(2, '2026-11-05', 500, 'Préstamo', 'Préstamo a Juan')],
  };
  const pickCsel = async (page, id, text) => {
    await page.click('#' + id);
    await page.click(`#csel-options .csel-opt:has-text("${text}")`);
  };
  const loanCards = (page) => page.$$eval('#loans-content .loan-card', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));

  await test('un préstamo no cuenta como gasto y aparece en «Préstamos»', async (open) => {
    const { page } = await open({ seed: conPrestamo });
    assert.match(await page.textContent('#topbar-sub'), /1 gastos en Noviembre · Bs\. 100,00/);
    await page.click('#tab-stats');
    assert.strictEqual(await page.textContent('#s-month'), 'Bs. 100,00');
    assert.strictEqual(await page.textContent('#s-count'), '1');
    assert.match(await page.textContent('#cat-breakdown'), /Prestaste Bs\. 500,00 en este período/);
    assert.doesNotMatch(await page.textContent('#cat-breakdown'), /🤝\s*Préstamo\s*\d/);
    await goMode(page, 'prestamos');
    assert.strictEqual(await page.textContent('#loans-content .stat-card .val'), 'Bs. 500,00');
    const [card] = await loanCards(page);
    assert.match(card, /Préstamo a Juan/);
    assert.match(card, /Bs\. 500,00 falta/i);
    assert.match(await page.textContent('#topbar-sub'), /Te deben Bs\. 500,00 · 1 sin devolver/);
    await goMode(page, 'gastos');
    await page.click('#tab-list');
    assert.match(await page.textContent('#list'), /Te deben Bs\. 500,00/);
  });

  await test('al elegir «Préstamo» el formulario explica que no cuenta como gasto', async (open) => {
    const { page } = await open();
    assert.strictEqual(await page.isVisible('#cat-hint'), false);
    await pickCsel(page, 'inp-cat', 'Préstamo');
    assert.match(await page.textContent('#cat-hint'), /No se cuenta como gasto/);
    await page.fill('#inp-amount', '200');
    await page.fill('#inp-detail', 'Préstamo a Ana');
    await page.click('#btn-submit');
    await expectToast(page, /Préstamo registrado/);
    const g = (await stored(page, 'gastos-app-v1'))[0];
    assert.strictEqual(g.cat, 'Préstamo');
    assert.match(await page.textContent('#topbar-sub'), /0 gastos en Noviembre · Bs\. 0,00/);
  });

  await test('una devolución se registra en ingresos eligiendo su préstamo', async (open) => {
    const { page } = await open({ seed: { ...conPrestamo, 'app-mode': 'ingresos' } });
    await pickCsel(page, 'inp-cat', 'Devolución');
    assert.strictEqual(await page.isVisible('#loan-field'), true);
    assert.match(await page.textContent('#cat-hint'), /No se cuenta como ingreso/);
    // Sin elegir préstamo no deja guardar
    await page.fill('#inp-amount', '200');
    await page.click('#btn-submit');
    await expectToast(page, /Elige qué préstamo te devolvieron/);
    assert.strictEqual(await stored(page, 'ingresos-app-v1'), null);
    await pickCsel(page, 'inp-loan', 'Préstamo a Juan');
    await page.click('#btn-submit');
    await expectToast(page, /Devolución registrada/);
    const [r] = await stored(page, 'ingresos-app-v1');
    assert.deepStrictEqual({ amount: r.amount, cat: r.cat, loanId: r.loanId, detail: r.detail }, { amount: 200, cat: 'Devolución', loanId: 2, detail: 'Devolución: Préstamo a Juan' });
    // No cuenta como ingreso
    assert.match(await page.textContent('#topbar-sub'), /0 ingresos en Noviembre · Bs\. 0,00/);
    await page.click('#tab-list');
    assert.match(await page.textContent('#list'), /De: Préstamo a Juan/);
    await goMode(page, 'prestamos');
    assert.match((await loanCards(page))[0], /Bs\. 300,00 falta/i);
  });

  await test('al elegir el préstamo se propone lo que falta como monto', async (open) => {
    const { page } = await open({ seed: { ...conPrestamo, 'app-mode': 'ingresos' } });
    await pickCsel(page, 'inp-cat', 'Devolución');
    await pickCsel(page, 'inp-loan', 'Préstamo a Juan');
    assert.strictEqual(await page.inputValue('#inp-amount'), '500');
  });

  await test('sin préstamos pendientes, «Devolución» avisa y no deja guardar', async (open) => {
    const { page } = await open({ seed: { 'app-mode': 'ingresos' } });
    await pickCsel(page, 'inp-cat', 'Devolución');
    assert.match(await page.textContent('#cat-hint'), /No tienes préstamos pendientes/);
    await page.fill('#inp-amount', '50');
    await page.fill('#inp-detail', 'Algo');
    await page.click('#btn-submit');
    await expectToast(page, /Elige qué préstamo/);
    assert.strictEqual(await stored(page, 'ingresos-app-v1'), null);
  });

  await test('«Me devolvieron» en la pestaña registra la devolución y salda el préstamo', async (open) => {
    const { page } = await open({ seed: conPrestamo });
    await goMode(page, 'prestamos');
    await page.click('#loans-content .loan-card >> text=Me devolvieron');
    assert.strictEqual(await page.inputValue('#repay-amount'), '500');
    await page.fill('#repay-amount', '150');
    await page.click('#btn-repay-confirm');
    await expectToast(page, /falta Bs\. 350,00/);
    assert.match((await loanCards(page))[0], /Bs\. 350,00 falta/i);
    assert.match((await loanCards(page))[0], /↩ 11\/11\/2026 · Bs\. 150,00/);
    await page.click('#loans-content .loan-card >> text=Me devolvieron');
    assert.strictEqual(await page.inputValue('#repay-amount'), '350');
    await page.click('#btn-repay-confirm');
    await expectToast(page, /préstamo saldado/);
    assert.strictEqual(await page.textContent('#loans-content .stat-card .val'), 'Bs. 0,00');
    assert.match(await page.textContent('#loans-content'), /Devueltos/);
    assert.match((await loanCards(page))[0], /✓ Devuelto/);
    assert.strictEqual(await page.locator('#loans-content button[data-loan]').count(), 0);
    const ingresos = await stored(page, 'ingresos-app-v1');
    assert.deepStrictEqual(ingresos.map((r) => [r.amount, r.cat, r.loanId]).sort(), [[150, 'Devolución', 2], [350, 'Devolución', 2]]);
    // El préstamo saldado ya no se ofrece en el formulario de devolución
    await page.click('#gear-btn'); await page.click('#mcard-ingresos');
    await pickCsel(page, 'inp-cat', 'Devolución');
    assert.match(await page.textContent('#cat-hint'), /No tienes préstamos pendientes/);
  });

  await test('en Análisis no cuentan; el histórico muestra lo que hay en la cuenta y lo que te deben', async (open) => {
    const { page } = await open({ seed: {
      'gastos-app-v1': [mk(1, '2026-11-03', 1000, 'Alimentación', 'Mercado'), mk(2, '2026-11-05', 500, 'Préstamo', 'Préstamo a Juan')],
      'ingresos-app-v1': [mk(9, '2026-11-01', 3000, 'Sueldos', 'Sueldo'), { ...mk(10, '2026-11-08', 200, 'Devolución', 'Devolución: Juan'), loanId: 2 }],
      'app-mode': 'analisis',
    } });
    await page.click('#antab-chart');
    const chart = (await page.innerText('#an-chart-content')).replace(/\s+/g, ' ');
    assert.match(chart, /INGRESOS Bs\. 3\.000,00 GASTOS Bs\. 1\.000,00/);
    assert.match(chart, /Prestaste Bs\. 500,00 · ↩️ te devolvieron Bs\. 200,00/);
    await page.click('#antab-hist');
    const hist = (await page.innerText('#an-hist-content')).replace(/\s+/g, ' ');
    assert.match(hist, /INGRESOS TOTALES Bs\. 3\.000,00 GASTOS TOTALES Bs\. 1\.000,00/);
    // En la cuenta: 3000 + 200 − 1000 − 500
    assert.match(hist, /TENGO EN LA CUENTA Bs\. 1\.700,00/);
    assert.match(hist, /ME DEBEN \(PRÉSTAMOS\) Bs\. 300,00/);
    // Ahorro 2000 (3000 − 1000) frente a una meta de 600 (20 %)
    assert.match(hist, /OBJETIVO CUMPLIDO \+Bs\. 1\.400,00 por encima/);
  });

  await test('borrar un préstamo deja sus devoluciones como ingresos normales', async (open) => {
    const { page } = await open({ seed: { ...conPrestamo, 'ingresos-app-v1': [{ ...mk(10, '2026-11-08', 200, 'Devolución', 'Devolución: Juan'), loanId: 2 }] } });
    await page.click('#tab-list');
    await page.locator('#list .expense-item', { hasText: 'Préstamo a Juan' }).locator('.btn-action.del').click();
    assert.match(await page.textContent('#modal-detail'), /Tiene 1 devolución registrada: quedará como ingreso normal/);
    await page.click('#del-modal .modal-btn.confirm');
    const [r] = await stored(page, 'ingresos-app-v1');
    assert.strictEqual(r.cat, 'Otros');
    assert.strictEqual('loanId' in r, false);
  });

  await test('cambiar la categoría de un préstamo libera sus devoluciones', async (open) => {
    const { page } = await open({ seed: { ...conPrestamo, 'ingresos-app-v1': [{ ...mk(10, '2026-11-08', 200, 'Devolución', 'Devolución: Juan'), loanId: 2 }] } });
    await page.click('#tab-list');
    await page.locator('#list .expense-item', { hasText: 'Préstamo a Juan' }).locator('.btn-action.edit').click();
    await pickCsel(page, 'inp-cat', 'Otro');
    await page.click('#btn-submit');
    await expectToast(page, /1 devolución pasó a «Otros»/);
    assert.strictEqual((await stored(page, 'ingresos-app-v1'))[0].cat, 'Otros');
  });

  await test('editar una devolución deja elegir su préstamo aunque ya esté saldado', async (open) => {
    const { page } = await open({ seed: {
      ...conPrestamo, 'app-mode': 'ingresos',
      'ingresos-app-v1': [{ ...mk(10, '2026-11-08', 500, 'Devolución', 'Devolución: Juan'), loanId: 2 }],
    } });
    await page.click('#tab-list');
    await page.click('#list .btn-action.edit');
    assert.match(await page.textContent('#inp-loan-lbl'), /Préstamo a Juan · devuelto/);
    await page.fill('#inp-amount', '450');
    await page.click('#btn-submit');
    const [r] = await stored(page, 'ingresos-app-v1');
    assert.deepStrictEqual([r.amount, r.cat, r.loanId], [450, 'Devolución', 2]);
  });

  await test('pago detectado: se puede guardar como préstamo', async (open) => {
    const { page } = await open({ native: { enabled: true, captured: [aviso('n1', 'Tu transferencia de 300.00 bolivianos ha sido procesada')] } });
    await waitSynced(page);
    await page.click('#review-bar');
    await page.fill('#review-list .rv-name', 'Préstamo a Pedro');
    await page.click('#review-list .chip:has-text("Préstamo")');
    await page.click('#review-list .rv-save');
    await expectToast(page, /Guardado como préstamo/);
    const [g] = await stored(page, 'gastos-app-v1');
    assert.deepStrictEqual([g.cat, g.detail, 'pending' in g], ['Préstamo', 'Préstamo a Pedro', false]);
    await goMode(page, 'prestamos');
    assert.match((await loanCards(page))[0], /Préstamo a Pedro/);
  });

  await test('dinero recibido de alguien a quien le prestaste: se propone como devolución', async (open) => {
    const { page } = await open({
      seed: { 'gastos-app-v1': [mk(1, '2026-11-01', 300, 'Préstamo', 'Préstamo a Juan Pérez'), mk(2, '2026-11-02', 100, 'Préstamo', 'Préstamo a Ana')] },
      native: { enabled: true, captured: [aviso('n1', 'Recibio transferencia de la cuenta 1234567890 JUAN PEREZ AL BANCO NACIONAL DE BOLIVIA S.A., por Bs. 300.00 Concepto sin especificar')] },
    });
    await waitSynced(page);
    await page.click('#review-bar');
    const card = page.locator('#review-list .rv-card');
    assert.match(await card.textContent(), /Parece que Préstamo a Juan Pérez te devolvió dinero/);
    assert.strictEqual(await card.locator('.chip.active').textContent(), '↩️ Devolución');
    assert.match(await card.locator('.loan-chip.active').textContent(), /Préstamo a Juan Pérez · falta Bs\. 300,00/);
    await card.locator('.rv-save').click();
    await expectToast(page, /Guardado como devolución/);
    const [r] = await stored(page, 'ingresos-app-v1');
    assert.deepStrictEqual([r.cat, r.loanId], ['Devolución', 1]);
    await goMode(page, 'prestamos');
    assert.match(await page.textContent('#loans-content .stat-card .val'), /Bs\. 100,00/);
  });

  await test('dinero recibido sin coincidencia: se puede marcar como devolución eligiendo el préstamo', async (open) => {
    const { page } = await open({
      seed: { 'gastos-app-v1': [mk(1, '2026-11-01', 300, 'Préstamo', 'Préstamo a Juan')] },
      native: { enabled: true, captured: [aviso('n1', 'Recibiste Bs 300 de Carla Rojas')] },
    });
    await waitSynced(page);
    await page.click('#review-bar');
    const card = page.locator('#review-list .rv-card');
    assert.strictEqual(await card.locator('.rv-loans').isVisible(), false);
    await card.locator('.chip:has-text("Devolución")').click();
    assert.strictEqual(await card.locator('.rv-loans').isVisible(), true);
    await card.locator('.rv-save').click();
    await expectToast(page, /Elige qué préstamo/);
    await card.locator('.loan-chip').click();
    await card.locator('.rv-save').click();
    assert.strictEqual((await stored(page, 'ingresos-app-v1'))[0].loanId, 1);
  });

  await test('la copia de seguridad conserva préstamos y devoluciones unidos', async (open) => {
    const seed = { ...conPrestamo, 'ingresos-app-v1': [{ ...mk(10, '2026-11-08', 200, 'Devolución', 'Devolución: Juan'), loanId: 2 }] };
    const a = await open({ seed });
    const { data } = await exportWeb(a.page);
    const b = await open();
    await importFile(b.page, data);
    await importSummary(b.page);
    await b.page.click('#btn-import-confirm');
    await goMode(b.page, 'prestamos');
    assert.match((await loanCards(b.page))[0], /Bs\. 300,00 falta/i);
  });

  await test('«+ Nuevo préstamo» en Mis Préstamos lo guarda como préstamo', async (open) => {
    const { page } = await open();
    await goMode(page, 'prestamos');
    assert.strictEqual(await page.textContent('#topbar-sub'), 'Nadie te debe nada');
    await page.click('#loans-content .fx-add');
    await page.click('#btn-loan-confirm');
    await expectToast(page, /Escribe a quién le prestaste/);
    await page.fill('#loan-name', 'Carla');
    await page.fill('#loan-amount', '250');
    await page.click('#btn-loan-confirm');
    await expectToast(page, /Préstamo registrado/);
    const [g] = await stored(page, 'gastos-app-v1');
    assert.deepStrictEqual([g.detail, g.amount, g.cat, g.date], ['Carla', 250, 'Préstamo', '2026-11-11T12:00:00']);
    assert.match((await loanCards(page))[0], /Carla/);
    assert.strictEqual(await page.textContent('#topbar-sub'), 'Te deben Bs. 250,00 · 1 sin devolver');
  });


  // Varios préstamos con distinta antigüedad y estado (hoy es 11/11/2026)
  const variosPrestamos = {
    'gastos-app-v1': [
      mk(1, '2026-11-08', 150, 'Préstamo', 'Ana'),
      mk(2, '2026-11-05', 500, 'Préstamo', 'Juan'),
      mk(3, '2026-10-20', 80, 'Préstamo', 'Luis'),
      mk(4, '2026-06-01', 400, 'Préstamo', 'Pedro'),
      mk(5, '2026-03-01', 100, 'Préstamo', 'Rosa'),
      { ...mk(6, '2026-09-01', 100, 'Otro', 'Préstamo no devuelto: Rosa'), lostLoanId: 5 },
    ],
    'ingresos-app-v1': [
      { ...mk(10, '2026-11-10', 200, 'Devolución', 'Devolución: Juan'), loanId: 2 },
      { ...mk(11, '2026-10-28', 80, 'Devolución', 'Devolución: Luis'), loanId: 3 },
    ],
  };
  const loanNames = (page) => page.$$eval('#loans-list .loan-card .item-detail', (els) => els.map((e) => e.textContent));
  const chipTexts = (page) => page.$$eval('#loan-chips .chip', (els) => els.map((e) => e.textContent));

  await test('Mis Préstamos: filtros con conteo, búsqueda y orden', async (open) => {
    const { page } = await open({ seed: variosPrestamos });
    await goMode(page, 'prestamos');
    assert.deepStrictEqual(await chipTexts(page), ['Pendientes (3)', 'Antiguos (1)', 'Devueltos (1)', 'No devueltos (1)', 'Todos (5)']);
    assert.deepStrictEqual(await loanNames(page), ['Ana', 'Juan', 'Pedro']);
    await page.click('#loan-chips [data-filter="old"]');
    assert.deepStrictEqual(await loanNames(page), ['Pedro']);
    await page.click('#loan-chips [data-filter="repaid"]');
    assert.deepStrictEqual(await loanNames(page), ['Luis']);
    await page.click('#loan-chips [data-filter="lost"]');
    assert.deepStrictEqual(await loanNames(page), ['Rosa']);
    await page.click('#loan-chips [data-filter="all"]');
    assert.deepStrictEqual(await loanNames(page), ['Ana', 'Juan', 'Luis', 'Pedro', 'Rosa']);
    // Búsqueda sin tildes ni mayúsculas
    await page.fill('#loan-search', 'jU');
    assert.deepStrictEqual(await loanNames(page), ['Juan']);
    await page.fill('#loan-search', 'zzz');
    assert.match(await page.textContent('#loans-list'), /Ningún préstamo con ese nombre/);
    await page.fill('#loan-search', '');
    // Orden
    await page.click('#loan-chips [data-filter="pending"]');
    await pickCsel(page, 'loan-sort', 'Más antiguos');
    assert.deepStrictEqual(await loanNames(page), ['Pedro', 'Juan', 'Ana']);
    await pickCsel(page, 'loan-sort', 'Mayor monto');
    assert.deepStrictEqual(await loanNames(page), ['Pedro', 'Juan', 'Ana']);
    const cards = await loanCards(page);
    assert.match(cards[0], /hace 5 meses ANTIGUO/i);
    assert.match(cards[1], /hace 6 días/);
    assert.match(cards[1], /Bs\. 300,00 falta/i);
  });

  await test('«Ya no me lo devolverán»: lo que falta pasa a gasto y el saldo no cambia', async (open) => {
    const seed = { ...variosPrestamos, 'app-mode': 'analisis' };
    const { page } = await open({ seed });
    await page.click('#antab-hist');
    const before = (await page.innerText('#an-hist-content')).replace(/\s+/g, ' ');
    const enCuenta = before.match(/TENGO EN LA CUENTA (Bs\. [\d.,-]+)/)[1];
    assert.match(before, /ME DEBEN \(PRÉSTAMOS\) Bs\. 850,00/);
    await goMode(page, 'prestamos');
    await page.locator('#loans-list .loan-card', { hasText: 'Pedro' }).locator('[data-more]').click();
    assert.match(await page.textContent('#la-sub'), /Prestaste Bs\. 400,00 el 01\/06\/2026 · falta Bs\. 400,00/);
    await page.click('#la-list [data-act="lost"]');
    await expectToast(page, /Bs\. 400,00 pasan a contarse como gasto/);
    const g = (await stored(page, 'gastos-app-v1')).find((x) => x.lostLoanId === 4);
    assert.deepStrictEqual([g.amount, g.cat, g.detail, g.date], [400, 'Otro', 'Préstamo no devuelto: Pedro', '2026-11-11T12:00:00']);
    assert.deepStrictEqual(await chipTexts(page), ['Pendientes (2)', 'Devueltos (1)', 'No devueltos (2)', 'Todos (5)']);
    assert.strictEqual(await page.textContent('#topbar-sub'), 'Te deben Bs. 450,00 · 2 sin devolver');
    // Cuenta como gasto de noviembre…
    await goMode(page, 'gastos');
    assert.match(await page.textContent('#topbar-sub'), /Bs\. 400,00/);
    await page.click('#tab-list');
    assert.match(await page.textContent('#list'), /Préstamo no devuelto/);
    // …pero lo que hay en la cuenta no cambia
    await goMode(page, 'analisis');
    await page.click('#antab-hist');
    const after = (await page.innerText('#an-hist-content')).replace(/\s+/g, ' ');
    assert.strictEqual(after.match(/TENGO EN LA CUENTA (Bs\. [\d.,-]+)/)[1], enCuenta);
    assert.match(after, /ME DEBEN \(PRÉSTAMOS\) Bs\. 450,00/);
  });

  await test('un préstamo dado por perdido puede volver a pendiente', async (open) => {
    const { page } = await open({ seed: variosPrestamos });
    await goMode(page, 'prestamos');
    await page.click('#loan-chips [data-filter="lost"]');
    await page.click('#loans-list [data-more]');
    await page.click('#la-list [data-act="reopen"]');
    await expectToast(page, /pendiente otra vez/);
    assert.strictEqual((await stored(page, 'gastos-app-v1')).some((x) => x.lostLoanId === 5), false);
    assert.deepStrictEqual(await chipTexts(page), ['Pendientes (4)', 'Antiguos (2)', 'Devueltos (1)', 'Todos (5)']);
  });

  await test('editar un préstamo desde ⋯', async (open) => {
    const { page } = await open({ seed: variosPrestamos });
    await goMode(page, 'prestamos');
    await page.locator('#loans-list .loan-card', { hasText: 'Ana' }).locator('[data-more]').click();
    await page.click('#la-list [data-act="edit"]');
    assert.strictEqual(await page.textContent('#loan-modal-title'), 'Editar préstamo');
    assert.strictEqual(await page.inputValue('#loan-amount'), '150');
    await page.fill('#loan-name', 'Ana María');
    await page.fill('#loan-amount', '180');
    await page.click('#btn-loan-confirm');
    await expectToast(page, /Préstamo actualizado/);
    const ana = (await stored(page, 'gastos-app-v1')).find((x) => x.id === 1);
    assert.deepStrictEqual([ana.detail, ana.amount, ana.cat, ana.date], ['Ana María', 180, 'Préstamo', '2026-11-08T12:00:00']);
    assert.strictEqual((await stored(page, 'gastos-app-v1')).length, 6);
  });

  await test('eliminar un préstamo pide confirmación y lo borra con lo suyo', async (open) => {
    const { page } = await open({ seed: variosPrestamos });
    await goMode(page, 'prestamos');
    await page.click('#loan-chips [data-filter="all"]');
    await page.locator('#loans-list .loan-card', { hasText: 'Rosa' }).locator('[data-more]').click();
    await page.click('#la-list [data-act="delete"]');
    assert.match(await page.textContent('#la-list [data-act="delete"]'), /¿Seguro\? Toca otra vez/);
    assert.strictEqual((await stored(page, 'gastos-app-v1')).length, 6, 'un toque no borra');
    await page.click('#la-list [data-act="delete"]');
    await expectToast(page, /Préstamo eliminado/);
    const gastos = await stored(page, 'gastos-app-v1');
    assert.strictEqual(gastos.some((x) => x.id === 5 || x.lostLoanId === 5), false);
    // Con devoluciones: quedan como ingresos normales
    await page.locator('#loans-list .loan-card', { hasText: 'Juan' }).locator('[data-more]').click();
    assert.match(await page.textContent('#la-list [data-act="delete"]'), /Su devolución queda como un ingreso normal\./);
    await page.click('#la-list [data-act="delete"]');
    await page.click('#la-list [data-act="delete"]');
    const juanBack = (await stored(page, 'ingresos-app-v1')).find((x) => x.id === 10);
    assert.deepStrictEqual([juanBack.cat, 'loanId' in juanBack], ['Otros', false]);
  });

  await test('borrar desde Mis Gastos un préstamo perdido también quita su «no devuelto»', async (open) => {
    const { page } = await open({ seed: { 'gastos-app-v1': [
      mk(1, '2026-11-02', 100, 'Préstamo', 'Pepe'),
      { ...mk(2, '2026-11-09', 100, 'Otro', 'Préstamo no devuelto: Pepe'), lostLoanId: 1 },
      mk(3, '2026-11-03', 20, 'Alimentación', 'Pan'),
    ] } });
    await page.click('#tab-list');
    assert.match(await page.textContent('#list'), /Préstamo no devuelto/);
    const loanItem = page.locator('#list .expense-item').filter({ has: page.locator('.item-cat', { hasText: /^Préstamo$/ }) });
    assert.match(await loanItem.textContent(), /✗ No devuelto/);
    await loanItem.locator('.btn-action.del').click();
    await page.click('#del-modal .modal-btn.confirm');
    assert.deepStrictEqual((await stored(page, 'gastos-app-v1')).map((x) => x.detail), ['Pan']);
  });

  await test('el botón atrás cierra el menú ⋯ de un préstamo', async (open) => {
    const { page } = await open({ seed: variosPrestamos, native: true });
    await page.waitForFunction(() => !!window.__native.listeners['App:backButton']);
    await goMode(page, 'prestamos');
    await page.click('#loans-list [data-more]');
    await pressBack(page);
    assert.strictEqual(await page.locator('#loan-actions.show').count(), 0);
  });

  await test('el botón atrás cierra la ventana de devolución', async (open) => {
    const { page } = await open({ seed: conPrestamo, native: true });
    await page.waitForFunction(() => !!window.__native.listeners['App:backButton']);
    await goMode(page, 'prestamos');
    await page.click('#loans-content .loan-card >> text=Me devolvieron');
    await pressBack(page);
    assert.strictEqual(await page.locator('#repay-modal.show').count(), 0);
    assert.strictEqual((await nativeCalls(page, 'App', 'minimizeApp')).length, 0);
    // Sin nada abierto, atrás deja la app en segundo plano (como en los demás modos)
    await pressBack(page);
    assert.strictEqual((await nativeCalls(page, 'App', 'minimizeApp')).length, 1);
  });

  await browser.close();
  server.close();

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} de ${results.length} pruebas correctas`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
