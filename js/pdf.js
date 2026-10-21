// Esportazione PDF dell'elenco libri, generato sul telefono con pdf-lib (offline).

/* global PDFLib */

// Caratteri disponibili nei font standard dei PDF (codifica WinAnsi)
const WIN_ANSI_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
function safe(text) {
  return String(text ?? '').split('').map(ch => {
    const c = ch.charCodeAt(0);
    if ((c >= 32 && c <= 126) || (c >= 160 && c <= 255) || WIN_ANSI_EXTRA.includes(ch)) return ch;
    const base = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
    return base.length === 1 && base.charCodeAt(0) < 256 ? base : '?';
  }).join('');
}

function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return PDFLib.rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

function fit(font, text, size, maxW) {
  text = safe(text);
  if (font.widthOfTextAtSize(text, size) <= maxW) return text;
  while (text.length > 1 && font.widthOfTextAtSize(text + '…', size) > maxW) text = text.slice(0, -1);
  return text.trimEnd() + '…';
}

export async function buildPdf(groups, { title, groupLabel, includeCovers, colorOf }) {
  const { PDFDocument, StandardFonts, rgb } = PDFLib;
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  doc.setCreator('Scaffale');
  const reg = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const W = 595.28, H = 841.89, M = 42;
  const INK = rgb(0.11, 0.14, 0.25), GREY = rgb(0.42, 0.45, 0.55), LINE = rgb(0.88, 0.89, 0.93);
  const ACCENT = hexToRgb('#3A3FD4');

  const total = groups.reduce((n, g) => n + g.books.length, 0);
  const read = groups.reduce((n, g) => n + g.books.filter(b => b.pages && b.currentPage >= b.pages).length, 0);
  const reading = groups.reduce((n, g) => n + g.books.filter(b => b.currentPage > 0 && !(b.pages && b.currentPage >= b.pages)).length, 0);

  let page, y;
  const pages = [];
  const newPage = (first) => {
    page = doc.addPage([W, H]);
    pages.push(page);
    if (first) {
      page.drawRectangle({ x: 0, y: H - 128, width: W, height: 128, color: ACCENT });
      page.drawText(safe(title), { x: M, y: H - 70, size: 26, font: bold, color: rgb(1, 1, 1) });
      const date = new Date().toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' });
      const sub = `${total} libri, ${reading} in lettura, ${read} letti. Aggiornato al ${date}. Ordinati per ${groupLabel}.`;
      page.drawText(safe(sub), { x: M, y: H - 98, size: 10.5, font: reg, color: rgb(0.86, 0.87, 1) });
      y = H - 160;
    } else {
      y = H - M;
    }
  };
  newPage(true);

  const coverCache = new Map();
  async function embedCover(b) {
    if (!includeCovers || !b.cover) return null;
    if (coverCache.has(b.id)) return coverCache.get(b.id);
    try {
      const bytes = new Uint8Array(await b.cover.arrayBuffer());
      const img = b.cover.type === 'image/png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
      coverCache.set(b.id, img);
      return img;
    } catch (e) { return null; }
  }

  const ROW = includeCovers ? 56 : 44;
  for (const g of groups) {
    if (y - 40 - ROW < M) newPage(false);
    const gc = hexToRgb(g.color || '#3A3FD4');
    page.drawRectangle({ x: M, y: y - 16, width: 5, height: 18, color: gc });
    page.drawText(fit(bold, g.name, 14, W - 2 * M - 60), { x: M + 13, y: y - 12, size: 14, font: bold, color: INK });
    const cnt = `${g.books.length}`;
    page.drawText(cnt, { x: W - M - bold.widthOfTextAtSize(cnt, 12), y: y - 12, size: 12, font: bold, color: GREY });
    y -= 30;

    for (const b of g.books) {
      if (y - ROW < M) newPage(false);
      const top = y;
      let x = M;
      const img = await embedCover(b);
      if (includeCovers) {
        if (img) {
          page.drawImage(img, { x, y: top - 46, width: 31, height: 46 });
        } else {
          page.drawRectangle({ x, y: top - 46, width: 31, height: 46, color: hexToRgb(colorOf(b)) });
        }
        x += 43;
      } else {
        page.drawRectangle({ x, y: top - 34, width: 4, height: 34, color: hexToRgb(colorOf(b)) });
        x += 14;
      }
      const textW = W - M - x - 110;
      page.drawText(fit(bold, b.title || 'Senza titolo', 11.5, textW), { x, y: top - 12, size: 11.5, font: bold, color: INK });
      page.drawText(fit(reg, b.author || 'Autore sconosciuto', 10, textW), { x, y: top - 26, size: 10, font: reg, color: INK });
      const meta = [b.year, b.genre, b.publisher, b.digitalOnly && 'solo digitale'].filter(Boolean).join('  /  ');
      if (meta) page.drawText(fit(reg, meta, 8.5, textW), { x, y: top - 39, size: 8.5, font: reg, color: GREY });

      // Colonna del segnalibro
      const bx = W - M - 96;
      let label, ratio = null;
      if (b.pages && b.currentPage >= b.pages) { label = 'Letto'; ratio = 1; }
      else if (b.currentPage > 0) {
        label = b.pages ? `pag. ${b.currentPage} di ${b.pages}` : `pag. ${b.currentPage}`;
        if (b.pages) ratio = b.currentPage / b.pages;
      } else label = 'Da leggere';
      page.drawText(safe(label), { x: bx, y: top - 13, size: 9.5, font: bold, color: ratio === 1 ? hexToRgb('#1E8E5A') : INK });
      if (ratio !== null) {
        page.drawRectangle({ x: bx, y: top - 24, width: 96, height: 4, color: LINE });
        page.drawRectangle({ x: bx, y: top - 24, width: Math.max(2, 96 * Math.min(1, ratio)), height: 4, color: ratio === 1 ? hexToRgb('#1E8E5A') : ACCENT });
      }

      y -= ROW;
      page.drawLine({ start: { x: M, y: y + 7 }, end: { x: W - M, y: y + 7 }, thickness: 0.5, color: LINE });
    }
    y -= 14;
  }

  pages.forEach((p, i) => {
    const t = `${i + 1} / ${pages.length}`;
    p.drawText(t, { x: W - M - reg.widthOfTextAtSize(t, 8.5), y: 22, size: 8.5, font: reg, color: GREY });
    p.drawText('Scaffale', { x: M, y: 22, size: 8.5, font: reg, color: GREY });
  });

  const bytes = await doc.save();
  return new Blob([bytes], { type: 'application/pdf' });
}
