// Bu modül, Telegram botunun AI destekli tüm özelliklerini tek yerde toplar:
//  - Serbest metinli mesajları ayrıştırma + soru/kayıt ayrımı (classifyAndParseMessage)
//  - Doğal dilde finans soruları cevaplama (answerFinanceQuestion)
//  - Belirsiz kategorileri akıllıca tahmin etme (guessCategoryWithAI)
//  - Fiş/fatura fotoğrafından işlem çıkarma (extractReceiptFromImage)
//  - Aylık harcama analizi/öngörü metni üretme (generateMonthlyInsights)
//
// Hepsi ANTHROPIC_API_KEY gerektirir; server.js bu anahtar yoksa bu fonksiyonları
// hiç çağırmaz ve eski (kural tabanlı) davranışa döner.

const ANTHROPIC_MODEL = 'claude-sonnet-5';

function stripJsonFence(s) {
  return s.trim().replace(/^```(json)?/i, '').replace(/```$/, '').trim();
}

async function callClaude(apiKey, { system, content, maxTokens = 1024 }) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content }]
    })
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Anthropic API hatası (${response.status}): ${errText.slice(0, 300)}`);
  }
  const data = await response.json();
  const textBlock = (data.content || []).find((b) => b.type === 'text');
  if (!textBlock) throw new Error('Anthropic yanıtında metin bulunamadı.');
  return textBlock.text.trim();
}

async function callClaudeJSON(apiKey, opts) {
  const text = await callClaude(apiKey, opts);
  try {
    return JSON.parse(stripJsonFence(text));
  } catch (e) {
    throw new Error('AI yanıtı geçerli JSON değildi: ' + text.slice(0, 300));
  }
}

/* ------------------------------------------------------------------ */
/* 1) Serbest metin ayrıştırma + soru/kayıt ayrımı                     */
/* ------------------------------------------------------------------ */
// Regex tabanlı parser.js bir tutar bulamadığında devreye girer.
// Mesajın (a) yeni bir gelir/gider kaydı mı yoksa (b) mevcut veriler
// hakkında bir soru mu olduğunu tek çağrıda belirler.
async function classifyAndParseMessage(text, { cards, categories, todayISO }, apiKey) {
  const cardNames = (cards || []).map((c) => c.name).join(', ') || '(kayıtlı kart yok)';
  const giderCats = (categories && categories.gider) || [];
  const gelirCats = (categories && categories.gelir) || [];

  const system = `Sen Türkçe konuşan bir kişisel gelir/gider takip Telegram botunun ayrıştırma modülüsün.
Kullanıcıdan gelen serbest metni analiz et. İki ihtimal var:
1) Kullanıcı yeni bir gelir/gider kaydı bildiriyor (harcama yaptım, para geldi, ödeme yaptım vb.)
2) Kullanıcı mevcut verileri hakkında bir SORU soruyor (ne kadar harcadım, hangi kategori, bakiyem ne vb.)
Bunlardan hiçbirine uymuyorsa "unclear" olarak işaretle.

Bugünün tarihi: ${todayISO}. Kayıtlı kartlar: ${cardNames}.
Gider kategorileri: ${giderCats.join(', ')}.
Gelir kategorileri: ${gelirCats.join(', ')}.

SADECE aşağıdaki JSON formatında yanıt ver, başka hiçbir metin, açıklama veya kod bloğu işareti ekleme:
{
  "kind": "transaction" | "question" | "unclear",
  "transaction": {
    "type": "gelir" | "gider",
    "amount": number,
    "category": "(yukarıdaki listeden birebir bir kategori adı)",
    "date": "YYYY-MM-DD" | null,
    "cardName": "(yukarıdaki kart isimlerinden biri, yoksa null)" | null,
    "installments": number,
    "description": "kısa açıklama"
  } | null
}
"transaction" alanını sadece kind="transaction" ise doldur, diğer durumlarda null bırak.
Tarih ifadesi yoksa "date": null bırak (bugün varsayılacak).`;

  return callClaudeJSON(apiKey, { system, content: text, maxTokens: 500 });
}

/* ------------------------------------------------------------------ */
/* 2) Doğal dil ile veri sorgulama                                     */
/* ------------------------------------------------------------------ */
async function answerFinanceQuestion(question, data, apiKey) {
  const txs = (data.transactions || []).slice(-800); // token sınırı için son ~800 kayıt yeterli
  const compact = txs.map((t) => ({
    t: t.type, a: t.amount, c: t.category, d: t.date, n: t.note
  }));

  const system = `Sen kullanıcının kişisel gelir/gider verilerine erişimi olan bir Türkçe finans asistanısın.
Aşağıda JSON formatında kullanıcının işlem geçmişi (t: tür, a: tutar TL, c: kategori, d: tarih, n: not),
kayıtlı bütçe limitleri ve kartları var. Kullanıcının sorusunu SADECE bu verilere dayanarak,
net, kısa (en fazla 5-6 satır) ve somut rakamlarla Türkçe cevapla. Veri yoksa ya da soru
cevaplanamıyorsa bunu açıkça söyle, veri uydurma.

İşlemler: ${JSON.stringify(compact)}
Bütçe limitleri: ${JSON.stringify(data.budgets || {})}
Kartlar: ${JSON.stringify((data.cards || []).map((c) => ({ name: c.name, bank: c.bank })))}`;

  return callClaude(apiKey, { system, content: question, maxTokens: 700 });
}

/* ------------------------------------------------------------------ */
/* 3) Belirsiz kategori tahmini                                        */
/* ------------------------------------------------------------------ */
// Kural tabanlı guessCategory() sonucu "Diğer" (bilinmeyen) çıktığında çağrılır.
async function guessCategoryWithAI(description, type, categoryList, apiKey) {
  const system = `Aşağıdaki işlem açıklamasına bakarak, verilen listeden EN UYGUN kategoriyi seç.
Kategori listesi: ${categoryList.join(', ')}.
SADECE listedeki kategori adını birebir yaz, başka hiçbir açıklama, noktalama veya kod bloğu ekleme.`;

  const result = await callClaude(apiKey, { system, content: `İşlem türü: ${type}\nAçıklama: ${description}`, maxTokens: 30 });
  const cleaned = result.trim();
  return categoryList.includes(cleaned) ? cleaned : null;
}

/* ------------------------------------------------------------------ */
/* 4) Fiş / fatura fotoğrafından işlem çıkarma                         */
/* ------------------------------------------------------------------ */
async function extractReceiptFromImage(imageBuffer, mediaType, { cards, categories, todayISO }, apiKey) {
  const cardNames = (cards || []).map((c) => c.name).join(', ') || '(kayıtlı kart yok)';
  const giderCats = (categories && categories.gider) || [];

  const system = `Bu görsel bir market fişi, fatura veya alışveriş makbuzu. Bilgileri çıkar.
Bugünün tarihi: ${todayISO} (fişte tarih yoksa bunu kullan).
Kayıtlı kartlar: ${cardNames}. Gider kategorileri: ${giderCats.join(', ')}.

SADECE aşağıdaki JSON formatında yanıt ver, başka hiçbir açıklama veya kod bloğu ekleme:
{
  "amount": number,
  "description": "mağaza/işlem adı",
  "date": "YYYY-MM-DD",
  "category": "(yukarıdaki gider kategorilerinden biri)",
  "cardName": "(fişte kart bilgisi varsa yukarıdaki isimlerden biri, yoksa null)"
}
Fiş okunamıyorsa veya bir makbuz değilse: {"amount": null}`;

  const content = [
    { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBuffer.toString('base64') } },
    { type: 'text', text: 'Bu fişteki/faturadaki bilgileri JSON olarak çıkar.' }
  ];

  return callClaudeJSON(apiKey, { system, content, maxTokens: 400 });
}

/* ------------------------------------------------------------------ */
/* 5) Aylık akıllı özet / öngörü                                       */
/* ------------------------------------------------------------------ */
async function generateMonthlyInsights(summary, apiKey) {
  const system = `Sen bir Türkçe kişisel finans koçusun. Aşağıdaki JSON verilen kullanıcının bu ay ve
geçen ayki kategori bazlı harcama/gelir verilerine, bütçe limitlerine bakarak KISA (en fazla 6-7 satır),
somut rakamlar içeren, 1-2 pratik öneri barındıran bir Türkçe analiz yaz. Emoji kullanabilirsin ama abartma.
Veri çok azsa (örn. az sayıda işlem) bunu da belirt, abartılı yorum yapma.`;

  return callClaude(apiKey, { system, content: JSON.stringify(summary), maxTokens: 600 });
}

module.exports = {
  classifyAndParseMessage,
  answerFinanceQuestion,
  guessCategoryWithAI,
  extractReceiptFromImage,
  generateMonthlyInsights
};
