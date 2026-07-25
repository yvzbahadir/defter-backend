# Telegram'dan Otomatik Gelir/Gider Kaydı — Kurulum Rehberi

Bu paket, Telegram'a yazdığınız mesajları ("Akbank kredi kartı ile 3400tl alışveriş
yaptım 2 taksit olarak" gibi) otomatik olarak Defter uygulamanıza işler.

Toplam 3 adım var: **(1) Telegram bot oluşturma, (2) ücretsiz veritabanı (Neon),
(3) ücretsiz sunucu (Render).** Hepsi ücretsiz ve kredi kartı istemiyor.

---

## 1) Telegram Bot Oluşturma (BotFather)

1. Telegram'da **@BotFather** hesabını açın (arama kutusuna yazıp bulun).
2. `/newbot` yazıp gönderin.
3. Botunuza bir isim verin (örn: `Defterim`).
4. Botunuza bir kullanıcı adı verin — sonu `bot` ile bitmeli (örn: `defterim_bot`).
5. BotFather size şuna benzer bir **token** verecek:
   `123456789:AAExampleTokenHereXXXXXXXXXXXXXXXXXXX`
   Bunu bir yere kaydedin — `.env` dosyasında `TELEGRAM_BOT_TOKEN` olarak kullanacağız.
6. Şimdi kendi **chat ID**'nizi öğrenmemiz lazım (böylece bot sadece sizi dinler,
   başkası mesaj atsa bile işlem kaydetmez):
   - Telegram'da **@userinfobot** adlı botu açıp `/start` yazın.
   - Size dönen "Id: 123456789" gibi sayıyı not edin. Bu, `TELEGRAM_ALLOWED_CHAT_ID`
     olacak.
7. Oluşturduğunuz botu (örn. `@defterim_bot`) açıp `/start` yazarak sohbeti başlatın
   (webhook kurulana kadar bir şey olmayacak, normal).

---

## 2) Ücretsiz Veritabanı (Neon)

Render'ın ücretsiz veritabanı 30 gün sonra siliniyor, bu yüzden kalıcı ve tamamen
ücretsiz olan **Neon**'u kullanıyoruz.

1. https://neon.tech adresine gidip ücretsiz hesap açın (GitHub ile giriş yapabilirsiniz).
2. Yeni bir proje oluşturun (varsayılan ayarlar yeterli).
3. Proje açıldığında size bir **connection string** verilecek, şuna benzer:
   `postgresql://kullanici:sifre@ep-xxxx.neon.tech/neondb?sslmode=require`
4. Bu adresi kopyalayın — `.env` dosyasında `DATABASE_URL` olarak kullanacağız.

---

## 3) Kodu Render'a Deploy Etme

1. Bu klasördeki kodu bir GitHub reposuna yükleyin (GitHub Desktop veya
   `git init && git add . && git commit -m "ilk" && git push` ile).
2. https://render.com adresine gidip ücretsiz hesap açın (kredi kartı istemez).
3. **New +** → **Web Service** seçin, GitHub reponuzu bağlayın.
4. Ayarlar:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
5. **Environment** sekmesinden şu değişkenleri ekleyin:
   - `DATABASE_URL` → Neon'dan aldığınız connection string
   - `TELEGRAM_BOT_TOKEN` → BotFather'dan aldığınız token
   - `TELEGRAM_ALLOWED_CHAT_ID` → @userinfobot'tan aldığınız ID
   - `PUBLIC_URL` → Render size bir URL verecek, örn: `https://defter-backend.onrender.com`
     (deploy ilk kez bittikten sonra bu adresi görüp geri gelip bu değişkeni
     eklemeniz, sonra "Manual Deploy" ile yeniden başlatmanız gerekir)
6. **Create Web Service** deyip deploy'un bitmesini bekleyin (birkaç dakika sürer).
7. Loglarda `Telegram webhook ayarlandı: ...` yazısını görürseniz bot hazırdır.

> Not: Render'ın ücretsiz servisi 15 dakika kullanılmazsa "uyur"; Telegram'dan mesaj
> attığınızda ilk yanıt ~30-60 saniye gecikebilir, bu normaldir.

---

## 4) Web Arayüzünü Bağlama

`public/index.html` dosyasını açın, en üstteki script bloğunda şu satırı bulun:

```js
const API_BASE = '';
```

Bunu Render'ın size verdiği adresle değiştirin:

```js
const API_BASE = 'https://defter-backend.onrender.com';
```

Kaydedip bu HTML dosyasını nasıl kullanıyorsanız öyle açın (kendi bilgisayarınızda
çift tıklayarak, ya da isterseniz Render'daki `public` klasörü zaten statik olarak
sunuluyor — `https://defter-backend.onrender.com/index.html` adresinden de
açabilirsiniz).

---

## 5) Test Etme

Botunuza (Telegram'da) şunu yazın:

```
Akbank kredi kartı ile 3400tl alışveriş yaptım 2 taksit olarak
```

Bot size "✅ Gider kaydedildi: 3400 TL · Akbank ... · 2 taksit" gibi bir yanıt
vermeli. Web arayüzünü açtığınızda (veya en fazla 15 saniye içinde otomatik
yenilendiğinde) işlemi Taksitler/Kartlar sayfasında göreceksiniz.

**Önemli:** Bot, kartı isimle eşleştiriyor — yani önce web arayüzünden "Akbank"
adında (bank alanına "Akbank" yazılmış) bir kart eklemiş olmanız gerekir. Kart
bulunamazsa bot size kayıtlı kartların listesini gönderir.

### Anlaşılan mesaj örnekleri
- `Akbank kredi kartı ile 3400tl alışveriş yaptım 2 taksit olarak` → 2 taksitli gider
- `Migros'ta nakit 250 TL harcadım` → peşin, kartsız gider
- `Maaş olarak 45000 TL geldi` → gelir

Ayrıştırıcı basit kural tabanlıdır (`parser.js`); istediğiniz zaman yeni kelimeler
veya kalıplar ekleyebiliriz (örn. kategori tahmini, tarih ifadeleri gibi).

### Tarih ifadeleri
Mesajlarınızda tarih belirtebilirsiniz, belirtmezseniz bugün kullanılır:
`dün`, `3 gün önce`, `geçen hafta`, `geçen ay`, `15 Temmuz`, `15.07.2026`, `geçen pazartesi` gibi.

### PDF ekstre okuma (bazı bankalarda görsel/AI destekli)
Gönderdiğiniz PDF ekstre, önce hızlı ve ücretsiz bir yöntemle (metin çıkarma + kural
tabanlı ayrıştırma) okunmaya çalışılır. **Bazı bankalar (örn. Akbank/Axess) PDF'lerinde
özel font kodlaması kullanıyor**, bu durumda standart metin çıkarma anlamsız karakterler
üretiyor ve hiçbir işlem bulunamıyor. Bu durumda, `.env` dosyanızda `ANTHROPIC_API_KEY`
tanımlıysa bot otomatik olarak PDF sayfalarını görsele çevirip Claude'un görme (vision)
yeteneğiyle tabloyu okur — bu yöntem font kodlamasından etkilenmez. Anahtarı
https://console.anthropic.com adresinden alabilirsiniz (kullandığınız kadar ödersiniz,
birkaç sayfalık bir ekstre okumak birkaç kuruş tutar).

Tespit edilen işlemler, hangi aya ait olduklarına göre gruplanıp (alt toplamlarla)
gösterilir — taksitli harcamaların gelecek ay ödemeleri varsa bunlar ayrı ay
başlığı altında listelenir.

### ✅ İşlem onayı
Artık her kayıt (metin, fiş fotoğrafı, PDF ekstre) önce bir ÖNİZLEME olarak gösterilir,
hiçbir şey otomatik kaydedilmez. Onaylamak için `onayla` / `evet` / `kaydet`, iptal
için `iptal` / `hayır` yazmanız gerekir.

### 🧾 Fiş / fatura fotoğrafı okuma (ANTHROPIC_API_KEY gerekir)
Bir market fişinin veya faturanın fotoğrafını doğrudan bota gönderin (PDF değil, fotoğraf
olarak). Bot tutarı, mağaza adını, tarihi ve kategoriyi otomatik okuyup önizleme gösterir.

### 🗣️ Serbest metin ayrıştırma + doğal dil ile soru sorma (ANTHROPIC_API_KEY gerekir)
Kural tabanlı ayrıştırıcı (`parser.js`) bir tutar bulamazsa, mesaj otomatik olarak Claude'a
gönderilir. Claude iki şeyi ayırt eder:
- **Yeni bir kayıt** ise (örn. "geçen hafta Ecem'e verdiğim borcu bu ay geri aldım, 500 lira")
  → normal önizleme + onay akışına girer.
- **Verileriniz hakkında bir soru** ise (örn. "bu ay markete ne kadar harcadım",
  "hangi kategoriye en çok para gidiyor") → mevcut kayıtlarınıza bakıp Türkçe, somut
  rakamlarla cevap verir.

### 🎯 Akıllı kategori tahmini (ANTHROPIC_API_KEY gerekir)
Kural tabanlı kategori eşleştirmesi (`CATEGORY_SYNONYMS`) bilmediği bir işlem için "Diğer"
döndürdüğünde, bot ek olarak Claude'a bu açıklamaya en uygun kategoriyi sorar (örn. "Getir",
"Trendyol" gibi kural listesinde olmayan işlemler için).

### 📈 Aylık AI analizi
İki şekilde çalışır:
- **İsteğe bağlı:** Telegram'a `analiz` veya `ai özet` yazın, bu ayki harcamalarınızın
  kısa bir AI değerlendirmesini (geçen ayla kıyaslama, bütçe durumu, 1-2 öneri) alın.
- **Otomatik:** Ayın ilk 3 günü içinde botla herhangi bir şekilde etkileşime girip
  (örn. `özet` yazarak) o ayın verisi varsa, bot bir kereliğine kendiliğinden bir
  önceki ayın kısa analizini de gönderir.

### 🔔 Proaktif bildirimler: tekrarlayan işlemler, taksit hatırlatması, bütçe aşımı
Bu üç şey normalde ancak web arayüzünü açtığınızda veya bota bir şey yazdığınızda kontrol
edilir. **Gerçekten proaktif** (siz hiçbir şey yapmadan) bildirim almak için, backend'de
`/cron/daily-check?secret=...` adında bir endpoint var; bunu dışarıdan günde bir kez
tetiklemeniz gerekiyor (Render'ın ücretsiz planı kendiliğinden zamanlanmış görev
çalıştırmıyor). Ücretsiz bir seçenek:

1. `.env` / Render environment'a rastgele, tahmin edilemeyen bir `CRON_SECRET` değeri ekleyin
   (örn. `openssl rand -hex 16` ile üretebilirsiniz)
2. https://cron-job.org üzerinde ücretsiz hesap açın
3. Yeni bir cron job oluşturun:
   - URL: `https://<render-url-adresiniz>/cron/daily-check?secret=<CRON_SECRET değeriniz>`
   - Sıklık: günde 1 kez (örn. her sabah 09:00)
4. Kaydedin — artık her gün o saatte backend'iniz uyanır (Render uykudaysa), o gün için
   tekrarlayan işlemleri oluşturur, 3 gün içinde vadesi gelen taksitleri ve bütçe aşımlarını
   kontrol edip Telegram'dan (`TELEGRAM_ALLOWED_CHAT_ID`'ye) size mesaj atar.

Bu adımı atlarsanız sorun değil — tekrarlayan işlemler ve bütçe uyarıları yine de web
arayüzünü her açtığınızda ve (bütçe uyarısı için) her Telegram işlemi onayladığınızda
kontrol edilir; sadece "siz hiçbir şey yapmasanız bile günlük otomatik bildirim" kısmı
bu cron kurulumuna bağlı.

### Maliyet notu
Yukarıdaki AI özelliklerinin hepsi aynı `ANTHROPIC_API_KEY`'i kullanır ve kullandığınız
kadar ödersiniz. Kişisel kullanım için (günde birkaç mesaj/fiş) aylık maliyet muhtemelen
birkaç TL'yi geçmez.
