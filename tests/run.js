// Pruebas de Mis Finanzas en un navegador real (Chromium), a tamaño de teléfono
// y con la hora de Bolivia. Uso: node tests/run.js
// Requiere Playwright instalado en el sistema.
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

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

// Puente nativo simulado: hace creer a la página que corre dentro de la app Android
// y anota las llamadas a los plugins para poder comprobarlas.
function fakeNativeBridge() {
  window.androidBridge = { postMessage() {} };
  window.__native = { calls: [], listeners: {} };
  const promise = { rtype: 'promise' };
  window.Capacitor = {
    PluginHeaders: [
      { name: 'App', methods: [{ name: 'addListener' }, { name: 'removeListener' }, { name: 'getInfo', ...promise }, { name: 'minimizeApp', ...promise }] },
      { name: 'Filesystem', methods: [{ name: 'writeFile', ...promise }] },
      { name: 'Share', methods: [{ name: 'share', ...promise }] },
    ],
    nativePromise(plugin, method, options) {
      window.__native.calls.push({ plugin, method, options });
      if (plugin === 'App' && method === 'getInfo') return Promise.resolve({ version: '1.0', build: '7' });
      if (plugin === 'Filesystem' && method === 'writeFile') return Promise.resolve({ uri: 'file:///cache/' + options.path });
      if (plugin === 'Share' && window.__native.shareFails) return Promise.reject(new Error(window.__native.shareFails));
      return Promise.resolve({});
    },
    nativeCallback(plugin, method, options, callback) {
      window.__native.calls.push({ plugin, method, options });
      if (method === 'addListener') window.__native.listeners[plugin + ':' + options.eventName] = callback;
      return 'callback-1';
    },
  };
}

async function main() {
  const server = await startServer();
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch();
  const results = [];

  // Abre la app con una fecha/hora fija y datos guardados de antemano.
  async function open({ now = '2026-11-11T10:00:00-04:00', seed = {}, native = false } = {}) {
    const ctx = await browser.newContext({
      timezoneId: 'America/La_Paz', locale: 'es-BO',
      viewport: { width: 412, height: 915 }, acceptDownloads: true,
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
    if (native) await page.addInitScript(fakeNativeBridge);
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

  async function test(name, fn) {
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

  await test('al volver a Análisis solo queda marcada una pestaña', async (open) => {
    const { page } = await open({ seed: { 'app-mode': 'analisis' } });
    await page.click('#antab-hist');
    await page.click('#gear-btn'); await page.click('#mcard-gastos');
    await page.click('#gear-btn'); await page.click('#mcard-analisis');
    assert.strictEqual(await page.locator('#tabs-analisis .tab.active').count(), 1);
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

  await browser.close();
  server.close();

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} de ${results.length} pruebas correctas`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
