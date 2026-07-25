// Banka ekstresi PDF'inden pdf-parse ile çıkarılan ham metni işlemlere ayrıştırır.
// Yöntem: metindeki her "DD/MM/YYYY" tarihini bul, bir tarihten bir sonraki tarihe
// kadarki tüm metni TEK BİR İŞLEM olarak ele al (açıklamalar bazen 2 satıra
// bölündüğü için satır satır işlemek yanıltıcı olabiliyor).

const DATE_RE = /(\d{2})\/(\d{2})\/(\d{4})/g;
// Hem "1.234,56" (nokta binlik, virgül ondalık) hem "1,234.56" (virgül binlik,
// nokta ondalık) formatlarını yakalar.
const AMOUNT_RE = /-?\d{1,3}(?:[.,]\d{3})*[.,]\d{2}/g;

const EXCLUDE_HINTS = [
  'ödeme', 'odeme', 'teşekkür', 'tesekkur', 'internet şb', 'internet sb',
  'önceki dönem', 'onceki donem', 'devreden', 'toplam', 'genel toplam',
  'ara toplam', 'hesap bakiyesi', 'ekstre borcu', 'kazanılan', 'kazanilan'
];

function toISODate(d, m, y) {
  return `${y}-${m}-${d}`;
}

function amountToNumber(s) {
  let str = s.trim();
  const lastComma = str.lastIndexOf(',');
  const lastDot = str.lastIndexOf('.');
  const lastSep = Math.max(lastComma, lastDot);
  if (lastSep !== -1 && str.length - lastSep - 1 === 2) {
    const intPart = str.slice(0, lastSep).replace(/[.,]/g, '');
    const decPart = str.slice(lastSep + 1);
    str = intPart + '.' + decPart;
  } else {
    str = str.replace(/[.,]/g, '');
  }
  return parseFloat(str);
}

function extractCandidateTransactions(rawText) {
  const dateMatches = [...rawText.matchAll(DATE_RE)];
  const candidates = [];

  for (let i = 0; i < dateMatches.length; i++) {
    const m = dateMatches[i];
    const chunkStart = m.index + m[0].length;
    const chunkEnd = i + 1 < dateMatches.length ? dateMatches[i + 1].index : rawText.length;
    const chunk = rawText.slice(chunkStart, chunkEnd);

    const lowerChunk = chunk.toLowerCase();
    if (EXCLUDE_HINTS.some(h => lowerChunk.includes(h))) continue;

    const amounts = chunk.match(AMOUNT_RE);
    if (!amounts || amounts.length === 0) continue;

    // İlk tutar = bu dönemde tahsil edilen işlem tutarı (TUTAR/Borç Tutarı sütunu);
    // sonraki tutarlar genelde kalan borç/taksit veya ParafPara/puan sütunlarıdır.
    const amount = Math.abs(amountToNumber(amounts[0]));
    if (!amount || isNaN(amount)) continue;

    // Açıklama: tutardan önceki kısım, satır sonlarını boşlukla birleştir
    const firstAmountIdx = chunk.indexOf(amounts[0]);
    let description = chunk.slice(0, firstAmountIdx)
      .replace(/[\t\n]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    // Satır başındaki gereksiz noktalama/ikon karakterlerini temizle
    description = description.replace(/^[^\wÇĞİÖŞÜçğıöşü]+/, '').trim();
    if (!description) description = '(açıklama yok)';

    const [, dd, mm, yy] = m;
    candidates.push({
      date: toISODate(dd, mm, yy),
      description,
      amount,
      type: 'gider'
    });
  }

  return candidates;
}

const TR_MONTH_NAMES = [
  'Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran',
  'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'
];

function monthLabel(key) {
  const [y, m] = key.split('-');
  return `${TR_MONTH_NAMES[parseInt(m, 10) - 1]} ${y}`;
}

// İşlemleri, tarihlerine bakarak hangi ayın ödemesi olduğuna göre gruplar.
// Dönüş: [{ month: 'YYYY-MM', items: [...], total: number }, ...] (kronolojik sıralı)
function groupTransactionsByMonth(candidates) {
  const map = new Map();
  for (const c of candidates) {
    const key = c.date.slice(0, 7); // YYYY-MM
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(c);
  }
  return [...map.keys()].sort().map((key) => {
    const items = map.get(key).slice().sort((a, b) => (a.date < b.date ? -1 : 1));
    const total = items.reduce((s, c) => s + c.amount, 0);
    return { month: key, items, total };
  });
}

// PDF'ten çıkarılan işlemleri, hangi aya ait olduklarına göre gruplayıp
// Telegram'da gösterilecek metni üretir. Mesaj çok uzarsa (Telegram limiti
// ~4096 karakter) sadece ay bazlı özet gösterilir.
function formatGroupedStatementMessage(candidates, fmt) {
  const groups = groupTransactionsByMonth(candidates);
  const grandTotal = groups.reduce((s, g) => s + g.total, 0);
  const MAX_PER_MONTH = 12;

  const header = `📋 ${candidates.length} işlem tespit ettim, aylara göre gruplandım:\n`;
  let body = '';
  for (const g of groups) {
    body += `\n📅 ${monthLabel(g.month)} — ${g.items.length} işlem, toplam ${fmt(g.total)}\n`;
    const shown = g.items.slice(0, MAX_PER_MONTH);
    body += shown.map((c) => `• ${c.date} · -${fmt(c.amount)} · ${c.description}`).join('\n');
    if (g.items.length > MAX_PER_MONTH) {
      body += `\n… ve ${g.items.length - MAX_PER_MONTH} işlem daha (${monthLabel(g.month)})`;
    }
    body += '\n';
  }
  const footer = `\n💰 Toplam: ${fmt(grandTotal)}\n\nHepsini kaydetmek için "onayla", iptal için "iptal" yaz.`;

  let full = header + body + footer;
  if (full.length > 3900) {
    // Detaylı liste çok uzunsa sadece ay bazlı özet göster.
    const summary = groups
      .map((g) => `📅 ${monthLabel(g.month)} — ${g.items.length} işlem, toplam ${fmt(g.total)}`)
      .join('\n');
    full = header + '\n' + summary + footer +
      '\n\n(İşlem listesi çok uzun olduğu için sadece ay bazlı özet gösterildi; yine de "onayla" ile hepsini kaydedebilirsin.)';
  }
  return full;
}

module.exports = {
  extractCandidateTransactions,
  amountToNumber,
  groupTransactionsByMonth,
  monthLabel,
  formatGroupedStatementMessage
};
