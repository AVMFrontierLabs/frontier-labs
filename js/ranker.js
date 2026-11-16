/* Frontier Labs: "Rank every Earth site". Scores one Mars or Moon dataset against every Earth dataset in the library
 * that covers the same subject, using the same engine and the same scoring as the lab, then lists them best first. */
(function () {
'use strict';
const ENG = window.AnalogEngine, LIB = window.LAB_LIBRARY;
const box = document.getElementById('rankbox');
if (!ENG || !LIB || !box) return;
const esc = t => String(t ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const files = LIB.files, sets = LIB.sets || [];
const usable = f => f.kind === 'table' && !/^broken_/.test(f.name) && !/\bsame\b/i.test(f.note || '');
const idsOf = (world, subject) => Object.keys(files).filter(id => { const f = files[id]; return usable(f) && f.subject === subject && (world === 'earth' ? f.world === 'earth' : f.world !== 'earth') && !/^broken/.test(id); });
const subjects = ['temperature', 'topography', 'composition'].filter(s => idsOf('earth', s).length >= 2 && idsOf('celestial', s).length);
if (!subjects.length) return;

const cache = {};
const load = id => new Promise((ok, no) => {
  if (window.LAB_FILES && LAB_FILES[id]) return ok(LAB_FILES[id]);
  if (cache[id]) return cache[id].then(ok, no);
  cache[id] = new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'data/' + id + '.js'; s.onload = () => LAB_FILES[id] ? res(LAB_FILES[id]) : rej(new Error('empty')); s.onerror = () => rej(new Error('Could not load data/' + id + '.js')); document.head.appendChild(s); });
  cache[id].then(ok, no);
});
const nice = { temperature: 'Temperature', topography: 'Topography', composition: 'Surface composition' };
const opts = subjects.flatMap(s => idsOf('celestial', s).map(id => `<option value="${id}">${esc(files[id].site)} · ${nice[s]}</option>`)).join('');
box.innerHTML = `<div class="card rank">
  <h3>Rank every Earth site</h3>
  <p class="mute">Pick a Mars or Moon dataset. The lab scores it against every Earth site in the library for that subject and lists them best first, with the weakest part of each match.</p>
  <div class="rankrow"><select id="rkSel" aria-label="Mars or Moon dataset">${opts}</select><button type="button" class="go" id="rkGo">Rank Earth sites</button><span class="small mute" id="rkStat" aria-live="polite"></span></div>
  <div id="rkOut"></div>
</div>`;
const $ = id => document.getElementById(id);
const tone = p => p >= 35 ? 'var(--good)' : p >= 15 ? 'var(--warn)' : 'var(--bad)';

async function rank() {
  const cid = $('rkSel').value, cf = files[cid], subject = cf.subject, earths = idsOf('earth', subject);
  $('rkGo').disabled = true; $('rkOut').innerHTML = '';
  const rows = [];
  try {
    const crec = await load(cid);
    const cdata = ENG.parseText(crec.text, crec.name, { role: 'celestial', subject });
    let i = 0;
    for (const eid of earths) {
      $('rkStat').textContent = `Scoring ${++i} of ${earths.length}…`;
      await new Promise(r => setTimeout(r, 0));
      try {
        const erec = await load(eid), edata = ENG.parseText(erec.text, erec.name, { role: 'earth', subject });
        const set = sets.find(x => x.c === cid && x.e === eid), o = { subject, body: cf.world, bootstrap: 0 };
        if (set && set.elev) o.elevation = { from_m: set.elev[0], to_m: set.elev[1], lapseRate_K_per_km: set.elev[2] };
        const r = await ENG.analyze(cdata, edata, o);
        const weak = [...r.components].sort((a, b) => a.percent - b.percent)[0];
        rows.push({ id: eid, site: files[eid].site, score: r.likeness, verdict: r.verdict, weak, set, elev: !!(set && set.elev) });
      } catch (err) { rows.push({ id: eid, site: files[eid].site, err: err.message || String(err) }); }
    }
  } catch (err) { $('rkOut').innerHTML = `<div class="msg err"><b>Could not rank.</b><div>${esc(err.message || err)}</div></div>`; $('rkStat').textContent = ''; $('rkGo').disabled = false; return; }
  rows.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  const ok = rows.filter(r => r.score != null);
  let note = '';
  if (ok.length > 1 && ok[0].score - ok[1].score < 3) note = `<p class="small mute">${esc(ok[0].site)} and ${esc(ok[1].site)} are within 3 points, so this list cannot separate them without uncertainty ranges. Open each pair to see its full interval.</p>`;
  $('rkOut').innerHTML = `<ol class="ranklist">${rows.map((r, n) => r.err ? `<li class="rkerr"><b>${esc(r.site)}</b><span class="mute small">Skipped: ${esc(r.err)}</span></li>` : `<li>
    <span class="rkn">${n + 1}</span>
    <div class="rkmain"><div class="rkhead"><b>${esc(r.site)}</b><span class="rkv" style="color:${tone(r.score)}">${Math.round(r.score)}%</span></div>
    <div class="rkbar"><i style="width:${Math.max(1, r.score)}%;background:${tone(r.score)}"></i></div>
    <div class="small mute">${esc(r.verdict)}. Weakest part: ${esc(r.weak.name)} (${Math.round(r.weak.percent)}%).${r.elev ? ' Corrected for elevation.' : ''}</div></div>
    ${r.set && window.LAB && window.LAB.loadSet ? `<button type="button" data-set="${esc(r.set.id)}">Open in lab</button>` : '<span></span>'}</li>`).join('')}</ol>${note}
    <p class="small mute">Same engine and scoring as the lab, without the bootstrap uncertainty range, so scores can differ slightly from a full run. Map images are not ranked.</p>`;
  $('rkOut').querySelectorAll('[data-set]').forEach(b => b.onclick = () => window.LAB.loadSet(b.dataset.set));
  $('rkStat').textContent = ''; $('rkGo').disabled = false;
}
$('rkGo').onclick = rank;
})();
