# Scalvin — tam repo ve proje incelemesi

**İnceleme tarihi:** 4 Eylül 2026  
**İncelenen repo:** [cerncaycisi/scalvin](https://github.com/cerncaycisi/scalvin)  
**Ana referans:** main, `e59afe5cdd6b58f4b14f7d6827520169e2e96b79`  
**Güncel çalışma:** PR #13, `claude/roadmap-review-3y93ex`, `07cb94e484829610bc8f8fc689b07e8b1176e805`

## 1. Uzman kanaati

**Scalvin devam etmeye değer bir proje. Veri sahipliği, süreklilik belleği ve denetlenebilir işlemler tarafında ciddi bir mühendislik omurgası var. Buna karşılık, 4 Eylül 2026 itibarıyla genel kullanıma hazır bir duygusal destek ürünü veya tamamlanmış güvenlik sınırı olan bir çalışma zamanı sayılmaz. En doğru tanım: güçlü veri mekanikleri olan, önemli doğrulama ve kullanılabilirlik borcu taşıyan ileri bir geliştirme önizlemesi.**

Kodun en değerli tarafı, kullanıcının hayatına ilişkin kayıtları rastgele dosya düzenlemelerine bırakmaması: izin, kaynak, düzeltme, saklama, silme, yedekleme ve oturum yaşam döngüsünü açık işlemlere dönüştürmeye çalışması. Bu yaklaşım ürünün esas farklılaşma alanı olabilir.

En büyük tehlike ise belge, test ve kontrol sayısının tamamlanmış bir güvenlik veya fayda kanıtı gibi algılanması. İzin metni insan onayını; HMAC imzası kaynak doğruluğunu; istemci ayarı fiilen uygulanmış izolasyonu; yüzlerce birim testi iyi bir destek konuşmasını tek başına kanıtlamıyor. Scalvin bu ayrımların bir kısmını zaten dürüstçe belgeliyor. Ancak ürünün ilerlemesi için bu açıkların kapanması gerekiyor.

Benim öncelik sıram yeni persona, yeni yaklaşım veya yeni operasyon katmanı eklemek olmazdı. Önce bugün bozulan güvenlik yardımcı mekanizmasını düzeltir; bir istemcide baştan sona güvenilir ana akışı tamamlardım. Sonra gerçek konuşma ve kullanım kanıtı toplardım.

Bu rapor kod, yerel deneyler, depo yönetimi ve ürün tasarımı değerlendirmesidir. Klinik etkililik incelemesi yapılmadı; canlı kullanıcı verisi veya gerçek model sağlayıcısına gönderilmiş oturum kullanılmadı.

## 2. Kapsam, yöntem ve kanıt sınırı

Ana dalın dosya envanteri, mimarisi, kurulum ve paketleme yolu, MCP aracı, dosya işlemleri, bellek ve kaynak yaşam döngüsü, güvenlik hook'u, istemci başlatıcıları, yedekleme, yayın kapıları ve değerlendirme altyapısı incelendi. Kritik akışlarda satır düzeyinde okuma yapıldı. Persona ve yaklaşım dosyalarının tamamı için klinik yeterlilik onayı verilmedi.

Yerel doğrulama Linux, Node **24.19.0**, npm **11.9.0**, Python **3.12.13** ortamında gerçekleştirildi. Ana dalın tam test paketi çalıştırıldı. PR #13 ayrı çalışma kopyasında incelendi; statik kontrolleri ve değişen alanlara ait hedefli testleri çalıştırıldı. PR dalında ikinci bir tam test koşusu yapılmadı.

Ek olarak, tamamen sentetik ve sonrasında temizlenen çalışma alanlarında:

- Gerçek hook girişinden eski acil kaynak kaydının etkisi ölçüldü.
- MCP üzerinden gerçek bellek düzeltmesi yapılarak sonuçtaki köken alanları incelendi.
- Kaynak okuma çağrısı yapılmadan öneri gönderimi denendi.
- Çıktı sınırını aşan, SIGTERM sinyalini görmezden gelen zararsız bir alt sürecin yaşamı izlendi.
- İlgisiz ortam değişkeninin alt süreç ortamında kalıp kalmadığı bir işaret değeriyle doğrulandı.
- Arşiv boyutu büyürken tek kayıtla sınırlı okuma ve bellek duraklatma işlemlerinin maliyeti ölçüldü.

Gerçek istemcilerin etkileşimli onay pencereleri, üretimde ağ erişimi, işletim sistemi seviyesinde tam izolasyon, güç kesintisinden kurtarma, penetrasyon testi ve bağımsız klinik değerlendirme bu çalışmanın kanıtladığı alanlar değildir.

**Önem dereceleri:** P1, yaygın veya hassas kullanımdan önce ele alınması gereken sorun/sürüm engelidir. P2, güvenilirlik, ürün doğruluğu, bakım veya ölçek açısından planlı olarak kapatılması gereken borçtur. “Doğrulandı” yerel deney veya doğrudan güncel depo gözlemi; “sınır” açıkça eksik güvence; “yorum” mühendislik/ürün değerlendirmesidir. Uzaktan kod çalıştırma veya gerçek veri sızıntısı doğrulandığı iddia edilmiyor.

## 3. Reponun bugünkü fotoğrafı

| Alan | Gözlem |
|---|---|
| Ana dal | 24 Temmuz 2026 tarihli `e59afe5` |
| Son incelenen aktif çalışma | 1 Eylül 2026 tarihli PR #13, `07cb94e` |
| Ana dal dosya envanteri | 253 izlenen dosya |
| CLI kodu | 31 kod dosyası, yaklaşık 21.921 satır |
| Test kodu | 64 kod dosyası, yaklaşık 15.669 satır |
| Büyük merkez dosya | `cli/operations.js`: 4.764 satır |
| MCP yüzeyi | 13 adlandırılmış araç |
| Persona / yaklaşım | 9 persona, 13 yaklaşım dosyası |
| Harici npm bağımlılığı | package-lock içinde bağımlılık ağacı yok |
| Paket kimliği | `1.0.0`, fakat `private: true`; geliştirme önizlemesi |
| Yayın | GitHub Releases sorgusunda yayın bulunmadı |
| Açık iş | 6 açık PR: 5 Dependabot + PR #13; ayrıca issue #12 |
| Lisans/köken | MIT; NOTICE içinde upstream kredi mevcut |

Bu sayılar ürün başarısı veya test kapsam yüzdesi değildir. Repo küçük bir istem derlemesinin ötesine geçmiş; buna rağmen kod hacmi, kullanıcıda değer ürettiğini göstermiyor. Ana dalın Temmuz'da kalması da tek başına projenin terk edildiği anlamına gelmiyor: Eylül başında aktif bakım dalı var.

Paket sürümünün `1.0.0` olması “kararlı 1.0 yayımlandı” şeklinde yorumlanmamalı. Manifest ve yayın belgeleri geliştirme durumunu daha açık anlatıyor. Kullanıcıya görünen sürüm adlandırmasının bu önizleme durumuyla daha uyumlu olması faydalı olur.

Kaynaklar: [package.json](https://github.com/cerncaycisi/scalvin/blob/e59afe5cdd6b58f4b14f7d6827520169e2e96b79/package.json), [manifest](https://github.com/cerncaycisi/scalvin/blob/e59afe5cdd6b58f4b14f7d6827520169e2e96b79/manifest.json), [PR #13](https://github.com/cerncaycisi/scalvin/pull/13), [NOTICE](https://github.com/cerncaycisi/scalvin/blob/e59afe5cdd6b58f4b14f7d6827520169e2e96b79/NOTICE.md).

## 4. Mimari: sağlam olan taraflar

Akışın özü şu: sürümü sabitlenmiş dağıtım, özel çalışma alanı üretir; konuşma istemcisi mümkün olduğunca sınırlı MCP işlemleri kullanır; bellek değişiklikleri doğrulama ve işlem planlarından geçer; ham dış kaynaklar ayrı işçide öneriye dönüştürülür; önerinin kalıcı belleğe geçişi ayrıca kontrol edilir.

### 4.1 Dosya güvenliği ve işlem disiplini

`fs-safe.js` yüzeysel bir “dosyayı yaz” yardımcı modülü değil. Sembolik bağlantı ve özel dosya kontrolleri, dosya tanıtıcısı üzerinden okuma, inode/device karşılaştırmaları, hardlink denetimi, özel izinler, geçici dosya ve atomik yeniden adlandırma, çalışma alanı özeti ve etkinleştirme kontrolleri içeriyor.

Silme ve etkinleştirme sonrası kısmi başarının kullanıcıya doğru bildirilmesi de dikkate değer. Özellikle “aktif alan güncellendi ama geri dönüş kopyası hâlâ duruyor” ayrımının modellenmesi doğru bir güven yaklaşımı.

Bunun sınırı: işbirlikçi kilit ve dosya kontrolleri bütün yerel saldırganları dışlayan bir işletim sistemi sınırı değildir. İstisna yakalama/geri alma testleri de süreç zorla öldürüldüğünde veya güç kesildiğinde kurtarmanın tamamını kanıtlamaz.

Kaynak: [dosya işlemleri ve etkinleştirme](https://github.com/cerncaycisi/scalvin/blob/e59afe5cdd6b58f4b14f7d6827520169e2e96b79/cli/lib/fs-safe.js).

### 4.2 Belleğin kökenini veri modeline koyması

Bir ifadenin kaynağı, ilk görülme zamanı, canlı kullanıcı doğrulaması, revizyonu, tartışmalı durumu ve gözden geçirme ihtiyacı ayrı alanlarda tutuluyor. İçe aktarılan metin ile güncel kullanıcı doğrulamasının farklı otoriteler sayılması doğru.

Bu, Scalvin'in ürün çekirdeği olmaya aday. İyi bir süreklilik sistemi çok şey hatırlayan sistemden ziyade **neyi, kimin söylediğini, ne zaman doğrulandığını ve artık kullanılıp kullanılmaması gerektiğini bilen sistemdir.** Aşağıdaki düzeltme hatası da tam bu nedenle önemlidir.

Kaynak: [bellek kökeni protokolü](https://github.com/cerncaycisi/scalvin/blob/e59afe5cdd6b58f4b14f7d6827520169e2e96b79/runtime/MEMORY-PROVENANCE.md).

### 4.3 İzin, saklama ve yedekleme

Bellek, transkript, kaynak, kullanım kayıtları ve bağlam grafiği gibi alanların ayrı kontrol edilmesi; geçmişi sessizce doldurmama ilkesi; duraklatma ve mühürleme ayrımı; saklama ve silme işlemlerinin açık olması güçlü.

Şifreli yedekleme AES-256-GCM ve scrypt kullanıyor; v3 profili N=131072, r=8, p=1. Özel izinler, anahtarın ayrı tutulması ve şifreli yük içindeki metadata yaklaşımı olumlu. Bu, bağımsız kriptografik denetim yapıldığı anlamına gelmez; özel yedek biçiminin ve kurtarma yolunun ayrıca incelenmesi değerli olur.

**Yerel çalışma alanının kendisi düz metin dosyalar içerir. Şifreli yedek özelliği, çalışan tüm alanın şifreli olduğu anlamına gelmez.** Ayrıca Scalvin'in transkript kaydını kapatmak, model istemcisinin kendi oturum kaydını otomatik olarak kapatmaz.

Kaynaklar: [veri ve izin protokolü](https://github.com/cerncaycisi/scalvin/blob/e59afe5cdd6b58f4b14f7d6827520169e2e96b79/runtime/DATA-AND-CONSENT.md), [yedek kriptografisi](https://github.com/cerncaycisi/scalvin/blob/e59afe5cdd6b58f4b14f7d6827520169e2e96b79/cli/lib/backup-crypto.js), [Claude Code oturum kayıtları](https://code.claude.com/docs/en/sessions).

### 4.4 Tedarik zinciri ve dürüst sürüm engelleri

Bağımlılıksız çalışma zamanı tedarik zinciri yüzeyini azaltıyor. Manifest doğrulaması, açık paket envanteri, sabit commit referansları, SHA ile sabitlenmiş GitHub Actions, CodeQL, platform matrisi ve yayın kanıtı tasarımı ciddi emek gösteriyor.

Özellikle hazır olmayan sınırları `false` olarak raporlaması ve kararlı yayını engellemesi olumlu. Bu, gizlenecek bir başarısızlık değil; tamamlanması gereken işi görünür tutan doğru davranış. Ancak belgelenen denetimlerin depo sunucusunda uygulanması ve gerçek aday üzerinde kanıtlanması hâlâ gerekiyor.

## 5. Bulguların özeti

| No | Öncelik | Bulgu | Kanıt türü |
|---|---|---|---|
| F1 | P1 | Süresi dolan acil kaynak kaydı gerçek mekanik taramayı tamamen durduruyor | Gerçek hook girişinde doğrulandı |
| F2 | P1 | Sert özel veri sınırı ve bağımsız insan onayı hâlâ istemci davranışına bağlı | Kod + self-test + yayın kapısı |
| F3 | P1 | main koruması kapalı; uygulanmış ruleset bulunmuyor | Güncel GitHub API gözlemi |
| F4 | P2 | Bellek düzeltmesi canlı doğrulama zamanını ve inceleme durumunu yenilemiyor | Gerçek MCP mutasyonunda doğrulandı |
| F5 | P2 | Çıktı sınırını aşan alt süreç SIGTERM'i reddederse hayatta kalabiliyor | Kontrollü süreç deneyi |
| F6 | P2 | Kaynak okunmadan kaynakla ilişkili imzalı öneri gönderilebiliyor | İşçi araç yüzeyinde doğrulandı |
| F7 | P2 | Alt süreç ortamı yalnızca SCALVIN_ önekini temizliyor | Kod + sentetik işaret deneyi |
| F8 | P2 | Küçük bellek işlemleri tüm çalışma alanı boyutundan etkileniyor | Kod + mikro ölçüm |
| F9 | P2 | Başlangıç talimat yükü büyük; kullanıcı değeri/maliyet karşılığı ölçülmemiş | Dosya ölçümü + ürün yorumu |
| F10 | P2 / yayın | Gerçek model davranışı ve çok oturumlu kullanıcı değeri kanıtı yetersiz | Değerlendirme altyapısı ve yayın durumu |
| F11 | P2 | Node 20 destek iddiası güncel yaşam döngüsüyle uyumsuz | Paket + CI + resmî Node bilgisi |
| F12 | P2 | Ana kullanıcı kontrol akışı terminale ve istemci bilgisine fazla bağımlı | İşlem yüzeyi ve ürün akışı incelemesi |

## 6. Ayrıntılı teknik bulgular

### F1 — Kaynak eskiliği, tarayıcının kendisini devreden çıkarıyor

**Gözlem.** CA, TR ve US acil kaynak kayıtları 14 Temmuz 2026'da doğrulanmış görünüyor; son kullanımları 13 Ağustos 2026. İnceleme tarihinde 22 gündür eski durumdalar. Gerçek hook, kaynak sağlığını sınıflandırmadan önce kontrol ediyor. Eski kayıt varsa “degraded” bildirimi üretiyor ve sınıflandırıcıya hiç girmiyor.

**Deney.** Pozitif kontrol olarak kullanılan doğrudan kriz ifadesi sınıflandırıcı fonksiyonunda `fire: true` ve `urgent-review` üretti. Aynı giriş gerçek hook üzerinden işlendiğinde yalnızca `EMERGENCY_RESOURCE_REGISTRY_STALE` bildirimi geldi; çıkış kodu 0 oldu ve mekanik tarama yapılmadı.

**Etki.** Bu, sadece “telefon numarasının güncelliğine kefil olunamıyor” durumu değil. Kaynak eskiliği, normalde çalışabilen sinyal taramasını da kesiyor. Yazılı güvenlik protokolü ve modelin kendi değerlendirmesi devam ediyor; bütün güvenlik yaklaşımının ortadan kalktığı söylenemez. Mekanik hook desteği zaten olmayan adaptörler için ayrıca varmış gibi bir koruma varsayılmamalı.

Bu incelemede dört resmî sayfaya erişildi; yayımlanan CA, TR ve US iletişim yolları mevcut kayıtlarla uyumlu göründü. Dolayısıyla doğrulanan kusur “numaralar yanlış” değil, kayıt tazeliği ve ona bağlanmış çalışma davranışı. Repo kayıtlarının doğrulama tarihleri bu incelemede değiştirilmedi.

**Öneri.** Önce resmî kaynak yeniden doğrulama süreci tamamlanmalı; kayıtlar, dokümantasyon ve bütünlük dosyaları birlikte güncellenmeli. Ardından algılayıcı sağlığı ile iletişim kaynağı tazeliği ayrı durumlar olarak modellenmeli. Eski iletişim bilgisi güncel diye sunulmadan sinyal taraması sürdürülebilir. Gerçek tarihli yayın tazeliği kapısı katı kalmalıdır.

Testlerde de iki ayrı görev olmalı: sabit saat ve sentetik güncel/eski veriyle deterministik davranış testleri; gerçek tarihe bakan bağımsız tazelik kapısı. Tek zaman aşımının kurulum, dil tercihi ve zaman aşımı testlerinin birçoğunu aynı anda bozması bakım maliyetini artırıyor. Testleri yeşile boyamak için tarihi gizlemek de doğru çözüm değildir.

Kaynaklar: [kayıt](https://github.com/cerncaycisi/scalvin/blob/e59afe5cdd6b58f4b14f7d6827520169e2e96b79/hooks/emergency-resources.json), [hook erken dönüşü](https://github.com/cerncaycisi/scalvin/blob/e59afe5cdd6b58f4b14f7d6827520169e2e96b79/hooks/safety-net.cjs#L400-L421), [issue #12](https://github.com/cerncaycisi/scalvin/issues/12). Resmî doğrulama sayfaları: [Kanada](https://www.canada.ca/en/public-health/services/suicide-prevention/warning-signs.html), [Türkiye 112](https://www.112.gov.tr/), [ABD 911](https://www.911.gov/calling-911/frequently-asked-questions/), [ABD 988](https://988lifeline.org/).

### F2 — İşlem doğrulaması güçlü; insan onayı ve izolasyon tamamlanmış değil

**Gözlem.** Gerçek bir MCP broker var. Araçları sınırlı, argümanları tipli, ham kaynak ve keyfî dosya yolu yüzeyi kapalı. Buna rağmen kendi self-test'i açıkça şunları söylüyor:

- `hardBoundaryAttested: false`
- `completeTypedPrivateSurface: false`
- `isolatedSourceWorkerAttested: false`

Mutasyon önizlemesinde üretilen onay belirteci aynı çağırana döndürülüyor. Belirteç tam istek özeti, süre ve çalışma alanı durumu ile bağlanıyor. Bu tekrar kullanımını ve farklı işlemle değiştirmeyi sınırlar; fakat belirteci geri gönderenin bağımsız bir insan olduğunu kanıtlamaz.

**Deney.** Sentetik MCP istemcisi önizlemeyi aldı, dönen belirteci aynı işlemle geri verdi ve düzeltme gerçekleşti. Broker'a ayrıca doğrulanmış insan onayı olayı sağlanmadı. Bu deney, gerçek Claude/Codex onay arayüzünün aşıldığını göstermiyor; broker'ın insan onayını tek başına doğrulamadığını gösteriyor.

İstemci başlatıcısının çalıştırılabilir dosyayı çözmesi ve `--version` çıktısını kontrol etmesi de etkili izinlerin uygulandığını kanıtlamaz. Ayar dosyasındaki “kapalı” değer ile çalışan istemcinin gerçekten kapattığı yetenek ayrı şeylerdir.

**Öneri.** Önce tek istemci/işletim sistemi/sürüm bileşimi seçilmeli. Gerçek başlatma sonrasında shell, dosya, ağ, dış araçlar, kullanıcı ayarları, oturum kayıtları ve onay olayları ölçülmeli. İşlem belirteci ile kullanıcı iradesi ayrı kanıtlar olarak tutulmalı. İstemci onayı yoksa hassas mutasyon yolu kapalı kalmalı. Genel adaptör için önizleme sınırı açık biçimde korunmalı.

Kaynaklar: [onay belirteci](https://github.com/cerncaycisi/scalvin/blob/e59afe5cdd6b58f4b14f7d6827520169e2e96b79/cli/mcp-server.js#L175-L217), [broker self-test](https://github.com/cerncaycisi/scalvin/blob/e59afe5cdd6b58f4b14f7d6827520169e2e96b79/cli/mcp-server.js#L1411-L1425), [supervisor](https://github.com/cerncaycisi/scalvin/blob/e59afe5cdd6b58f4b14f7d6827520169e2e96b79/cli/session-supervisor.js).

### F3 — Yayın disiplini belgede var; ana dalda zorunlu değil

**Gözlem.** İnceleme anındaki GitHub dal verisi `main.protected: false` döndürdü. Üst kuralları da içeren ruleset sorgusu boş liste döndürdü. Bu, RELEASING belgesinde tarif edilen ana dal/tag korumalarının etkin olduğuna kanıt bulunmadığı anlamına geliyor. Yayın ortamı onay korumaları ayrıca doğrulanmadı; onlar için yokluk iddiası yapılmıyor.

**Etki.** Kaliteli CI dosyası, geçmeyen değişikliğin ana dala girmesini kendiliğinden engellemez. “Required CI” adlı işin bulunması da GitHub'ın o işi zorunlu tuttuğu anlamına gelmez.

**Öneri.** Ana dalda PR zorunluluğu, gereken kontroller, force-push ve silme kısıtları uygulanmalı; istisna yetkileri bilinçli seçilmeli. Sürüm etiketi ve yayın kimliği korumaları ayrıca kurulmalı. Kabul ölçütü, ayar belgesi yazılması değil, başarısız denetimli değişikliğin gerçekten birleştirilemediğinin görülmesi olmalı.

Kaynaklar: [dallar API'si](https://api.github.com/repos/cerncaycisi/scalvin/branches), [ruleset API'si](https://api.github.com/repos/cerncaycisi/scalvin/rulesets?includes_parents=true), [yayın kuralları](https://github.com/cerncaycisi/scalvin/blob/e59afe5cdd6b58f4b14f7d6827520169e2e96b79/RELEASING.md). API gözlemleri 4 Eylül 2026'ya aittir; bağlantılar zaman içinde değişebilir.

### F4 — Yeni düzeltme, eski doğrulama metadata'sıyla kalıyor

**Gözlem.** `planCorrection`, ifadenin metnini, durumunu, revizyonunu ve revizyon geçmişini güncelliyor. `Last live confirmed`, `Last confirmed session` ve mevcut gözden geçirme durumunu birlikte güncellemiyor. Oysa köken protokolü canlı doğrulamada bu alanların güncellenmesini istiyor.

**Deney.** Ocak tarihli sentetik tercih MCP `memory_correct` ile düzeltildi. Yeni metin kaydedildi, `status=user_confirmed`, `currentRevision=2` oldu. Ancak canlı doğrulama tarihi 1 Ocak'ta, oturum bağı eski oturumda ve `reviewState=due` kaldı. Gerçek gözden geçirme hesaplaması yeni düzeltilen kaydı **246 günlük, üç oturum geçmiş ve hâlâ inceleme gerektiriyor** olarak sınıflandırdı.

**Etki.** Kullanıcı “bu bilgi artık şöyle” dediğinde sistem aynı bilgiyi yeniden eskimiş gibi gündeme getirebilir. Metin ile güven/tazelik bilgisi ayrışır. Ürünün temel vaadi güvenilir süreklilik olduğu için bu sıradan bir görsel hata değildir.

**Öneri.** Düzeltme ve canlı doğrulama ortak bir durum geçişi kullanmalı. Tarih, varsa gerçek aktif oturum, revizyon ve inceleme alanları aynı işlemde tutarlı güncellenmeli. Oturum dışı düzeltmeler için açık bir politika olmalı; var olmayan oturum kimliği uydurulmamalı. Kabul testi, sadece metin değişimini değil hemen sonraki `dueState` sonucunu da doğrulamalı.

Kaynaklar: [düzeltme planı](https://github.com/cerncaycisi/scalvin/blob/e59afe5cdd6b58f4b14f7d6827520169e2e96b79/cli/memory-data.js#L783-L814), [işlem çağrısı](https://github.com/cerncaycisi/scalvin/blob/e59afe5cdd6b58f4b14f7d6827520169e2e96b79/cli/operations.js#L4045-L4060), [inceleme hesabı](https://github.com/cerncaycisi/scalvin/blob/e59afe5cdd6b58f4b14f7d6827520169e2e96b79/cli/memory-review.js), [canlı doğrulama kuralı](https://github.com/cerncaycisi/scalvin/blob/e59afe5cdd6b58f4b14f7d6827520169e2e96b79/runtime/MEMORY-PROVENANCE.md#L65-L75).

### F5 — Çıktı sınırı hatası dönerken işçi çalışmaya devam edebiliyor

**Gözlem.** Zaman aşımı yolunda SIGTERM ardından gecikmeli SIGKILL var. Çıktı taşması yolunda yalnızca SIGTERM gönderiliyor; hata döndürülürken ana zamanlayıcı temizleniyor. Sürecin gerçekten çıktığı beklenmiyor.

**Deney.** 8 MiB sınırını aşacak şekilde 9 MiB çıktı veren ve SIGTERM'i görmezden gelen sentetik alt süreç başlatıldı. `SOURCE_WORKER_OUTPUT_TOO_LARGE` hatası döndü. Süreç **2.300 ms sonra hâlâ hayattaydı**. Deney düzeneği ardından süreci SIGKILL ile sonlandırıp temizledi.

**Etki.** “İşçi durduruldu” varsayımı ile gerçek süreç yaşamı ayrışır. Kaynak tüketimi ve iş iptali güvenilirliği etkilenir. Burada ağ erişimi veya veri kaçırma gösterilmedi.

**Öneri.** Çıktı taşması ve zaman aşımı aynı sonlandırma yordamından geçmeli: nazik sonlandırma, sonlu bekleme, zorla sonlandırma, çıkışın doğrulanması ve kaynak temizliği. Alt süreç ağacı ve Windows davranışı ayrıca düşünülmeli. Tek bir SIGTERM çağrısını test etmek yeterli değildir.

Kaynak: [sınırlı istemci çalıştırma](https://github.com/cerncaycisi/scalvin/blob/e59afe5cdd6b58f4b14f7d6827520169e2e96b79/cli/client-launcher.js#L201-L239).

### F6 — İmzalı kaynak önerisi, kaynağın okunmuş olmasını kanıtlamıyor

**Gözlem.** İşçi yüzeyinde `source_metadata`, `source_read_chunk`, `proposal_submit` var. Sunucu kaynak içeriğini kendi bağlamına yüklese de öneri kabulü, modelin kaynak parçalarını okuduğu bir çağrı dizisine veya okuma kapsamına bağlanmıyor.

**Deney.** Sıfır metadata ve sıfır parça okuma çağrısıyla, kaynak metninin desteklemediği sentetik bir aday doğrudan gönderildi. İşçi kabul etti; önerinin HMAC doğrulaması geçti. **Canlı belleğe yazım yapılmadı**; entegrasyon ve onay aşamaları ayrı kaldı.

**Etki.** HMAC bu önerinin belirli sunucu/anahtar yolundan geçtiğini ve değişmediğini gösteriyor. Kaynağın okunmasını veya adayın kaynaktan çıkarılmasını kanıtlamıyor. “İmzalı olduğu için güvenilir çıkarım” şeklindeki ürün/inceleme varsayımı hatalı olur.

**Öneri.** Okunan aralıklar kaydedilmeli; öneriler kaynak revizyonu yanında sınırlı alıntı/konum kanıtı taşımalı. Beklenen okuma kapsamı tamamlanmadan dolu öneri kabul edilmemesi düşünülmeli. Bunun da anlamsal doğruluğu tek başına garanti etmeyeceği açık kalmalı. Nihai entegrasyonun ayrı, sınırlı ve kullanıcı kontrollü olması korunmalı.

Kaynak: [işçi araçları ve imzalama](https://github.com/cerncaycisi/scalvin/blob/e59afe5cdd6b58f4b14f7d6827520169e2e96b79/cli/source-worker.js#L245-L310).

### F7 — Alt süreç ortamı gereğinden geniş

**Gözlem.** İki başlatıcıdaki `cleanEnvironment`, yalnızca `SCALVIN_` ile başlayan değişkenleri çıkarıyor. Diğer ana süreç ortamı değişkenleri taşınıyor.

**Deney.** İlgisiz bir sentetik işaret değişkeni kaldı, SCALVIN önekli işaret çıkarıldı. Gerçek kimlik bilgileri okunmadı veya yazdırılmadı.

**Etki.** Ana süreç ortamında sağlayıcı anahtarları veya davranış değiştiren değişkenler varsa alt süreç bunları da alabilir. Bu incelemede gerçek sır aktarımı ya da sızıntı kanıtlanmadı; kanıtlanan geniş kalıtım davranışıdır.

**Öneri.** İşçi ve etkileşimli ana istemci için ayrı, gerekçeli ortam politikaları tanımlanmalı. Sağlayıcı kimlik doğrulaması için gerçekten gereken değişkenler açıkça taşınmalı; ilgisiz anahtarlar ve davranış değiştiren seçenekler varsayılan olarak aktarılmamalı. İsim “temiz” olduğu için davranışın asgari yetki sağladığı varsayılmamalı.

Kaynaklar: [işçi ortamı](https://github.com/cerncaycisi/scalvin/blob/e59afe5cdd6b58f4b14f7d6827520169e2e96b79/cli/client-launcher.js#L193-L206), [ana istemci ortamı](https://github.com/cerncaycisi/scalvin/blob/e59afe5cdd6b58f4b14f7d6827520169e2e96b79/cli/session-supervisor.js#L15-L19).

### F8 — Küçük işlem, büyük arşivin maliyetini ödüyor

**Gözlem.** `currentWorkspaceContext` bütün çalışma alanının özetini alıyor. Genel içerik işlemi, çalışma alanını kardeş geçici alana kopyalayıp doğrulayarak etkinleştiriyor. Bu güvenlik disiplini, arşiv büyüdükçe küçük işlemlere de maliyet bindiriyor.

Sentetik, boş profil üzerinde `memory_show(scope=profile, limit=1)` üçer kez; bellek duraklatma mutasyonu her boyutta bir kez ölçüldü:

| Ek sentetik arşiv | Profil okuma medyanı | Duraklatma işlemi |
|---|---:|---:|
| 0 MiB | 78 ms | 491 ms |
| 64 MiB | 194 ms | 914 ms |
| 128 MiB | 247 ms | 1.357 ms |

Bunlar tek makinedeki mikro ölçümlerdir; üretim gecikmesi, p95 veya genel performans garantisi değildir. Yine de metin belleği boşken arşiv boyutunun maliyete yansıdığını gösterir.

**Öneri.** Önce hedef boyut ve gecikme bütçesi konmalı. Kontrol durumu, bellek ve büyük kaynak arşivlerinin değişim alanları ayrılmalı; doğrulanmış hash dizini, dosya kapsamlı işlem günlüğü veya kopyalama optimizasyonu değerlendirilmeli. Daha büyük ölçekte veritabanı + insan tarafından okunabilir dışa aktarım düşünülebilir. Güvenlik kontrollerini ölçüsüzce kaldırmak doğru çözüm değildir.

Kaynaklar: [bağlam yükleme ve işlem](https://github.com/cerncaycisi/scalvin/blob/e59afe5cdd6b58f4b14f7d6827520169e2e96b79/cli/operations.js#L1867-L1920), [özet ve etkinleştirme](https://github.com/cerncaycisi/scalvin/blob/e59afe5cdd6b58f4b14f7d6827520169e2e96b79/cli/lib/fs-safe.js#L804-L920).

## 7. Ürün, konuşma kalitesi ve bakım değerlendirmesi

### F9 — Talimat ağırlığı yüksek, karşılığı ölçülmeli

Varsayılan başlangıçta okunması istenen temel güvenlik/çalışma zamanı dosyaları ile Susan, moderate ve varsayılan üç yaklaşım toplamında **12 dosya, 106.339 UTF-8 bayt, 15.373 boşlukla ayrılmış sözcük** ölçüldü. Buna özel bellek, araç şemaları ve konuşma geçmişi dahil değil. Bu bir gerçek model token veya fatura ölçümü değildir.

Geniş protokol hacmi daha iyi davranışı otomatik olarak sağlamaz. Kuralların çakışması, modelin önemli ayrıntıları kaçırması, oturum maliyeti ve gecikme riskleri gerçek istemciyle ölçülmeli.

Önerim güvenlik ve izin çekirdeğini koruyup kalan talimatları olayla yüklenen kısa modüllere taşımak; protokollerin aynı bilgiyi kaç yerde tekrarladığını azaltmak; her dosyanın ana konuşmaya katkısını deneyle görmek. Yeni “davranış katmanı” eklemeden önce mevcut yükün sonuç kalitesine etkisini ölçmek daha değerli.

Kaynak: [oturum başlangıç akışı](https://github.com/cerncaycisi/scalvin/blob/e59afe5cdd6b58f4b14f7d6827520169e2e96b79/runtime/START-SESSION.md).

### F10 — Değerlendirme altyapısı var; gerçek davranış kanıtı onun gerisinde

Depoda 139 güvenlik, 44 yayın davranışı, 18 persona ve 22 kaynak değerlendirme vakası bulunuyor. Bunlar farklı korpuslardır; birleştirilip “223 gerçek konuşmada başarılı” diye sunulmamalı.

Yakalanmış yanıt değerlendirme altyapısında anahtar ifade bulunması/bulunmaması, sözcük/soru/karakter sınırı gibi deterministik kontroller var. Bunlar biçim ve belli ihlaller için yararlı. Ancak doğru bağlamda empati, olumsuzlamayı anlama, kullanıcının yanlış çıkarımı düzeltmesi, belirsizlik, ilişki sınırı ve çok oturumlu bellek doğruluğunu tek başına ölçmez.

Bağımsız insan değerlendirmesi ve gerçek aday/istemci/model bağlantılı kanıt gereksinimlerinin belgelenmesi doğru. İncelenen repo ve yayın durumu, bunların tamamlanmış olduğunu göstermiyor.

Önerilen gerçek değerlendirme senaryoları:

- Kullanıcı önceki bir bilgiyi reddettiğinde sistemin bunu yorum dayanağı olarak kullanmayı bırakması.
- İroni, alıntı, geçmiş olay ve güncel risk ifadesinin ayrıştırılması.
- Bir oturumda verilen iznin başka veri kategorisine taşmaması.
- Bellek duraklatıldıktan sonra geçmişe gizli geri doldurma yapılmaması.
- Kaynağa gömülmüş talimatın öneri veya konuşma otoritesi kazanmaması.
- Birkaç oturum boyunca kullanıcının değişen tercihinin doğru izlenmesi.
- Destek konuşmasının bağımlılık veya sahte profesyonel otorite üretmemesi.

“Destekleyici hissettirdi” ile “klinik fayda gösterildi” ayrı iddialardır. Erken ürün deneyi önce kullanılabilirlik ve veri denetimi iddialarını sınamalı.

Kaynak: [yanıt değerlendirme kodu](https://github.com/cerncaycisi/scalvin/blob/e59afe5cdd6b58f4b14f7d6827520169e2e96b79/cli/evaluate-captured-responses.js#L469-L502).

### F11 — Node destek aralığı güncellenmeli

Paket `node >=20.0.0` kabul ediyor ve CI Node 20'yi içeriyor. İnceleme tarihinde Node 20 resmî tabloda EOL; Node 22 ve 24 LTS. Destek aralığı ve matris bu gerçekle uyumlu hale getirilmeli. EOL çalışma zamanının test edilmesi güvenlik güncellemesi aldığı anlamına gelmez.

Öneri: desteklenen LTS hatlarını açıkça belirtmek; minimum sürümü, manifesti, kurulum belgelerini ve CI'ı birlikte güncellemek. “En az 20” gibi açık uçlu ifade ile hangi sürümlerin gerçekten desteklendiği arasında fark bırakmamak.

Kaynaklar: [paket motor aralığı](https://github.com/cerncaycisi/scalvin/blob/e59afe5cdd6b58f4b14f7d6827520169e2e96b79/package.json#L12-L14), [resmî Node sürümleri](https://nodejs.org/en/about/previous-releases), [EOL politikası](https://nodejs.org/en/about/eol).

### F12 — Kontrol zenginliği, kullanıcı kontrolüne dönüşmeli

Pause, seal, düzeltme, gözden geçirme, silme, dışa aktarma, saklama, kaynak yönetimi ve yedekleme gibi yetenekler mevcut. Fakat tipli konuşma yüzeyi tüm özel işlemleri kapsamıyor; bazı işler terminale ve istemci bilgisine dayanıyor.

Hedef kullanıcı yazılımcıysa bu kabul edilebilir bir önizleme tercihi olabilir. Teknik olmayan ve duygusal olarak zorlanan kullanıcı için komut bilgisi, klasörler, istemci izinleri ve veri kategorileri yüksek zihinsel yük oluşturur. Ürünün kendi kullanıcı denetimleri kolay bulunur ve sonuçları anlaşılır olmadıkça altyapıdaki kontrol zenginliği kullanıcıya tam yansımaz.

Öncelikli küçük arayüz, üç soruyu cevaplamalı:

1. Hakkımda şu anda ne tutuluyor ve hangisi doğrulanmış?
2. Şimdi durdurabilir, düzeltebilir veya silebilir miyim?
3. Bu işlemden sonra nerede hangi kopyalar kalıyor?

Kullanıcı akışına hash, manifest ve broker terminolojisi taşımak gerekmiyor. Veri gönderimi, istemci kayıtları ve silmenin sınırı ise anlaşılır biçimde görünmeli.

### Kod organizasyonu ve dokümantasyon borcu

`operations.js` 4.764 satırlık merkez haline gelmiş. Bellek, kaynak, oturum, yedekleme ve çalışma alanı işlemlerinin büyük kısmının burada birleşmesi ortak değişkenler ve tekrar eden geçişler için risk yaratıyor. Bellek düzeltmesindeki eksik metadata güncellemesi bu tür dağıtılmış kural riskine somut örnek.

Bölme işlemi sırf dosya küçültmek için yapılmamalı. Ortak işlem motoru korunurken alan geçişleri bellek, kaynak, oturum ve veri kontrolü modüllerine ayrılmalı. Aynı yaşam döngüsü kuralının broker, CLI ve Markdown açıklamalarında farklı uygulanması önlenmeli.

`npm run lint` yalnızca sözdizimi denetimi. Bu isim daha güçlü bir statik kalite denetimi varmış izlenimi verebilir. 110 JavaScript dosyasının parse edilmesi değerlidir; ancak kullanılmayan değişken, problemli Promise/süreç yaşamı veya durum geçişi tutarlılığını tek başına yakalamaz. Yeni araç eklemekten önce yakalanması istenen hata sınıfları seçilmeli.

Dokümantasyon geniş ve birçok konuda dürüst. Bununla birlikte birden fazla dosyada aynı yetenek listesinin elle tutulması sürüklenme riski yaratıyor; bazı özetler genişleyen MCP yüzeyinin gerisinde kalmış görünüyor. Araç ve adaptör yetenek tablolarını mümkün olduğunca tek kaynaktan üretmek faydalı olur.

## 8. Çalıştırılan kontroller ve gerçek sonuçlar

### Ana dal — kendi koşumum

| Kontrol | Sonuç |
|---|---|
| Tam `npm test` | 618 test: **596 geçti, 14 başarısız, 8 atlandı** |
| Tam koşu süresi | Yaklaşık 223,2 saniye |
| JavaScript sözdizimi | 110 dosya geçti |
| Acil kaynak kaydı | Başarısız: CA, TR, US eski |
| Dağıtım manifesti | 121 dosya doğrulandı |
| Paket envanteri | Geçti |
| Yerel Markdown bağlantıları | 103 dosyada geçti |
| Public-repo taraması | 253 aday dosyada geçti |
| Python uyumluluk testleri | 18/18 geçti |
| Kararlı yayın hazırlığı | 8 açık engel nedeniyle reddedildi |

Bu kontrollerin geçmesi tüm güvenlik açıklarının yokluğu anlamına gelmez. Özellikle public-repo taraması bütün olası sırları bulan bir güvenlik garantisi değildir.

14 başarısızlık şu şekilde ayrıldı:

- **11 başarısızlık eski kaynak kaydıyla ilişkili.** Kurulum/doctor/dil ve paket duman testi dahil farklı alanlara yayılıyor. Hook'un regex zaman aşımı testinin beklenen yoluna bile eski kaynak erken dönüşü engel oluyor.
- **1 başarısızlık bu ortamda Unix soketi açarken EPERM.** Ürün kusuru olarak sayılmadı.
- **2 dosya işlemi testi ilk tam koşuda başarısız, tek başlarına tekrarında başarılı.** Birinde `BACKUP_LAYOUT_INVALID`, diğerinde `FILE_CHANGED_DURING_COPY` görüldü. Kök neden çözülmedi; “düzeldi” veya kesin “ortam kaynaklı” denmedi.

Bu nedenle sonuç “11 hata var” diye başka rapordan kopyalanmadı; benim tam koşumumun ham sonucu 14 başarısızlıktır. Öte yandan 14'ünün de 14 bağımsız ürün hatası olduğu söylenemez.

Kararlı yayın kapısının sekiz engeli: eski kaynak kaydı; generic adaptörün önizleme sınırı; üç adaptör için etkili başlatma doğrulamasının eksikliği; broker sert sınırının tamamlanmaması; tipli özel işlem yüzeyinin eksikliği; izole işçi doğrulamasının eksikliği. Bunlar daha sonraki insan/konuşma değerlendirmesi gereksinimlerinin tamamının yerine geçmez.

### Güncel PR #13 — kendi doğrulamam ve CI

PR #13 çalışma kopyasında sözdizimi, manifest, paket envanteri, bağlantı ve public-repo kontrolleri geçti; gerçek tarihli acil kaynak kontrolü yine başarısız. Değişen CodeQL iş akışı kuralları ve kaynak denetimi için hedefli **11/11 test geçti**.

GitHub'da PR'nin 1 Eylül tarihli [CI çalışması](https://github.com/cerncaycisi/scalvin/actions/runs/33483860192) başarısız. Yedi platform/Node işinin tümü statik/depo kontrolü aşamasında durmuş; sonraki test ve paket adımları atlanmış. Python ve CodeQL işleri geçmiş. Bu, o CI çalışmasının bütün platformlarda runtime testlerini tamamladığı anlamına gelmiyor.

Ana dalın 3 Eylül tarihli [zamanlanmış CodeQL işi](https://github.com/cerncaycisi/scalvin/actions/runs/33731142757) başarılı. Güncel code-scanning alert envanteri incelenmedi; bu başarıdan “sıfır güvenlik açığı” sonucu çıkarılmadı.

## 9. PR #13 için özel yorum

PR #13 yaklaşık 10 dosyada 582 ekleme, 29 silme içeriyor. Üretim çalışma zamanı dosyalarını onarmıyor; esas olarak yol haritası, bakım ve denetim davranışına odaklanıyor.

Olumlu tarafları:

- Acil kaynak kaydının dolmasına 14 gün kala erken uyarı ve haftalık bakım kontrolü tasarlıyor.
- CodeQL testlerinde tek bir eski SHA değerine bağımlılık yerine değişmez commit sabitleme özelliğini sınamaya geçiyor. Bu, güvenlik ilkesini korurken meşru bağımlılık güncellemelerini kolaylaştırır.
- Kaynak eskiliğini saklamıyor ve yayın engellerini açık tutuyor.

Sınırı: eski kaynak kaydı aynı kalıyor. Dolayısıyla mevcut bozuk davranış ve kırmızı ana denetim bu PR ile çözülmüyor. Haftalık iş akışının dosyada bulunması, PR ana dala girmeden zamanlanmış bakımın aktif olduğu anlamına gelmiyor.

**Kanaatim:** Faydalı bakım PR'si; toparlanmanın tamamı değil. Kaynak doğrulaması ve somut çalışma zamanı düzeltmeleri ayrı, küçük ve test edilebilir değişikliklerle takip edilmeli. Geniş yol haritası, en acil çalışan kod sorunlarını gölgelememeli.

Kaynak: [PR #13 farkı ve tartışması](https://github.com/cerncaycisi/scalvin/pull/13).

## 10. Projenin konumlandırılması: asıl değer nerede?

Scalvin'in savunulabilir tarafı çok sayıda persona veya yaklaşım sunması değil. Bu alanlarda seçenek sayısı kolay çoğalır ve bakım/konuşma değerlendirmesi matrisi büyür.

Asıl değer önerisi şu olabilir:

**“Kullanıcının kendi denetiminde, geçmişi yanlış kesinliklere dönüştürmeden sürdüren bir düşünme ve konuşma alanı.”**

Bu cümleyi ürün davranışına çevirmek için dört yetenek öne çıkmalı:

- Doğru hatırlama kadar doğru unutma.
- Kullanıcının düzeltmesini hemen otorite kabul etme.
- Kaynak bilgisini kişinin güncel gerçeğiyle karıştırmama.
- Her veri işleminin sonucunu kullanıcıya anlaşılır biçimde gösterme.

Repo “local-first” yaklaşımını ciddiye alıyor; ancak bulut model istemcisi kullanıldığında modele verilen içerik sağlayıcıya gidebilir. Yerel dosya sahipliği, tüm hesaplamanın yerel olması veya sağlayıcı kaydının bulunmamasıyla eş anlamlı değildir. Ürün açıklaması bu ayrımı berrak tutmalı.

Generic adaptörün sınırlı durumu nedeniyle “her modelde aynı güvenceyle çalışır” iddiası da erken olur. İlk kararlı hedefin tek istemcide dar ve iyi doğrulanmış bir deneyim olması daha gerçekçi.

### Hedef kullanıcı ve ilk değer anı

İlk hedef olarak teknik, veri sahipliğine önem veren, terminal kullanabilen yetişkin kullanıcı daha uyumlu görünüyor. Genel tüketici kitlesine geçiş için kurulum, izinler, görünür bellek ve kurtarma akışında ayrı ürün işi var.

İlk değer anı “13 yaklaşım seçtim” olmamalı. Örneğin kullanıcı üç kısa görüşme yaptıktan sonra sistem önceki konuyu doğru ve ihtiyatlı biçimde hatırlamalı, kullanıcı düzeltince tartışmadan güncellemeli ve kullanıcı kaydı kolayca görebilmeli.

Gelir modeli, abonelik fiyatı veya yatırım değeri için elde yeterli kullanım verisi yok. Repo verisinden talep ya da ödeme isteği çıkarılamaz. Kullanım kanıtı gelmeden yeni özellik genişliği üzerinden ekonomik sonuç üretmek erken olur.

## 11. Önerilen çalışma sırası

Aşağıdaki süreler iş sırası için yaklaşık plan pencereleridir; ekip kapasitesi veya teslim taahhüdü değildir.

| Pencere | İş | Tamamlanma ölçütü |
|---|---|---|
| İlk birkaç gün | Acil kaynakları yeniden doğrula; kayıt ve projeksiyonları güncelle | Gerçek tarihli kaynak kontrolü geçer; hook beklenen taramayı yapar |
| İlk birkaç gün | main ve sürüm kurallarını etkinleştir | Başarısız gereken kontrol birleştirmeyi gerçekten engeller |
| İlk hafta | Bellek düzeltme geçişini onar | Yeni düzeltme tarih/oturum/inceleme bakımından tutarlı |
| İlk hafta | İşçi sonlandırmasını ortak ve sonlu hale getir | SIGTERM'i reddeden süreç ve gerekli alt süreçleri kalmaz |
| İlk hafta | Okunmamış kaynak önerisini sınırla; ortam politikasını daralt | Okuma/kanıt ve ortam sınırları olumlu/olumsuz deneylerle doğrulanır |
| İkinci hafta | Bir gerçek istemcide ana akış ve izin sınırını kanıtla | İzin reddi, iptal, bağlantı kopması, kayıt ve araç sınırları ölçülür |
| İkinci–dördüncü hafta | Başlangıç yükünü ve büyük alan maliyetini azalt | Belirlenen boyut/gecikme/bağlam bütçeleri sağlanır |
| Sonraki aşama | Dar kapsamlı kullanıcı deneyi ve bağımsız yanıt incelemesi | Kullanılabilirlik, bellek doğruluğu ve yanlış davranışlar ölçülür |

İlk kullanıcı deneyi için küçük, gönüllü ve açık kapsamlı bir grup yeterli olabilir. Önce sentetik verili uçtan uca denemeler tamamlanmalı. Örneğin iki haftalık 5–10 kişilik bir kullanılabilirlik deneyi ürün kararlarını besleyebilir; bu ölçek etkililik veya genel güvenlik kanıtı sayılmaz.

Ölçülecekler: kurulumu tamamlama süresi, ilk yararlı oturuma ulaşma, izin akışında takılma, yanlış/eskimiş bellek kullanımı, düzeltmenin sonucu, yedekten dönme başarısı, oturum başı bağlam yükü ve sonraki hafta yeniden kullanım. Hassas içeriği toplamadan ölçülebilecek operasyonel veriler tercih edilmeli.

Şimdilik ertelenmesini önerdiğim işler: yeni persona sayısını artırmak, yeni yaklaşım eklemek, genel adaptöre kararlı güvence vermek ve kullanıcı kanıtı olmadan karmaşık yeni davranış katmanları tasarlamak.

## 12. Kararlı sürüm için kabul kapıları

Bir “hazır” kararı vermeden önce en az şu somut kanıtları ararım:

1. Resmî acil kaynak tazeliği geçerli; algılayıcı ile kaynak sağlığının bozulma davranışları ayrı ve test edilmiş.
2. Desteklenen LTS/işletim sistemi matrisinde gerekli CI işleri gerçekten çalışıp geçmiş; başarısız kontrol ana dala girişi engelliyor.
3. Bir ilan edilmiş istemci sürümünde etkili araç, dosya, ağ, ayar ve kayıt sınırı doğrulanmış.
4. İnsan onayı, yalnızca modelin geri gönderebildiği belirteçten ayrı kanıtlanmış.
5. Düzeltme, duraklatma, mühürleme, silme, dışa aktarma ve kurtarma uçtan uca tutarlı.
6. Kaynak önerisinin doğrulanmış kaynağı ve sınırlı dayanağı görülebiliyor; kaynaktaki talimat otorite kazanmıyor.
7. İşçi iptali ve hata yolları gerçekten süreç sonlanmasıyla bitiyor.
8. Gerçek yanıt değerlendirmesi ve bağımsız insan incelemesi tam aday sürüme bağlanmış.
9. Veri sahipliği, sağlayıcıya gönderim ve istemci kayıtları kullanıcıya anlaşılır anlatılıyor.
10. İlan edilen alan boyutu ve oturum yükünde kullanılabilirlik ölçülmüş.

Bu kapılar daha fazla belge üretmek için değil, mevcut iddiaları gözlenebilir davranışa bağlamak için kullanılmalı.

## 13. Son hüküm

| Boyut | Değerlendirme |
|---|---|
| Veri sahipliği ve süreklilik fikri | Güçlü |
| Dosya/işlem/izin mühendisliği | Ciddi ve birçok yerde özenli |
| Kodun sürdürülebilirliği | Büyük merkez modül ve tekrar eden kurallar nedeniyle baskı altında |
| Fiilen kanıtlanmış özel veri sınırı | Tamamlanmamış |
| Gerçek konuşma ve kullanıcı değeri kanıtı | Erken |
| Teknik kullanıcıya geliştirme önizlemesi | Anlamlı, sınırları açık tutulmalı |
| Genel kullanıcıya kararlı ürün | Henüz hazır değil |

**Üstad yorumu:** Burada korunacak iyi bir çekirdek var. En doğru yatırım, çekirdeğin çevresine daha çok kural katmanı eklemekten önce onu sadeleştirip gerçek davranışla kanıtlamak olur. Scalvin'in bir sonraki büyük ilerlemesi daha çok şey yapması değil; kullanıcının söylediğini doğru güncellemesi, izin vermediğini yapmaması ve hata verdiğinde gerçekten durmasıdır. Bu üçü güvenilir biçimde çalışırsa mevcut mimari değer üretir. Çalışmazsa geniş protokol ve test hacmi aradaki boşluğu kapatamaz.

## Ek — Bulguları tekrar doğrulamak için

Aşağıdaki deneyler yalnızca boş/sentetik geçici çalışma alanlarında uygulanmalıdır; canlı kullanıcı çalışma alanı gerekmez.

| Deney | Yöntem | Bu incelemedeki sonuç |
|---|---|---|
| Kaynak tazeliği | `npm run check:emergency-resources` | CA/TR/US eski |
| Genel statik durum | `npm run check`; erken durduğu için diğer alt kontroller ayrıca | Tazelik dışında listelenen alt kontroller geçti |
| Ana test paketi | `npm test` | 596 başarılı / 14 başarısız / 8 atlanan |
| Düzeltme | Eski tarihli kayıt oluştur; MCP önizleme ve onayla düzelt; dönen köken ve dueState'i oku | Metin yeni, doğrulama/inceleme eski |
| Kaynak okuma | Sentetik kaynağa işçi bağlamı aç; parça okumadan dolu öneri gönder; imzayı doğrula | Kabul ve geçerli HMAC, canlı belleğe yazım yok |
| Çıktı taşması | 9 MiB yazan ve SIGTERM'i yok sayan zararsız çocuk; hata sonrası yaşam kontrolü | 2,3 saniye sonra hayatta |
| Ortam kalıtımı | İki sentetik işaret: SCALVIN önekli ve ilgisiz | Yalnızca önekli temizlendi |
| Ölçek | Aynı boş profil, 0/64/128 MiB ilgisiz arşiv, üç sınırlı okuma ve bir pause | Boyutla artan maliyet |
| PR #13 | Değişen CodeQL ve acil kaynak testleri | 11/11 geçti; gerçek tazelik yine başarısız |

Deneylerde üretilen alt süreç ve geçici kullanıcı alanları temizlendi. Tam test ve bütünlük sonuçları belirtilen commit'lerin değişmemiş içerikleri üzerinde alındı. Repo talimatı gereği deney özeti sonrasında yerel mühendislik günlüğüne eklendi; uygulama koduna düzeltme, commit veya uzak depoya gönderim yapılmadı.

