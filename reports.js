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

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

/** İki sayısal seri arasındaki Pearson korelasyon katsayısı (-1..1). Yetersiz veri varsa null. */
function pearsonCorrelation(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 3) return null;
  const ma = mean(a.slice(0, n));
  const mb = mean(b.slice(0, n));
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const xa = a[i] - ma, xb = b[i] - mb;
    num += xa * xb; da += xa * xa; db += xb * xb;
  }
  if (da === 0 || db === 0) return null;
  return round2(num / Math.sqrt(da * db));
}

/** Box-Muller dönüşümüyle normal dağılımdan tek bir örnek üretir. */
function randomNormal(meanVal, sd) {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return meanVal + z * sd;
}

/** Gini katsayısı (0 = tam eşit dağılım, 1 = tüm tutar tek kalemde). */
function giniCoefficient(values) {
  const arr = values.filter((v) => v >= 0).sort((a, b) => a - b);
  const n = arr.length;
  if (n === 0) return 0;
  const total = sum(arr);
  if (total === 0) return 0;
  let cumulative = 0;
  for (let i = 0; i < n; i++) cumulative += (i + 1) * arr[i];
  return round2((2 * cumulative) / (n * total) - (n + 1) / n);
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

/* ============================== 1) Anomali Tespiti ============================== */

/**
 * Bir ayda, her kategorinin geçmiş ortalamasına göre kaç standart sapma uzakta
 * olduğunu (z-score) hesaplar. |z| >= zThreshold olan kategoriler "anomali" sayılır.
 * Geçmiş, incelenen ayı KAPSAMAZ (aksi halde ayın kendisi kendi ortalamasını çeker).
 */
function anomalyDetection(data, monthKey = todayISO().slice(0, 7), { historyMonths = 6, zThreshold = 2 } = {}) {
  const txs = (data.transactions || []).filter((t) => t.type === 'gider');
  const categories = [...new Set(txs.map((t) => t.category))];
  const historyKeys = lastNMonthKeys(historyMonths, shiftMonthKey(monthKey, -1));

  const anomalies = categories.map((category) => {
    const catTx = txs.filter((t) => t.category === category);
    const historySeries = historyKeys.map((k) => round2(sum(catTx.filter((t) => txInMonth(t, k)).map((t) => t.amount))));
    const currentValue = round2(sum(catTx.filter((t) => txInMonth(t, monthKey)).map((t) => t.amount)));
    const avg = mean(historySeries);
    const sd = stdDev(historySeries);
    if (sd === 0) return null;
    const z = round2((currentValue - avg) / sd);
    if (Math.abs(z) < zThreshold) return null;
    return {
      category, currentValue, historicalAverage: round2(avg), stdDev: round2(sd),
      zScore: z, direction: z > 0 ? 'yüksek' : 'düşük'
    };
  }).filter(Boolean).sort((a, b) => Math.abs(b.zScore) - Math.abs(a.zScore));

  return { month: monthKey, zThreshold, historyMonths, anomalies };
}

/**
 * Tek tek işlem bazında, kendi kategorisinin tipik tutarına göre olağandışı
 * (çok büyük/küçük) olanları bulur. Örn. "Market" kategorisinde her zaman
 * 200-400 TL harcarken bir gün 3000 TL'lik bir işlem olması gibi.
 */
function unusualTransactions(data, monthKey = todayISO().slice(0, 7), { zThreshold = 2, minSamples = 4 } = {}) {
  const txs = (data.transactions || []).filter((t) => t.type === 'gider');
  const byCategory = {};
  txs.forEach((t) => { (byCategory[t.category] = byCategory[t.category] || []).push(t); });

  const flagged = [];
  Object.entries(byCategory).forEach(([category, list]) => {
    const historical = list.filter((t) => t.date.slice(0, 7) < monthKey).map((t) => t.amount);
    if (historical.length < minSamples) return;
    const avg = mean(historical);
    const sd = stdDev(historical);
    if (sd === 0) return;
    list.filter((t) => txInMonth(t, monthKey)).forEach((t) => {
      const z = round2((t.amount - avg) / sd);
      if (Math.abs(z) >= zThreshold) {
        flagged.push({ id: t.id, date: t.date, category, amount: t.amount, note: t.note || '', zScore: z, typicalAmount: round2(avg) });
      }
    });
  });
  flagged.sort((a, b) => Math.abs(b.zScore) - Math.abs(a.zScore));
  return { month: monthKey, zThreshold, transactions: flagged };
}

/* ============================== 2) Finansal Sağlık Skoru ============================== */

/**
 * 0-100 arası tek bir skor: tasarruf oranı (35p) + bütçe disiplini (25p) +
 * gelir istikrarı (20p) + taahhüt yükü (20p). Dashboard'da tek bakışta
 * "bu ay finansal olarak ne durumdayım" sorusuna cevap verir.
 */
function financialHealthScore(data, monthKey = todayISO().slice(0, 7)) {
  const overview = monthOverview(data, monthKey);
  const budget = budgetVsActual(data, monthKey);
  const trend = monthlyTrend(data, 6);
  const cashflow = cashflowProjection(data, 1);

  // 1) Tasarruf oranı: %30 ve üstü tasarruf oranı tam puan sayılır
  const savingsScore = clamp((overview.savingsRate / 30) * 35, 0, 35);

  // 2) Bütçe disiplini: limiti olan kategorilerin ne kadarı aşılmamış
  const budgeted = budget.rows.filter((r) => r.limit > 0);
  const budgetScore = budgeted.length
    ? clamp((budgeted.filter((r) => r.status !== 'aşıldı').length / budgeted.length) * 25, 0, 25)
    : 25; // hiç bütçe tanımlanmamışsa nötr davranıp tam puan ver

  // 3) Gelir istikrarı: değişim katsayısı (CV = stdDev/ortalama) düşükse yüksek puan
  const incomeSeries = trend.rows.map((r) => r.income);
  const incomeMean = mean(incomeSeries);
  const incomeCV = incomeMean > 0 ? stdDev(incomeSeries) / incomeMean : 1;
  const stabilityScore = clamp((1 - incomeCV) * 20, 0, 20);

  // 4) Taahhüt yükü: taksit + tekrarlayan / gelir oranı düşükse yüksek puan
  const committed = cashflow.rows[0] ? cashflow.rows[0].totalCommitted : 0;
  const commitmentRatio = overview.income > 0 ? committed / overview.income : (committed > 0 ? 1 : 0);
  const commitmentScore = clamp((1 - commitmentRatio) * 20, 0, 20);

  const total = round2(savingsScore + budgetScore + stabilityScore + commitmentScore);
  const label = total >= 80 ? 'Mükemmel' : total >= 60 ? 'İyi' : total >= 40 ? 'Orta' : 'Zayıf';

  return {
    month: monthKey, score: total, label,
    breakdown: {
      savings: round2(savingsScore),
      budgetDiscipline: round2(budgetScore),
      incomeStability: round2(stabilityScore),
      commitmentLoad: round2(commitmentScore)
    }
  };
}

/* ============================== 3) Mevsimsellik ============================== */

/**
 * Her takvim ayının (Ocak, Şubat, ...) yıllar arası ortalamasını genel ortalamaya
 * oranlayıp bir "mevsimsel endeks" üretir. 100'ün üstü o ayın normalden yüksek,
 * altı düşük harcandığı anlamına gelir. Elde en az 1 yıl veri olmasa da çalışır,
 * ama anlamlı olması için birkaç yıl / birden çok yıl aynı ay tekrarı gerekir.
 */
function seasonalityIndex(data, type = 'gider') {
  const monthNames = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
  const txs = (data.transactions || []).filter((t) => t.type === type);
  const byMonthYear = {};
  txs.forEach((t) => {
    const key = t.date.slice(0, 7);
    byMonthYear[key] = (byMonthYear[key] || 0) + t.amount;
  });

  const byMonthOfYear = Array.from({ length: 12 }, () => []);
  Object.entries(byMonthYear).forEach(([key, total]) => {
    const m = Number(key.slice(5, 7)) - 1;
    byMonthOfYear[m].push(total);
  });

  const monthAverages = byMonthOfYear.map((arr) => (arr.length ? mean(arr) : 0));
  const observedAverages = monthAverages.filter((_, i) => byMonthOfYear[i].length);
  const overallAverage = observedAverages.length ? mean(observedAverages) : 0;

  const rows = monthNames.map((name, i) => ({
    month: name,
    monthIndex: i + 1,
    average: round2(monthAverages[i]),
    sampleCount: byMonthOfYear[i].length,
    seasonalIndex: overallAverage > 0 && byMonthOfYear[i].length ? round2((monthAverages[i] / overallAverage) * 100) : null
  }));

  return { type, overallAverage: round2(overallAverage), rows };
}

/* ============================== 4) Serbest Nakit Tahmini ============================== */

/**
 * Önümüzdeki N ay için "gerçekten harcanabilir" nakit tahmini: tahmini gelir -
 * taahhüt edilmiş çıkışlar (taksit+tekrarlayan, cashflowProjection'dan) -
 * tahmini değişken (taahhüt dışı) gider. Değişken gider, taksit/tekrarlayan
 * etiketi taşımayan geçmiş işlemlerden regresyon+üstel düzeltmeyle tahmin edilir.
 */
function freeCashForecast(data, monthsAhead = 3, historyMonths = 6) {
  const keys = lastNMonthKeys(historyMonths);
  const txs = data.transactions || [];
  const variableSeries = keys.map((k) => round2(sum(
    txs.filter((t) => t.type === 'gider' && txInMonth(t, k) && !t.recurringId && !t.installmentRef && !t.installmentGroupId)
      .map((t) => t.amount)
  )));
  const variableReg = linearRegression(variableSeries);
  const variableSmoothed = exponentialSmoothing(variableSeries, 0.5);

  const incomeForecast = forecast(data, monthsAhead, historyMonths);
  const cashflow = cashflowProjection(data, monthsAhead);

  const points = incomeForecast.points.map((p, i) => {
    const idx = variableSeries.length - 1 + (i + 1);
    const variableReg_ = variableReg.predict(idx);
    const projectedVariable = Math.max(0, round2((variableReg_ + variableSmoothed) / 2));
    const committed = cashflow.rows[i] ? cashflow.rows[i].totalCommitted : 0;
    return {
      month: p.month,
      projectedIncome: p.projectedIncome,
      committed: round2(committed),
      projectedVariableExpense: projectedVariable,
      freeCash: round2(p.projectedIncome - committed - projectedVariable)
    };
  });

  return { basedOnMonths: keys, points };
}

/* ============================== 5) Birikim Hedefi Simülasyonu (Monte Carlo) ============================== */

/**
 * Geçmiş aylık net (gelir-gider) serisinin ortalama+standart sapmasını kullanarak
 * binlerce rastgele gelecek senaryosu simüle eder ve hedefe hangi ayda, hangi
 * olasılıkla ulaşılacağını tahmin eder. Tek bir doğrusal tahmin çizgisinden farklı
 * olarak belirsizliği de (iyimser/kötümser senaryo) gösterir.
 */
function savingsGoalSimulation(data, targetAmount, { monthsHorizon = 24, historyMonths = 6, simulations = 2000, startingBalance = 0 } = {}) {
  const trend = monthlyTrend(data, historyMonths);
  const netSeries = trend.rows.map((r) => r.net);
  const avgNet = mean(netSeries);
  const sdNet = stdDev(netSeries) || Math.abs(avgNet) * 0.2 || 1; // yetersiz veri varsa küçük bir varyans varsay

  const reachMonths = [];
  let neverCount = 0;
  for (let s = 0; s < simulations; s++) {
    let balance = startingBalance;
    let reached = null;
    for (let m = 1; m <= monthsHorizon; m++) {
      balance += randomNormal(avgNet, sdNet);
      if (balance >= targetAmount) { reached = m; break; }
    }
    if (reached) reachMonths.push(reached); else neverCount++;
  }
  reachMonths.sort((a, b) => a - b);
  const percentile = (p) => (reachMonths.length ? reachMonths[Math.min(reachMonths.length - 1, Math.floor(reachMonths.length * p))] : null);

  return {
    targetAmount, monthsHorizon, simulations,
    avgMonthlyNet: round2(avgNet), monthlyNetStdDev: round2(sdNet),
    probabilityWithinHorizon: round2(((simulations - neverCount) / simulations) * 100),
    estimatedMonths: {
      optimistic_p25: percentile(0.25),
      median_p50: percentile(0.5),
      pessimistic_p75: percentile(0.75)
    }
  };
}

/* ============================== 6) Kategori Korelasyonu ============================== */

/**
 * En çok harcanan N kategori arasında, ay bazlı serilerin Pearson korelasyonunu
 * hesaplar. Örn. "Eğlence" arttığında "Market" düşüyor mu gibi ilişkileri ortaya
 * çıkarır. |r| > 0.5 genelde dikkate değer bir ilişki sayılır.
 */
function categoryCorrelation(data, { months = 12, type = 'gider', topN = 8 } = {}) {
  const keys = lastNMonthKeys(months);
  const txs = (data.transactions || []).filter((t) => t.type === type);
  const totalsByCategory = {};
  txs.forEach((t) => { totalsByCategory[t.category] = (totalsByCategory[t.category] || 0) + t.amount; });
  const categories = Object.entries(totalsByCategory).sort((a, b) => b[1] - a[1]).slice(0, topN).map(([c]) => c);

  const seriesByCategory = {};
  categories.forEach((c) => {
    seriesByCategory[c] = keys.map((k) => round2(sum(txs.filter((t) => t.category === c && txInMonth(t, k)).map((t) => t.amount))));
  });

  const pairs = [];
  for (let i = 0; i < categories.length; i++) {
    for (let j = i + 1; j < categories.length; j++) {
      const r = pearsonCorrelation(seriesByCategory[categories[i]], seriesByCategory[categories[j]]);
      if (r === null) continue;
      pairs.push({ categoryA: categories[i], categoryB: categories[j], correlation: r });
    }
  }
  pairs.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));
  return { months: keys, categories, pairs };
}

/* ============================== 7) Otomatik Tekrarlayan İşlem Tespiti ============================== */

/**
 * Geçmiş işlemlerden (henüz "Tekrarlayanlar"a elle eklenmemiş) benzer tutar +
 * aynı kategori + farklı aylarda tekrar eden kalıpları bulur; abonelik/kira gibi
 * kaçırılmış tekrarlayan kalemleri önerir. Basit bir tutar kümeleme yöntemi kullanır.
 */
function detectRecurringCandidates(data, { months = 6, minOccurrences = 3, amountTolerancePct = 15 } = {}) {
  const keys = lastNMonthKeys(months);
  const cutoff = keys[0] + '-01';
  const txs = (data.transactions || []).filter((t) =>
    t.date >= cutoff && !t.recurringId && !t.installmentRef && !t.installmentGroupId);
  const existingRecurringKeys = new Set((data.recurring || []).map((r) => `${r.type}|${r.category}`));

  const byGroup = {};
  txs.forEach((t) => { (byGroup[`${t.type}|${t.category}`] = byGroup[`${t.type}|${t.category}`] || []).push(t); });

  const candidates = [];
  Object.entries(byGroup).forEach(([key, list]) => {
    const [type, category] = key.split('|');
    if (list.length < minOccurrences) return;

    // Tutara göre basit kümeleme: sırala, birbirine yakın tutarları aynı kümede topla
    const sorted = [...list].sort((a, b) => a.amount - b.amount);
    const clusters = [];
    let current = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
      const prevAvg = mean(current.map((t) => t.amount));
      if (prevAvg > 0 && Math.abs(sorted[i].amount - prevAvg) / prevAvg * 100 <= amountTolerancePct) {
        current.push(sorted[i]);
      } else {
        clusters.push(current);
        current = [sorted[i]];
      }
    }
    clusters.push(current);

    clusters.filter((c) => c.length >= minOccurrences).forEach((cluster) => {
      const monthsSeen = new Set(cluster.map((t) => monthKeyOf(t.date)));
      if (monthsSeen.size < minOccurrences) return; // aynı ay içinde tekrar etmiş olabilir, farklı aylara yayılmalı
      candidates.push({
        type, category,
        occurrences: cluster.length,
        averageAmount: round2(mean(cluster.map((t) => t.amount))),
        typicalDayOfMonth: Math.round(mean(cluster.map((t) => Number(t.date.slice(8, 10))))),
        monthsSeen: [...monthsSeen].sort(),
        alreadyDefined: existingRecurringKeys.has(key),
        sampleNote: cluster[0].note || ''
      });
    });
  });

  candidates.sort((a, b) => b.occurrences - a.occurrences);
  return { historyMonths: months, candidates };
}

/* ============================== 8) Otomatik Bütçe Önerisi ============================== */

/**
 * Her kategori için son N ayın MEDYANINI (ortalamadan farklı olarak tek bir
 * uç değerden etkilenmez) baz alıp küçük bir marj ekleyerek bütçe limiti önerir.
 */
function suggestedBudgets(data, { months = 6, marginPct = 10 } = {}) {
  const keys = lastNMonthKeys(months);
  const txs = (data.transactions || []).filter((t) => t.type === 'gider');
  const categories = [...new Set(txs.map((t) => t.category))];
  const currentBudgets = data.budgets || {};

  const rows = categories.map((category) => {
    const series = keys.map((k) => round2(sum(txs.filter((t) => t.category === category && txInMonth(t, k)).map((t) => t.amount))));
    const med = round2(median(series));
    return {
      category,
      historicalMedian: med,
      suggestedLimit: round2(med * (1 + marginPct / 100)),
      currentLimit: currentBudgets[category] || 0,
      hasBudget: !!currentBudgets[category]
    };
  });
  rows.sort((a, b) => b.suggestedLimit - a.suggestedLimit);
  return { months: keys, marginPct, rows };
}

/* ============================== 9) Harcama Yoğunluğu (Gini) ============================== */

/**
 * Bir ayın harcamalarının kategoriler arasında ne kadar eşit/eşitsiz dağıldığını
 * ölçer (Gini katsayısı, 0=tam eşit, 1=tek kategoride toplanmış) + en büyük 2
 * kategorinin toplam içindeki payı (Pareto benzeri basit bir gösterge).
 */
function spendingConcentration(data, monthKey = todayISO().slice(0, 7)) {
  const breakdown = categoryBreakdown(data, 'gider', monthKey);
  const gini = giniCoefficient(breakdown.rows.map((r) => r.amount));
  const sorted = [...breakdown.rows].sort((a, b) => b.amount - a.amount);
  const top2Total = round2(sum(sorted.slice(0, 2).map((r) => r.amount)));
  const top2Pct = breakdown.total > 0 ? round2((top2Total / breakdown.total) * 100) : 0;
  const interpretation = gini >= 0.6 ? 'Harcamalar birkaç kategoride yoğunlaşmış'
    : gini >= 0.35 ? 'Orta düzey dağılım' : 'Harcamalar kategoriler arasında dengeli dağılmış';
  return { month: monthKey, categoryCount: breakdown.rows.length, giniCoefficient: gini, top2CategoriesPct: top2Pct, interpretation };
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
  pearsonCorrelation,
  giniCoefficient,
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
  fullReportBundle,
  // yeni matematiksel analizler
  anomalyDetection,
  unusualTransactions,
  financialHealthScore,
  seasonalityIndex,
  freeCashForecast,
  savingsGoalSimulation,
  categoryCorrelation,
  detectRecurringCandidates,
  suggestedBudgets,
  spendingConcentration
};
