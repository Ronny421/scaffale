// Scansione del codice a barre (ISBN o EAN) con la fotocamera.
// Usa il BarcodeDetector integrato in Chrome per Android: funziona offline.

import { classifyCode } from './catalog.js';

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
        const infos = codes.map(c => classifyCode(c.rawValue)).filter(Boolean);
        // Se nell'inquadratura c'è anche l'ISBN ha la precedenza: le etichette dei negozi
        // sono EAN qualsiasi e spesso stanno proprio accanto al codice del libro
        const info = infos.find(i => i.type === 'isbn') || infos[0];
        if (info) {
          // Conferma con letture uguali per evitare errori; per i codici che non sono ISBN
          // ne servono di più, così c'è il tempo di inquadrare l'ISBN se è lì vicino
          seen[info.code] = (seen[info.code] || 0) + 1;
          const needed = info.type === 'isbn' ? 2 : 5;
          if (seen[info.code] >= needed) { stop(); if (navigator.vibrate) navigator.vibrate(60); return resolve(info.code); }
        }
      } catch (e) { /* frame non pronto */ }
      setTimeout(tick, 120);
    };
    tick();
  });
}
