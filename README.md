# Turbo Video Downloader (Opera / Chromium)

Rozszerzenie wykrywa filmy na stronach i pobiera je **wieloma połączeniami naraz** – do jednego pliku MP4, z napisami, ze wznawianiem (także po restarcie przeglądarki) i z nagrywaniem transmisji na żywo.

## Instalacja w Operze

1. Wpisz w pasku adresu `opera://extensions`.
2. Włącz **Tryb dewelopera** (przełącznik w prawym górnym rogu).
3. Kliknij **Załaduj rozpakowane** i wskaż folder `turbo-video-downloader` (ten, w którym jest `manifest.json`).
4. Przypnij ikonę rozszerzenia do paska (ikona puzzla → pinezka).
5. **Odśwież** karty, które były otwarte przed instalacją.

Działa też w Chrome, Edge, Brave i Vivaldi (ta sama procedura, np. `chrome://extensions`).

## Jak używać

1. Wejdź na stronę z filmem i **włącz odtwarzanie** (wtedy odtwarzacz zaczyna pobierać strumień i rozszerzenie go wychwytuje). Liczba na ikonie pokazuje, ile filmów wykryto.
2. Kliknij ikonę rozszerzenia. Przy filmie wybierz jakość, a jeśli są dostępne – **ścieżkę dźwiękową** (język) i **napisy**. Kliknij **⚡ Pobierz**.
3. Otworzy się karta **Menedżer pobierania** z paskiem postępu, prędkością i czasem do końca.
4. Gotowy plik trafia do domyślnego folderu pobrań (albo przeglądarka zapyta o miejsce, jeśli zaznaczysz to w ustawieniach). Napisy zapisują się obok jako `.srt` – VLC, MPC-HC i odtwarzacz Windows wczytują je same.

W menedżerze możesz też wkleić link do `.mp4`/`.webm`, playlisty `.m3u8` albo manifestu `.mpd`.

### Wstrzymywanie i wznawianie

Pobierane dane trafiają od razu na dysk (prywatny folder rozszerzenia), nie do pamięci. Dzięki temu:

- **Wstrzymaj** / **Wznów** – wznowienie dociąga tylko brakujące bajty,
- po błędzie (np. zerwanym łączu) **Wznów** zaczyna od miejsca przerwania,
- po **zamknięciu karty menedżera albo restarcie przeglądarki** pobieranie wznawia się samo po ponownym otwarciu menedżera (popup pokazuje liczbę niedokończonych pobrań),
- ✕ usuwa zadanie razem z pobranymi danymi.

Gdy link w międzyczasie wygaśnie, menedżer napisze, że trzeba odświeżyć stronę z filmem.

### Transmisje na żywo

Przy transmisji HLS popup pokazuje **⏺ Nagrywaj**. Nagrywanie trwa, aż klikniesz w menedżerze **⏹ Zatrzymaj i zapisz** (albo transmisja się skończy). Jeśli menedżer zostanie zamknięty w trakcie, po ponownym otwarciu możesz **zapisać nagrany fragment** albo **nagrywać dalej**.

### Strony bez przeładowania

Na stronach, które zmieniają adres bez przeładowania (X, Instagram…), licznik na ikonie liczy filmy bieżącej podstrony, a te z poprzednich są w popupie w zwiniętej sekcji **Wcześniej na tej karcie**.

## Skąd prędkość

| Mechanizm | Co daje |
|---|---|
| **Wiele połączeń na plik** (HTTP Range) | Plik dzielony na fragmenty pobierane równolegle (domyślnie 6). Serwery i CDN-y często ograniczają prędkość *na połączenie*, więc suma jest kilka razy szybsza. |
| **Dzielenie w locie** | Gdy jeden wątek skończy, a inny ma jeszcze dużo do pobrania, wolny fragment jest dzielony na pół i przejmowany. Koniec pobierania nie "wisi" na jednym wolnym połączeniu. |
| **Równoległe segmenty HLS/DASH** | Domyślnie 8 segmentów naraz (zamiast po kolei jak w odtwarzaczu). |
| **Wznawianie** | Zerwane połączenie jest wznawiane od ostatniego zapisanego bajtu, z ponowieniami. |
| **Bez cache przeglądarki** | Dane nie są drugi raz zapisywane do cache HTTP. |

Ustawienia (na górze menedżera):

- **Połączenia na plik**: 6 to optimum dla większości serwerów. Opera, jak każdy Chromium, otwiera do serwera HTTP/1.1 maksymalnie 6 połączeń, więc więcej da efekt tylko na serwerach HTTP/2 i HTTP/3.
- **Segmenty naraz**: 8–16. Przy bardzo szybkim łączu możesz dać więcej.
- **Pobrania naraz**: ile filmów jednocześnie (nagrywanie transmisji nie wlicza się do limitu).
- **Łącz w jeden plik MP4**: obraz, dźwięk i segmenty składane w jeden `.mp4` (domyślnie włączone).

## Jeden plik MP4

Segmenty HLS (TS i fMP4), DASH i osobne ścieżki dźwięku są składane w zwykły plik `.mp4` **bez ponownego kodowania** (jak `ffmpeg -c copy` – bez utraty jakości, w kilka sekund). Rozszerzenie robi to samo, bez zewnętrznych programów.

| Wejście | Wynik |
|---|---|
| HLS TS z H.264 + AAC (także osobne audio „packed AAC”) | ✅ `.mp4` |
| HLS fMP4 / CMAF, DASH (fMP4) – dowolny kodek | ✅ `.mp4` |
| TS z H.265, AC-3, MP3; DASH w WebM | ⚠️ zapis bez łączenia (`.ts` / osobne pliki) + gotowa komenda ffmpeg |

Gdy łączenie jest niemożliwe, menedżer zapisze pliki tak jak są i pokaże komendę, którą połączysz je ręcznie ([ffmpeg](https://ffmpeg.org/download.html)), np.:

```bash
ffmpeg -i "film.ts" -c copy "film.mp4"
```

## Obsługiwane formaty

| Format | Stan |
|---|---|
| MP4, WebM, MOV, MKV, M4V… (bezpośredni plik) | ✅ wielowątkowo |
| HLS `.m3u8` (TS i fMP4, wybór jakości i ścieżki audio, BYTERANGE) | ✅ równoległe segmenty → jeden `.mp4` |
| HLS na żywo | ✅ nagrywanie do zatrzymania |
| DASH `.mpd` (SegmentTemplate, SegmentTimeline, SegmentList, SegmentBase) | ✅ wybór jakości i audio → jeden `.mp4` |
| DASH na żywo, DASH z kilkoma okresami | ❌ na żywo nie; z kilku okresów pobierany pierwszy |
| Napisy WebVTT (HLS, DASH, `<track>` na stronie) | ✅ zapis jako `.srt` obok filmu |
| Treści z DRM / szyfrowane (Netflix, Disney+, płatne VOD…) | ❌ celowo nieobsługiwane |
| YouTube | ❌ celowo wyłączony (regulamin zabrania pobierania) |

## Ograniczenia

- Pobierane dane zajmują miejsce na dysku systemowym (w profilu przeglądarki) do chwili zapisania gotowego pliku; potem są usuwane.
- Jeżeli strona wymaga ciasteczek i nagłówka `Referer`, rozszerzenie wysyła je tak samo jak strona. Linki z tokenem, który wygasa, trzeba pobrać od razu po wykryciu – po restarcie przeglądarki wznowienie może wymagać odświeżenia strony.

## Testy

Wymagają tylko Node 18+ (bez instalowania pakietów) i – dla testów w przeglądarce – Chrome 126+. Lokalny serwer testowy symuluje wygasłe linki, błędy 403/404, zrywanie połączeń, wolne łącze, serwery bez Range, transmisję na żywo, HLS i DASH.

```bash
npm test             # silnik, parsery HLS/DASH/napisów, łączenie w MP4 – kilkanaście sekund
npm run test:remux   # łączenie w MP4 sprawdzane odtwarzaczem Chrome
npm run test:e2e     # całe rozszerzenie w Chrome działającym w tle, na tymczasowym profilu
```

Testy w Chrome same szukają przeglądarki (inną wskażesz zmienną `CHROME`). `HEADFUL=1` pokazuje okno, a `KEEP=1` zostawia profil i pobrane pliki do obejrzenia.

Nagrania testowe w `tests/fixtures/` (H.264/AAC z WebCodecs, MP4 z MediaRecorder) wygenerował Chrome; `npm run fixtures` tworzy je od nowa.

Pakując rozszerzenie do sklepu, pomiń `tests/` i `package.json` – nie są potrzebne do działania.

## Struktura

```
manifest.json        – konfiguracja (Manifest V3)
background.js        – wykrywanie filmów w ruchu sieciowym
content.js           – wykrywanie <video>, <track> i linków na stronie
popup.html/js        – lista wykrytych filmów, wybór jakości / audio / napisów
manager.html/js      – menedżer pobierania (postęp, wznawianie, łączenie, zapis)
lib/engine.js        – silnik: wielowątkowy Range, segmenty HLS/DASH, nagrywanie na żywo
lib/store.js         – pliki robocze na dysku (OPFS) + store-worker.js
lib/remux.js         – łączenie w jeden MP4 (ts.js – demultiplekser TS, mp4.js – odczyt/zapis MP4)
lib/hls.js           – parser .m3u8
lib/dash.js          – parser .mpd (xml.js – minimalny parser XML)
lib/subs.js          – napisy WebVTT → SRT
lib/net.js           – nagłówki Referer/Origin (declarativeNetRequest)
lib/media.js         – rozpoznawanie formatów, nazwy plików
lib/jobs.js          – kolejka i ustawienia
tests/               – testy (Node i Chrome) i nagrania testowe
package.json         – skrypty testów (rozszerzenie nie korzysta z Node)
```
