/**
 * reports.js
 * ----------------------------------------------------------------------
 * Gelir/Gider takip uygulaması için finansal analiz ve raporlama motoru.
 * Tüm fonksiyonlar saf (pure) fonksiyonlardır: `data` (db.getData() çıktısı)
 * alır, hesaplanmış sonucu döner. Hiçbir yan etkisi yoktur, DB'ye yazmaz.
 *
 * server.js içindeki /api/reports/* uç noktaları bu modülü kullanır;
 * public/index.html içindeki "Raporlar" sekmesi bu uç noktalardan gelen
 * veriyle tablo ve grafikleri oluşturur.
 * ----------------------------------------------------------------------
 */

/* ============================== Yardımcılar ============================== */

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function monthKeyOf(dateStr) {
  return dateStr.slice(0, 7);
}

/** "2026-07" -> {y:2026, m:7} */
function splitMonthKey(key) {
  const [y, m] = key.split('-').map(Number);
  return { y, m };
}

/** N ay öncesinin/sonrasının ay anahtarını üretir. n negatif olabilir. */
function shiftMonthKey(key, n) {
  const { y, m } = splitMonthKey(key);
  const d = new Date(y, m - 1 + n, 1);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

/** [baseline-n .. baseline] aralığındaki ay anahtarlarını (artan sırada) üretir. */
function lastNMonthKeys(n, baseline = todayISO().slice(0, 7)) {
  const keys = [];
  for (let i = n - 1; i >= 0; i--) keys.push(shiftMonthKey(baseline, -i));
  return keys;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function sum(arr) {
  return arr.reduce((s, n) => s + (Number(n) || 0), 0);
}

function mean(arr) {
  if (!arr.length) return 0;
  return sum(arr) / arr.length;
}

/** Örneklem standart sapması (volatilite ölçümü için). */
function stdDev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const variance = sum(arr.map((x) => (x - m) ** 2)) / (arr.length - 1);
  return Math.sqrt(variance);
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Basit hareketli ortalama; her nokta için son `window` değerin ortalaması. */
function movingAverage(series, window = 3) {
  return series.map((_, i) => {
    const start = Math.max(0, i - window + 1);
    const slice = series.slice(start, i + 1);
    return round2(mean(slice));
  });
}

/** Bir metrikteki yüzde değişim (MoM/YoY büyüme oranı için). */
function pctChange(current, previous) {
  if (!previous) return current > 0 ? 100 : 0;
  return round2(((current - previous) / Math.abs(previous)) * 100);
}

/**
 * En küçük kareler doğrusal regresyonu (basit trend/tahmin motoru).
 * x: [0,1,2,...] gibi index dizisi, y: değerler.
 * Döner: { slope, intercept, predict(x) }
 */
function linearRegression(y) {
  const n = y.length;
  if (n === 0) return { slope: 0, intercept: 0, predict: () => 0 };
  if (n === 1) return { slope: 0, intercept: y[0], predict: () => y[0] };
  const x = y.map((_, i) => i);
  const xMean = mean(x);
  const yMean = mean(y);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (x[i] - xMean) * (y[i] - yMean);
    den += (x[i] - xMean) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  const intercept = yMean - slope * xMean;
  return { slope, intercept, predict: (xi) => intercept + slope * xi };
}

/**
 * Basit üstel düzeltme (exponential smoothing) — kısa vadeli tahmin için
 * hareketli ortalamaya göre daha güncel verilere ağırlık verir.
 * alpha ne kadar yüksekse, güncel aya o kadar çok ağırlık verilir.
 */
function exponentialSmoothing(series, alpha = 0.5) {
  if (!series.length) return 0;
  let s = series[0];
  for (let i = 1; i < series.length; i++) {
    s = alpha * series[i] + (1 - alpha) * s;
  }
  return round2(s);
}

/* ============================== Temel Filtreler ============================== */

function txInMonth(t, monthKey) {
  return t.date && t.date.slice(0, 7) === monthKey;
}

function txInRange(t, from, to) {
  return t.date && (!from || t.date >= from) && (!to || t.date <= to);
}

/* ============================== Özet / Genel Bakış ============================== */

/**
 * Belirli bir ay için gelir/gider özeti + tasarruf oranı + önceki aya göre değişim.
 */
function monthOverview(data, monthKey = todayISO().slice(0, 7)) {
  const txs = data.transactions || [];
  const thisMonthTx = txs.filter((t) => txInMonth(t, monthKey));
  const income = round2(sum(thisMonthTx.filter((t) => t.type === 'gelir').map((t) => t.amount)));
  const expense = round2(sum(thisMonthTx.filter((t) => t.type === 'gider').map((t) => t.amount)));
  const net = round2(income - expense);
  const savingsRate = income > 0 ? round2((net / income) * 100) : 0;

  const prevKey = shiftMonthKey(monthKey, -1);
  const prevTx = txs.filter((t) => txInMonth(t, prevKey));
  const prevIncome = round2(sum(prevTx.filter((t) => t.type === 'gelir').map((t) => t.amount)));
  const prevExpense = round2(sum(prevTx.filter((t) => t.type === 'gider').map((t) => t.amount)));

  const allIncome = round2(sum(txs.filter((t) => t.type === 'gelir').map((t) => t.amount)));
  const allExpense = round2(sum(txs.filter((t) => t.type === 'gider').map((t) => t.amount)));
  const overallBalance = round2(allIncome - allExpense);

  return {
    month: monthKey,
    income,
    expense,
    net,
    savingsRate,
    transactionCount: thisMonthTx.length,
    avgTransaction: round2(mean(thisMonthTx.map((t) => t.amount))),
    incomeChangePct: pctChange(income, prevIncome),
    expenseChangePct: pctChange(expense, prevExpense),
    overallBalance,
    previousMonth: { month: prevKey, income: prevIncome, expense: prevExpense }
  };
}

/* ============================== Kategori Kırılımı ============================== */

/**
 * Bir tür (gelir/gider) için belirli bir ayda kategori bazlı dağılım.
 * Yüzde payı, işlem sayısı ve ortalama tutar dahil — tablo/pasta grafik için hazır.
 */
function categoryBreakdown(data, type = 'gider', monthKey = todayISO().slice(0, 7)) {
  const txs = (data.transactions || []).filter((t) => t.type === type && txInMonth(t, monthKey));
  const total = round2(sum(txs.map((t) => t.amount)));
  const byCategory = {};
  for (const t of txs) {
    if (!byCategory[t.category]) byCategory[t.category] = { amount: 0, count: 0 };
    byCategory[t.category].amount += t.amount;
    byCategory[t.category].count += 1;
  }
  const rows = Object.entries(byCategory)
    .map(([category, v]) => ({
      category,
      amount: round2(v.amount),
      count: v.count,
      avg: round2(v.amount / v.count),
      pct: total > 0 ? round2((v.amount / total) * 100) : 0
    }))
    .sort((a, b) => b.amount - a.amount);
  return { month: monthKey, type, total, rows };
}

/**
 * Bir kategorinin son N ay boyunca değişimi (pivot tablo satırı / trend çizgisi için).
 */
function categoryTrend(data, category, type = 'gider', months = 12) {
  const keys = lastNMonthKeys(months);
  const txs = (data.transactions || []).filter((t) => t.type === type && t.category === category);
  const series = keys.map((k) => round2(sum(txs.filter((t) => txInMonth(t, k)).map((t) => t.amount))));
  return {
    category,
    type,
    months: keys,
    series,
    movingAverage3: movingAverage(series, 3),
    average: round2(mean(series)),
    max: round2(Math.max(...series, 0)),
    min: round2(Math.min(...series, 0)),
    volatility: round2(stdDev(series))
  };
}

/**
 * Tüm kategoriler için son N ay pivot tablosu: satır = kategori, sütun = ay.
 * Raporlar sayfasındaki "Kategori x Ay" tablosunu doğrudan besler.
 */
function categoryPivotTable(data, type = 'gider', months = 6) {
  const keys = lastNMonthKeys(months);
  const txs = (data.transactions || []).filter((t) => t.type === type);
  const categories = [...new Set(txs.map((t) => t.category))].sort();
  const rows = categories.map((category) => {
    const catTx = txs.filter((t) => t.category === category);
    const values = keys.map((k) => round2(sum(catTx.filter((t) => txInMonth(t, k)).map((t) => t.amount))));
    return { category, values, total: round2(sum(values)) };
  });
  rows.sort((a, b) => b.total - a.total);
  const totalsByMonth = keys.map((_, i) => round2(sum(rows.map((r) => r.values[i]))));
  return { type, months: keys, rows, totalsByMonth, grandTotal: round2(sum(totalsByMonth)) };
}

/* ============================== Aylık Trend (Dashboard grafiği) ============================== */

/**
 * Son N ay için gelir/gider/net serisi + kümülatif bakiye + hareketli ortalama.
 */
function monthlyTrend(data, months = 12) {
  const keys = lastNMonthKeys(months);
  const txs = data.transactions || [];
  let cumulative = 0;
  const rows = keys.map((k) => {
    const monthTx = txs.filter((t) => txInMonth(t, k));
    const income = round2(sum(monthTx.filter((t) => t.type === 'gelir').map((t) => t.amount)));
    const expense = round2(sum(monthTx.filter((t) => t.type === 'gider').map((t) => t.amount)));
    const net = round2(income - expense);
    cumulative = round2(cumulative + net);
    return { month: k, income, expense, net, cumulative };
  });
  const incomeSeries = rows.map((r) => r.income);
  const expenseSeries = rows.map((r) => r.expense);
  return {
    months: keys,
    rows,
    incomeMovingAvg3: movingAverage(incomeSeries, 3),
    expenseMovingAvg3: movingAverage(expenseSeries, 3),
    avgIncome: round2(mean(incomeSeries)),
    avgExpense: round2(mean(expenseSeries)),
    expenseVolatility: round2(stdDev(expenseSeries))
  };
}

/* ============================== Tahmin (Forecast) ============================== */

/**
 * Önümüzdeki N ay için gelir/gider tahmini. İki yöntemin ortalamasını kullanır:
 * doğrusal regresyon (trend yönü) + üstel düzeltme (yakın geçmişe ağırlık).
 * Böylece hem trendi hem de son ayların davranışını yansıtan dengeli bir tahmin çıkar.
 */
function forecast(data, monthsAhead = 3, historyMonths = 6) {
  const trend = monthlyTrend(data, historyMonths);
  const incomeSeries = trend.rows.map((r) => r.income);
  const expenseSeries = trend.rows.map((r) => r.expense);

  const incomeReg = linearRegression(incomeSeries);
  const expenseReg = linearRegression(expenseSeries);
  const incomeSmoothed = exponentialSmoothing(incomeSeries, 0.5);
  const expenseSmoothed = exponentialSmoothing(expenseSeries, 0.5);

  const lastKey = trend.months[trend.months.length - 1] || todayISO().slice(0, 7);
  const points = [];
  for (let i = 1; i <= monthsAhead; i++) {
    const idx = incomeSeries.length - 1 + i;
    const incomeReg_ = incomeReg.predict(idx);
    const expenseReg_ = expenseReg.predict(idx);
    const income = Math.max(0, round2((incomeReg_ + incomeSmoothed) / 2));
    const expense = Math.max(0, round2((expenseReg_ + expenseSmoothed) / 2));
    points.push({
      month: shiftMonthKey(lastKey, i),
      projectedIncome: income,
      projectedExpense: expense,
      projectedNet: round2(income - expense)
    });
  }
  return {
    basedOnMonths: trend.months,
    incomeTrendSlope: round2(incomeReg.slope),
    expenseTrendSlope: round2(expenseReg.slope),
    points
  };
}

/* ============================== Bütçe vs Gerçekleşen ============================== */

/**
 * Her kategori için tanımlı bütçe limiti ile o ayki gerçekleşen harcamayı karşılaştırır.
 */
function budgetVsActual(data, monthKey = todayISO().slice(0, 7)) {
  const budgets = data.budgets || {};
  const breakdown = categoryBreakdown(data, 'gider', monthKey);
  const spentByCategory = Object.fromEntries(breakdown.rows.map((r) => [r.category, r.amount]));

  const categories = new Set([...Object.keys(budgets), ...Object.keys(spentByCategory)]);
  const rows = [...categories].map((category) => {
    const limit = budgets[category] || 0;
    const spent = spentByCategory[category] || 0;
    const remaining = round2(limit - spent);
    const usagePct = limit > 0 ? round2((spent / limit) * 100) : null;
    let status = 'bütçesiz';
    if (limit > 0) {
      status = spent >= limit ? 'aşıldı' : spent >= limit * 0.8 ? 'riskli' : 'normal';
    }
    return { category, limit: round2(limit), spent: round2(spent), remaining, usagePct, status };
  });
  rows.sort((a, b) => (b.usagePct ?? -1) - (a.usagePct ?? -1));
  return { month: monthKey, rows, totalBudget: round2(sum(rows.map((r) => r.limit))), totalSpent: round2(sum(rows.map((r) => r.spent))) };
}

/* ============================== Kart Kullanımı ============================== */

/** Karta göre harcama dağılımı + son N ayda kart bazlı trend. */
function cardUsageBreakdown(data, monthKey = todayISO().slice(0, 7)) {
  const cards = data.cards || [];
  const cardById = Object.fromEntries(cards.map((c) => [c.id, c]));
  const txs = (data.transactions || []).filter((t) => t.type === 'gider' && txInMonth(t, monthKey));
  const total = round2(sum(txs.map((t) => t.amount)));
  const byCard = {};
  let cashTotal = 0;
  for (const t of txs) {
    if (!t.cardId) { cashTotal += t.amount; continue; }
    if (!byCard[t.cardId]) byCard[t.cardId] = { amount: 0, count: 0 };
    byCard[t.cardId].amount += t.amount;
    byCard[t.cardId].count += 1;
  }
  const rows = Object.entries(byCard).map(([cardId, v]) => ({
    cardId,
    name: cardById[cardId] ? cardById[cardId].name : 'Bilinmeyen kart',
    bank: cardById[cardId] ? cardById[cardId].bank : '',
    amount: round2(v.amount),
    count: v.count,
    pct: total > 0 ? round2((v.amount / total) * 100) : 0
  }));
  if (cashTotal > 0) {
    rows.push({ cardId: null, name: 'Nakit / Kartsız', bank: '', amount: round2(cashTotal), count: txs.filter((t) => !t.cardId).length, pct: total > 0 ? round2((cashTotal / total) * 100) : 0 });
  }
  rows.sort((a, b) => b.amount - a.amount);
  return { month: monthKey, total, rows };
}

/* ============================== Taksit / Nakit Akışı Projeksiyonu ============================== */

/**
 * Önümüzdeki N ay için, halihazırda taahhüt edilmiş taksit ödemelerini
 * (data.installments) ve aktif tekrarlayan işlemleri (data.recurring) baz alarak
 * beklenen zorunlu çıkışları aya göre gruplar. "Bu ay taksitlerden ne kadar
 * ödeyeceğim?" sorusuna tablo halinde cevap verir.
 */
function cashflowProjection(data, monthsAhead = 6) {
  const startKey = todayISO().slice(0, 7);
  const keys = [];
  for (let i = 0; i < monthsAhead; i++) keys.push(shiftMonthKey(startKey, i));

  const perMonth = Object.fromEntries(keys.map((k) => [k, { installments: 0, recurring: 0 }]));

  (data.installments || []).forEach((inst) => {
    const monthlyAmt = round2(inst.totalAmount / inst.months);
    for (let idx = 0; idx < inst.months; idx++) {
      const paid = inst.paid && inst.paid[idx];
      if (paid) continue;
      const dueKey = monthKeyOf(addMonthsISO(inst.startDate, idx));
      if (perMonth[dueKey] !== undefined) perMonth[dueKey].installments += monthlyAmt;
    }
  });

  (data.recurring || []).forEach((r) => {
    if (!r.active) return;
    keys.forEach((k) => { perMonth[k].recurring += r.amount; });
  });

  const rows = keys.map((k) => ({
    month: k,
    installments: round2(perMonth[k].installments),
    recurring: round2(perMonth[k].recurring),
    totalCommitted: round2(perMonth[k].installments + perMonth[k].recurring)
  }));
  return { months: keys, rows, totalOverPeriod: round2(sum(rows.map((r) => r.totalCommitted))) };
}

function addMonthsISO(dateStr, n) {
  const d = new Date(dateStr);
  d.setMonth(d.getMonth() + n);
  return d.toISOString().slice(0, 10);
}

/* ============================== Davranış Analizi ============================== */

/**
 * Haftanın günlerine göre harcama alışkanlığı (hafta içi vs hafta sonu, en yüksek gün).
 */
function weekdaySpendingPattern(data, months = 6) {
  const keys = lastNMonthKeys(months);
  const txs = (data.transactions || []).filter((t) => t.type === 'gider' && keys.includes(monthKeyOf(t.date)));
  const dayNames = ['Pazar', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi'];
  const totals = new Array(7).fill(0);
  const counts = new Array(7).fill(0);
  txs.forEach((t) => {
    const day = new Date(t.date).getDay();
    totals[day] += t.amount;
    counts[day] += 1;
  });
  const rows = dayNames.map((name, i) => ({
    day: name,
    total: round2(totals[i]),
    count: counts[i],
    avg: round2(counts[i] ? totals[i] / counts[i] : 0)
  }));
  const weekday = round2(sum(rows.slice(1, 6).map((r) => r.total)));
  const weekend = round2(totals[0] + totals[6]);
  return { rows, weekdayTotal: weekday, weekendTotal: weekend };
}

/* ============================== En Yüksek İşlemler ============================== */

function topTransactions(data, type = 'gider', monthKey = null, limit = 10) {
  let txs = (data.transactions || []).filter((t) => t.type === type);
  if (monthKey) txs = txs.filter((t) => txInMonth(t, monthKey));
  return [...txs].sort((a, b) => b.amount - a.amount).slice(0, limit);
}

/* ============================== CSV Dışa Aktarım ============================== */

/** İşlem listesini CSV metnine çevirir (Excel'de doğrudan açılabilir, ; ayraçlı — TR yerel ayarı). */
function transactionsToCSV(transactions) {
  const header = ['Tarih', 'Tür', 'Kategori', 'Tutar', 'Not', 'KartId', 'TaksitNo', 'TaksitToplam'];
  const lines = [header.join(';')];
  for (const t of transactions) {
    const row = [
      t.date || '',
      t.type || '',
      (t.category || '').replace(/;/g, ','),
      String(t.amount ?? '').replace('.', ','),
      (t.note || '').replace(/;/g, ',').replace(/\n/g, ' '),
      t.cardId || '',
      t.installmentNo || '',
      t.installmentTotal || ''
    ];
    lines.push(row.join(';'));
  }
  return lines.join('\n');
}

/* ============================== Genel Rapor Paketi ============================== */

/**
 * Dashboard'un tek istekte ihtiyaç duyduğu her şeyi bir arada döner
 * (özet + trend + kategori kırılımı + bütçe + tahmin). Ağ isteği sayısını azaltır.
 */
function fullReportBundle(data, { monthKey = todayISO().slice(0, 7), trendMonths = 12, forecastMonths = 3 } = {}) {
  return {
    overview: monthOverview(data, monthKey),
    expenseByCategory: categoryBreakdown(data, 'gider', monthKey),
    incomeByCategory: categoryBreakdown(data, 'gelir', monthKey),
    trend: monthlyTrend(data, trendMonths),
    forecast: forecast(data, forecastMonths),
    budget: budgetVsActual(data, monthKey),
    cardUsage: cardUsageBreakdown(data, monthKey),
    cashflow: cashflowProjection(data, 6),
    weekdayPattern: weekdaySpendingPattern(data, 6),
    topExpenses: topTransactions(data, 'gider', monthKey, 5)
  };
}

module.exports = {
  // yardımcılar
  lastNMonthKeys,
  shiftMonthKey,
  round2,
  movingAverage,
  linearRegression,
  exponentialSmoothing,
  stdDev,
  median,
  pctChange,
  // raporlar
  monthOverview,
  categoryBreakdown,
  categoryTrend,
  categoryPivotTable,
  monthlyTrend,
  forecast,
  budgetVsActual,
  cardUsageBreakdown,
  cashflowProjection,
  weekdaySpendingPattern,
  topTransactions,
  transactionsToCSV,
  fullReportBundle
};
