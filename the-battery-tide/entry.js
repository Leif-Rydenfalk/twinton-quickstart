// The Battery tide gauge, live — a deliberately narrow digital twin of one real instrument.
//
// Reality:  NOAA CO-OPS station 8518750 (The Battery, 40.7006 N, 74.0142 W), observed water level,
//           every six minutes, metres above MLLW, preliminary (q = p).
// Model:    NOAA's harmonic tide prediction for the same station, plus a surge model fitted in the
//           browser to Open-Meteo wind and pressure. The fit trains on the older part of the 48 h
//           window and is scored on the last 12 h, so the error shown is a holdout, not a backtest.
// Twin:     the observed surface (cyan), the tide prediction (amber), and tide + fitted surge
//           (violet) at the gauge. The difference between cyan and amber is the surge; the panel
//           reports both the tide-only and the twin holdout error, and says so if the surge does
//           not earn its place.
//
// The scene is an approximate massing of The Battery and the lower Manhattan shore, not a survey.
// Scenario thresholds (1.5 / 2.0 / 2.5 m MLLW) are illustrative, not official flood stages.
//
// No network beyond the manifest's data URLs; no storage; no eval. Everything is ctx.

export async function start(ctx) {
  const LAT = 40.7006, LON = -74.0142;
  const OBS_URL = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?station=8518750&product=water_level&datum=MLLW&units=metric&time_zone=gmt&format=json&range=48";
  const PRED_URL = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?station=8518750&product=predictions&datum=MLLW&units=metric&time_zone=gmt&format=json&range=48&interval=6";
  const WX_URL = "https://api.open-meteo.com/v1/forecast?latitude=40.7006&longitude=-74.0142&current=temperature_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,pressure_msl,cloud_cover&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m,pressure_msl&past_days=2&forecast_days=1&timezone=UTC";
  const BRIDGE_URL = "https://gist.githubusercontent.com/Leif-Rydenfalk/1c0dd122d6fc3aa5bb20fe2fee20f34f/raw/the-battery-tide.json";

  const C = {
    water: "#0b3550", crest: "#2d7ea8", obs: "#4fe3ff", tide: "#f5a524", twin: "#c69bff",
    bad: "#ff6b6b", land: "#151b22", walk: "#252d38", wall: "#3b4654", tree: "#2f6b4f",
    trunk: "#4a3a2a", build: "#1c2530", win: "#f2c76b", gate: "#43e08a", gauge: "#d8dee8",
  };
  const f = await ctx.local(LAT, LON);

  // ---------------------------------------------------------------- helpers
  const box = (size, at, color, emissive, heading = 0) =>
    Promise.resolve(ctx.box({ frame: f, size, at, color, emissive: emissive || "#0a0f14", heading })).catch(() => null);
  const boxA = (size, at, color, emissive, heading = 0) =>
    ctx.box({ frame: f, size, at, color, emissive: emissive || "#0a0f14", heading });
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const rad = (d) => d * Math.PI / 180;
  const utc = (s) => Date.parse(String(s).replace(" ", "T") + (String(s).includes("Z") ? "" : "Z"));
  const fmt = (v, n = 2) => (v == null || !isFinite(v) ? "—" : v.toFixed(n));

  // ---------------------------------------------------------------- model + data state
  const S = {
    obs: null, pred: null, wx: null, bridge: null, model: null,
    obsV: null, predV: null, twinV: null, surgeV: null, level: 1.2, target: 1.2,
    range: 48, surgeOn: true, gatesClosed: false, loading: false, lastLoad: 0,
    fetchedAt: null, error: null, chart: [], objects: [], crests: [],
  };

  function nearest(series, t, tol = 15 * 60e3) {
    if (!series?.length) return null;
    let lo = 0, hi = series.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (series[mid].t < t) lo = mid + 1; else hi = mid; }
    let best = series[lo];
    if (lo > 0 && Math.abs(series[lo - 1].t - t) < Math.abs(best.t - t)) best = series[lo - 1];
    return Math.abs(best.t - t) <= tol ? best : null;
  }

  function solve(A, b) {
    const n = b.length, M = A.map((r, i) => [...r, b[i]]);
    for (let i = 0; i < n; i++) {
      let p = i;
      for (let j = i + 1; j < n; j++) if (Math.abs(M[j][i]) > Math.abs(M[p][i])) p = j;
      [M[i], M[p]] = [M[p], M[i]];
      const d = M[i][i] || 1e-9;
      for (let k = i; k <= n; k++) M[i][k] /= d;
      for (let j = 0; j < n; j++) if (j !== i) {
        const g = M[j][i];
        for (let k = i; k <= n; k++) M[j][k] -= g * M[i][k];
      }
    }
    return M.map((r) => r[n]);
  }

  // A 4-parameter linear surge model: intercept + pressure anomaly + east/north wind components.
  // Units: metres of water per hPa and per km/h of wind, fitted by ridge-regularised least squares.
  function fitRows(rows) {
    if (rows.length < 12) return null;
    const A = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], b = [0, 0, 0, 0];
    for (const r of rows) {
      const x = [1, r.dp, r.u, r.v];
      for (let j = 0; j < 4; j++) { b[j] += x[j] * r.res; for (let k = 0; k < 4; k++) A[j][k] += x[j] * x[k]; }
    }
    for (let j = 0; j < 4; j++) A[j][j] += 0.01;
    return solve(A, b);
  }
  const applySurge = (c, e) => c[0] + c[1] * e.dp + c[2] * e.u + c[3] * e.v;

  function buildWeather(w) {
    if (!w?.hourly?.time?.length) return null;
    const h = w.hourly, out = { t: [], p: [], u: [], v: [], speed: [], dir: [] };
    for (let i = 0; i < h.time.length; i++) {
      const t = utc(h.time[i]);
      if (!isFinite(t)) continue;
      const speed = +h.wind_speed_10m?.[i], dir = +h.wind_direction_10m?.[i], p = +h.pressure_msl?.[i];
      if (!isFinite(speed) || !isFinite(dir) || !isFinite(p)) continue;
      out.t.push(t); out.p.push(p); out.speed.push(speed); out.dir.push(dir);
      out.u.push(-speed * Math.sin(rad(dir))); out.v.push(-speed * Math.cos(rad(dir)));
    }
    return out.t.length ? out : null;
  }
  function wxAt(t) {
    const w = S.wx; if (!w) return null;
    let lo = 0, hi = w.t.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (w.t[mid] < t) lo = mid + 1; else hi = mid; }
    let i = lo;
    if (i > 0 && Math.abs(w.t[i - 1] - t) < Math.abs(w.t[i] - t)) i--;
    return { dp: w.p[i] - w.meanP, u: w.u[i], v: w.v[i], speed: w.speed[i], dir: w.dir[i] };
  }

  function fitModel(obs, pred, wx) {
    const rows = [];
    if (!wx) return null;
    for (const o of obs) {
      const p = nearest(pred, o.t, 12 * 60e3); if (!p) continue;
      const e = wxAt(o.t); if (!e) continue;
      rows.push({ t: o.t, o: o.v, p: p.v, res: o.v - p.v, dp: e.dp, u: e.u, v: e.v });
    }
    if (rows.length < 24) return null;
    const end = rows[rows.length - 1].t;
    const train = rows.filter((r) => r.t <= end - 12 * 3600e3);
    const test = rows.filter((r) => r.t > end - 12 * 3600e3);
    if (train.length < 24 || test.length < 8) return null;
    const cWind = fitRows(train);
    // Two honest challengers to the wind fit: no surge at all, and persistence of the last three hours
    // of the training window. The twin uses the one with the lowest holdout error, and says which.
    const last6 = train.filter((r) => r.t > train[train.length - 1].t - 3 * 3600e3);
    const persist = last6.length ? last6.reduce((a, r) => a + r.res, 0) / last6.length : 0;
    const candidates = [
      { name: "tide-only", c: [0, 0, 0, 0] },
      { name: "persistence", c: [persist, 0, 0, 0] },
      ...(cWind ? [{ name: "wind/pressure", c: cWind }] : []),
    ];
    const maeOf = (c) => test.reduce((a, r) => a + Math.abs(r.o - (r.p + applySurge(c, r))), 0) / test.length;
    let best = candidates[0], maeTwin = maeOf(best.c);
    for (const k of candidates.slice(1)) { const m = maeOf(k.c); if (m < maeTwin - 1e-9) { best = k; maeTwin = m; } }
    const maeTide = maeOf(candidates[0].c);
    const bias = test.reduce((a, r) => a + (r.o - (r.p + applySurge(best.c, r))), 0) / test.length;
    const mean = test.reduce((a, r) => a + r.o, 0) / test.length;
    const ss = test.reduce((a, r) => a + (r.o - mean) ** 2, 0);
    const sr = test.reduce((a, r) => a + (r.o - (r.p + applySurge(best.c, r))) ** 2, 0);
    return { c: best.c, chosen: best.name, persist, maeTwin, maeTide, bias, n: test.length, r2: ss > 0 ? 1 - sr / ss : null, trained: train.length };
  }

  async function load(manual = false) {
    if (S.loading) return; S.loading = true;
    if (!manual) renderPanel();
    try {
      const [oj, pj, wj, bj] = await Promise.all([
        ctx.data(OBS_URL).catch(() => null),
        ctx.data(PRED_URL).catch(() => null),
        ctx.data(WX_URL).catch(() => null),
        ctx.data(BRIDGE_URL).catch(() => null),
      ]);
      const obs = (oj?.data || []).map((r) => ({ t: utc(r.t), v: +r.v })).filter((r) => isFinite(r.t) && isFinite(r.v)).sort((a, b) => a.t - b.t);
      const pred = (pj?.predictions || []).map((r) => ({ t: utc(r.t), v: +r.v })).filter((r) => isFinite(r.t) && isFinite(r.v)).sort((a, b) => a.t - b.t);
      const wx = buildWeather(wj);
      if (wx) {
        // The pressure anomaly must be measured against the same window the fit sees: hours up to the
        // last observation, never the forecast hours that are only used for the next prediction.
        const lastObs = obs.length ? obs[obs.length - 1].t : Date.now();
        const ps = wx.p.filter((_, i) => wx.t[i] <= lastObs);
        wx.meanP = (ps.length ? ps : wx.p).reduce((a, b) => a + b, 0) / (ps.length || wx.p.length);
      }
      S.obs = obs.length ? obs : null; S.pred = pred.length ? pred : null; S.wx = wx;
      // The bridge is third-party, mutable text. Coerce and bound everything before it reaches the panel.
      S.bridge = bj && typeof bj === "object" ? {
        thread: bj.thread == null ? null : String(bj.thread).slice(0, 60),
        trust: { score: Number.isFinite(+bj.trust?.score) ? +bj.trust.score : null },
        mesh: { twins: Number.isFinite(+bj.mesh?.twins) ? +bj.mesh.twins : 0, sources: Number.isFinite(+bj.mesh?.sources) ? +bj.mesh.sources : 0 },
        updated: Number.isFinite(+bj.updated) ? +bj.updated : 0,
      } : null;
      S.model = S.obs && S.pred ? fitModel(S.obs, S.pred, wx) : null;
      S.error = !S.obs || !S.pred ? "NOAA feed unavailable; the scene is static and the water is a nominal 1.20 m, not a live reading." : null;
      S.fetchedAt = Date.now();
      const last = S.obs?.[S.obs.length - 1];
      const p = last && S.pred ? nearest(S.pred, last.t, 12 * 60e3) : null;
      S.obsV = last?.v ?? null; S.predV = p?.v ?? null;
      if (last && p) {
        const e = wxAt(last.t);
        S.surgeV = e && S.model ? applySurge(S.model.c, e) : (S.model?.c?.[0] ?? 0);
        S.twinV = S.surgeOn ? p.v + S.surgeV : p.v;
        S.target = last.v;
      }
      S.chart = buildChart();
      buildChartObjects();
      updateMarkers();
      renderPanel();
    } catch (e) {
      S.error = "Feed error: " + (e?.message || e);
      renderPanel();
    } finally { S.loading = false; }
  }

  function buildChart() {
    if (!S.obs?.length) return [];
    const end = S.obs[S.obs.length - 1].t, out = [];
    for (let i = S.range - 1; i >= 0; i--) {
      const t = end - i * 3600e3;
      const o = nearest(S.obs, t, 35 * 60e3); if (!o) continue;
      const p = S.pred ? nearest(S.pred, t, 35 * 60e3) : null;
      out.push({ t, o: o.v, p: p?.v ?? null });
    }
    return out;
  }

  // ---------------------------------------------------------------- scene
  // Dynamic objects first so they exist when the animation starts.
  S.water = await boxA([1100, 0.25, 560], [0, 1.2 - 0.25, 348], C.water, "#03101c");
  S.ptrObs = await boxA([14, 0.22, 0.9], [-80, 0.4 + 1.2 * 6, 66.5], C.obs, "#1b6f86");
  S.ptrPred = await boxA([14, 0.16, 0.9], [-80, 0.4 + 1.1 * 6, 66.0], C.tide, "#6b4a0d");
  S.ptrTwin = await boxA([9, 0.12, 0.9], [-80, 0.4 + 1.2 * 6, 65.5], C.twin, "#3a2455");
  S.float = await boxA([2.2, 0.3, 2.2], [132, 0.4 + 1.2, 150], "#d8dee8", "#20252c");
  S.beacon = await boxA([2.4, 2.4, 2.4], [140, 5.8, 150], "#8a8f87", "#20252c");

  S.gates = [];
  for (const x of [-70, 70]) {
    S.gates.push(await boxA([24, 4, 0.8], [x, 0.4, 64], C.gate, "#123a24"));
  }

  S.ferry = {
    hull: await boxA([38, 3, 10], [0, 1.2, 220], "#e8ecf2", "#20252c"),
    cabin: await boxA([24, 5, 8], [0, 4.2, 220], "#cfd6df", "#20252c"),
    win: await boxA([22, 0.8, 0.2], [0, 5.4, 215.9], "#f2c76b", "#6b4a0d"),
    stack: await boxA([3, 3, 3], [8, 6.8, 220], "#f5a524", "#6b4a0d"),
  };

  // Chart bars: 48 hourly pairs, observed (cyan) and NOAA tide (amber), built once and rescaled.
  S.bars = { obs: [], pred: [] };
  const barP = [];
  for (let i = 0; i < 48; i++) {
    const x = -108 + i * 4.6;
    barP.push(boxA([1.3, 1, 1.3], [x, 0.4, -98], C.obs, "#123a44").then((h) => { S.bars.obs[i] = h; }));
    barP.push(boxA([1.3, 1, 1.3], [x, 0.4, -96], C.tide, "#4a3308").then((h) => { S.bars.pred[i] = h; }));
  }
  await Promise.all(barP);
  S.nowBar = await boxA([0.35, 18, 0.35], [108, 0.4, -94], C.bad, "#4a1010");

  // Static massing. Fire-and-forget: the host queues these behind the handles above.
  box([1000, 0.4, 720], [0, -0.2, -300], C.land);                       // land north of the seawall
  box([1000, 0.25, 60], [0, 0.15, 30], C.walk);                          // Battery promenade
  box([1000, 2.6, 8], [0, 0.4, 64], C.wall);                             // seawall, crest ~3.0 m
  box([16, 0.6, 92], [140, 0.3, 114], "#39424f");                        // gauge pier
  for (let i = 0; i < 9; i++) box([1.2, 7, 1.2], [132 + i * 2, -3, 78 + i * 8], "#2a333f");
  box([240, 18, 1.2], [0, 0.4, -101], "#10161d");                        // chart backboard
  for (const th of [1.5, 2.0, 2.5]) box([240, 0.08, 0.9], [0, 0.4 + th * 5, -95], th >= 2.5 ? C.bad : th >= 2.0 ? C.tide : "#8a8f87");
  box([240, 0.2, 1.4], [0, 0.3, -94], "#38424e");                        // chart baseline

  // The gauge house: a small, real-looking instrument shelter with a stilling well cut away.
  box([16, 5, 12], [140, 0.4, 150], C.gauge);
  box([18, 0.5, 14], [140, 5.4, 150], "#aeb7c2");
  box([4, 3, 0.3], [140, 0.6, 143.8], "#2a333f");                        // door
  box([2.5, 1.2, 0.2], [146, 3.2, 143.8], C.win, "#6b4a0d");             // window
  box([3, 7, 3], [131, 0.4, 150], "#0d1218");                            // stilling well
  box([0.3, 12, 0.3], [126, 5.4, 146], "#8a8f87");                       // sensor mast
  box([2.4, 0.2, 2.4], [126, 17.4, 146], "#b7c0ca");                     // antenna
  box([5, 0.2, 3], [135, 6, 145], "#1b3a5a", "#0a1a2a");                 // solar panel
  box([0.5, 0.5, 0.5], [126, 18, 146], "#ff5a52", "#6b1010");            // beacon lamp

  // Tide staff: 18 m tall, 6x vertical, bands at 3 m (0.5 m of water) each.
  const bands = ["#2ecc71", "#8bd17c", "#f5b041", "#e67e22", "#e74c3c", "#8e44ad"];
  for (let i = 0; i < 6; i++) box([1.8, 3, 1.8], [-80, 0.4 + i * 3, 66], bands[i], "#101418");
  box([2.4, 0.4, 2.4], [-80, 18.4, 66], "#d8dee8");

  // Castle Clinton: a low circular fort on the promenade (approximate massing).
  for (let i = 0; i < 12; i++) {
    const a = i / 12 * Math.PI * 2, x = -100 + Math.cos(a) * 22, z = 25 + Math.sin(a) * 22;
    box([10, 4.2, 1.6], [x, 0.4, z], "#6b5a45", "#1b1610", -a * 180 / Math.PI);
  }
  box([1.2, 12, 1.2], [-100, 0.4, 25], "#8a8f87");
  box([3, 0.4, 2], [-100, 12.4, 25], "#c0392b");

  // Park trees, lamps and street furniture.
  const trees = [[-300, 18], [-250, 45], [-210, 12], [-170, 40], [-40, 20], [10, 46], [55, 14], [95, 42], [200, 18], [250, 44], [300, 20], [-360, 42], [360, 40]];
  for (const [x, z] of trees) {
    box([1, 4, 1], [x, 0.4, z], C.trunk);
    box([7, 6, 7], [x, 4.4, z], C.tree, "#10251a");
    box([4.5, 2, 4.5], [x, 8.6, z], "#3d815f", "#10251a");
  }
  for (let i = 0; i < 7; i++) {
    const x = -320 + i * 105;
    box([0.4, 6, 0.4], [x, 0.4, 52], "#6f7885");
    box([1.4, 1.4, 1.4], [x, 6.3, 52], C.win, "#6b4a0d");
  }
  for (let i = 0; i < 10; i++) {
    const x = -300 + i * 66, z = 8 + (i % 3) * 12;
    box([0.55, 1.75, 0.55], [x, 0.4, z], ["#c0392b", "#2980b9", "#f1c40f", "#ecf0f1"][i % 4]);
  }

  // Lower Manhattan: approximate masses behind the Battery, not surveyed.
  const sky = [[-250, -320, 34, 120], [-210, -420, 44, 150], [-150, -300, 30, 95], [-100, -390, 48, 170],
    [-40, -330, 36, 130], [10, -430, 50, 185], [70, -360, 40, 190], [120, -450, 46, 160],
    [180, -320, 34, 110], [240, -410, 54, 150], [300, -300, 30, 90], [-300, -500, 60, 130],
    [330, -480, 44, 120], [-20, -540, 70, 100], [140, -550, 60, 110]];
  for (const [x, z, w, h] of sky) {
    box([w, h, w * 0.8], [x, 0.4, z], C.build, "#0a0f14");
    for (let i = 1; i <= 3; i++) box([w * 0.7, 1.2, 0.2], [x, h * i / 4, z + w * 0.4 + 0.2], C.win, "#6b4a0d");
  }
  box([1.6, 42, 1.6], [70, 190, -360], "#9aa3ad");                      // One World Trade-ish spire

  // A few wave crests on the water, moved in the animation.
  const crestP = [];
  for (let i = 0; i < 18; i++) {
    const x = -420 + (i * 137) % 840, z = 90 + (i * 211) % 430;
    S.crests.push({ x, z, ph: i * 0.7 });
    crestP.push(boxA([3.2, 0.07, 1.3], [x, 1.25, z], C.crest, "#0a2230").then((h) => { S.crests[i].h = h; }));
  }
  await Promise.all(crestP);

  // ---------------------------------------------------------------- panel / actions
  function gateState() {
    const v = S.obsV ?? S.level;
    if (v >= 2.5) return "overtopping (scenario)";
    if (v >= 2.0) return "gates closed (scenario)";
    if (v >= 1.5) return "walkway flooding (scenario)";
    return "open";
  }
  function bridgeState() {
    const b = S.bridge;
    if (!b) return { text: "offline", color: "#8a8f87" };
    const age = b.updated ? (Date.now() / 1000 - b.updated) : Infinity;
    if (age > 24 * 3600) return { text: `snapshot stale ${Math.round(age / 3600)}h`, color: C.tide };
    const trust = b.trust?.score == null ? "unverified" : `trust ${b.trust.score}`;
    return { text: b.thread ? `${b.thread} · ${trust}` : `snapshot · no thread yet · ${trust}`, color: C.gate };
  }
  function renderPanel() {
    const b = S.bridge, bs = bridgeState();
    const age = S.obs?.length ? Math.max(0, Math.round((Date.now() - S.obs[S.obs.length - 1].t) / 1000)) : null;
    const rows = [
      ["Observed (NOAA)", S.obsV == null ? "—" : `${fmt(S.obsV)} m MLLW`],
      ["Tide (NOAA model)", S.predV == null ? "—" : `${fmt(S.predV)} m`],
      ["Twin (selected)", S.twinV == null ? "—" : `${fmt(S.twinV)} m`],
      ["Surge, observed", S.obsV != null && S.predV != null ? `${fmt(S.obsV - S.predV)} m` : "—"],
      ["Surge, modelled", S.surgeV == null ? "—" : `${fmt(S.surgeV)} m`],
      ["Holdout MAE", S.model ? `${fmt(S.model.maeTwin, 3)} m` : "—"],
      ["Tide-only MAE", S.model ? `${fmt(S.model.maeTide, 3)} m` : "—"],
      ["Twin model", S.model ? (S.model.chosen === "tide-only" ? "tide-only (surge did not earn it)" : `${S.model.chosen}${S.model.maeTwin < S.model.maeTide ? " · beats tide-only" : " · does not beat tide-only"}`) : "—"],
      ["Vertical scale", "6× on staff + chart"],
      ["Gate (scenario)", gateState()],
      ["Observation age", age == null ? "—" : `${age} s`],
      ["Trana bridge", bs.text],
      ["Mesh (snapshot)", b?.mesh ? `${b.mesh.twins} twin · ${b.mesh.sources} source` : "—"],
    ];
    const actions = [
      { label: "Refresh", onClick: () => load(true) },
      { label: S.surgeOn ? "Surge: on" : "Surge: off", on: S.surgeOn, onClick: () => { S.surgeOn = !S.surgeOn; recompute(); renderPanel(); } },
      { label: S.range === 48 ? "48 h" : "24 h", onClick: () => { S.range = S.range === 48 ? 24 : 48; S.chart = buildChart(); buildChartObjects(); renderPanel(); } },
      { label: S.gatesClosed ? "Gates: closed" : "Gates: open", on: S.gatesClosed, onClick: () => { S.gatesClosed = !S.gatesClosed; setGates(); renderPanel(); } },
    ];
    const list = [
      { name: "NOAA CO-OPS 8518750", sub: "observed · 6 min · preliminary · m MLLW", color: C.obs },
      { name: "NOAA harmonic tide", sub: "prediction · 6 min · external model", color: C.tide },
      { name: "Open-Meteo", sub: S.wx ? "wind + pressure · hourly model" : "unavailable", color: C.twin },
      { name: "Trana bridge (snapshot)", sub: b ? `${b.thread || "no thread yet"} · ${b.trust?.score == null ? "unverified" : "trust " + b.trust.score}` : "offline", color: bs.color },
    ];
    ctx.panel({
      title: "The Battery tide gauge, live",
      sub: "One instrument, one live feed, one model: observed vs tide + surge every six minutes. Vertical scale is 6× on the staff and chart bars. Trana is ce-net's public review/thread layer; the bridge is a snapshot, not a measurement. Ferry and wave crests are illustrative. Scene is approximate massing; thresholds are scenarios.",
      rows, actions, list,
      source: S.error ? S.error : "NOAA CO-OPS station 8518750 (observed water level, preliminary), NOAA harmonic predictions, Open-Meteo wind/pressure model. Holdout = last 12 h of a 48 h fit. Bridge: public gist snapshot, schema twinton.trana/1 — social metadata, not a measurement.",
    });
  }

  function recompute() {
    if (S.obsV == null || S.predV == null) return;
    const last = S.obs[S.obs.length - 1], e = wxAt(last.t);
    S.surgeV = e && S.model ? applySurge(S.model.c, e) : (S.model?.c?.[0] ?? 0);
    S.twinV = S.surgeOn ? S.predV + S.surgeV : S.predV;
    updateMarkers();
  }

  function updateMarkers() {
    const lvl = S.obsV ?? S.level;
    if (S.ptrObs) ctx.set(S.ptrObs, { at: [-80, 0.4 + clamp(lvl, 0, 3) * 6, 66.5] });
    if (S.ptrPred && S.predV != null) ctx.set(S.ptrPred, { at: [-80, 0.4 + clamp(S.predV, 0, 3) * 6, 66.0] });
    if (S.ptrTwin && S.twinV != null) ctx.set(S.ptrTwin, { at: [-80, 0.4 + clamp(S.twinV, 0, 3) * 6, 65.5] });
    if (S.float) ctx.set(S.float, { at: [132, 0.4 + clamp(lvl, 0, 3), 150] });
    if (S.beacon) ctx.set(S.beacon, { color: bridgeState().color });
  }

  function buildChartObjects() {
    const data = S.chart;
    for (let i = 0; i < 48; i++) {
      const d = data[i];
      const hO = d ? 0.6 + clamp(d.o, 0, 3) * 5 : 0.25;
      const hP = d && d.p != null ? 0.6 + clamp(d.p, 0, 3) * 5 : 0.25;
      ctx.set(S.bars.obs[i], { visible: !!d, at: [-108 + i * 4.6, 0.4 + hO / 2, -98], scale: [1, hO, 1] });
      ctx.set(S.bars.pred[i], { visible: !!d, at: [-108 + i * 4.6, 0.4 + hP / 2, -96], scale: [1, hP, 1] });
    }
    const n = Math.max(1, data.length);
    ctx.set(S.nowBar, { visible: data.length > 0, at: [-108 + (n - 1) * 4.6, 0.4, -94] });
  }

  function setGates() {
    for (const g of S.gates) ctx.set(g, { heading: S.gatesClosed ? 90 : 0, color: S.gatesClosed ? C.bad : C.gate });
  }

  // ---------------------------------------------------------------- steps
  // The host's ctx.steps reads `at` and `view` (globe.js) to fly the camera; keep them even though
  // the minimal {title,text} shape is what the public quick start documents.
  const steps = [
    { title: "One gauge, one place", text: "NOAA station 8518750 sits at The Battery, 40.7006 N, 74.0142 W. It measures the harbor every six minutes, in metres above MLLW. The cyan surface is that observation.", at: [LAT, LON, 260], view: { heading: 18, tilt: 25 } },
    { title: "The tide is already a model", text: "The amber pointer is NOAA's harmonic tide prediction for the same moment. The gap between cyan and amber is the surge: wind, pressure and weather that the tide table cannot know.", at: [LAT, LON, 330], view: { heading: 10, tilt: 27 } },
    { title: "The twin fits the gap", text: "The twin fits the surge to Open-Meteo wind and pressure on the older 36 hours, then scores itself on the last 12. If the surge model does not beat the tide alone, the panel says so. Use the Gates button in the panel to close the scenario gates.", at: [LAT, LON, 290], view: { heading: 24, tilt: 24 } },
    { title: "A twin needs a reviewer", text: "This one carries its NOAA source, its holdout error, and a Trana bridge snapshot where people can check it. The violet pointer is tide + surge; the bridge is the social layer, and it says when it is stale.", at: [LAT, LON, 220], view: { heading: 18, tilt: 22 } },
  ];
  ctx.steps(steps);
  ctx.orbit(LAT, LON, 300, { heading: 18, tilt: 27, min: 18 });

  // ---------------------------------------------------------------- animation + live refresh
  let frame = 0, clock = 0, lastRefresh = Date.now();
  ctx.every((dt) => {
    frame++; clock += dt;
    S.level = lerp(S.level, S.target, Math.min(1, dt * 1.8));
    if (frame % 2 === 0) {
      ctx.set(S.water, { at: [0, S.level - 0.25, 348] });
      ctx.set(S.float, { at: [132, 0.4 + S.level, 150] });
    }
    if (frame % 3 === 0) {
      const t = clock, x = -300 + ((t * 4.2) % 600);
      for (const [o, dy] of [[S.ferry.hull, 0], [S.ferry.cabin, 3], [S.ferry.win, 4.2], [S.ferry.stack, 5.6]]) {
        ctx.set(o, { at: [x, S.level + dy, 220] });
      }
    }
    if (frame % 5 === 0) {
      for (const c of S.crests) {
        c.x += 0.8; if (c.x > 430) c.x = -430;
        ctx.set(c.h, { at: [c.x, S.level + 0.08 + Math.sin(frame * 0.08 + c.ph) * 0.05, c.z] });
      }
    }
    if (Date.now() - lastRefresh > 90_000) { lastRefresh = Date.now(); load(true); }
  });

  await load();
  renderPanel();
  setGates();
}
