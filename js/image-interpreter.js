/* Frontier Labs: image interpreter. Works in any normal browser, with or without a server.
 *
 * The visitor adds a terrain, satellite or rover picture and presses "Interpret image". Then:
 *   1. The picture is read with FileReader, drawn on a canvas, shrunk to at most 1024 px and turned into
 *      compressed base64 (the "data:image/...;base64," prefix is removed and the real media type is kept).
 *   2. The page always measures the picture itself (colour, brightness, contrast, roughness). This runs in the browser
 *      and needs no network, so it is the demo-proof fallback.
 *   3. If a server is reachable, the picture and the audience mode go to POST api/interpret-image. The server holds the
 *      Gemini or Anthropic key, so no key is ever in the page. Any failure (no key, offline, rate limit, bad reply) quietly
 *      falls back to step 2's result.
 *
 * Nothing here runs on page load. It does not use claude.use(), the claude.ai sandbox or any call straight to an AI provider.
 * Which server to call: window.LAB_API_BASE, or <meta name="lab-api-base" content="https://your-server.example/">,
 * or the page's own folder (works with server.py).
 */
(function () {
'use strict';

const MAX_DIM = 1024;                 // longest side after resizing
const MAX_B64 = 1400000;              // keep the payload near 1 MB of base64
const MAX_FILE = 30 * 1024 * 1024;    // refuse files above this before decoding
const AI_TIMEOUT_MS = 40000;

/* ---------------- small helpers ---------------- */
const $ = id => document.getElementById(id);
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const esc = t => String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fail = (code, message) => Object.assign(new Error(message), { code });
const apiBase = () => {
  let b = window.LAB_API_BASE;
  if (b == null) { const m = document.querySelector('meta[name="lab-api-base"]'); b = m ? m.content : ''; }
  b = String(b || '');
  return b && !b.endsWith('/') ? b + '/' : b;
};

/* The audience bar keeps its choice in <body data-audience>. Auto-Detect uses the Students wording. */
const AUD_LABEL = { auto: 'Students', kids: 'Kids', students: 'Students', educators: 'Educators', scientist: 'Scientists', manager: 'Managers' };
const audience = () => {
  const id = (window.LAB_AUDIENCE && window.LAB_AUDIENCE.get && window.LAB_AUDIENCE.get()) || document.body.dataset.audience || 'auto';
  return AUD_LABEL[id] || 'Students';
};
const lang = () => { try { return (window.LAB && window.LAB.lang && window.LAB.lang()) || 'en'; } catch (e) { return 'en'; } };

/* ================= 1. browser pre-processing ================= */
function readAsDataURL(file) {
  return new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = () => no(fail('E-READ', 'The file could not be read.')); r.readAsDataURL(file); });
}
function loadImage(src) {
  return new Promise((ok, no) => { const im = new Image(); im.onload = () => ok(im); im.onerror = () => no(fail('E-DECODE', 'The browser could not open this image. Try a JPG or PNG.')); im.src = src; });
}
/* "data:image/jpeg;base64,AAAA" -> { mediaType: "image/jpeg", base64: "AAAA" } */
function splitDataURL(u) {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(u || '');
  if (!m) throw fail('E-ENCODE', 'The image could not be encoded.');
  return { mediaType: m[1].toLowerCase(), base64: m[2] };
}
/**
 * file -> { base64, mediaType, width, height, canvas, bytes }
 * opts: { maxDim (default 1024), maxB64 (default ~1.4 MB) }
 */
async function prepare(file, opts = {}) {
  const maxDim = opts.maxDim || MAX_DIM, maxB64 = opts.maxB64 || MAX_B64;
  if (!file) throw fail('E-NOFILE', 'Choose an image first.');
  const okType = /^image\/(png|jpe?g|webp|gif|bmp)$/i.test(file.type || '') || /\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name || '');
  if (!okType) throw fail('E-FORMAT', 'This file is not a supported image. Use JPG, PNG, WebP, GIF or BMP.');
  if (file.size > MAX_FILE) throw fail('E-SIZE', 'This image is larger than 30 MB. Pick a smaller one.');
  const im = await loadImage(await readAsDataURL(file));
  let w = im.naturalWidth, h = im.naturalHeight;
  if (!w || !h) throw fail('E-DECODE', 'The image has no size.');
  const k = Math.min(1, maxDim / Math.max(w, h));
  w = Math.max(1, Math.round(w * k)); h = Math.max(1, Math.round(h * k));
  const draw = (cw, ch) => {
    const cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
    const g = cv.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, cw, ch);   // transparent pixels become black, not undefined
    g.imageSmoothingQuality = 'high'; g.drawImage(im, 0, 0, cw, ch); return cv;
  };
  let cv = draw(w, h), out = null;
  const isPng = /png/i.test(file.type || '') || /\.png$/i.test(file.name || '');
  if (isPng && w * h <= 700000) { try { out = splitDataURL(cv.toDataURL('image/png')); } catch (e) { out = null; } if (out && out.base64.length > maxB64) out = null; }
  for (let q = 0.86, tries = 0; !out && tries < 8; tries++) {
    const j = splitDataURL(cv.toDataURL('image/jpeg', q));
    if (j.base64.length <= maxB64) { out = j; break; }
    if (q > 0.58) q -= 0.14; else { w = Math.max(64, Math.round(w * 0.8)); h = Math.max(64, Math.round(h * 0.8)); cv = draw(w, h); }
    if (tries === 7) out = j;
  }
  return { ...out, width: cv.width, height: cv.height, canvas: cv, bytes: Math.round(out.base64.length * 0.75) };
}

/* ================= 2. local canvas terrain analyser (deterministic) ================= */
/* Everything below uses only the picture's own pixels, so the same picture always gives the same answer. */
function analyzeLocal(srcCanvas) {
  const S = 192, k = Math.min(1, S / Math.max(srcCanvas.width, srcCanvas.height));
  const w = Math.max(8, Math.round(srcCanvas.width * k)), h = Math.max(8, Math.round(srcCanvas.height * k));
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const g = cv.getContext('2d', { willReadFrequently: true }); g.drawImage(srcCanvas, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data, n = w * h, L = new Float32Array(n), hist = new Uint32Array(256);
  let sr = 0, sg = 0, sb = 0, sL = 0, sSat = 0, ochre = 0, gray = 0, blue = 0, green = 0, white = 0, dark = 0, hueWarm = 0;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = d[p], gg = d[p + 1], b = d[p + 2], mx = Math.max(r, gg, b), mn = Math.min(r, gg, b), dl = mx - mn;
    const sat = mx ? dl / mx : 0, l = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
    L[i] = l; hist[Math.min(255, l | 0)]++; sr += r; sg += gg; sb += b; sL += l; sSat += sat;
    let hue = 0;
    if (dl) { hue = mx === r ? ((gg - b) / dl) % 6 : mx === gg ? (b - r) / dl + 2 : (r - gg) / dl + 4; hue = (hue * 60 + 360) % 360; }
    if (r > gg + 6 && gg >= b - 4 && r - b >= 32 && sat > 0.2 && hue <= 50 && l > 30 && l < 235) ochre++;   // iron-oxide red and ochre
    if (hue <= 60 && sat > 0.12) hueWarm++;
    if (sat < 0.14 && l >= 22 && l <= 238) gray++;
    if (b > r + 18 && b > gg + 6) blue++;
    if (gg > r + 10 && gg > b + 10) green++;
    if (l > 215 && sat < 0.12) white++;
    if (l < 35) dark++;
  }
  const mean = sL / n; let v = 0; for (let i = 0; i < n; i++) v += (L[i] - mean) * (L[i] - mean);
  const sd = Math.sqrt(v / n);
  const pct = q => { let t = 0, target = q * n; for (let i = 0; i < 256; i++) { t += hist[i]; if (t >= target) return i; } return 255; };
  const p5 = pct(0.05), p95 = pct(0.95);
  let ent = 0; for (let i = 0; i < 256; i++) if (hist[i]) { const q = hist[i] / n; ent -= q * Math.log2(q); }
  /* Sobel gradient on luminance (0 to 1) for roughness, and a hard-edge test for crater rims and shadows */
  let gs = 0, strong = 0, cnt = 0, hard = 0, hcnt = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x, a = L[i - w - 1], b = L[i - w], c = L[i - w + 1], dd = L[i - 1], f = L[i + 1], gA = L[i + w - 1], hB = L[i + w], iC = L[i + w + 1];
    const gx = (c + 2 * f + iC) - (a + 2 * dd + gA), gy = (gA + 2 * hB + iC) - (a + 2 * b + c), m = Math.hypot(gx, gy) / (4 * 255);
    gs += m; cnt++; if (m > 0.18) strong++;
    if (x + 3 < w && y + 3 < h) { hcnt++; if (Math.abs(L[i] - L[i + 3]) > 70 || Math.abs(L[i] - L[i + 3 * w]) > 70) hard++; }
  }
  const grad = gs / cnt, edgeFrac = strong / cnt, hardFrac = hard / hcnt;
  const M = {
    brightness: mean / 255, contrast: sd / 255, spread: (p95 - p5) / 255, entropy: ent / 8, saturation: sSat / n,
    ochre: ochre / n, warm: hueWarm / n, gray: gray / n, blue: blue / n, green: green / n, white: white / n, dark: dark / n,
    redBlue: (sr / n) / Math.max(1, sb / n), roughness: clamp((grad - 0.015) / 0.11), edges: edgeFrac, hardEdges: hardFrac,
    craterRelief: clamp(hardFrac / 0.05), meanRGB: [Math.round(sr / n), Math.round(sg / n), Math.round(sb / n)],
  };
  /* analog scores, 0 to 100 */
  const notEarth = 1 - clamp(M.green * 3.5) * 0.8 - clamp(M.blue * 3) * 0.6;
  const marsRaw = 0.46 * clamp(M.ochre / 0.45) + 0.24 * clamp((M.redBlue - 1.0) / 0.6) + 0.16 * clamp(M.warm / 0.7) + 0.14 * (1 - clamp(M.gray / 0.8));
  const moonRaw = 0.42 * clamp((M.gray - 0.25) / 0.55) + 0.2 * (1 - clamp(M.ochre / 0.3)) + 0.2 * M.craterRelief + 0.18 * (1 - clamp(M.saturation / 0.3));
  const mars = Math.round(100 * clamp(marsRaw * clamp(notEarth, 0.15, 1)));
  const moon = Math.round(100 * clamp(moonRaw * clamp(notEarth, 0.15, 1)));
  let best = mars < 30 && moon < 30 ? 'Neither' : Math.abs(mars - moon) < 10 ? 'Mixed' : mars > moon ? 'Mars' : 'Moon';
  /* terrain label */
  let terrain;
  if (M.white > 0.35) terrain = 'Snow, ice or very bright surface';
  else if (M.green > 0.2) terrain = 'Vegetated Earth landscape';
  else if (M.blue > 0.3) terrain = 'Water or open sky';
  else if (M.craterRelief > 0.6 && M.contrast > 0.18) terrain = 'Cratered or strongly shadowed relief';
  else if (M.roughness > 0.6) terrain = 'Rocky, blocky ground';
  else if (M.roughness < 0.2) terrain = 'Smooth plain or fine dust';
  else terrain = 'Gently rough ground';
  let moonType = null;
  if (best === 'Moon' || best === 'Mixed') moonType = M.brightness < 0.37 ? 'mare-like (dark basalt plain)' : M.brightness > 0.5 && M.roughness > 0.4 ? 'highland-like (bright and rugged)' : 'mixed mare and highland tones';
  const margin = Math.abs(mars - moon), top = Math.max(mars, moon);
  const confidence = best === 'Neither' || best === 'Mixed' ? 'Low' : top >= 60 && margin >= 25 ? 'Medium' : 'Low';
  const sites = best === 'Mars'
    ? [{ name: 'Atacama Desert (Yungay)', why: 'Dry, oxidised, red-brown soils are the classic Mars stand-in.' }, { name: 'Utah desert (MDRS)', why: 'Rust-coloured sandstone and clay beds with the Mars Desert Research Station on site.' }]
    : best === 'Moon'
      ? [{ name: 'Mauna Kea (Hawaii)', why: 'Grey volcanic cinders are used to test Moon rovers and dust handling.' }, { name: 'Devon Island (Haughton crater)', why: 'A cold, grey impact crater with rugged relief.' }]
      : best === 'Mixed'
        ? [{ name: 'Devon Island (Haughton crater)', why: 'Has both grey impact rock and rust-coloured weathered layers.' }, { name: 'Hawaii volcanic fields', why: 'Dark basalt with oxidised red cinder cones.' }]
        : [{ name: 'Death Valley', why: 'Barren and dry. A closer scene would test better than this one.' }];
  const caveats = ['This reads colour, brightness and texture only. It is a screening step, not a measurement of minerals.'];
  if (M.green > 0.12) caveats.push('Green areas suggest plants, which no Mars or Moon surface has.');
  if (M.blue > 0.2) caveats.push('Blue areas may be sky or water, which can lower the match.');
  if (M.brightness < 0.1 || M.brightness > 0.9) caveats.push('The picture is very dark or very bright, so colour readings are less reliable.');
  return { source: 'local', mars, moon, best, terrain, moonType, confidence, metrics: M, sites, caveats, width: w, height: h };
}

/* ---------- plain-language write-up for each audience ---------- */
const P = x => Math.round(100 * x) + '%';
function narrate(a, aud) {
  const M = a.metrics, b = a.best, red = P(M.ochre), gry = P(M.gray), rough = M.roughness < 0.25 ? 'smooth' : M.roughness < 0.6 ? 'moderately rough' : 'very rough';
  const name = b === 'Neither' ? 'neither Mars nor the Moon' : b === 'Mixed' ? 'both Mars and the Moon' : b === 'Mars' ? 'Mars' : 'the Moon';
  const why = b === 'Mars' ? `${red} of the pixels are rusty red or ochre and the average colour leans red.`
    : b === 'Moon' ? `${gry} of the pixels are grey with little colour, and the shadows are sharp.`
    : b === 'Mixed' ? `It has ${red} rust-coloured pixels and ${gry} grey ones, so it sits between the two.`
    : 'It does not have the red dust of Mars or the grey, sharp shadows of the Moon.';
  const T = {
    Kids: {
      headline: b === 'Mars' ? 'This picture looks a lot like Mars!' : b === 'Moon' ? 'This picture looks a lot like the Moon!' : b === 'Mixed' ? 'This picture looks a bit like Mars and a bit like the Moon.' : 'This looks like a place on Earth, not Mars or the Moon.',
      summary: b === 'Mars' ? `The ground is red and dusty, just like the planet Mars. Mars is red because its dust is full of rust. About ${red} of this picture is rusty colours.`
        : b === 'Moon' ? `The ground is grey and the shadows are sharp, just like the Moon. The Moon has no air, so its shadows look very dark. About ${gry} of this picture is grey.`
        : b === 'Mixed' ? `Some of the ground is rusty and some is grey. Real explorers look for places like this to practise.`
        : `The colours look like ordinary Earth ground. Try a picture with red dust or grey craters and see what changes.` },
    Students: {
      headline: b === 'Neither' ? 'The surface matches neither Mars nor the Moon well.' : b === 'Mixed' ? 'The surface shows traits of both Mars and the Moon.' : `The surface looks more like ${name}.`,
      summary: `${why} The ground looks ${rough} and the terrain reads as ${a.terrain.toLowerCase()}. Mars scores ${a.mars}% and the Moon scores ${a.moon}% on colour and texture.` },
    Educators: {
      headline: b === 'Neither' ? 'This scene is not a good Mars or Moon stand-in.' : b === 'Mixed' ? 'This scene is a mixed Mars and Moon analog.' : `This scene works as a ${name === 'Mars' ? 'Mars' : 'Moon'} analog.`,
      summary: `${why} Mars scores ${a.mars}% and the Moon ${a.moon}%. Classroom idea: print the picture, have pupils mark red, grey and shadowed areas, then compare their counts with the percentages here.` },
    Scientists: {
      headline: `Colour and albedo screening: ${b === 'Mixed' ? 'ambiguous' : b === 'Neither' ? 'no clear analog' : b + '-like'} (Mars ${a.mars}, Moon ${a.moon}).`,
      summary: `Mean albedo proxy ${P(M.brightness)}, luminance contrast ${P(M.contrast)}, red to blue ratio ${M.redBlue.toFixed(2)}, iron-oxide hue fraction ${red}, low-saturation fraction ${gry}. Roughness index ${M.roughness.toFixed(2)}, hard-edge shadow fraction ${P(M.hardEdges)}.${a.moonType ? ' Tones read as ' + a.moonType + '.' : ''} Confirm with calibrated multispectral or spectral data before drawing mineral conclusions.` },
    Managers: {
      headline: b === 'Neither' ? 'Bottom line: this site is a weak stand-in.' : b === 'Mixed' ? 'Bottom line: usable for some tests, not a clean match.' : `Bottom line: this site is a plausible ${name === 'Mars' ? 'Mars' : 'Moon'} stand-in.`,
      summary: `${why} Confidence is ${a.confidence.toLowerCase()}. This is a quick visual screen that costs nothing to repeat. If the site matters to a decision, back it with a data comparison in the lab.` },
  };
  const t = T[aud] || T.Students;
  const findings = [
    `Rust and ochre colour: ${red} of pixels`, `Grey, low-colour ground: ${gry}`, `Ground texture: ${rough} (index ${M.roughness.toFixed(2)})`,
    `Shadow and crater contrast: ${M.craterRelief < 0.25 ? 'low' : M.craterRelief < 0.6 ? 'moderate' : 'high'}`,
  ];
  return { headline: t.headline, summary: t.summary, findings };
}

/* ================= 3. server call (optional) ================= */
async function callServer(prep, aud, local) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), AI_TIMEOUT_MS);
  try {
    const m = local.metrics;
    const res = await fetch(apiBase() + 'api/interpret-image', {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: ctl.signal,
      body: JSON.stringify({
        image: { base64: prep.base64, mediaType: prep.mediaType }, audience: aud, language: lang(),
        metrics: { ochre_fraction: +m.ochre.toFixed(3), gray_fraction: +m.gray.toFixed(3), green_fraction: +m.green.toFixed(3), blue_fraction: +m.blue.toFixed(3), brightness: +m.brightness.toFixed(3), contrast: +m.contrast.toFixed(3), roughness_index: +m.roughness.toFixed(3), local_mars_score: local.mars, local_moon_score: local.moon },
      }),
    });
    if (!res.ok) throw fail('E-SERVER', 'Server answered ' + res.status);
    const j = await res.json();
    if (!j || !j.result || !j.result.headline || !j.result.summary) throw fail('E-REPLY', 'The server reply was empty.');
    return { ...j.result, provider: j.provider };
  } finally { clearTimeout(timer); }
}

/* ================= 4. the card ================= */
const PROV = { gemini: 'Google Gemini', anthropic: 'Claude', openai: 'AI' };
const ST = { file: null, prep: null, busy: false, last: null };

function mount() {
  const host = $('imgsec'); if (!host) return;
  host.innerHTML = `<div class="wrap"><div class="card ii">
    <h2 class="ii-h">Image interpreter</h2>
    <p class="mute" id="iiLede">Add a terrain, satellite or rover picture. The lab reads its colour and texture and says whether it looks more like Mars or the Moon.</p>
    <div class="ii-row">
      <div class="ii-pick">
        <label class="drop ii-drop" id="iiDrop" tabindex="0" role="button" aria-label="Choose an image"><input type="file" id="iiFile" accept="image/*" hidden><b>Drop an image here or click to choose</b><span class="small mute" id="iiHint">JPG, PNG, WebP, GIF or BMP. Large pictures are shrunk for you.</span></label>
        <div class="fname" id="iiName"></div>
        <div class="ii-thumbwrap hidden" id="iiThumbWrap"><img id="iiThumb" alt="Preview of the chosen image"></div>
      </div>
      <div class="ii-side">
        <div class="ii-mode small mute">Written for: <b id="iiAud"></b></div>
        <label class="ii-off small"><input type="checkbox" id="iiOffline"> Offline mode (measure the picture here, no AI)</label>
        <div class="actions"><button class="go big" id="iiGo" type="button" disabled>Interpret image</button><span id="iiStatus" class="small mute" aria-live="polite"></span></div>
      </div>
    </div>
    <div id="iiErr"></div>
    <div id="iiOut" class="ii-out" aria-live="polite"></div>
  </div></div>`;
  const drop = $('iiDrop'), inp = $('iiFile');
  drop.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inp.click(); } };
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); }; drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer && e.dataTransfer.files[0]; if (f) choose(f); };
  inp.onchange = () => { if (inp.files[0]) choose(inp.files[0]); };
  $('iiGo').onclick = run;
  refreshAudience();
  window.addEventListener('lab:audience', () => { refreshAudience(); if (ST.last) paint(ST.last.result, ST.last.local, ST.last.note); });
}
const refreshAudience = () => { const el = $('iiAud'); if (el) el.textContent = audience(); };
const say = (t, spin) => { $('iiStatus').innerHTML = (spin ? '<span class="spin"></span> ' : '') + esc(t); };
const showErr = (title, body) => { $('iiErr').innerHTML = `<div class="msg err"><b>${esc(title)}</b>${body ? `<div class="fix">${esc(body)}</div>` : ''}</div>`; };

async function choose(file) {
  $('iiErr').innerHTML = ''; $('iiOut').innerHTML = ''; ST.last = null; ST.prep = null; ST.file = file;
  $('iiName').textContent = file.name; $('iiGo').disabled = true; say('Preparing the image…', true);
  try {
    ST.prep = await prepare(file);
    $('iiThumb').src = 'data:' + ST.prep.mediaType + ';base64,' + ST.prep.base64; $('iiThumbWrap').classList.remove('hidden');
    $('iiName').textContent = `${file.name} · ${ST.prep.width}×${ST.prep.height} ${ST.prep.mediaType.replace('image/', '').toUpperCase()}, ${Math.round(ST.prep.bytes / 1024)} KB`;
    $('iiGo').disabled = false; say('');
  } catch (e) { say(''); $('iiThumbWrap').classList.add('hidden'); showErr(e.message || 'The image could not be prepared.', 'Try another picture.'); }
}

async function run() {
  if (!ST.prep || ST.busy) return;
  ST.busy = true; $('iiGo').disabled = true; $('iiErr').innerHTML = '';
  const aud = audience();
  let local;
  try { say('Measuring the picture…', true); local = analyzeLocal(ST.prep.canvas); }
  catch (e) { ST.busy = false; $('iiGo').disabled = false; say(''); showErr('The picture could not be measured.', e.message); return; }
  let remote = null, note = '';
  if (!$('iiOffline').checked) {
    try { say('Asking the AI…', true); remote = await callServer(ST.prep, aud, local); }
    catch (e) { note = e && e.name === 'AbortError' ? 'The AI took too long, so the lab measured the picture itself.' : 'No AI is connected right now, so the lab measured the picture itself.'; }
  } else note = 'Offline mode: measured in your browser.';
  const result = remote ? { ...remote, source: 'ai' } : { source: 'local', ...narrate(local, aud), best_analog: local.best, mars_score: local.mars, moon_score: local.moon, terrain: local.terrain + (local.moonType ? ', ' + local.moonType : ''), suggested_sites: local.sites, confidence: local.confidence, caveats: local.caveats };
  ST.last = { result, local, note, aud };
  paint(result, local, note);
  say(''); ST.busy = false; $('iiGo').disabled = false;
}

function paint(r, local, note) {
  /* If the audience changed after an offline run, rewrite the text for the new audience. AI text stays as it was written. */
  if (r.source === 'local') { const n = narrate(local, audience()); r = { ...r, headline: n.headline, summary: n.summary, findings: n.findings }; }
  const mars = r.mars_score != null ? Math.round(r.mars_score) : local.mars, moon = r.moon_score != null ? Math.round(r.moon_score) : local.moon, M = local.metrics;
  const col = v => v >= 60 ? 'var(--good)' : v >= 30 ? 'var(--warn)' : 'var(--bad)';
  const bar = (name, v, c) => `<div class="ii-bar"><span>${name}</span><span class="v">${v}%</span><span class="t"><i style="width:${Math.max(1, v)}%;background:${c}"></i></span></div>`;
  const src = r.source === 'ai' ? `AI vision: ${esc(PROV[r.provider] || 'AI')}, cross-checked with pixel measurements` : 'Measured from the picture in your browser';
  const rows = [['Rust and ochre pixels', P(M.ochre)], ['Grey, low-colour pixels', P(M.gray)], ['Average brightness', P(M.brightness)], ['Contrast', P(M.contrast)], ['Red to blue ratio', M.redBlue.toFixed(2)], ['Roughness index (0 to 1)', M.roughness.toFixed(2)], ['Hard shadow edges', P(M.hardEdges)], ['Green pixels', P(M.green)], ['Blue pixels', P(M.blue)]];
  $('iiOut').innerHTML = `
    <div class="ii-top"><span class="ii-badge">${esc(src)}</span>${note ? `<span class="small mute">${esc(note)}</span>` : ''}</div>
    <h3 class="ii-head" style="color:${r.best_analog === 'Neither' ? 'var(--bad)' : r.best_analog === 'Mixed' ? 'var(--warn)' : 'var(--good)'}">${esc(r.headline)}</h3>
    <p class="ii-sum">${esc(r.summary)}</p>
    <div class="ii-grid">
      <div><h4>Likeness</h4>${bar('Mars', mars, col(mars))}${bar('The Moon', moon, col(moon))}
        <p class="small mute">Terrain: ${esc(r.terrain || local.terrain)}. Confidence: ${esc(r.confidence || local.confidence)}.</p></div>
      <div><h4>What stands out</h4><ul class="ii-list">${(r.findings && r.findings.length ? r.findings : narrate(local, audience()).findings).map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>
    </div>
    ${r.suggested_sites && r.suggested_sites.length ? `<h4>Closest places on Earth to test</h4><ul class="ii-list">${r.suggested_sites.map(s => `<li><b>${esc(s.name)}</b>${s.why ? ' ' + esc(s.why) : ''}</li>`).join('')}</ul>` : ''}
    <details class="ii-meas"><summary>Pixel measurements</summary><div class="scroll"><table class="stack"><tbody>${rows.map(x => `<tr><td style="text-align:left">${x[0]}</td><td>${x[1]}</td></tr>`).join('')}</tbody></table></div></details>
    ${r.caveats && r.caveats.length ? `<p class="small mute ii-cav">${r.caveats.map(esc).join(' ')}</p>` : ''}`;
}

/* One exported helper, so the map-legend reader in js/app.js can send a properly sized picture too. */
window.LabImage = { prepare, analyzeLocal };

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();
