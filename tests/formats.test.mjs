// Parsery formatów: HLS (.m3u8), DASH (.mpd), napisy WebVTT → SRT.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseM3U8, audioOptions, subtitleOptions, mediaLabel } from '../lib/hls.js';
import { parseMpd, parseDuration, dashAudioOptions, representationLabel } from '../lib/dash.js';
import { parseVtt, mergeVtt, toSrt, cleanCueText } from '../lib/subs.js';
import { vttSegments, CUES, TS_OFFSET } from './media.mjs';

// ---------------- HLS ----------------

test('HLS master: warianty, audio w kilku językach, napisy', () => {
  const pl = parseM3U8(
    `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",URI="en.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Polski",LANGUAGE="pl",DEFAULT=YES,URI="pl.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub",NAME="Polskie",LANGUAGE="pl",URI="s/pl.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub",NAME="English",LANGUAGE="en",FORCED=YES,URI="s/en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,AUDIO="aud",SUBTITLES="sub"
360.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080,FRAME-RATE=50,AUDIO="aud",SUBTITLES="sub"
1080.m3u8
`,
    'https://cdn.example/v/master.m3u8'
  );
  assert.equal(pl.kind, 'master');
  assert.equal(pl.variants[0].height, 1080);
  const audios = audioOptions(pl, pl.variants[0]);
  assert.deepEqual(audios.map((a) => a.language), ['pl', 'en'], 'domyślna ścieżka pierwsza');
  const subs = subtitleOptions(pl, pl.variants[0]);
  assert.equal(subs.length, 2);
  assert.equal(subs[0].url, 'https://cdn.example/v/s/pl.m3u8');
  assert.equal(subs[1].forced, true);
  assert.equal(mediaLabel(audios[1]), 'English (EN)');
});

test('HLS media: numer sekwencji segmentów i docelowa długość', () => {
  const pl = parseM3U8(
    '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:120\n#EXTINF:6,\na.ts\n#EXTINF:6,\nb.ts\n',
    'https://x/live/index.m3u8'
  );
  assert.equal(pl.endList, false);
  assert.equal(pl.targetDuration, 6);
  assert.deepEqual(pl.segments.map((s) => s.seq), [120, 121]);
});

// ---------------- DASH ----------------

test('czas ISO 8601', () => {
  assert.equal(parseDuration('PT1H2M3.5S'), 3723.5);
  assert.equal(parseDuration('PT0S'), 0);
  assert.equal(parseDuration('P1DT1S'), 86401);
});

test('DASH: SegmentTimeline (r=-1), BaseURL na kilku poziomach, sortowanie jakości', () => {
  const mpd = parseMpd(
    `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" xmlns:cenc="urn:mpeg:cenc:2013" type="static" mediaPresentationDuration="PT10S">
  <BaseURL>https://cdn.example/content/</BaseURL>
  <Period id="1">
    <BaseURL>p1/</BaseURL>
    <AdaptationSet mimeType="video/mp4" codecs="avc1.64001f" frameRate="30000/1001">
      <SegmentTemplate timescale="1000" media="$RepresentationID$/$Time$.m4s" initialization="$RepresentationID$/init-$Bandwidth$.mp4">
        <SegmentTimeline><S t="0" d="4000" r="1"/><S d="2000" r="-1"/></SegmentTimeline>
      </SegmentTemplate>
      <Representation id="v1" bandwidth="500000" width="640" height="360"/>
      <Representation id="v2" bandwidth="2500000" width="1280" height="720"/>
    </AdaptationSet>
    <AdaptationSet mimeType="audio/mp4" lang="en"><Label>English</Label>
      <SegmentTemplate media="a/seg_$Number%04d$.m4s" initialization="a/init.mp4" duration="96000" timescale="48000" startNumber="0"/>
      <Representation id="a1" bandwidth="128000"/>
    </AdaptationSet>
  </Period>
</MPD>`,
    'https://site.example/manifest.mpd'
  );
  assert.equal(mpd.duration, 10);
  assert.deepEqual(mpd.video.map((r) => r.id), ['v2', 'v1']);
  const v = mpd.video[0];
  assert.equal(v.init.url, 'https://cdn.example/content/p1/v2/init-2500000.mp4');
  assert.deepEqual(
    v.segments.map((s) => s.url.split('/').pop()),
    ['0.m4s', '4000.m4s', '8000.m4s'],
    't=0 d=4000 r=1 → 0, 4000; potem d=2000 do końca (10 s)'
  );
  assert.equal(Math.round(v.frameRate * 100) / 100, 29.97);
  assert.equal(representationLabel(v), '720p · 2.5 Mb/s');
  const a = mpd.audio[0];
  assert.deepEqual(a.segments.map((s) => s.url.split('/').pop()), ['seg_0000.m4s', 'seg_0001.m4s', 'seg_0002.m4s', 'seg_0003.m4s', 'seg_0004.m4s']);
  assert.equal(a.lang, 'en');
  assert.equal(a.label, 'English');
  assert.equal(dashAudioOptions(mpd).length, 1);
});

test('DASH: SegmentList z zakresami, SegmentBase (cały plik), DRM, napisy', () => {
  const mpd = parseMpd(
    `<MPD type="static" mediaPresentationDuration="PT6S"><Period>
      <AdaptationSet mimeType="video/mp4">
        <Representation id="v" bandwidth="1000" height="480"><BaseURL>video.mp4</BaseURL>
          <SegmentList duration="3" timescale="1">
            <Initialization range="0-799"/>
            <SegmentURL mediaRange="800-5000"/><SegmentURL mediaRange="5001-9000"/>
          </SegmentList>
        </Representation>
      </AdaptationSet>
      <AdaptationSet mimeType="audio/mp4"><ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011"/>
        <Representation id="a" bandwidth="64000"><BaseURL>audio.mp4</BaseURL><SegmentBase indexRange="0-500"/></Representation>
      </AdaptationSet>
      <AdaptationSet contentType="text" mimeType="text/vtt" lang="pl">
        <Representation id="t"><BaseURL>pl.vtt</BaseURL></Representation>
      </AdaptationSet>
    </Period></MPD>`,
    'https://x.example/m/manifest.mpd'
  );
  const v = mpd.video[0];
  assert.deepEqual(v.init, { url: 'https://x.example/m/video.mp4', range: [0, 799] });
  assert.deepEqual(v.segments.map((s) => s.range), [[800, 5000], [5001, 9000]]);
  assert.equal(mpd.audio[0].single, true);
  assert.equal(mpd.audio[0].encrypted, true);
  assert.equal(mpd.encrypted, true);
  assert.equal(mpd.text[0].container, 'vtt');
  assert.equal(mpd.text[0].url, 'https://x.example/m/pl.vtt');
});

test('DASH: transmisja na żywo i zły plik', () => {
  assert.equal(parseMpd('<MPD type="dynamic"><Period/></MPD>', 'https://x/a.mpd').dynamic, true);
  assert.throws(() => parseMpd('<html><body>404</body></html>', 'https://x/a.mpd'), /manifest DASH/);
});

// ---------------- napisy ----------------

test('WebVTT z segmentów HLS: wyrównanie X-TIMESTAMP-MAP do początku filmu, bez powtórzeń', () => {
  const cues = mergeVtt(vttSegments(), TS_OFFSET);
  assert.equal(cues.length, CUES.length, 'napis z granicy segmentów tylko raz');
  cues.forEach((c, i) => {
    assert.ok(Math.abs(c.start - CUES[i].start) < 0.002);
    assert.ok(Math.abs(c.end - CUES[i].end) < 0.002);
  });
  // Film zaczyna się 2 s później niż odniesienie napisów → napisy przesunięte o -2 s,
  // a napis w całości sprzed początku filmu znika.
  const shifted = mergeVtt(vttSegments(), TS_OFFSET + 2);
  assert.equal(shifted.length, CUES.length - 1);
  assert.ok(Math.abs(shifted[0].start - (CUES[1].start - 2)) < 0.002);
  const cut = mergeVtt(vttSegments(), TS_OFFSET + 1);
  assert.equal(cut[0].start, 0, 'napis zaczęty przed początkiem filmu obcięty do 0');
  assert.ok(Math.abs(cut[0].end - (CUES[0].end - 1)) < 0.002);
});

test('SRT: format czasu, przecinek, znaczniki i encje', () => {
  const srt = toSrt(parseVtt('WEBVTT\n\nid1\n00:01:02.5 --> 01:00:00.000 line:90%\n<v Jan>Ala <c.yellow>ma</c> <i>kota</i> &amp; psa\n').cues);
  assert.equal(srt, '1\r\n00:01:02,500 --> 01:00:00,000\r\nAla ma <i>kota</i> & psa\r\n');
  assert.equal(cleanCueText('<b>tłusty</b> <00:00:01.000>dalej'), '<b>tłusty</b> dalej');
});
