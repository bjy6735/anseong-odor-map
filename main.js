/* =================================================
   Anseong Odor Map – main.js (clean + toggle + wind)
================================================= */

window.addEventListener("DOMContentLoaded", () => {
  /* =========================
     0) 기본 설정 & 전역
  ========================= */
  const width = 900, height = 900;
  const svg = d3.select("#map");
  const tip = d3.select("#tip");
  const statusEl = document.getElementById("status");

  // ⚠️ #map은 SVG여야 함
  if (svg.empty() || svg.node().tagName.toLowerCase() !== "svg") {
    console.error("❌ #map은 <svg id='map'> 이어야 함");
    if (statusEl) statusEl.textContent = "❌ #map이 svg가 아님";
    return;
  }

  const GEOJSON = "anseong_li.geojson";
  const ODOR_CSV = "odor.csv";
  const BARNS_JSON = "barns.geojson";

  const profileSvg = d3.select("#profile");
  const pw = +profileSvg.attr("width");
  const ph = +profileSvg.attr("height");
  const cx = pw / 2;

  const mapLayer = svg.append("g").attr("class", "layer-map");
  const barnLayer = svg.append("g").attr("class", "layer-barns");

  let GEO = null;
  let ROWS = null;
  let PATHS = null;
  let COLOR = null;
  let CURRENT = null;

  let BARNS = null;
  let BARN_CIRCLES = null;
  let PROJECTION = null;
  let barnsVisible = false;

  let EXISTING_DAYS = new Set();

  let LEVELS = null;
  const LEVEL_N = 6;

  let SELECTED_HOUR = 12;

  // ✅ 누적/시간별 지도 토글
  let SHOW_ACCUMULATED_MAP = true;

  let CURRENT_WIND = null;
  let CURRENT_MODE = "day";     // day | week | all
  let CURRENT_DATE = "2025-10-01";

  /* =========================
     1) 유틸
  ========================= */
  function norm(s) {
    return (s ?? "")
      .toString()
      .normalize("NFC")
      .replace(/\uFEFF/g, "")
      .replace(/[\r\n\t]/g, "")
      .replace(/\s+/g, "")
      .trim();
  }

  function parseDateYYYYMMDD(s) {
    const [y, m, d] = String(s).split("-").map(Number);
    return new Date(y, m - 1, d);
  }

  function startOfWeek(dateObj) {
    const d = new Date(dateObj);
    const day = (d.getDay() + 6) % 7; // 월요일 시작
    d.setDate(d.getDate() - day);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function ymd(y, m, d) {
    return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }

  function parseHour(v) {
    if (v == null) return null;
    if (typeof v === "number") return v;

    const s = String(v).trim();
    if (/^\d+$/.test(s)) return +s;

    const m1 = s.match(/^(\d{1,2})\s*:/);
    if (m1) return +m1[1];

    const m2 = s.match(/^(\d{1,2})\s*시/);
    if (m2) return +m2[1];

    const m3 = s.match(/\b(\d{1,2}):\d{2}\b/);
    if (m3) return +m3[1];

    return null;
  }

  /* =========================
     1.1) 단계(색)
  ========================= */
  function buildLevelsFromValues(vals, n = 6) {
    if (!vals.length) return { thresholds: [], n };
    const qs = [];
    for (let i = 1; i < n; i++) qs.push(d3.quantile(vals, i / n));
    return { thresholds: qs, n };
  }

  function levelForValue(v) {
    if (!Number.isFinite(v) || v <= 0 || !LEVELS) return 0;
    const t = LEVELS.thresholds;
    let lvl = 1;
    while (lvl <= t.length && v > t[lvl - 1]) lvl++;
    return lvl;
  }

  function formatLevelLabel(lvl) {
    return (lvl <= 0) ? "데이터 없음" : `${lvl}단계`;
  }

  function renderLegend() {
    const el = document.getElementById("legend");
    if (!el || !LEVELS || !COLOR) return;

    el.innerHTML = "";

    const title = document.createElement("div");
    title.className = "legend-title";
    title.textContent = "level of odor";
    el.appendChild(title);

    const row = document.createElement("div");
    row.className = "legend-row";

    const makeSwatch = (label, color) => {
      const item = document.createElement("div");
      item.className = "legend-item";

      const sw = document.createElement("span");
      sw.className = "legend-swatch";
      sw.style.background = color;

      const tx = document.createElement("span");
      tx.className = "legend-text";
      tx.textContent = label;

      item.appendChild(sw);
      item.appendChild(tx);
      row.appendChild(item);
    };

    makeSwatch("level 0", "#eee");
    for (let i = 1; i <= LEVELS.n; i++) {
      const p = (i - 0.5) / LEVELS.n;
      const col = COLOR(COLOR.domain()[0] + p * (COLOR.domain()[1] - COLOR.domain()[0]));
      makeSwatch(`level ${i}`, col);
    }

    el.appendChild(row);
  }

  function setRangeLabel(text) {
    const el = document.getElementById("range-label");
    if (el) el.textContent = text || "";
  }

  /* =========================
     2) 집계 (공간) : day/week/all
  ========================= */
  function aggregate(rows, mode, selectedDateStr) {
    const sum = new Map();
    const cnt = new Map();

    let dayStart = null, dayEnd = null;

    if (mode === "day" || mode === "week") {
      const sel = parseDateYYYYMMDD(selectedDateStr);
      if (mode === "day") {
        dayStart = new Date(sel); dayStart.setHours(0, 0, 0, 0);
        dayEnd = new Date(sel); dayEnd.setHours(23, 59, 59, 999);
      } else {
        const ws = startOfWeek(sel);
        dayStart = ws;
        dayEnd = new Date(ws);
        dayEnd.setDate(ws.getDate() + 6);
        dayEnd.setHours(23, 59, 59, 999);
      }
    }

    for (const r of rows) {
      const ds = norm(r["날짜"]);
      if (!ds || ds === "2025-09-30") continue;

      if (mode !== "all") {
        const dt = parseDateYYYYMMDD(ds);
        if (dt < dayStart || dt > dayEnd) continue;
      }

      const li = norm(r["행정구역"]);
      const odor = +r["냄새지수"];
      if (!li || !Number.isFinite(odor)) continue;

      sum.set(li, (sum.get(li) || 0) + odor);
      cnt.set(li, (cnt.get(li) || 0) + 1);
    }

    const out = new Map();
    for (const [li, s] of sum.entries()) {
      const c = cnt.get(li) || 0;
      out.set(li, c ? s / c : 0);
    }
    return out;
  }

  /* =========================
     3.2) 특정 시간 슬라이스(공간)
  ========================= */
  function aggregateByHourSlice(rows, mode, baseDateStr, hour, weekRange = null) {
    const sum = new Map();
    const cnt = new Map();

    let dayStart = null, dayEnd = null;

    if (mode === "day") {
      const d = parseDateYYYYMMDD(baseDateStr);
      dayStart = new Date(d); dayStart.setHours(0, 0, 0, 0);
      dayEnd = new Date(d); dayEnd.setHours(23, 59, 59, 999);
    }

    if (mode === "week" && weekRange?.start && weekRange?.end) {
      dayStart = parseDateYYYYMMDD(weekRange.start);
      dayEnd = parseDateYYYYMMDD(weekRange.end);
      dayEnd.setHours(23, 59, 59, 999);
    }

    for (const r of rows) {
      const ds = norm(r["날짜"]);
      if (!ds || ds === "2025-09-30") continue;

      if (mode !== "all") {
        const dt = parseDateYYYYMMDD(ds);
        if (dt < dayStart || dt > dayEnd) continue;
      }

      const h = parseHour(r["시간"]);
      if (h !== hour) continue;

      const li = norm(r["행정구역"]);
      const odor = +r["냄새지수"];
      if (!li || !Number.isFinite(odor)) continue;

      sum.set(li, (sum.get(li) || 0) + odor);
      cnt.set(li, (cnt.get(li) || 0) + 1);
    }

    const out = new Map();
    for (const [li, s] of sum.entries()) {
      out.set(li, cnt.get(li) ? s / cnt.get(li) : 0);
    }
    return out;
  }

  /* =========================
     3) 집계 (시간) : 냄새
  ========================= */
  function aggregateByHour(rows, dateStr) {
    const map = new Map();

    for (const r of rows) {
      const d = norm(r["날짜"]);
      if (d !== dateStr || d === "2025-09-30") continue;

      const h = parseHour(r["시간"]);
      if (h == null || h < 0 || h > 23) continue;

      const odor = +r["냄새지수"];
      if (!Number.isFinite(odor)) continue;

      if (!map.has(h)) map.set(h, { sum: 0, count: 0 });
      map.get(h).sum += odor;
      map.get(h).count += 1;
    }

    const arr = [];
    for (let i = 0; i < 24; i++) {
      const v = map.get(i);
      arr.push(v ? v.sum / v.count : 0);
    }
    return arr;
  }

  function aggregateByHourWeek(rows, startDay, endDay) {
    const sum = Array(24).fill(0);
    const cnt = Array(24).fill(0);

    for (const r of rows) {
      const ds = norm(r["날짜"]);
      if (!ds || ds === "2025-09-30") continue;
      if (!ds.startsWith("2025-10")) continue;

      const day = parseInt(ds.slice(-2), 10);
      if (!Number.isFinite(day)) continue;
      if (day < startDay || day > endDay) continue;

      const h = parseHour(r["시간"]);
      if (h == null || h < 0 || h > 23) continue;

      const odor = +r["냄새지수"];
      if (!Number.isFinite(odor)) continue;

      sum[h] += odor;
      cnt[h] += 1;
    }

    return sum.map((s, h) => cnt[h] ? s / cnt[h] : 0);
  }

  /* =========================
     3.1) 집계 (시간) : 풍향/풍속
  ========================= */
  function aggregateWindByHour(rows, dateStr) {
    const acc = Array.from({ length: 24 }, () => ({
      dirX: 0, dirY: 0, speedSum: 0, cnt: 0
    }));

    for (const r of rows) {
      const d = norm(r["날짜"]);
      if (d !== dateStr || d === "2025-09-30") continue;

      const h = parseHour(r["시간"]);
      if (h == null || h < 0 || h > 23) continue;

      const dir = +r["풍향"];
      const spd = +r["풍속"];
      if (!Number.isFinite(dir) || !Number.isFinite(spd)) continue;

      const rad = dir * Math.PI / 180;
      acc[h].dirX += Math.cos(rad);
      acc[h].dirY += Math.sin(rad);
      acc[h].speedSum += spd;
      acc[h].cnt += 1;
    }

    return acc.map(v => {
      if (!v.cnt) return null;
      return {
        dir: Math.atan2(v.dirY, v.dirX) * 180 / Math.PI,
        speed: v.speedSum / v.cnt
      };
    });
  }

  function aggregateWindByHourWeek(rows, startDay, endDay) {
    const acc = Array.from({ length: 24 }, () => ({
      dirX: 0, dirY: 0, speedSum: 0, cnt: 0
    }));

    for (const r of rows) {
      const ds = norm(r["날짜"]);
      if (!ds || ds === "2025-09-30") continue;
      if (!ds.startsWith("2025-10")) continue;

      const day = parseInt(ds.slice(-2), 10);
      if (!Number.isFinite(day)) continue;
      if (day < startDay || day > endDay) continue;

      const h = parseHour(r["시간"]);
      if (h == null || h < 0 || h > 23) continue;

      const dir = +r["풍향"];
      const spd = +r["풍속"];
      if (!Number.isFinite(dir) || !Number.isFinite(spd)) continue;

      const rad = dir * Math.PI / 180;
      acc[h].dirX += Math.cos(rad);
      acc[h].dirY += Math.sin(rad);
      acc[h].speedSum += spd;
      acc[h].cnt += 1;
    }

    return acc.map(v => {
      if (!v.cnt) return null;
      return {
        dir: Math.atan2(v.dirY, v.dirX) * 180 / Math.PI,
        speed: v.speedSum / v.cnt
      };
    });
  }

  /* =========================
     4) 지도
  ========================= */
  function drawBaseMap(geo) {
    PROJECTION = d3.geoMercator().fitSize([width, height], geo);
    const path = d3.geoPath().projection(PROJECTION);

    PATHS = mapLayer.selectAll("path")
      .data(geo.features)
      .enter()
      .append("path")
      .attr("d", path)
      .attr("fill", "#eee")
      .attr("stroke", "#000")
      .attr("stroke-width", 0.25)
      .attr("stroke-opacity", 0.18)
      .on("mouseenter", function (event, d) {
        const sel = d3.select(this);
        sel.attr("data-prev-fill", sel.attr("fill"));
        sel.attr("fill", "#e63946");

        const name = norm(d.properties?.LI_KOR_NM);
        const v = CURRENT?.get(name) || 0;
        const lvl = levelForValue(v);

        tip.style("display", "block")
          .style("left", (event.clientX + 12) + "px")
          .style("top", (event.clientY + 12) + "px")
          .html(`<b>${name}</b><br/>평균 ${v.toFixed(2)}<br/>${formatLevelLabel(lvl)}`);
      })
      .on("mouseleave", function () {
        const sel = d3.select(this);
        const prev = sel.attr("data-prev-fill");
        if (prev != null) sel.attr("fill", prev);
        tip.style("display", "none");
      });
  }

  function applyChoropleth(mode, selectedDateStr) {
    const m = aggregate(ROWS, mode, selectedDateStr);
    CURRENT = m;

    PATHS.interrupt().transition()
      .duration(350)
      .attr("fill", d => {
        const n = norm(d.properties?.LI_KOR_NM);
        const v = m.get(n) || 0;
        return v <= 0 ? "#eee" : COLOR(v);
      });
  }

  function applyChoroplethFromMap(map) {
    CURRENT = map;

    PATHS.interrupt()
      .attr("fill", d => {
        const n = norm(d.properties?.LI_KOR_NM);
        const v = map.get(n) || 0;
        return v <= 0 ? "#eee" : COLOR(v);
      });
  }

  function currentWeekRangeFromActive() {
    const active = document.querySelector(".week-btn.active");
    if (!active) return null;

    // ✅ wk1~wk5면 id에서 숫자 뽑기
    const id = active.id || "";
    const m = id.match(/wk(\d)/);
    if (!m) return null;

    const i = +m[1];
    return getRowRangeOctober(i);
  }

  function refreshMap() {
    if (!ROWS || !PATHS) return;

    if (SHOW_ACCUMULATED_MAP) {
      applyChoropleth(CURRENT_MODE, CURRENT_DATE);
      return;
    }

    // 시간별 지도
    const weekRange = (CURRENT_MODE === "week") ? currentWeekRangeFromActive() : null;
    const hourMap = aggregateByHourSlice(
      ROWS,
      CURRENT_MODE,
      CURRENT_DATE,
      SELECTED_HOUR,
      weekRange
    );
    applyChoroplethFromMap(hourMap);
  }

  /* =========================
     4.1) 축사
  ========================= */
  function drawBarns(barns, projection) {
    if (!barns?.features?.length) return;

    const pts = barns.features
      .map(f => {
        const c = f?.geometry?.coordinates;
        if (!c || c.length < 2) return null;
        return { ...f, __xy: projection([+c[0], +c[1]]) };
      })
      .filter(f => f && f.__xy && Number.isFinite(f.__xy[0]) && Number.isFinite(f.__xy[1]));

    BARN_CIRCLES = barnLayer.selectAll("circle.barn")
      .data(pts)
      .enter()
      .append("circle")
      .attr("class", "barn")
      .attr("cx", d => d.__xy[0])
      .attr("cy", d => d.__xy[1])
      .attr("r", 0)
      .attr("opacity", 0.75)
      .attr("fill", "#e63946")
      .style("pointer-events", "none");
  }

  function showBarns() {
    if (!BARN_CIRCLES) return;

    BARN_CIRCLES.interrupt()
      .attr("r", 0).attr("opacity", 0).style("pointer-events", "none");

    BARN_CIRCLES.raise()
      .transition()
      .delay((d, i) => i * 18)
      .duration(320)
      .ease(d3.easeCubicOut)
      .attr("r", 3)
      .attr("opacity", 0.7)
      .on("end", function () {
        d3.select(this).style("pointer-events", "auto");
      });
  }

  function hideBarns() {
    if (!BARN_CIRCLES) return;

    BARN_CIRCLES.interrupt()
      .transition()
      .duration(220)
      .ease(d3.easeCubicIn)
      .attr("r", 0)
      .attr("opacity", 0)
      .on("end", function () {
        d3.select(this).style("pointer-events", "none");
      });
  }

  /* =========================
     5) 풍향/풍속 UI
  ========================= */
  const windSvg = d3.select("#wind-dir");
  const windSpeedEl = d3.select("#wind-speed");
  const C = 40;

  (function initWindUI() {
    if (windSvg.empty()) return;

    const defs = windSvg.append("defs");
    defs.append("marker")
      .attr("id", "arrowHead")
      .attr("viewBox", "0 0 10 10")
      .attr("refX", 5)
      .attr("refY", 5)
      .attr("markerWidth", 6)
      .attr("markerHeight", 6)
      .attr("orient", "auto-start-reverse")
      .append("path")
      .attr("d", "M 0 0 L 10 5 L 0 10 z")
      .attr("fill", "#222");

    windSvg.append("circle")
      .attr("cx", C).attr("cy", C)
      .attr("r", 34)
      .attr("fill", "none")
      .attr("stroke", "#ddd");

    windSvg.append("line")
      .attr("id", "wind-arrow")
      .attr("x1", C).attr("y1", C)
      .attr("x2", C).attr("y2", 10)
      .attr("stroke", "#222")
      .attr("stroke-width", 2.5)
      .attr("marker-end", "url(#arrowHead)");

    windSvg.append("circle")
      .attr("cx", C).attr("cy", C)
      .attr("r", 3)
      .attr("fill", "#222");
  })();

  function updateWindUI(w, hour) {
    if (windSvg.empty()) return;

    if (!w) {
      d3.select("#wind-arrow").attr("opacity", 0.2);
      if (windSpeedEl) windSpeedEl.textContent = `${hour}시 · 풍속 -`;
      return;
    }

    d3.select("#wind-arrow")
      .attr("opacity", 1)
      .attr("transform", `rotate(${w.dir}, ${C}, ${C})`);

    if (windSpeedEl) windSpeedEl.textContent = `${hour}시 · 풍속 ${w.speed.toFixed(1)}`;
  }

  /* =========================
     6) 시간 프로파일 + 드래그 점
  ========================= */
  function drawDailyProfile(vals) {
    profileSvg.selectAll("*").remove();

    profileSvg.append("rect")
      .attr("width", pw)
      .attr("height", ph)
      .attr("fill", "#fafafa");

    const padTop = 10;
    const padBot = 10;
    const y = d3.scaleLinear().domain([0, 23]).range([padTop, ph - padBot]);
    const x = d3.scaleLinear().domain([0, d3.max(vals) || 1]).range([0, cx - 20]);

    // ===== 가로 시간 축 =====
    const majorHours = [0, 6, 12, 18, 23];
    const minorHours = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20,22];

    // 보조선 (얇고 연함)
    profileSvg.selectAll("line.h-grid-minor")
    .data(minorHours)
    .enter()
    .append("line")
    .attr("class", "h-grid-minor")
    .attr("x1", cx - (cx - 16))
    .attr("x2", cx + (cx - 16))
    .attr("y1", d => y(d))
    .attr("y2", d => y(d))
    .attr("stroke", "#000")
    .attr("opacity", 0.05);

    // 주요선 (조금 진하게)
    profileSvg.selectAll("line.h-grid-major")
    .data(majorHours)
    .enter()
    .append("line")
    .attr("class", "h-grid-major")
    .attr("x1", cx - (cx - 16))
    .attr("x2", cx + (cx - 16))
    .attr("y1", d => y(d))
    .attr("y2", d => y(d))
    .attr("stroke", d => d === 12 ? "#e63946" : "#000")
    .attr("stroke-width", d => d === 12 ? 1.2 : 0.8)
    .attr("opacity", d => d === 12 ? 0.35 : 0.18);

    profileSvg.append("line")
      .attr("x1", cx - (cx - 16))
      .attr("x2", cx + (cx - 16))
      .attr("y1", y(12))
      .attr("y2", y(12))
      .attr("stroke", "#999")
      .attr("stroke-width", 1)
      .attr("opacity", 0.35);

    [0, 6, 12, 18, 23].forEach(h => {
      profileSvg.append("text")
        .attr("x", 6)
        .attr("y", y(h) + 4)
        .attr("font-size", 10)
        .attr("fill", "#666")
        .text(`${h}시`);
    });

    const area = d3.area()
      .x0(d => cx - x(d))
      .x1(d => cx + x(d))
      .y((d, i) => y(i))
      .curve(d3.curveBasis);

    profileSvg.append("path")
      .datum(vals)
      .attr("d", area)
      .attr("fill", "#6b8789")
      .attr("opacity", 0.11);

    const dot = profileSvg.append("circle")
      .attr("cx", cx)
      .attr("cy", y(SELECTED_HOUR))
      .attr("r", 10)
      .attr("fill", "#e63946")
      .attr("opacity", 0.75)
      .style("cursor", "grab");

    function clampY(py) {
      return Math.max(padTop, Math.min(ph - padBot, py));
    }

    function applyHourFromY(py) {
      const cy = clampY(py);
      const h = Math.round(y.invert(cy));
      const hh = Math.max(0, Math.min(23, h));

      SELECTED_HOUR = hh;
      dot.attr("cy", y(hh));

      updateWindUI(CURRENT_WIND?.[hh], hh);

      // ✅ 시간별 지도 모드일 때만 지도 갱신
      if (!SHOW_ACCUMULATED_MAP) refreshMap();
    }

    dot.call(
      d3.drag()
        .on("start", (event) => {
          dot.style("cursor", "grabbing");
          applyHourFromY(event.y);
        })
        .on("drag", (event) => {
          applyHourFromY(event.y);
        })
        .on("end", () => {
          dot.style("cursor", "grab");
          dot.transition().duration(120).attr("cy", y(SELECTED_HOUR));

          // ✅ 누적 모드면 끝나고 누적 지도로 복귀(시간별이면 그대로 유지)
          if (SHOW_ACCUMULATED_MAP) refreshMap();
        })
    );
  }

  /* =========================
     7) 달력
  ========================= */
  function getRowRangeOctober(i) {
    const year = 2025;
    const month = 9; // 0-based (10월)
    const firstOfMonth = new Date(year, month, 1);
    const startOffset = (firstOfMonth.getDay() + 6) % 7;

    const startDate = new Date(year, month, 1 + (i - 1) * 7 - startOffset);
    const endDate = new Date(startDate);
    endDate.setDate(startDate.getDate() + 6);

    const clamp = d => {
      if (d.getMonth() !== month) return null;
      return ymd(d.getFullYear(), d.getMonth() + 1, d.getDate());
    };

    return { start: clamp(startDate), end: clamp(endDate) };
  }

  function buildOctoberCalendar() {
    const cal = document.getElementById("calendar");
    if (!cal) return;

    cal.innerHTML = "";

    ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].forEach(w => {
      const d = document.createElement("div");
      d.className = "cal-dow";
      d.textContent = w;
      cal.appendChild(d);
    });

    const offset = (new Date(2025, 9, 1).getDay() + 6) % 7;
    for (let i = 0; i < offset; i++) {
      const b = document.createElement("div");
      b.className = "cal-cell disabled";
      cal.appendChild(b);
    }

    for (let day = 1; day <= 31; day++) {
      const ds = ymd(2025, 10, day);
      const c = document.createElement("div");
      c.className = "cal-cell";
      c.dataset.date = ds;
      c.textContent = day;

      if (!EXISTING_DAYS.has(day)) {
        c.classList.add("disabled");
        c.style.pointerEvents = "none";
      } else {
        c.onclick = () => {
          document.querySelectorAll(".cal-cell.selected")
            .forEach(x => x.classList.remove("selected"));
          c.classList.add("selected");

          document.querySelectorAll(".week-btn.active")
            .forEach(x => x.classList.remove("active"));

          setRangeLabel("");

          CURRENT_MODE = "day";
          CURRENT_DATE = ds;

          applyChoropleth("day", ds);
          drawDailyProfile(aggregateByHour(ROWS, ds));

          CURRENT_WIND = aggregateWindByHour(ROWS, ds);
          updateWindUI(CURRENT_WIND?.[SELECTED_HOUR], SELECTED_HOUR);

          // ✅ 토글 상태 반영
          refreshMap();
        };
      }

      cal.appendChild(c);
    }

    const firstDay = Math.min(...EXISTING_DAYS);
    const firstDs = `2025-10-${String(firstDay).padStart(2, "0")}`;
    const firstCell = cal.querySelector(`.cal-cell[data-date='${firstDs}']`);
    if (firstCell) firstCell.click();
  }

  /* =========================
     8) 로드
  ========================= */
  if (statusEl) statusEl.textContent = "로딩 중...";

  Promise.all([
    d3.json(GEOJSON),
    d3.csv(ODOR_CSV),
    d3.json(BARNS_JSON)
  ])
    .then(([geo, rows, barns]) => {
      GEO = geo;
      ROWS = rows;
      BARNS = barns;

      EXISTING_DAYS = new Set(
        ROWS
          .map(r => norm(r["날짜"]))
          .filter(d => d && d.startsWith("2025-10"))
          .map(d => parseInt(d.slice(-2), 10))
          .filter(n => Number.isFinite(n))
      );

      drawBaseMap(GEO);

      const all = aggregate(ROWS, "all", "2025-10-01");
      const vals = [...all.values()].filter(v => v > 0 && Number.isFinite(v)).sort((a, b) => a - b);

      const lo = d3.quantile(vals, 0.02) ?? 0;
      const hi = d3.quantile(vals, 0.98) ?? (d3.max(vals) || 1);

      COLOR = d3.scaleSequential()
        .domain([lo, hi])
        .interpolator(d3.interpolateYlGnBu);

      LEVELS = buildLevelsFromValues(vals, LEVEL_N);
      renderLegend();

      drawBarns(BARNS, PROJECTION);
      buildOctoberCalendar();

      // ✅ 주차 버튼
      for (let i = 1; i <= 5; i++) {
        const el = document.getElementById(`wk${i}`);
        if (!el) continue;

        el.addEventListener("click", () => {
          document.querySelectorAll(".week-btn").forEach(x => x.classList.remove("active"));
          el.classList.add("active");

          document.querySelectorAll(".cal-cell.selected").forEach(x => x.classList.remove("selected"));

          const r = getRowRangeOctober(i);
          if (!r.start || !r.end) return;

          let startDay = parseInt(r.start.slice(-2), 10);
          let endDay = parseInt(r.end.slice(-2), 10);

          while (startDay <= endDay && !EXISTING_DAYS.has(startDay)) startDay++;
          while (endDay >= startDay && !EXISTING_DAYS.has(endDay)) endDay--;

          CURRENT_MODE = "week";
          CURRENT_DATE = r.start;

          if (startDay > endDay) {
            setRangeLabel(`${i}주차 (데이터 없음)`);
            drawDailyProfile(Array(24).fill(0));
            CURRENT_WIND = Array(24).fill(null);
            updateWindUI(null, SELECTED_HOUR);
            refreshMap();
            return;
          }

          setRangeLabel(`${i}주차 (${startDay}–${endDay})`);

          // 누적 지도(기본) + 프로파일 + 풍향풍속
          applyChoropleth("week", r.start);
          drawDailyProfile(aggregateByHourWeek(ROWS, startDay, endDay));
          CURRENT_WIND = aggregateWindByHourWeek(ROWS, startDay, endDay);
          updateWindUI(CURRENT_WIND?.[SELECTED_HOUR], SELECTED_HOUR);

          refreshMap();
        });
      }

      // ✅ 전체 버튼
      document.getElementById("btn-all")?.addEventListener("click", () => {
        CURRENT_MODE = "all";
        CURRENT_DATE = "2025-10-01";

        const maxDay = Math.max(...EXISTING_DAYS);
        drawDailyProfile(aggregateByHourWeek(ROWS, 1, maxDay));

        CURRENT_WIND = aggregateWindByHourWeek(ROWS, 1, maxDay);
        updateWindUI(CURRENT_WIND?.[SELECTED_HOUR], SELECTED_HOUR);

        document.querySelectorAll(".cal-cell.selected").forEach(x => x.classList.remove("selected"));
        document.querySelectorAll(".week-btn.active").forEach(x => x.classList.remove("active"));
        setRangeLabel("");

        refreshMap();
      });

      // ✅ 축사 토글 (없어도 안 터짐)
      const barnsBtn = document.getElementById("toggle-barns");
      barnsBtn?.addEventListener("click", () => {
        barnsVisible = !barnsVisible;
        barnsBtn.classList.toggle("active", barnsVisible);
        barnsBtn.textContent = barnsVisible ? "축사 숨기기" : "축사 보기";
        if (barnsVisible) showBarns();
        else hideBarns();
      });

      // ✅ 누적/시간별 토글 (없어도 안 터짐)
      const mapToggleBtn = document.getElementById("toggle-map-view");
      if (mapToggleBtn) {
        mapToggleBtn.textContent = "누적 지도";
        mapToggleBtn.classList.toggle("active", SHOW_ACCUMULATED_MAP);

        mapToggleBtn.addEventListener("click", () => {
          SHOW_ACCUMULATED_MAP = !SHOW_ACCUMULATED_MAP;
          mapToggleBtn.textContent = SHOW_ACCUMULATED_MAP ? "누적 지도" : "시간별 지도";
          mapToggleBtn.classList.toggle("active", SHOW_ACCUMULATED_MAP);
          refreshMap();
        });
      }

      if (statusEl) statusEl.textContent = "준비됨";
    })
    .catch(err => {
      console.error(err);
      if (statusEl) statusEl.textContent = "로드 실패 (콘솔 확인)";
    });
});
