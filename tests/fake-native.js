// Puente nativo simulado: hace creer a la página que corre dentro de la app Android
// y anota las llamadas a los plugins para poder comprobarlas.
function fakeNativeBridge(capture) {
  window.androidBridge = { postMessage() {} };
  // "capture" imita lo que guarda Android: avisos capturados, permiso y apps instaladas
  window.__native = {
    calls: [], listeners: {},
    captured: capture.captured || [], captureEnabled: !!capture.enabled, watched: [],
    apps: capture.apps || [],
    // Aviso propio: activado y permiso (granted | prompt | denied); qué responde Android al pedirlo
    notify: capture.notify || { enabled: true, permission: 'prompt' },
    notifyAnswer: capture.notifyAnswer || 'granted',
    // Simula que la app se abrió tocando el aviso (Android guarda el evento hasta que la página escucha)
    openReviewOnStart: !!capture.openReviewOnStart,
  };
  const promise = { rtype: 'promise' };
  window.Capacitor = {
    PluginHeaders: [
      { name: 'App', methods: [{ name: 'addListener' }, { name: 'removeListener' }, { name: 'getInfo', ...promise }, { name: 'minimizeApp', ...promise }] },
      { name: 'Filesystem', methods: [{ name: 'writeFile', ...promise }] },
      { name: 'Share', methods: [{ name: 'share', ...promise }] },
      {
        name: 'PaymentCapture',
        methods: [{ name: 'addListener' }, { name: 'removeListener' }].concat(
          ['getStatus', 'listApps', 'setWatched', 'openAccessSettings', 'openAppInfo', 'getCaptured', 'removeCaptured',
            'setNotifyEnabled', 'requestNotifyPermission', 'openNotifySettings'].map((name) => ({ name, ...promise }))
        ),
      },
    ],
    nativePromise(plugin, method, options) {
      window.__native.calls.push({ plugin, method, options });
      if (plugin === 'App' && method === 'getInfo') return Promise.resolve({ version: '1.0', build: '7' });
      if (plugin === 'Filesystem' && method === 'writeFile') return Promise.resolve({ uri: 'file:///cache/' + options.path });
      if (plugin === 'Share' && window.__native.shareFails) return Promise.reject(new Error(window.__native.shareFails));
      if (plugin === 'PaymentCapture') {
        const st = window.__native;
        if (method === 'getStatus') return Promise.resolve({ enabled: st.captureEnabled, watched: st.watched, androidVersion: 34, notify: { ...st.notify } });
        if (method === 'setNotifyEnabled') { st.notify.enabled = options.enabled; return Promise.resolve({ ...st.notify }); }
        if (method === 'requestNotifyPermission') {
          st.notify.enabled = true;
          if (st.notify.permission === 'prompt') st.notify.permission = st.notifyAnswer;
          return Promise.resolve({ ...st.notify });
        }
        if (method === 'listApps') return Promise.resolve({ apps: st.apps });
        if (method === 'setWatched') st.watched = options.packages;
        if (method === 'getCaptured') return Promise.resolve({ items: st.captured.slice() });
        if (method === 'removeCaptured') {
          if (st.removeFails) return Promise.reject(new Error('fallo simulado'));
          st.captured = st.captured.filter((i) => !options.ids.includes(i.id));
        }
      }
      return Promise.resolve({});
    },
    nativeCallback(plugin, method, options, callback) {
      window.__native.calls.push({ plugin, method, options });
      if (method === 'addListener') {
        window.__native.listeners[plugin + ':' + options.eventName] = callback;
        if (plugin === 'PaymentCapture' && options.eventName === 'openReview' && window.__native.openReviewOnStart) {
          window.__native.openReviewOnStart = false;
          setTimeout(() => callback({}), 0);
        }
      }
      return 'callback-1';
    },
  };
}

module.exports = { fakeNativeBridge };
