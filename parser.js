// Basit kural tabanlı Türkçe metin ayrıştırıcı.
// "Akbank kredi kartı ile 3400tl alışveriş yaptım 2 taksit olarak" gibi
// mesajları { type, amount, installments, cardMatch, isCash, note } şeklinde ayrıştırır.

function normalizeAmount(raw) {
  // raw örnekleri: "3400", "3.400", "3400,50", "3.400,50"
  let s = raw.trim();
  // Hem binlik ayraç hem ondalık ayraç varsa: son ayracı ondalık kabul et.
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  const lastSep = Math.max(lastComma, lastDot);
  if (lastSep !== -1 && s.length - lastSep - 1 <= 2 && s.length - lastSep - 1 > 0) {
    const intPart = s.slice(0, lastSep).replace(/[.,]/g, '');
    const decPart = s.slice(lastSep + 1);
    s = intPart + '.' + decPart;
  } else {
    s = s.replace(/[.,]/g, '');
  }
  return parseFloat(s);
}

function extractAmount(text) {
  // 1) Öncelik: para birimi ekiyle biten tutar ("3400tl", "1.250,50 TL" gibi)
  const withCurrency = /(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?|\d+)\s*(?:tl\b|try\b|₺|lira)/i;
  const m1 = text.match(withCurrency);
  if (m1) return normalizeAmount(m1[1]);

  // 2) Yedek: para birimi yazılmamışsa ("87135,56 maaş yattı" gibi),
  //    "N taksit" ifadesindeki sayıyı hariç tutup en az 2 haneli ilk sayıyı tutar say.
  const withoutInstallmentPhrase = text.replace(/\d+\s*taksit/gi, '');
  const bare = /\b\d[\d.,]*\d\b|\b\d{2,}\b/;
  const m2 = withoutInstallmentPhrase.match(bare);
  if (m2) return normalizeAmount(m2[0]);

  return null;
}

/* ---------- Tarih ifadeleri ("dün", "geçen hafta", "15 Temmuz" vb.) ---------- */

const TR_MONTHS = {
  'ocak': 1, 'şubat': 2, 'subat': 2, 'mart': 3, 'nisan': 4,
  'mayıs': 5, 'mayis': 5, 'haziran': 6, 'temmuz': 7,
  'ağustos': 8, 'agustos': 8, 'eylül': 9, 'eylul': 9,
  'ekim': 10, 'kasım': 11, 'kasim': 11, 'aralık': 12, 'aralik': 12
};

const TR_WEEKDAYS = {
  'pazartesi': 1, 'salı': 2, 'sali': 2, 'çarşamba': 3, 'carsamba': 3,
  'perşembe': 4, 'persembe': 4, 'cuma': 5, 'cumartesi': 6, 'pazar': 0
};

function toISO(d) {
  return d.toISOString().slice(0, 10);
}

function addDays(d, n) {
  const copy = new Date(d);
  copy.setDate(copy.getDate() + n);
  return copy;
}

// Metinde tanınan bir tarih ifadesi varsa { date: 'YYYY-MM-DD', match: '<eşleşen metin>' }
// döner; yoksa bugünün tarihini ve match:null döner. `match`, tutar ayrıştırmasının
// tarihteki sayıları (gün/ay) tutar sanmaması için orijinal metinden çıkarılır.
function extractDate(text, refDate = new Date()) {
  const t = text.toLowerCase();
  let m;

  // 1) Açık tarih: 15.07.2026 / 15/07/2026 / 15.07 / 15/07
  m = t.match(/\b(\d{1,2})[.\/](\d{1,2})(?:[.\/](\d{2,4}))?\b/);
  if (m) {
    const dd = parseInt(m[1], 10), mm = parseInt(m[2], 10);
    if (dd >= 1 && dd <= 31 && mm >= 1 && mm <= 12) {
      let yyyy = m[3] ? parseInt(m[3], 10) : refDate.getFullYear();
      if (yyyy < 100) yyyy += 2000;
      const d = new Date(yyyy, mm - 1, dd);
      if (!isNaN(d)) return { date: toISO(d), match: m[0] };
    }
  }

  // 2) "15 Temmuz" veya "15 Temmuz 2026"
  const monthAlt = Object.keys(TR_MONTHS).join('|');
  m = t.match(new RegExp(`\\b(\\d{1,2})\\s+(${monthAlt})(?:\\s+(\\d{4}))?\\b`, 'i'));
  if (m) {
    const dd = parseInt(m[1], 10);
    const mm = TR_MONTHS[m[2]];
    const yyyy = m[3] ? parseInt(m[3], 10) : refDate.getFullYear();
    const d = new Date(yyyy, mm - 1, dd);
    if (!isNaN(d)) return { date: toISO(d), match: m[0] };
  }

  // 3) "N gün önce" / "N hafta önce"
  m = t.match(/(\d+)\s*gün\s*önce/);
  if (m) return { date: toISO(addDays(refDate, -parseInt(m[1], 10))), match: m[0] };
  m = t.match(/(\d+)\s*hafta\s*önce/);
  if (m) return { date: toISO(addDays(refDate, -7 * parseInt(m[1], 10))), match: m[0] };

  // 4) Sabit ifadeler
  m = t.match(/\b(evvelsi|önceki)\s*gün\b/);
  if (m) return { date: toISO(addDays(refDate, -2)), match: m[0] };
  if (/\bdün\b/.test(t)) return { date: toISO(addDays(refDate, -1)), match: 'dün' };
  if (/\bgeçen\s*hafta\b/.test(t)) return { date: toISO(addDays(refDate, -7)), match: 'geçen hafta' };
  if (/\bgeçen\s*ay\b/.test(t)) {
    const d = new Date(refDate);
    d.setMonth(d.getMonth() - 1);
    return { date: toISO(d), match: 'geçen ay' };
  }
  if (/\bbugün\b/.test(t)) return { date: toISO(refDate), match: 'bugün' };

  // 5) Gün adları: "pazartesi" (en yakın geçmiş) / "geçen pazartesi" (bir önceki hafta)
  for (const [name, idx] of Object.entries(TR_WEEKDAYS)) {
    m = t.match(new RegExp(`\\b(geçen\\s+)?${name}\\b`, 'i'));
    if (m) {
      let diff = refDate.getDay() - idx;
      if (diff < 0) diff += 7;
      if (m[1] && diff === 0) diff = 7; // "geçen X" bugüne denk geldiyse bir hafta öncesine git
      return { date: toISO(addDays(refDate, -diff)), match: m[0] };
    }
  }

  return { date: toISO(refDate), match: null };
}

function extractInstallments(text) {
  if (/peşin/i.test(text)) return 1;
  const m = text.match(/(\d+)\s*taksit/i);
  if (m) return parseInt(m[1], 10);
  return 1;
}

function guessType(text) {
  const t = text.toLowerCase();
  const incomeHints = ['gelir', 'maaş', 'maas', 'yattı', 'yatti', 'geldi', 'ödeme aldım', 'kazandım'];
  const expenseHints = ['gider', 'harcama', 'alışveriş', 'alisveris', 'ödedim', 'odedim', 'harcadım', 'harcadim'];
  const hasIncome = incomeHints.some(h => t.includes(h));
  const hasExpense = expenseHints.some(h => t.includes(h));
  if (hasIncome && !hasExpense) return 'gelir';
  return 'gider'; // varsayılan: gider
}

function findCard(text, cards) {
  const t = text.toLowerCase();
  // Önce banka adına göre, sonra kart adına göre eşleştirmeyi dene.
  let best = null;
  for (const c of cards) {
    if (c.bank && t.includes(c.bank.toLowerCase())) { best = c; break; }
  }
  if (!best) {
    for (const c of cards) {
      if (c.name && t.includes(c.name.toLowerCase())) { best = c; break; }
    }
  }
  return best;
}

const CATEGORY_SYNONYMS = {
  'Kira': ['kira'],
  'Fatura': ['fatura', 'elektrik', 'doğalgaz', 'dogalgaz', 'internet fatur', 'telefon fatur', 'su fatur'],
  'Market': ['market', 'migros', 'carrefour', 'a101', 'bim', 'şok', 'sok'],
  'Ulaşım': ['ulaşım', 'ulasim', 'benzin', 'otobüs', 'otobus', 'taksi', 'uber', 'metro', 'yakıt', 'yakit'],
  'Araç': ['araç', 'arac', 'oto tamir', 'lastik', 'yedek parça'],
  'Eğlence': ['eğlence', 'eglence', 'sinema', 'konser', 'oyun'],
  'Sağlık': ['sağlık', 'saglik', 'eczane', 'doktor', 'hastane', 'ilaç', 'ilac'],
  'Maaş': ['maaş', 'maas'],
  'Reels Geliri': ['reels'],
  'Freelance': ['freelance', 'proje ücreti', 'proje ucreti'],
  'Yatırım': ['yatırım', 'yatirim', 'faiz', 'temettü', 'temettu', 'borsa']
};

function guessCategory(text, type, categories) {
  const t = text.toLowerCase();
  const list = (categories && categories[type]) || [];
  for (const cat of list) {
    const synonyms = CATEGORY_SYNONYMS[cat] || [cat.toLowerCase()];
    if (synonyms.some(s => t.includes(s))) return cat;
  }
  return list.includes('Diğer') ? 'Diğer' : (list[0] || 'Diğer');
}

function mentionsCard(text) {
  return /kart/i.test(text);
}

function parseMessage(text, cards, refDate = new Date()) {
  const dateInfo = extractDate(text, refDate);
  // Tutarı, tarih ifadesindeki rakamlar (gün/ay) tutar sanılmasın diye
  // tarih eşleşmesi metinden çıkarılmış bir kopya üzerinden ara.
  const textForAmount = dateInfo.match ? text.replace(dateInfo.match, ' ') : text;
  const amount = extractAmount(textForAmount);
  const installments = extractInstallments(text);
  const type = guessType(text);
  const card = findCard(text, cards);
  const cashMentioned = /nakit/i.test(text);
  const cardMentioned = mentionsCard(text);

  return {
    raw: text,
    type,
    amount,
    installments,
    card,          // eşleşen kart objesi ya da null
    cardMentioned, // mesajda "kart" geçiyor mu
    isCash: cashMentioned || (!cardMentioned),
    date: dateInfo.date,       // "YYYY-MM-DD" — algılanan ya da bugünün tarihi
    dateWasExplicit: !!dateInfo.match
  };
}

module.exports = { parseMessage, extractAmount, extractInstallments, extractDate, guessCategory };
