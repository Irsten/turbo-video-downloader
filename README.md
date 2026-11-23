# Turbo Video Downloader (Opera / Chromium)

Rozszerzenie wykrywa filmy na stronach i pobiera je **wieloma połączeniami naraz**.

## Instalacja w Operze

1. Wpisz w pasku adresu `opera://extensions`.
2. Włącz **Tryb dewelopera** (przełącznik w prawym górnym rogu).
3. Kliknij **Załaduj rozpakowane** i wskaż folder `turbo-video-downloader` (ten, w którym jest `manifest.json`).
4. Przypnij ikonę rozszerzenia do paska (ikona puzzla → pinezka).
5. **Odśwież** karty, które były otwarte przed instalacją.

Działa też w Chrome, Edge, Brave i Vivaldi (ta sama procedura, np. `chrome://extensions`).

## Jak używać

1. Wejdź na stronę z filmem i **włącz odtwarzanie** (wtedy odtwarzacz zaczyna pobierać strumień i rozszerzenie go wychwytuje). Liczba na ikonie pokazuje, ile filmów wykryto.
2. Kliknij ikonę rozszerzenia → przy filmie kliknij **⚡ Pobierz**. Dla HLS wybierz jakość z listy.
3. Otworzy się karta **Menedżer pobierania** z paskiem postępu, prędkością i czasem do końca.
   Nie zamykaj jej, dopóki pobieranie trwa.
4. Gotowy plik trafia do domyślnego folderu pobrań Opery (albo zapyta o miejsce, jeśli zaznaczysz to w ustawieniach).

W menedżerze możesz też wkleić bezpośredni link do `.mp4`/`.webm`/`.m3u8`.

## Skąd prędkość

| Mechanizm | Co daje |
|---|---|
| **Wiele połączeń na plik** (HTTP Range) | Plik dzielony na fragmenty pobierane równolegle (domyślnie 6). Serwery i CDN-y często ograniczają prędkość *na połączenie*, więc suma jest kilka razy szybsza. |
| **Dzielenie w locie** | Gdy jeden wątek skończy, a inny ma jeszcze dużo do pobrania, wolny fragment jest dzielony na pół i przejmowany. Koniec pobierania nie "wisi" na jednym wolnym połączeniu. |
| **Równoległe segmenty HLS** | Domyślnie 8 segmentów naraz (zamiast po kolei jak w odtwarzaczu). |
| **Wznawianie** | Zerwane połączenie jest wznawiane od ostatniego bajtu, z ponowieniami. |
| **Bez cache przeglądarki** | Dane nie są drugi raz zapisywane do cache HTTP. |

Ustawienia (na górze menedżera):

- **Połączenia na plik**: 6 to optimum dla większości serwerów. Opera, jak każdy Chromium, otwiera do serwera HTTP/1.1 maksymalnie 6 połączeń, więc więcej da efekt tylko na serwerach HTTP/2 i HTTP/3.
- **Segmenty HLS naraz**: 8–16. Przy bardzo szybkim łączu możesz dać więcej.
- **Pobrania naraz**: ile filmów jednocześnie.

## Obsługiwane formaty

| Format | Stan |
|---|---|
| MP4, WebM, MOV, MKV, M4V… (bezpośredni plik) | ✅ wielowątkowo |
| HLS `.m3u8` (TS i fMP4, wybór jakości, BYTERANGE) | ✅ równoległe segmenty → `.ts` lub `.mp4` |
| HLS z osobną ścieżką audio | ✅ dwa pliki + gotowa komenda ffmpeg do połączenia |
| HLS na żywo | ⚠️ pobiera fragment dostępny w danej chwili |
| DASH `.mpd` | ❌ jeszcze nie |
| Treści z DRM / szyfrowane (Netflix, Disney+, płatne VOD…) | ❌ celowo nieobsługiwane |
| YouTube | ❌ celowo wyłączony (regulamin zabrania pobierania) |

### Pliki `.ts`

Otworzysz je w VLC albo MPC-HC. Zamiana na `.mp4` bez utraty jakości trwa kilka sekund ([ffmpeg](https://ffmpeg.org/download.html)):

```bash
ffmpeg -i "film.ts" -c copy "film.mp4"
```

## Ograniczenia

- Plik jest składany w pamięci przeglądarki (Opera przenosi duże dane na dysk), więc filmy rzędu kilku GB działają, ale potrzebują wolnego miejsca na dysku systemowym.
- Jeżeli strona wymaga ciasteczek i nagłówka `Referer`, rozszerzenie wysyła je tak samo jak strona. Linki z tokenem, który wygasa, trzeba pobrać od razu po wykryciu.

## Struktura

```
manifest.json      – konfiguracja (Manifest V3)
background.js      – wykrywanie filmów w ruchu sieciowym
content.js         – wykrywanie <video> i linków na stronie
popup.html/js      – lista wykrytych filmów
manager.html/js    – menedżer pobierania (postęp, prędkość, zapis)
lib/engine.js      – silnik: wielowątkowy Range + HLS
lib/hls.js         – parser .m3u8
lib/net.js         – nagłówki Referer/Origin (declarativeNetRequest)
lib/media.js       – rozpoznawanie formatów, nazwy plików
lib/jobs.js        – kolejka i ustawienia
```
