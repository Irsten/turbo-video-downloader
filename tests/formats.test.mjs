// Format parsers: HLS (.m3u8), DASH (.mpd), WebVTT subtitles → SRT, file name template.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseM3U8, audioOptions, subtitleOptions, mediaLabel } from '../lib/hls.js';
import { parseMpd, parseDuration, dashAudioOptions, representationLabel } from '../lib/dash.js';
import { parseVtt, mergeVtt, toSrt, cleanCueText } from '../lib/subs.js';
import { vttSegments, CUES, TS_OFFSET } from './media.mjs';

// ---------------- HLS ----------------

test('HLS master: variants, audio in several languages, subtitles', () => {
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
  assert.deepEqual(audios.map((a) => a.language), ['pl', 'en'], 'default track first');
  const subs = subtitleOptions(pl, pl.variants[0]);
  assert.equal(subs.length, 2);
  assert.equal(subs[0].url, 'https://cdn.example/v/s/pl.m3u8');
  assert.equal(subs[1].forced, true);
  assert.equal(mediaLabel(audios[1]), 'English (EN)');
});

test('HLS media: segment sequence numbers and target duration', () => {
  const pl = parseM3U8(
    '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:120\n#EXTINF:6,\na.ts\n#EXTINF:6,\nb.ts\n',
    'https://x/live/index.m3u8'
  );
  assert.equal(pl.endList, false);
  assert.equal(pl.targetDuration, 6);
  assert.deepEqual(pl.segments.map((s) => s.seq), [120, 121]);
});

// ---------------- DASH ----------------

test('ISO 8601 duration', () => {
  assert.equal(parseDuration('PT1H2M3.5S'), 3723.5);
  assert.equal(parseDuration('PT0S'), 0);
  assert.equal(parseDuration('P1DT1S'), 86401);
});

test('DASH: SegmentTimeline (r=-1), BaseURL on several levels, sorting of qualities', () => {
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
    't=0 d=4000 r=1 → 0, 4000; then d=2000 until the end (10 s)'
  );
  assert.equal(Math.round(v.frameRate * 100) / 100, 29.97);
  assert.equal(representationLabel(v), '720p · 2.5 Mb/s');
  const a = mpd.audio[0];
  assert.deepEqual(a.segments.map((s) => s.url.split('/').pop()), ['seg_0000.m4s', 'seg_0001.m4s', 'seg_0002.m4s', 'seg_0003.m4s', 'seg_0004.m4s']);
  assert.equal(a.lang, 'en');
  assert.equal(a.label, 'English');
  assert.equal(dashAudioOptions(mpd).length, 1);
});

test('DASH: SegmentList with ranges, SegmentBase (whole file), DRM, subtitles', () => {
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

test('DASH: live stream and a wrong file', () => {
  assert.equal(parseMpd('<MPD type="dynamic"><Period/></MPD>', 'https://x/a.mpd').dynamic, true);
  assert.throws(() => parseMpd('<html><body>404</body></html>', 'https://x/a.mpd'), /not a DASH manifest/);
});

// ---------------- subtitles ----------------

test('WebVTT from HLS segments: X-TIMESTAMP-MAP aligned to the start of the video, no duplicates', () => {
  const cues = mergeVtt(vttSegments(), TS_OFFSET);
  assert.equal(cues.length, CUES.length, 'a cue on a segment boundary only once');
  cues.forEach((c, i) => {
    assert.ok(Math.abs(c.start - CUES[i].start) < 0.002);
    assert.ok(Math.abs(c.end - CUES[i].end) < 0.002);
  });
  // The video starts 2 s later than the subtitle reference → subtitles shifted by -2 s,
  // and a cue entirely before the start of the video disappears.
  const shifted = mergeVtt(vttSegments(), TS_OFFSET + 2);
  assert.equal(shifted.length, CUES.length - 1);
  assert.ok(Math.abs(shifted[0].start - (CUES[1].start - 2)) < 0.002);
  const cut = mergeVtt(vttSegments(), TS_OFFSET + 1);
  assert.equal(cut[0].start, 0, 'a cue started before the video start is clipped to 0');
  assert.ok(Math.abs(cut[0].end - (CUES[0].end - 1)) < 0.002);
});

test('SRT: format czasu, przecinek, znaczniki i encje', () => {
  const srt = toSrt(parseVtt('WEBVTT\n\nid1\n00:01:02.5 --> 01:00:00.000 line:90%\n<v Jan>Ala <c.yellow>ma</c> <i>kota</i> &amp; psa\n').cues);
  assert.equal(srt, '1\r\n00:01:02,500 --> 01:00:00,000\r\nAla ma <i>kota</i> & psa\r\n');
  assert.equal(cleanCueText('<b>bold</b> <00:00:01.000>more'), '<b>bold</b> more');
});

// ---------------- file name template ----------------

test('name template: variables, empty brackets, forbidden characters, defaults', async () => {
  const { applyTemplate, DEFAULT_TEMPLATE } = await import('../lib/media.js');
  const v = { title: 'Cat video', quality: '720p', file: 'video123', host: 'example.com' };
  assert.equal(applyTemplate(DEFAULT_TEMPLATE, v), 'Cat video [720p]');
  assert.equal(applyTemplate(DEFAULT_TEMPLATE, { ...v, quality: '' }), 'Cat video', 'empty [] disappears');
  assert.equal(applyTemplate('{site} - {title}', { ...v, title: 'A: B/C?' }), 'example.com - A B C');
  assert.equal(applyTemplate('{title} - {site}', { ...v, host: '' }), 'Cat video', 'a dangling separator disappears');
  assert.equal(applyTemplate('{TYTUL} ({jakość})', v), 'Cat video (720p)', 'case-insensitive; Polish names from older versions still work');
  assert.equal(applyTemplate('', { title: '', file: 'video123' }), 'video123', 'empty result → name from the address');
  assert.equal(applyTemplate('{title}', {}), 'video');
  assert.match(applyTemplate('{date} {file}', v), /^\d{4}-\d{2}-\d{2} video123$/);
  assert.equal(applyTemplate('{unknown} {title}', v), '{unknown} Cat video', 'unknown variables stay');
});

// ---------------- fixes from the code review ----------------

test('file name: cut at 120 characters without breaking an emoji', async () => {
  const { sanitizeFilename } = await import('../lib/media.js');
  const name = sanitizeFilename('a'.repeat(119) + '😀😀 end');
  assert.equal(Array.from(name).length, 120);
  assert.ok(name.endsWith('😀'));
  assert.doesNotMatch(name, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/, 'no lone surrogate');
});

test('DASH: a duration-based template without a known length is marked, not guessed', () => {
  const mpd = parseMpd(
    `<MPD type="static"><Period><AdaptationSet mimeType="video/mp4">
      <SegmentTemplate media="v/seg-$Number$.m4s" initialization="v/init.mp4" duration="2"/>
      <Representation id="v" bandwidth="1"/></AdaptationSet></Period></MPD>`,
    'https://x/a.mpd'
  );
  assert.equal(mpd.video[0].unknownLength, true);
  assert.deepEqual(mpd.video[0].segments, []);
});

test('SPS: the fixture parses; a cut SPS throws instead of giving garbage', async () => {
  const { parseSps, splitNals } = await import('../lib/ts.js');
  const { loadFixtures } = await import('./media.mjs');
  const sps = splitNals(loadFixtures().video[0].data).find((n) => (n[0] & 31) === 7);
  assert.deepEqual(parseSps(sps), { width: 320, height: 180 });
  assert.throws(() => parseSps(sps.subarray(0, 3)), /past the end/);
});
