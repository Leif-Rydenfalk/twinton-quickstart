// Starter tide gauge — copy this, change the station, keep the shape.
// Reality: NOAA observed water level. Model: NOAA harmonic prediction. The gap is the surge.
// The scene is a pier, a gauge house and the water surface; the chart is made of boxes.
const LAT = 37.8063, LON = -122.4659;
const OBS = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?station=9414290&product=water_level&datum=MLLW&units=metric&time_zone=gmt&format=json&range=24";
const PRED = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?station=9414290&product=predictions&datum=MLLW&units=metric&time_zone=gmt&format=json&range=24&interval=6";

export async function start(ctx) {
  const f = await ctx.local(LAT, LON);
  const box = (size, at, color, emissive) => ctx.box({ frame: f, size, at, color, emissive });
  const water = await box([500, 0.2, 320], [0, 0.8, 180], "#0b3550", "#03101c");
  box([500, 0.3, 40], [0, 0.1, 20], "#252d38");                 // promenade
  box([500, 1.8, 6], [0, 0.3, 42], "#3b4654");                  // seawall
  box([12, 0.4, 70], [80, 0.3, 80], "#39424f");                 // pier
  box([12, 5, 9], [80, 0.5, 120], "#d8dee8");                   // gauge house
  box([14, 0.4, 11], [80, 5.5, 120], "#aeb7c2");
  box([0.3, 10, 0.3], [74, 5.5, 116], "#8a8f87");               // mast
  const ptr = await box([8, 0.18, 0.7], [-70, 0.4 + 1.2 * 5, 42.5], "#4fe3ff", "#1b6f86");
  const ptr2 = await box([8, 0.14, 0.7], [-70, 0.4 + 1.1 * 5, 42.0], "#f5a524", "#6b4a0d");
  const bars = [];
  for (let i = 0; i < 24; i++) bars.push(await box([1.2, 1, 1.2], [-48 + i * 4, 0.4, 36], "#4fe3ff", "#123a44"));

  let obs = null, pred = null;
  const load = async () => {
    const [oj, pj] = await Promise.all([ctx.data(OBS).catch(() => null), ctx.data(PRED).catch(() => null)]);
    const parse = (rows) => (rows || []).map((r) => ({ t: Date.parse(r.t.replace(" ", "T") + "Z"), v: +r.v })).filter((r) => isFinite(r.t) && isFinite(r.v)).sort((a, b) => a.t - b.t);
    obs = parse(oj?.data); pred = parse(pj?.predictions);
    const last = obs[obs.length - 1], p = pred.length ? pred.reduce((a, b) => Math.abs(b.t - last.t) < Math.abs(a.t - last.t) ? b : a) : null;
    const o = last?.v, pr = p?.v;
    if (o != null) ctx.set(water, { at: [0, o - 0.2, 180] });
    if (o != null) ctx.set(ptr, { at: [-70, 0.4 + Math.max(0, Math.min(3, o)) * 5, 42.5] });
    if (pr != null) ctx.set(ptr2, { at: [-70, 0.4 + Math.max(0, Math.min(3, pr)) * 5, 42.0] });
    for (let i = 0; i < bars.length; i++) {
      const r = obs[obs.length - bars.length + i], v = r?.v ?? 0, h = 0.5 + Math.max(0, Math.min(3, v)) * 4;
      ctx.set(bars[i], { at: [-48 + i * 4, 0.4 + h / 2, 36], scale: [1, h, 1] });
    }
    ctx.panel({
      title: "Starter tide gauge",
      sub: "The cyan surface is the observed water level; the amber pointer is the harmonic tide prediction. The gap is the surge.",
      rows: [
        ["Observed", o == null ? "—" : o.toFixed(2) + " m MLLW"],
        ["Tide (model)", pr == null ? "—" : pr.toFixed(2) + " m"],
        ["Surge (obs − tide)", o == null || pr == null ? "—" : (o - pr).toFixed(2) + " m"],
        ["Station", "9414290 · San Francisco"],
        ["Age", last ? Math.round((Date.now() - last.t) / 1000) + " s" : "—"],
      ],
      source: "NOAA CO-OPS observed water level and harmonic predictions, m MLLW, preliminary. Scene is approximate.",
    });
  };
  await load();
  ctx.steps([
    { title: "One gauge", text: "A real NOAA station, one observed water level every six minutes.", at: [LAT, LON, 160] },
    { title: "One model", text: "The amber pointer is the harmonic tide prediction. The gap is the surge the tide table cannot know.", at: [LAT, LON, 220] },
  ]);
  ctx.orbit(LAT, LON, 180, { heading: 0, tilt: 22 });
}
