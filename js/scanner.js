// Scansione del codice a barre ISBN con la fotocamera.
// Usa il BarcodeDetector integrato in Chrome per Android: funziona offline.

import { isValidIsbn, cleanIsbn } from './catalog.js';

export function barcodeSupported() {
  return 'BarcodeDetector' in window;
}

export async function scanIsbn(videoEl, { signal } = {}) {
  const detector = new window.BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a'] });
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  });
  videoEl.srcObject = stream;
  await videoEl.play();

  const stop = () => stream.getTracks().forEach(t => t.stop());
  try {
    // Chiede la messa a fuoco continua, se il telefono la supporta
    const track = stream.getVideoTracks()[0];
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    if (caps.focusMode && caps.focusMode.includes('continuous')) {
      await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
    }
  } catch (e) { /* non importante */ }

  return new Promise((resolve, reject) => {
    let seen = {};
    const tick = async () => {
      if (signal && signal.aborted) { stop(); return reject(new DOMException('Annullato', 'AbortError')); }
      try {
        const codes = await detector.detect(videoEl);
        for (const c of codes) {
          const v = cleanIsbn(c.rawValue);
          if (isValidIsbn(v) && /^97[89]/.test(v)) {
            // Conferma con due letture uguali per evitare errori
            seen[v] = (seen[v] || 0) + 1;
            if (seen[v] >= 2) { stop(); if (navigator.vibrate) navigator.vibrate(60); return resolve(v); }
          }
        }
      } catch (e) { /* frame non pronto */ }
      setTimeout(tick, 120);
    };
    tick();
  });
}
