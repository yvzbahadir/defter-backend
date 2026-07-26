require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const { Telegraf } = require('telegraf');
const db = require('./db');
const { parseMessage, guessCategory } = require('./parser');
const { extractCandidateTransactions, formatGroupedStatementMessage } = require('./statementParser');
const { extractTransactionsWithAI } = require('./aiStatementParser');
const {
  classifyAndParseMessage,
  answerFinanceQuestion,
  guessCategoryWithAI,
  extractReceiptFromImage,
  generateMonthlyInsights
} = require('./aiAssistant');
const { PDFParse } = require('pdf-parse');
const https = require('https');
const reports = require('./reports');

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_CHAT_ID = process.env.TELEGRAM_ALLOWED_CHAT_ID; // güvenlik: sadece bu kullanıcı/sohbet komut verebilir
const PUBLIC_URL = process.env.PUBLIC_URL; // örn: https://defter-backend.onrender.com
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY; // AI destekli tüm özellikler için (PDF/fiş okuma, serbest metin, soru-cevap, analiz)
const CRON_SECRET = process.env.CRON_SECRET; // /cron/daily-check endpoint'ini korumak için

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function addMonths(dateStr, n) {
  const d = new Date(dateStr);
  d.setMonth(d.getMonth() + n);
  return d.toISOString().slice(0, 10);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function fmt(n) {
  return '₺' + Number(n || 0).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function findCardByName(cards, name) {
  if (!name) return null;
  const norm = String(name).trim().toLowerCase();
  return (cards || []).find((c) => c.name && c.name.toLowerCase() === norm) || null;
}

// Sohbet başına, onay bekleyen PDF'ten çıkarılmış işlemler (bellek içi, geçici)
const pendingStatements = new Map();
// Sohbet başına, onay bekleyen TEK bir gelir/gider kaydı (metin veya fiş fotoğrafından)
const pendingTransactions = new Map();
// Sohbet başına, "tüm veriyi sil" komutunun onayını bekleyen durum (bellek içi, geçici)
const pendingWipeConfirmations = new Set();
const WIPE_CONFIRM_PHRASE = 'evet, tümünü sil';

// Render'ın ücretsiz planı uykudan uyanırken yanıt gecikebiliyor; bu durumda Telegram
// aynı update'i webhook'a tekrar gönderebilir ve aynı mesaj (örn. "onayla") iki kez
// işlenip işlemler ÇİFT kaydedilebilir. Bunu önlemek için son işlenen update_id'leri
// bellekte tutup tekrarını görmezden geliyoruz.
const processedUpdateIds = new Set();
function isDuplicateUpdate(ctx) {
  const id = ctx.update && ctx.update.update_id;
  if (id === undefined || id === null) return false;
  if (processedUpdateIds.has(id)) return true;
  processedUpdateIds.add(id);
  if (processedUpdateIds.size > 1000) {
    const keepLast = [...processedUpdateIds].slice(-500);
    processedUpdateIds.clear();
    keepLast.forEach((x) => processedUpdateIds.add(x));
  }
  return false;
}

function freshDefaultData() {
  // db.js'teki DEFAULT_DATA referansını değil, derin bir kopyasını döndürür
  // (aksi halde nesne/dizi referansları paylaşılır ve sonraki kayıtlar eski veriye karışabilir).
  return JSON.parse(JSON.stringify(db.DEFAULT_DATA));
}

/* ---------- Kategori tahmini: önce kural tabanlı, "Diğer" çıkarsa AI'a danış ---------- */
async function resolveCategory(description, type, categories, apiKey) {
  const ruleBased = guessCategory(description, type, categories);
  if (ruleBased !== 'Diğer' || !apiKey) return ruleBased;
  try {
    const list = (categories && categories[type]) || [];
    const aiGuess = await guessCategoryWithAI(description, type, list, apiKey);
    return aiGuess || ruleBased;
  } catch (e) {
    console.error('AI kategori tahmini başarısız:', e.message);
    return ruleBased;
  }
}

/* ---------- Onay bekleyen tek işlem: önizleme metni üretme ve kaydetme ---------- */
function buildTransactionPreview(parsed, category) {
  const date = parsed.date || todayISO();
  const dateNote = parsed.dateWasExplicit ? ` · ${date}` : '';

  if (parsed.type === 'gelir') {
    return {
      pending: { type: 'gelir', amount: parsed.amount, category, date, note: `Telegram: ${parsed.raw}` },
      previewText: `Gelir: ${fmt(parsed.amount)} · ${category}${dateNote}`
    };
  }

  const cardId = parsed.card ? parsed.card.id : null;
  const installments = parsed.installments && parsed.installments > 1 ? parsed.installments : 1;
  const cardLabel = parsed.card ? `${parsed.card.name} (${parsed.card.bank || ''})` : 'Nakit / Kartsız';
  return {
    pending: {
      type: 'gider', amount: parsed.amount, category, date, note: `Telegram: ${parsed.raw}`,
      cardId, installments
    },
    previewText: `Gider: ${fmt(parsed.amount)} · ${category} · ${cardLabel} · ${installments > 1 ? installments + ' taksit' : 'peşin'}${dateNote}`
  };
}

function commitTransaction(data, pending) {
  if (pending.type === 'gelir') {
    data.transactions.push({
      id: uid(), type: 'gelir', amount: pending.amount, category: pending.category, note: pending.note, date: pending.date
    });
    return `Gelir kaydedildi: ${fmt(pending.amount)} · ${pending.category}`;
  }

  const installments = pending.installments || 1;
  if (installments <= 1) {
    data.transactions.push({
      id: uid(), type: 'gider', amount: pending.amount, category: pending.category, note: pending.note,
      date: pending.date, cardId: pending.cardId || undefined
    });
  } else {
    const groupId = uid();
    const monthlyAmt = Math.round((pending.amount / installments) * 100) / 100;
    for (let i = 0; i < installments; i++) {
      data.transactions.push({
        id: uid(), type: 'gider', amount: monthlyAmt, category: pending.category, note: pending.note,
        date: addMonths(pending.date, i), cardId: pending.cardId || undefined,
        installmentGroupId: groupId, installmentNo: i + 1,
        installmentTotal: installments, installmentPurchaseAmount: pending.amount
      });
    }
  }
  return `Gider kaydedildi: ${fmt(pending.amount)} · ${pending.category}`;
}

/* ---------- Bütçe aşımı kontrolü (bir kategori için, belirli ayda) ---------- */
function categoryMonthTotal(data, category, monthKey) {
  return (data.transactions || [])
    .filter((t) => t.type === 'gider' && t.category === category && t.date.slice(0, 7) === monthKey)
    .reduce((s, t) => s + t.amount, 0);
}

// totalBefore: işlem eklenmeden ÖNCEKİ toplam. Sadece %80 veya %100 eşiğini YENİ geçtiyse uyarı döner
// (zaten aşılmışsa her işlemde tekrar tekrar uyarmamak için).
function checkBudgetWarning(data, category, monthKey, totalBefore) {
  const limit = data.budgets ? data.budgets[category] : null;
  if (!limit || limit <= 0) return null;
  const totalAfter = categoryMonthTotal(data, category, monthKey);
  const pctBefore = (totalBefore / limit) * 100;
  const pctAfter = (totalAfter / limit) * 100;
  if (pctBefore < 100 && pctAfter >= 100) {
    return `🚨 "${category}" kategorisinde bu ayki bütçe limitini aştın! (${fmt(totalAfter)} / ${fmt(limit)})`;
  }
  if (pctBefore < 80 && pctAfter >= 80) {
    return `⚠️ "${category}" kategorisinde bütçenin %${Math.round(pctAfter)}'ine ulaştın (${fmt(totalAfter)} / ${fmt(limit)}).`;
  }
  return null;
}

/* ---------- Aylık AI özet için veri hazırlama ---------- */
function categoryTotalsForMonth(data, monthKey) {
  const totals = { gelir: 0, gider: 0, kategoriler: {} };
  for (const t of data.transactions || []) {
    if (t.date.slice(0, 7) !== monthKey) continue;
    if (t.type === 'gelir') totals.gelir += t.amount;
    else {
      totals.gider += t.amount;
      totals.kategoriler[t.category] = (totals.kategoriler[t.category] || 0) + t.amount;
    }
  }
  return totals;
}

function buildMonthlySummaryForAI(data) {
  const thisMonth = todayISO().slice(0, 7);
  const lastMonthDate = new Date();
  lastMonthDate.setMonth(lastMonthDate.getMonth() - 1);
  const lastMonth = lastMonthDate.toISOString().slice(0, 7);
  return {
    buAy: { ay: thisMonth, ...categoryTotalsForMonth(data, thisMonth) },
    gecenAy: { ay: lastMonth, ...categoryTotalsForMonth(data, lastMonth) },
    butceLimitleri: data.budgets || {}
  };
}

async function maybeSendMonthlyInsight(ctx, data) {
  if (!ANTHROPIC_API_KEY) return;
  if (new Date().getDate() > 3) return; // sadece ayın ilk 3 günü
  const monthKey = todayISO().slice(0, 7);
  if (data.lastAutoInsightMonth === monthKey) return;
  const totals = categoryTotalsForMonth(data, monthKey);
  if (totals.gelir === 0 && Object.keys(totals.kategoriler).length === 0) return; // bu ay hiç veri yoksa gönderme

  try {
    const summary = buildMonthlySummaryForAI(data);
    const insight = await generateMonthlyInsights(summary, ANTHROPIC_API_KEY);
    data.lastAutoInsightMonth = monthKey;
    await db.setData(data);
    await ctx.reply('🤖 Aylık özet:\n\n' + insight);
  } catch (e) {
    console.error('Otomatik aylık özet hatası:', e.message);
  }
}

/* ---------- Tekrarlayan işlemler + yaklaşan taksitler (proaktif bildirimler) ---------- */
function nextMonthKey(key) {
  let [y, m] = key.split('-').map(Number);
  m += 1;
  if (m > 12) { m = 1; y += 1; }
  return y + '-' + String(m).padStart(2, '0');
}

// Web arayüzündeki generateRecurringTransactions() ile aynı mantık; sadece web açılınca değil,
// backend'de (cron ile) de çalışabilsin diye burada da var.
function generateRecurringTransactionsServer(data) {
  const todayKey = todayISO().slice(0, 7);
  const generated = [];
  (data.recurring || []).forEach((r) => {
    if (!r.active) return;
    let cursor = r.lastGeneratedMonth ? nextMonthKey(r.lastGeneratedMonth) : (r.startDate || todayISO()).slice(0, 7);
    let guard = 0;
    while (cursor <= todayKey && guard < 600) {
      guard++;
      const [y, m] = cursor.split('-').map(Number);
      const daysInMonth = new Date(y, m, 0).getDate();
      const day = Math.min(r.dayOfMonth, daysInMonth);
      const dateStr = `${cursor}-${String(day).padStart(2, '0')}`;
      const tx = {
        id: uid(), type: r.type, amount: r.amount, category: r.category,
        note: (r.note ? r.note + ' ' : '') + '(otomatik · tekrarlanan)',
        date: dateStr, recurringId: r.id
      };
      data.transactions.push(tx);
      generated.push(tx);
      r.lastGeneratedMonth = cursor;
      cursor = nextMonthKey(cursor);
    }
  });
  return generated;
}

// "Taksitler" sayfasındaki manuel taksitlerin (data.installments) vadesi gelen ayları
// otomatik olarak gider kaydına dönüştürür; web arayüzündeki generateInstallmentTransactions()
// ile aynı mantık. Bu sayede taksitler, kullanıcı web arayüzünü açıp elle "ödendi" işaretlemese
// bile Giderler/Raporlar/Bütçe hesaplarına dahil olur (artık birbirinden bağımsız değiller).
function generateInstallmentTransactionsServer(data) {
  const todayStr = todayISO();
  const generated = [];
  (data.installments || []).forEach((inst) => {
    if (!inst.paid) inst.paid = new Array(inst.months).fill(false);
    if (!inst.paidTx) inst.paidTx = new Array(inst.months).fill(null);
    for (let idx = 0; idx < inst.months; idx++) {
      if (inst.paid[idx]) continue;
      const dueStr = addMonths(inst.startDate, idx);
      if (dueStr > todayStr) break; // vadesi henüz gelmemiş, sıradaki ayları kontrol etmeye gerek yok
      inst.paid[idx] = true;
      const tx = {
        id: uid(), type: 'gider', amount: Math.round((inst.totalAmount / inst.months) * 100) / 100,
        category: inst.category, note: `${inst.title} — taksit ${idx + 1}/${inst.months} (otomatik)`,
        date: dueStr, cardId: inst.cardId || undefined, installmentRef: inst.id
      };
      data.transactions.push(tx);
      inst.paidTx[idx] = tx.id;
      generated.push(tx);
    }
  });
  return generated;
}

function upcomingInstallments(data, daysAhead = 3) {
  const today = new Date();
  const limit = new Date(today);
  limit.setDate(limit.getDate() + daysAhead);
  const todayStr = todayISO();
  const limitStr = limit.toISOString().slice(0, 10);
  return (data.transactions || []).filter((t) => t.installmentGroupId && t.date >= todayStr && t.date <= limitStr);
}

// Render'ın ücretsiz planı hareketsizken uyuduğu için bu fonksiyon kendiliğinden periyodik
// çalışmaz; dışarıdan (örn. cron-job.org) /cron/daily-check endpoint'ine günde bir istek
// atılması gerekir. README'de kurulumu anlatılıyor.
async function runDailyChecks() {
  const data = await db.getData();
  let changed = false;
  const messages = [];

  const generated = generateRecurringTransactionsServer(data);
  if (generated.length) {
    changed = true;
    messages.push(
      '🔁 Otomatik oluşturulan tekrarlayan işlemler:\n' +
      generated.map((t) => `• ${t.date} · ${t.type === 'gelir' ? '+' : '-'}${fmt(t.amount)} · ${t.category}`).join('\n')
    );
  }

  const generatedInstallments = generateInstallmentTransactionsServer(data);
  if (generatedInstallments.length) {
    changed = true;
    messages.push(
      '📆 Vadesi gelen taksitler gider olarak işlendi:\n' +
      generatedInstallments.map((t) => `• ${t.date} · -${fmt(t.amount)} · ${t.category}`).join('\n')
    );
  }

  if (!data.remindedInstallmentIds) data.remindedInstallmentIds = [];
  const upcoming = upcomingInstallments(data, 3).filter((t) => !data.remindedInstallmentIds.includes(t.id));
  if (upcoming.length) {
    changed = true;
    data.remindedInstallmentIds.push(...upcoming.map((t) => t.id));
    messages.push(
      '⏳ Yaklaşan taksit ödemeleri (3 gün içinde):\n' +
      upcoming.map((t) => `• ${t.date} · ${fmt(t.amount)} · ${t.category} (${t.installmentNo}/${t.installmentTotal})`).join('\n')
    );
  }

  if (!data.remindedBudgetMonths) data.remindedBudgetMonths = {};
  const monthKey = todayISO().slice(0, 7);
  const budgetWarnings = [];
  for (const [cat, limit] of Object.entries(data.budgets || {})) {
    if (!limit || limit <= 0) continue;
    const total = categoryMonthTotal(data, cat, monthKey);
    if (total >= limit && data.remindedBudgetMonths[cat] !== monthKey) {
      budgetWarnings.push(`🚨 "${cat}" bütçe limitini aştın: ${fmt(total)} / ${fmt(limit)}`);
      data.remindedBudgetMonths[cat] = monthKey;
      changed = true;
    }
  }
  if (budgetWarnings.length) messages.push(budgetWarnings.join('\n'));

  if (changed) await db.setData(data);
  if (messages.length && bot && ALLOWED_CHAT_ID) {
    await bot.telegram.sendMessage(ALLOWED_CHAT_ID, messages.join('\n\n'));
  }
  return { generatedRecurring: generated.length, installmentReminders: upcoming.length, budgetWarnings: budgetWarnings.length };
}

/* ---------- Ek komutlar: özet, kartlar, geri alma, yardım ---------- */
function monthSummary(data) {
  const monthKey = todayISO().slice(0, 7);
  const txs = data.transactions || [];
  const monthIncome = txs.filter(t => t.type === 'gelir' && t.date.slice(0, 7) === monthKey).reduce((s, t) => s + t.amount, 0);
  const monthExpense = txs.filter(t => t.type === 'gider' && t.date.slice(0, 7) === monthKey).reduce((s, t) => s + t.amount, 0);
  const totalIncome = txs.filter(t => t.type === 'gelir').reduce((s, t) => s + t.amount, 0);
  const totalExpense = txs.filter(t => t.type === 'gider').reduce((s, t) => s + t.amount, 0);
  const balance = totalIncome - totalExpense;
  return `📊 Bu ay: Gelir ${fmt(monthIncome)} · Gider ${fmt(monthExpense)}\n💰 Genel bakiye: ${fmt(balance)}`;
}

function listCardsText(data) {
  const cards = data.cards || [];
  if (cards.length === 0) return 'Henüz kayıtlı kart yok. Önce web arayüzünden bir kart ekleyin.';
  return '💳 Kayıtlı kartlar:\n' + cards.map(c => `• ${c.name} (${c.bank || 'banka yok'})`).join('\n');
}

function helpText() {
  const lines = [
    '🤖 Ne yazabilirsin:',
    '• "Akbank kredi kartı ile 3400tl alışveriş yaptım 2 taksit olarak" → taksitli kart gideri',
    '• "Migros\'ta nakit 250 TL harcadım" → peşin, kartsız gider',
    '• "87135,56 maaş yattı" → gelir (TL yazmasan da olur)',
    '• "dün market 250 tl harcadım" → tarihi bugün değil dün olarak kaydeder',
    '• "geçen hafta / 3 gün önce / 15 Temmuz / geçen pazartesi 500 tl harcadım" → tarih ifadesi anlaşılır',
    '• Her kayıt önce ÖNİZLEME olarak gösterilir; "onayla"/"evet" ile kaydedilir, "iptal"/"hayır" ile silinir',
    '• Bir ekstre/dekont PDF\'i gönder → içindeki işlemleri otomatik tespit edip aylara göre gruplar (onay ister)',
    '• Bir fiş/fatura FOTOĞRAFI gönder → tutarı, kategoriyi otomatik okur (onay ister)'
  ];
  if (ANTHROPIC_API_KEY) {
    lines.push('• Yukarıdaki kalıplara uymayan serbest cümleler de anlaşılır (AI destekli)');
    lines.push('• "bu ay markete ne kadar harcadım" gibi SORULAR da sorabilirsin, verine bakıp cevaplar');
  }
  lines.push(
    '',
    '📌 Komutlar:',
    '• "özet" veya "bakiyem ne kadar" → bu ayın ve genel bakiyenin özeti',
    '• "kartlarım" → kayıtlı kartların listesi',
    '• "son işlemi sil" veya "geri al" → Telegram\'dan eklenen son kaydı siler',
    '• "tüm verileri sil" → TÜM kayıtları siler (onay ister, geri alınamaz)',
    '• "analiz" veya "ai özet" → bu ayki harcamaların için kısa AI analizi' + (ANTHROPIC_API_KEY ? '' : ' (ANTHROPIC_API_KEY gerekir)'),
    '• "yardım" → bu mesaj'
  );
  return lines.join('\n');
}

function removeLastTelegramTransaction(data) {
  const candidates = (data.transactions || []).filter(t => typeof t.note === 'string' && (t.note.startsWith('Telegram:') || t.note.startsWith('Fiş (foto):')));
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => (a.id > b.id ? -1 : 1)); // en yeni (id'ler zaman damgalı) başa gelsin
  const last = candidates[0];
  if (last.installmentGroupId) {
    data.transactions = data.transactions.filter(t => t.installmentGroupId !== last.installmentGroupId);
    return `Taksitli işlem (${last.installmentTotal} taksit, toplam ${fmt(last.installmentPurchaseAmount)}) silindi.`;
  }
  data.transactions = data.transactions.filter(t => t.id !== last.id);
  return `İşlem silindi: ${fmt(last.amount)} · ${last.category}`;
}

/* ---------- REST API (web arayüzü için) ---------- */
// Önceden bu üretim yalnızca dışarıdan (cron-job.org vb.) tetiklenen /cron/daily-check
// endpoint'ine bağlıydı; o kurulmadığı sürece "Tekrarlayanlar"da tanımlanan kurallar hiçbir
// zaman gerçek gelir/gider kaydına dönüşmüyordu. Artık web arayüzü her veri çektiğinde
// (sayfa açılışı, "Yenile", ya da periyodik refreshData) burada da aynı üretim çalışıyor;
// böylece dış bir cron kurulmasa bile vadesi gelen tekrarlar ve taksitler kendiliğinden oluşuyor.
app.get('/api/data', async (req, res) => {
  try {
    const data = await db.getData();
    const generated = generateRecurringTransactionsServer(data);
    const generatedInstallments = generateInstallmentTransactionsServer(data);
    if (generated.length || generatedInstallments.length) {
      await db.setData(data);
    }
    res.json(data);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Veri okunamadı' });
  }
});

app.put('/api/data', async (req, res) => {
  try {
    await db.setData(req.body);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Veri kaydedilemedi' });
  }
});

// Aynı tür + tarih + tutar + kategori + not'a sahip birebir aynı işlemleri tekilleştirir.
// Telegram'ın webhook'u zaman zaman aynı onayı iki kez gönderip aynı ekstre/fişi
// çift kaydettirebiliyor; bu uç nokta bu tür kopyaları temizler (taksitli/tekrarlayan
// gruplara ait kayıtlara dokunmaz, sadece tam eşleşen kopyaları siler, ilkini tutar).
app.post('/api/maintenance/dedupe-transactions', async (req, res) => {
  try {
    const data = await db.getData();
    const seen = new Set();
    const before = (data.transactions || []).length;
    data.transactions = (data.transactions || []).filter((t) => {
      const key = [t.type, t.date, t.amount, t.category, t.note || '', t.installmentGroupId || '', t.installmentNo || ''].join('|');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const removed = before - data.transactions.length;
    if (removed > 0) await db.setData(data);
    res.json({ ok: true, removed, remaining: data.transactions.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Tekilleştirme başarısız' });
  }
});

/* ---------- REST API: Raporlar (reports.js motorunu kullanır) ---------- */

// Tek istekte dashboard/raporlar sayfasının ihtiyaç duyduğu her şey
app.get('/api/reports/overview', async (req, res) => {
  try {
    const data = await db.getData();
    const monthKey = req.query.month || todayISO().slice(0, 7);
    const trendMonths = Math.min(36, Math.max(1, Number(req.query.trendMonths) || 12));
    const forecastMonths = Math.min(12, Math.max(1, Number(req.query.forecastMonths) || 3));
    res.json(reports.fullReportBundle(data, { monthKey, trendMonths, forecastMonths }));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Rapor oluşturulamadı' });
  }
});

// Bir ay için gelir/gider özeti, önceki aya göre değişim, tasarruf oranı
app.get('/api/reports/month', async (req, res) => {
  try {
    const data = await db.getData();
    res.json(reports.monthOverview(data, req.query.month || todayISO().slice(0, 7)));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ay özeti oluşturulamadı' });
  }
});

// Kategori kırılımı (pasta grafik / tablo) — type=gelir|gider
app.get('/api/reports/categories', async (req, res) => {
  try {
    const data = await db.getData();
    const type = req.query.type === 'gelir' ? 'gelir' : 'gider';
    res.json(reports.categoryBreakdown(data, type, req.query.month || todayISO().slice(0, 7)));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Kategori kırılımı oluşturulamadı' });
  }
});

// Kategori x Ay pivot tablosu (Raporlar sayfasındaki büyük tablo)
app.get('/api/reports/category-pivot', async (req, res) => {
  try {
    const data = await db.getData();
    const type = req.query.type === 'gelir' ? 'gelir' : 'gider';
    const months = Math.min(24, Math.max(1, Number(req.query.months) || 6));
    res.json(reports.categoryPivotTable(data, type, months));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Pivot tablo oluşturulamadı' });
  }
});

// Tek bir kategorinin zaman içindeki trendi
app.get('/api/reports/category-trend', async (req, res) => {
  try {
    if (!req.query.category) return res.status(400).json({ error: 'category parametresi zorunlu' });
    const data = await db.getData();
    const type = req.query.type === 'gelir' ? 'gelir' : 'gider';
    const months = Math.min(36, Math.max(1, Number(req.query.months) || 12));
    res.json(reports.categoryTrend(data, req.query.category, type, months));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Kategori trendi oluşturulamadı' });
  }
});

// Aylık gelir/gider/net trend serisi (dashboard çizgi grafiği)
app.get('/api/reports/trend', async (req, res) => {
  try {
    const data = await db.getData();
    const months = Math.min(36, Math.max(1, Number(req.query.months) || 12));
    res.json(reports.monthlyTrend(data, months));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Trend oluşturulamadı' });
  }
});

// Önümüzdeki N ay için gelir/gider tahmini (doğrusal regresyon + üstel düzeltme)
app.get('/api/reports/forecast', async (req, res) => {
  try {
    const data = await db.getData();
    const monthsAhead = Math.min(12, Math.max(1, Number(req.query.months) || 3));
    const historyMonths = Math.min(24, Math.max(2, Number(req.query.historyMonths) || 6));
    res.json(reports.forecast(data, monthsAhead, historyMonths));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Tahmin oluşturulamadı' });
  }
});

// Bütçe limiti vs gerçekleşen harcama karşılaştırması
app.get('/api/reports/budget', async (req, res) => {
  try {
    const data = await db.getData();
    res.json(reports.budgetVsActual(data, req.query.month || todayISO().slice(0, 7)));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Bütçe karşılaştırması oluşturulamadı' });
  }
});

// Karta göre harcama dağılımı
app.get('/api/reports/cards', async (req, res) => {
  try {
    const data = await db.getData();
    res.json(reports.cardUsageBreakdown(data, req.query.month || todayISO().slice(0, 7)));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Kart kullanım raporu oluşturulamadı' });
  }
});

// Önümüzdeki N ay taahhüt edilmiş nakit çıkışı (taksitler + tekrarlayan işlemler)
app.get('/api/reports/cashflow', async (req, res) => {
  try {
    const data = await db.getData();
    const monthsAhead = Math.min(24, Math.max(1, Number(req.query.months) || 6));
    res.json(reports.cashflowProjection(data, monthsAhead));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Nakit akışı projeksiyonu oluşturulamadı' });
  }
});

// Haftanın günlerine göre harcama alışkanlığı
app.get('/api/reports/weekday-pattern', async (req, res) => {
  try {
    const data = await db.getData();
    const months = Math.min(24, Math.max(1, Number(req.query.months) || 6));
    res.json(reports.weekdaySpendingPattern(data, months));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Harcama alışkanlığı raporu oluşturulamadı' });
  }
});

// En yüksek tutarlı işlemler
app.get('/api/reports/top-transactions', async (req, res) => {
  try {
    const data = await db.getData();
    const type = req.query.type === 'gelir' ? 'gelir' : 'gider';
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
    res.json(reports.topTransactions(data, type, req.query.month || null, limit));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'İşlem listesi oluşturulamadı' });
  }
});

/* ---------- REST API: Yeni matematiksel analizler ---------- */

// Kategori bazlı anomali tespiti (z-score): bu ay, geçmiş ortalamaya göre olağandışı kategoriler
app.get('/api/reports/anomalies', async (req, res) => {
  try {
    const data = await db.getData();
    const monthKey = req.query.month || todayISO().slice(0, 7);
    const historyMonths = Math.min(24, Math.max(2, Number(req.query.historyMonths) || 6));
    const zThreshold = Math.max(1, Number(req.query.zThreshold) || 2);
    res.json(reports.anomalyDetection(data, monthKey, { historyMonths, zThreshold }));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Anomali tespiti oluşturulamadı' });
  }
});

// İşlem bazında olağandışı (kendi kategorisinin tipik tutarından çok sapan) kayıtlar
app.get('/api/reports/unusual-transactions', async (req, res) => {
  try {
    const data = await db.getData();
    const monthKey = req.query.month || todayISO().slice(0, 7);
    const zThreshold = Math.max(1, Number(req.query.zThreshold) || 2);
    res.json(reports.unusualTransactions(data, monthKey, { zThreshold }));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Olağandışı işlem taraması oluşturulamadı' });
  }
});

// 0-100 arası finansal sağlık skoru (tasarruf oranı + bütçe disiplini + gelir istikrarı + taahhüt yükü)
app.get('/api/reports/health-score', async (req, res) => {
  try {
    const data = await db.getData();
    res.json(reports.financialHealthScore(data, req.query.month || todayISO().slice(0, 7)));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Finansal sağlık skoru oluşturulamadı' });
  }
});

// Takvim ayına göre mevsimsellik endeksi (100 = ortalama, üstü/altı sapma)
app.get('/api/reports/seasonality', async (req, res) => {
  try {
    const data = await db.getData();
    const type = req.query.type === 'gelir' ? 'gelir' : 'gider';
    res.json(reports.seasonalityIndex(data, type));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Mevsimsellik analizi oluşturulamadı' });
  }
});

// Önümüzdeki N ay için "gerçekten harcanabilir" serbest nakit tahmini
app.get('/api/reports/free-cash', async (req, res) => {
  try {
    const data = await db.getData();
    const monthsAhead = Math.min(12, Math.max(1, Number(req.query.months) || 3));
    const historyMonths = Math.min(24, Math.max(2, Number(req.query.historyMonths) || 6));
    res.json(reports.freeCashForecast(data, monthsAhead, historyMonths));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Serbest nakit tahmini oluşturulamadı' });
  }
});

// Birikim hedefi Monte Carlo simülasyonu: ?target=50000&months=24
app.get('/api/reports/savings-goal', async (req, res) => {
  try {
    if (!req.query.target) return res.status(400).json({ error: 'target parametresi zorunlu' });
    const data = await db.getData();
    const targetAmount = Number(req.query.target);
    const monthsHorizon = Math.min(120, Math.max(1, Number(req.query.months) || 24));
    const startingBalance = Number(req.query.startingBalance) || 0;
    res.json(reports.savingsGoalSimulation(data, targetAmount, { monthsHorizon, startingBalance }));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Birikim simülasyonu oluşturulamadı' });
  }
});

// En çok harcanan kategoriler arasında Pearson korelasyonu
app.get('/api/reports/category-correlation', async (req, res) => {
  try {
    const data = await db.getData();
    const type = req.query.type === 'gelir' ? 'gelir' : 'gider';
    const months = Math.min(36, Math.max(3, Number(req.query.months) || 12));
    const topN = Math.min(20, Math.max(2, Number(req.query.topN) || 8));
    res.json(reports.categoryCorrelation(data, { months, type, topN }));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Kategori korelasyonu oluşturulamadı' });
  }
});

// "Tekrarlayanlar"a henüz eklenmemiş, geçmişte tekrar eden kalıpları tespit eder (abonelik vb.)
app.get('/api/reports/recurring-candidates', async (req, res) => {
  try {
    const data = await db.getData();
    const months = Math.min(24, Math.max(2, Number(req.query.months) || 6));
    const minOccurrences = Math.max(2, Number(req.query.minOccurrences) || 3);
    res.json(reports.detectRecurringCandidates(data, { months, minOccurrences }));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Tekrarlayan işlem taraması oluşturulamadı' });
  }
});

// Geçmiş medyana dayalı otomatik bütçe limiti önerisi
app.get('/api/reports/suggested-budgets', async (req, res) => {
  try {
    const data = await db.getData();
    const months = Math.min(24, Math.max(2, Number(req.query.months) || 6));
    const marginPct = Math.max(0, Number(req.query.marginPct) || 10);
    res.json(reports.suggestedBudgets(data, { months, marginPct }));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Bütçe önerisi oluşturulamadı' });
  }
});

// Harcama yoğunluğu / eşitsizlik endeksi (Gini katsayısı)
app.get('/api/reports/spending-concentration', async (req, res) => {
  try {
    const data = await db.getData();
    res.json(reports.spendingConcentration(data, req.query.month || todayISO().slice(0, 7)));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Harcama yoğunluğu analizi oluşturulamadı' });
  }
});

// İşlemleri CSV olarak dışa aktar (Excel uyumlu, ; ayraçlı). from/to opsiyonel (YYYY-MM-DD).
app.get('/api/reports/export.csv', async (req, res) => {
  try {
    const data = await db.getData();
    let txs = data.transactions || [];
    if (req.query.from) txs = txs.filter((t) => t.date >= req.query.from);
    if (req.query.to) txs = txs.filter((t) => t.date <= req.query.to);
    if (req.query.type) txs = txs.filter((t) => t.type === req.query.type);
    txs = [...txs].sort((a, b) => (a.date < b.date ? -1 : 1));
    const csv = reports.transactionsToCSV(txs);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="defter-islemler-${todayISO()}.csv"`);
    res.send('\uFEFF' + csv); // BOM: Excel'in Türkçe karakterleri doğru göstermesi için
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'CSV oluşturulamadı' });
  }
});

// Dışarıdan (örn. cron-job.org, GitHub Actions scheduled workflow) günde bir kez tetiklenmesi
// önerilir. ?secret=CRON_SECRET zorunludur. README'de kurulum adımları var.
app.get('/cron/daily-check', async (req, res) => {
  try {
    if (!CRON_SECRET || req.query.secret !== CRON_SECRET) {
      return res.status(401).json({ error: 'Yetkisiz (secret eksik/yanlış)' });
    }
    const result = await runDailyChecks();
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

/* ---------- Telegram bot ---------- */
let bot = null;
if (BOT_TOKEN) {
  bot = new Telegraf(BOT_TOKEN);

  bot.on('text', async (ctx) => {
    try {
      if (isDuplicateUpdate(ctx)) return; // Telegram'ın tekrar gönderdiği aynı update'i yok say
      if (ALLOWED_CHAT_ID && String(ctx.chat.id) !== String(ALLOWED_CHAT_ID)) {
        return; // tanınmayan kullanıcıdan gelen mesajları yok say
      }
      const text = ctx.message.text.trim();
      const lower = text.toLowerCase();

      /* --- "Tüm veriyi sil" onayı bekleniyor: her şeyden önce bunu ele al --- */
      if (pendingWipeConfirmations.has(ctx.chat.id)) {
        if (lower === WIPE_CONFIRM_PHRASE) {
          await db.setData(freshDefaultData());
          pendingWipeConfirmations.delete(ctx.chat.id);
          pendingStatements.delete(ctx.chat.id);
          pendingTransactions.delete(ctx.chat.id);
          await ctx.reply('🗑️ Tüm veriler silindi. Kayıtlar, kartlar, taksitler, tekrarlar ve bütçeler sıfırlandı.');
          return;
        }
        if (/^(iptal|hayır|hayir|vazgeç|vazgec)\b/.test(lower)) {
          pendingWipeConfirmations.delete(ctx.chat.id);
          await ctx.reply('İptal edildi, hiçbir şey silinmedi.');
          return;
        }
        await ctx.reply(
          `Silme işlemini onaylamak için tam olarak şunu yaz: "${WIPE_CONFIRM_PHRASE}"\n` +
          `Vazgeçmek için "iptal" yaz.`
        );
        return;
      }
      if (/^\/?(tüm verileri sil|tüm veriyi sil|verileri sil|tüm veriyi temizle|tüm verileri temizle|hepsini sil|verileri sıfırla)\b/.test(lower)) {
        pendingWipeConfirmations.add(ctx.chat.id);
        await ctx.reply(
          '⚠️ Bu işlem TÜM kayıtlı verilerini (gelirler, giderler, taksitler, kartlar, tekrarlanan işlemler, bütçeler) ' +
          'kalıcı olarak silecek. Bu geri alınamaz.\n\n' +
          `Onaylamak için tam olarak şunu yaz: "${WIPE_CONFIRM_PHRASE}"\n` +
          'Vazgeçmek için "iptal" yaz.'
        );
        return;
      }

      /* --- PDF ekstre onayı / iptali --- */
      const pendingStmt = pendingStatements.get(ctx.chat.id);
      if (pendingStmt && /^(onayla|kaydet|evet)\b/.test(lower)) {
        const data = await db.getData();
        const categoryMonthBefore = {}; // "kategori|ay" -> önceki toplam (bütçe uyarısı için)
        for (const c of pendingStmt) {
          const category = guessCategory(c.description, c.type, data.categories);
          const monthKey = c.date.slice(0, 7);
          const key = category + '|' + monthKey;
          if (!(key in categoryMonthBefore)) categoryMonthBefore[key] = categoryMonthTotal(data, category, monthKey);
          data.transactions.push({
            id: uid(), type: c.type, amount: c.amount, category,
            note: `PDF ekstre: ${c.description}`, date: c.date
          });
        }
        await db.setData(data);
        pendingStatements.delete(ctx.chat.id);
        await ctx.reply(`✅ ${pendingStmt.length} işlem kaydedildi.`);

        const warnings = Object.keys(categoryMonthBefore)
          .map((key) => {
            const [cat, monthKey] = key.split('|');
            return checkBudgetWarning(data, cat, monthKey, categoryMonthBefore[key]);
          })
          .filter(Boolean);
        if (warnings.length) await ctx.reply(warnings.join('\n\n'));
        return;
      }
      if (pendingStmt && /^(iptal|hayır|hayir)\b/.test(lower)) {
        pendingStatements.delete(ctx.chat.id);
        await ctx.reply('İptal edildi, hiçbir işlem kaydedilmedi.');
        return;
      }

      /* --- Tek işlem onayı / iptali (metin ya da fiş fotoğrafından gelen) --- */
      const pendingTx = pendingTransactions.get(ctx.chat.id);
      if (pendingTx && /^(onayla|kaydet|evet)\b/.test(lower)) {
        const data = await db.getData();
        const monthKey = pendingTx.date.slice(0, 7);
        const totalBefore = pendingTx.type === 'gider' ? categoryMonthTotal(data, pendingTx.category, monthKey) : 0;
        const summary = commitTransaction(data, pendingTx);
        await db.setData(data);
        pendingTransactions.delete(ctx.chat.id);
        const warning = pendingTx.type === 'gider' ? checkBudgetWarning(data, pendingTx.category, monthKey, totalBefore) : null;
        await ctx.reply(`✅ ${summary}` + (warning ? `\n\n${warning}` : ''));
        return;
      }
      if (pendingTx && /^(iptal|hayır|hayir)\b/.test(lower)) {
        pendingTransactions.delete(ctx.chat.id);
        await ctx.reply('İptal edildi, hiçbir işlem kaydedilmedi.');
        return;
      }

      /* --- Komutlar --- */
      if (/^\/?(yardım|yardim|help)\b/.test(lower)) {
        await ctx.reply(helpText());
        return;
      }
      if (/^\/?(kartlar(ım|im)?)\b/.test(lower)) {
        const data = await db.getData();
        await ctx.reply(listCardsText(data));
        return;
      }
      if (/^\/?(özet|ozet)\b/.test(lower) || /bakiye/.test(lower)) {
        const data = await db.getData();
        await ctx.reply(monthSummary(data));
        await maybeSendMonthlyInsight(ctx, data); // ayın ilk günlerindeyse ayrıca AI özeti de gönder
        return;
      }
      if (/^\/?(ai\s*özet|ai\s*ozet|analiz)\b/.test(lower)) {
        if (!ANTHROPIC_API_KEY) {
          await ctx.reply('Bu özellik için Render\'da ANTHROPIC_API_KEY tanımlı olmalı.');
          return;
        }
        const data = await db.getData();
        await ctx.reply('🔎 Harcamalarını analiz ediyorum...');
        try {
          const summary = buildMonthlySummaryForAI(data);
          const insight = await generateMonthlyInsights(summary, ANTHROPIC_API_KEY);
          await ctx.reply('🤖 ' + insight);
        } catch (e) {
          console.error(e);
          await ctx.reply('Analiz oluşturulamadı: ' + e.message);
        }
        return;
      }
      if (/^(son işlemi sil|son kaydı sil|geri al|iptal et)/.test(lower)) {
        const data = await db.getData();
        const result = removeLastTelegramTransaction(data);
        if (!result) {
          await ctx.reply('Telegram üzerinden eklenmiş, silinecek bir işlem bulamadım.');
          return;
        }
        await db.setData(data);
        await ctx.reply(`↩️ ${result}`);
        return;
      }

      /* --- Normal gelir/gider kaydı (kural tabanlı ayrıştırma) --- */
      const data = await db.getData();
      const parsed = parseMessage(text, data.cards || []);

      if (parsed.amount) {
        if (parsed.type === 'gider' && parsed.cardMentioned && !parsed.card) {
          const cardNames = (data.cards || []).map(c => `${c.name} (${c.bank || ''})`).join(', ') || 'Henüz kayıtlı kart yok';
          await ctx.reply(`Bu mesajda geçen kartı sistemde bulamadım. Kayıtlı kartlar: ${cardNames}`);
          return;
        }
        const category = await resolveCategory(parsed.raw, parsed.type, data.categories, ANTHROPIC_API_KEY);
        const { pending, previewText } = buildTransactionPreview(parsed, category);
        pendingTransactions.set(ctx.chat.id, pending);
        await ctx.reply(`📝 ${previewText}\n\nKaydetmek için "onayla" ya da "evet", iptal için "iptal" ya da "hayır" yaz.`);
        return;
      }

      /* --- Kural tabanlı ayrıştırma tutar bulamadı: AI'a devret (varsa) --- */
      if (!ANTHROPIC_API_KEY) {
        await ctx.reply('Tutarı anlayamadım. Örnek: "Akbank kredi kartı ile 3400tl alışveriş yaptım 2 taksit olarak". Yardım için "yardım" yazabilirsin.');
        return;
      }

      try {
        const aiResult = await classifyAndParseMessage(
          text,
          { cards: data.cards, categories: data.categories, todayISO: todayISO() },
          ANTHROPIC_API_KEY
        );

        if (aiResult.kind === 'question') {
          await ctx.reply('🤖 Düşünüyorum...');
          const answer = await answerFinanceQuestion(text, data, ANTHROPIC_API_KEY);
          await ctx.reply(answer);
          return;
        }

        if (aiResult.kind === 'transaction' && aiResult.transaction && aiResult.transaction.amount) {
          const t = aiResult.transaction;
          const card = findCardByName(data.cards, t.cardName);
          const categoryList = (data.categories && data.categories[t.type]) || [];
          const category = categoryList.includes(t.category) ? t.category : 'Diğer';
          const parsedLike = {
            raw: text,
            type: t.type === 'gelir' ? 'gelir' : 'gider',
            amount: Math.abs(t.amount),
            installments: t.installments && t.installments > 1 ? t.installments : 1,
            card,
            date: t.date || todayISO(),
            dateWasExplicit: !!t.date
          };
          const { pending, previewText } = buildTransactionPreview(parsedLike, category);
          pendingTransactions.set(ctx.chat.id, pending);
          await ctx.reply(`🤖 ${previewText}\n\nKaydetmek için "onayla" ya da "evet", iptal için "iptal" ya da "hayır" yaz.`);
          return;
        }

        await ctx.reply('Tutarı anlayamadım ve bir soru olarak da yorumlayamadım. Yardım için "yardım" yazabilirsin.');
      } catch (e) {
        console.error(e);
        await ctx.reply('Tutarı anlayamadım. Yardım için "yardım" yazabilirsin. (AI analizi de başarısız oldu: ' + e.message + ')');
      }
    } catch (e) {
      console.error(e);
      await ctx.reply('Bir hata oluştu, işlem kaydedilemedi.');
    }
  });

  /* --- Fiş / fatura fotoğrafı --- */
  bot.on('photo', async (ctx) => {
    try {
      if (isDuplicateUpdate(ctx)) return;
      if (ALLOWED_CHAT_ID && String(ctx.chat.id) !== String(ALLOWED_CHAT_ID)) return;
      if (!ANTHROPIC_API_KEY) {
        await ctx.reply('Fiş/fatura fotoğrafı okuma özelliği için Render\'da ANTHROPIC_API_KEY tanımlı olmalı.');
        return;
      }

      const photos = ctx.message.photo;
      const largest = photos[photos.length - 1]; // Telegram fotoğrafları küçükten büyüğe sıralar
      await ctx.reply('🧾 Fiş okunuyor...');
      const fileLink = await ctx.telegram.getFileLink(largest.file_id);
      const buffer = await downloadBuffer(fileLink.href);
      const data = await db.getData();

      let result;
      try {
        result = await extractReceiptFromImage(
          buffer, 'image/jpeg',
          { cards: data.cards, categories: data.categories, todayISO: todayISO() },
          ANTHROPIC_API_KEY
        );
      } catch (e) {
        console.error(e);
        await ctx.reply('Fiş analiz edilemedi: ' + e.message);
        return;
      }

      if (!result || !result.amount) {
        await ctx.reply('Bu görselde bir fiş/fatura tanıyamadım. Net, iyi ışıklı bir fotoğrafla tekrar dener misin?');
        return;
      }

      const card = findCardByName(data.cards, result.cardName);
      const giderCats = (data.categories && data.categories.gider) || [];
      const pending = {
        type: 'gider',
        amount: Math.abs(result.amount),
        category: giderCats.includes(result.category) ? result.category : 'Diğer',
        date: result.date || todayISO(),
        note: `Fiş (foto): ${result.description || ''}`.trim(),
        cardId: card ? card.id : null,
        installments: 1
      };
      pendingTransactions.set(ctx.chat.id, pending);
      const cardLabel = card ? `${card.name} (${card.bank || ''})` : 'Nakit / Kartsız';
      await ctx.reply(
        `🧾 Fişten okudum: ${fmt(pending.amount)} · ${pending.category} · ${cardLabel}\n${pending.note}\n\n` +
        `Kaydetmek için "onayla" ya da "evet", iptal için "iptal" ya da "hayır" yaz.`
      );
    } catch (e) {
      console.error(e);
      await ctx.reply('Fotoğraf işlenirken bir hata oluştu: ' + e.message);
    }
  });

  bot.on('document', async (ctx) => {
    try {
      if (isDuplicateUpdate(ctx)) return;
      if (ALLOWED_CHAT_ID && String(ctx.chat.id) !== String(ALLOWED_CHAT_ID)) return;
      const doc = ctx.message.document;
      if (!doc.mime_type || !doc.mime_type.includes('pdf')) {
        await ctx.reply('Şu an sadece PDF dosyalarını okuyabiliyorum.');
        return;
      }

      await ctx.reply('📄 PDF alındı, okunuyor...');
      const fileLink = await ctx.telegram.getFileLink(doc.file_id);
      const buffer = await downloadBuffer(fileLink.href);
      const parser = new PDFParse({ data: buffer });
      const result = await parser.getText();
      const text = result.text || '';
      let candidates = extractCandidateTransactions(text);
      let usedAI = false;

      // Bazı ekstreler (özellikle Akbank/Axess gibi) gömülü özel font kodlaması
      // kullanıyor; pdf-parse anlamsız karakterler çıkarıyor ve regex hiçbir
      // işlem bulamıyor. Bu durumda, ANTHROPIC_API_KEY tanımlıysa PDF sayfalarını
      // görsele çevirip Claude'un görme yeteneğiyle okutuyoruz.
      if (candidates.length === 0) {
        if (!ANTHROPIC_API_KEY) {
          const preview = text.slice(0, 3000) || '(metin çıkarılamadı; bu PDF taranmış görüntü ya da özel font kodlaması kullanıyor olabilir)';
          await ctx.reply(
            'İşlem satırı tanıyamadım (bu ekstre büyük ihtimalle özel font kodlaması kullanıyor). ' +
            'Render\'da ANTHROPIC_API_KEY ortam değişkenini eklerseniz bu tür ekstreleri de ' +
            'görsel olarak okuyabilirim. PDF\'ten çıkan ham metnin bir kısmı:\n\n' + preview
          );
          return;
        }

        await ctx.reply('🔎 Standart okuma başarısız oldu, sayfaları görsel olarak analiz ediyorum (biraz sürebilir)...');
        try {
          candidates = await extractTransactionsWithAI(buffer, ANTHROPIC_API_KEY);
          usedAI = true;
        } catch (aiErr) {
          console.error(aiErr);
          await ctx.reply('Görsel analiz de başarısız oldu: ' + aiErr.message);
          return;
        }

        if (candidates.length === 0) {
          await ctx.reply('Görsel analizle de işlem satırı bulamadım. Bu ekstrede tanınabilir bir işlem tablosu olmayabilir.');
          return;
        }
      }

      pendingStatements.set(ctx.chat.id, candidates);
      const prefix = usedAI ? '🤖 (Görsel/AI analiziyle okundu)\n\n' : '';
      await ctx.reply(prefix + formatGroupedStatementMessage(candidates, fmt));
    } catch (e) {
      console.error(e);
      await ctx.reply('PDF okunurken bir hata oluştu: ' + e.message);
    }
  });

  if (PUBLIC_URL) {
    // Webhook modu (Render gibi barındırma servislerinde önerilir)
    app.use(bot.webhookCallback('/telegram-webhook'));
  }
}

async function start() {
  await db.init();
  app.listen(PORT, async () => {
    console.log(`Sunucu ${PORT} portunda çalışıyor.`);
    if (bot && PUBLIC_URL) {
      await bot.telegram.setWebhook(`${PUBLIC_URL}/telegram-webhook`);
      console.log('Telegram webhook ayarlandı:', `${PUBLIC_URL}/telegram-webhook`);
    } else if (bot) {
      console.log('PUBLIC_URL tanımlı değil, bot long-polling modunda başlatılıyor (lokal test için).');
      bot.launch();
    }
  });
}

start();
