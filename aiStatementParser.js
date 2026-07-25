// Bazı banka ekstresi PDF'leri (özellikle Akbank/Axess gibi) gömülü/özel font
// kodlaması kullanıyor; bu yüzden pdf-parse ile metin çıkarmaya çalışınca
// anlamsız karakterler çıkıyor ve statementParser.js'deki regex tabanlı
// ayrıştırıcı hiçbir işlem bulamıyor.
//
// Çözüm: PDF sayfalarını görsele (PNG) çevirip Claude'un görme (vision)
// yeteneğiyle tabloyu okutmak. Bu yöntem font kodlaması ne olursa olsun
// çalışır çünkü sayfanın görüntüsünü okuyor, gömülü metni değil.
//
// Bu modül sadece ANTHROPIC_API_KEY tanımlıysa devreye girer (server.js'de
// regex yöntemi başarısız olduğunda fallback olarak çağrılır).

const { pdf } = require('pdf-to-img');

const ANTHROPIC_MODEL = 'claude-sonnet-5';
const MAX_PAGES = 15; // aşırı uzun ekstrelerde maliyeti/isteği sınırlamak için

async function pdfBufferToImages(buffer) {
  const doc = await pdf(buffer, { scale: 2 });
  const images = [];
  for await (const page of doc) {
    images.push(page); // her biri bir PNG Buffer
    if (images.length >= MAX_PAGES) break;
  }
  return images;
}

const EXTRACTION_PROMPT = `Bu görsellerde bir Türk banka kredi kartı hesap özeti (ekstre) sayfaları var.
Aşağıdaki kurallara göre GÖRÜNEN İŞLEM SATIRLARINI çıkar:

- Her gerçek harcama/işlem satırı için: tarih, açıklama (mağaza/işlem adı) ve o işleme ait
  "Borç Tutarı" sütunundaki tutarı al.
- ŞUNLARI DAHIL ETME: "Önceki Dönem Hesap Özeti Bakiyesi", "İnternet Şb-Ödemeniz için Teşekkürler"
  gibi ödeme/bakiye satırları, "Toplam", "Genel Toplam", "Ara Toplam" satırları, faiz oranı
  tabloları, KKDF/BSMV notları, kampanya/reklam metinleri, sözleşme/mevzuat metinleri.
- Bir işlem taksitliyse ("3/2 taksit" gibi ibareler görürsen) sadece o ekstredeki dönem içi
  tutarı al (Borç Tutarı sütunu), "Kalan Borç/Taksit" sütununu değil.
- Tarihi YYYY-MM-DD formatına çevir (ekstrede DD/MM/YYYY olarak yazılıyor olabilir).
- Tutarı ondalık NOKTA ile, pozitif sayı olarak yaz (örn. "604,80 TL" -> 604.80).
- Açıklamayı ekstredeki haliyle kısa tut (şehir/ülke kodları gibi fazlalıkları kırpabilirsin).

SADECE aşağıdaki formatta GEÇERLİ bir JSON dizisi döndür, başka hiçbir açıklama, yorum veya
Markdown kod bloğu işareti (\`\`\`) EKLEME:

[{"date":"YYYY-MM-DD","description":"...","amount":123.45}]

Hiç işlem bulamazsan boş dizi [] döndür.`;

async function extractTransactionsWithAI(pdfBuffer, apiKey) {
  const images = await pdfBufferToImages(pdfBuffer);
  if (images.length === 0) return [];

  const content = [
    { type: 'text', text: EXTRACTION_PROMPT },
    ...images.map((img) => ({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: img.toString('base64') }
    }))
  ];

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 4000,
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

  // Model bazen yine de ```json ... ``` ile sarabiliyor; temizle.
  const cleaned = textBlock.text.trim().replace(/^```(json)?/i, '').replace(/```$/, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new Error('AI yanıtı geçerli JSON değildi: ' + cleaned.slice(0, 300));
  }

  if (!Array.isArray(parsed)) throw new Error('AI yanıtı beklenen dizi formatında değildi.');

  return parsed
    .filter((t) => t && t.date && typeof t.amount === 'number' && !isNaN(t.amount))
    .map((t) => ({
      date: t.date,
      description: String(t.description || '(açıklama yok)').trim(),
      amount: Math.abs(t.amount),
      type: 'gider'
    }));
}

module.exports = { extractTransactionsWithAI, pdfBufferToImages };
