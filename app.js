/* global L, jspdf, html2canvas, proj4, geomag, PDFLib */

(function () {
  "use strict";

  let warnedGeomagMissing = false;
  let mapMagneticLayoutRetries = 0;

  /** UTM zone 55S / WGS 84 — suited to ACT and other areas in zone 55 south of the equator */
  const EPSG32755 = "EPSG:32755";

  /** Raster resolution for PDF map capture (pixels per inch). */
  const EXPORT_RASTER_DPI = 300;

  /** Upper bound for html2canvas `scale` when the map fits in EXPORT_CAPTURE_MAX_EDGE_PX. */
  const EXPORT_HTML2CANVAS_SCALE_MAX = 2;

  /** Raster canvas long-edge cap; keep ≥ EXPORT_MAP_MAX_LONG_EDGE_PX. */
  const EXPORT_CAPTURE_MAX_EDGE_PX = 16384;
  /** Print map CSS px multiplier vs paper@DPI; capped by EXPORT_MAP_MAX_LONG_EDGE_PX. */
  const EXPORT_FIT_ZOOM_PIXEL_SCALE = 4;
  /** Print map max(width,height) in CSS px. */
  const EXPORT_MAP_MAX_LONG_EDGE_PX = 16384;
  /** After fitPxScale, multiply W×H by 2^n (~+n zoom for same bounds). */
  const EXPORT_PDF_EXTRA_ZOOM_LEVELS = 1;
  /** Max bitmap long edge before JPEG embed (jsPDF PNG path breaks on huge images). */
  const EXPORT_JSPDF_MAX_IMAGE_LONG_EDGE_PX = 4096;
  const EXPORT_PDF_JPEG_QUALITY = 0.93;
  /** Non–scale-table PDF tiles: load this many levels below display z (fewer requests, softer). */
  const EXPORT_PDF_TILE_LEVELS_COARSER = 3;

  /**
   * Optional fixed zoom per `1:scaleDen`; tune to your tiles. `{}` ⇒ fitBounds only.
   * See EXPORT_PDF_ZOOM_TABLE_STRICT if z is below extent-fit.
   */
  const EXPORT_PDF_ZOOM_BY_SCALE_DEN = {
    5000: 17,
    10000: 16,
    15000: 16,
    25000: 15,
    50000: 14,
    100000: 13,
    250000: 12,
  };

  /**
   * If false: may **raise** table zoom to `getBoundsZoom(export bounds)` so the orange extent fills the
   * print map (good when the table was only a rough guess). If true: use the table zoom exactly —
   * needed when values are set from **tile pyramid / label scale** (e.g. z15 for 1:25k) even if that
   * letterboxes on the large export canvas; crop-to-bounds still trims the PDF to the orange extent.
   */
  const EXPORT_PDF_ZOOM_TABLE_STRICT = true;

  /**
   * @param {number} scaleDen
   * @returns {number | null}
   */
  function pdfZoomFromScaleDenTable(scaleDen) {
    if (!EXPORT_PDF_ZOOM_BY_SCALE_DEN || typeof EXPORT_PDF_ZOOM_BY_SCALE_DEN !== "object") return null;
    if (!Object.prototype.hasOwnProperty.call(EXPORT_PDF_ZOOM_BY_SCALE_DEN, scaleDen)) return null;
    const z = Number(EXPORT_PDF_ZOOM_BY_SCALE_DEN[scaleDen]);
    return Number.isFinite(z) ? z : null;
  }

  /**
   * @param {L.Map} leafletMap
   * @param {L.LatLngBounds} b
   * @param {number} [marginPx]
   * @returns {boolean}
   */
  function exportBoundsFullyInMapViewport(leafletMap, b, marginPx) {
    const m = marginPx === undefined ? 0 : marginPx;
    const sz = leafletMap.getSize();
    const corners = [b.getNorthWest(), b.getNorthEast(), b.getSouthEast(), b.getSouthWest()];
    for (let i = 0; i < corners.length; i++) {
      const p = leafletMap.latLngToContainerPoint(corners[i]);
      if (p.x < -m || p.y < -m || p.x > sz.x + m || p.y > sz.y + m) return false;
    }
    return true;
  }

  function initProjUtm55() {
    const p4 = window.proj4;
    if (!p4 || typeof p4.defs !== "function") return false;
    p4.defs(EPSG32755, "+proj=utm +zone=55 +south +datum=WGS84 +units=m +no_defs");
    return true;
  }

  /**
   * @param {number} lng
   * @param {number} lat
   * @returns {{ e: number; n: number } | null}
   */
  function lngLatToUtm55(lng, lat) {
    const p4 = window.proj4;
    if (!p4) return null;
    try {
      const pair = p4("EPSG:4326", EPSG32755, [lng, lat]);
      return { e: pair[0], n: pair[1] };
    } catch (err) {
      console.warn(err);
      return null;
    }
  }

  /** Decimal degrees with hemisphere suffixes (WGS 84). */
  function formatLatLng(lat, lng) {
    const ns = lat >= 0 ? "N" : "S";
    const ew = lng >= 0 ? "E" : "W";
    return Math.abs(lat).toFixed(5) + "°" + ns + " · " + Math.abs(lng).toFixed(5) + "°" + ew;
  }

  /** East-positive declination (°), WMM2020 extrapolated by year; null if library missing. */
  function magneticDeclinationDeg(lat, lng) {
    const g = window.geomag;
    if (!g || typeof g.field !== "function") return null;
    try {
      const f = g.field(lat, lng, 0);
      if (!f || f.declination === undefined || f.declination === null) return null;
      const dec = Number(f.declination);
      return Number.isFinite(dec) ? dec : null;
    } catch (err) {
      console.warn(err);
      return null;
    }
  }

  function bindUtmReadout() {
    const el = document.getElementById("utm-readout");
    if (!el || !map) return;

    if (!initProjUtm55()) {
      const c = map.getCenter();
      el.innerHTML =
        '<span class="utm-label">EPSG:32755 · ' + formatLatLng(c.lat, c.lng) + "</span>proj4 failed to load";
      return;
    }

    function showCursor(lng, lat) {
      const ll = formatLatLng(lat, lng);
      const r = lngLatToUtm55(lng, lat);
      if (!r) {
        el.innerHTML =
          '<span class="utm-label">UTM zone 55S (EPSG:32755) · ' + ll + "</span>—";
        return;
      }
      el.innerHTML =
        '<span class="utm-label">UTM zone 55S (EPSG:32755) · ' + ll + "</span>" +
        "E " +
        r.e.toFixed(1) +
        " m<br>N " +
        r.n.toFixed(1) +
        " m";
    }

    function showIdle() {
      if (!map) return;
      const c = map.getCenter();
      const ll = formatLatLng(c.lat, c.lng);
      el.innerHTML =
        '<span class="utm-label">UTM zone 55S (EPSG:32755) · ' + ll + "</span>" +
        "Move pointer over map";
    }

    map.on("mousemove", function (e) {
      showCursor(e.latlng.lng, e.latlng.lat);
    });
    map.on("mouseout", function () {
      showIdle();
    });

    const c = map.getCenter();
    showCursor(c.lng, c.lat);
  }

  /** @type {L.Map | null} */
  let map = null;
  /** @type {L.TileLayer | null} */
  let tileLayer = null;

  /**
   * Local tile pyramid. Slippy Map / XYZ uses `tms: false` (default here).
   * GDAL gdal2tiles without `--xyz` uses TMS — open the app with `?tms=1` or set
   * `tms: true` below. Wrong Y order still fetches PNGs (200) but the map looks
   * empty or like random specks.
   *
   * PDF export draws tiles to a canvas → needs CORS: tile responses must include
   * `Access-Control-Allow-Origin` (e.g. `*` or your app origin). `crossOrigin: true` on the layer
   * requests anonymous CORS; without the header, tiles fail to load (or `toDataURL` throws “tainted canvas”).
   *
   * If the tile server has no CORS yet: open the app with `?tilesCors=0` to view the map only (PDF export
   * stays disabled until the server sends `Access-Control-Allow-Origin` and you reload without that flag).
   */
  const TILE_CONFIG = {
    url: "https://actomaptiletest.ryan-stocks.com/{z}/{x}/{y}.png",
    tms: false,
    minZoom: 0,
    maxZoom: 17,
    /** Request CORS so PDF export works; set `false` only with matching `?tilesCors=0` behaviour. */
    tileCrossOrigin: true,
  };

  function tileCrossOriginFromConfig() {
    const q = new URLSearchParams(window.location.search);
    if (q.get("tilesCors") === "0" || q.get("tilesCors") === "false") return false;
    if (q.get("tilesCors") === "1") return true;
    return TILE_CONFIG.tileCrossOrigin !== false;
  }

  function leafletTileCrossOriginOptions() {
    return { crossOrigin: tileCrossOriginFromConfig() };
  }

  function tileConfigUrlHost() {
    try {
      const u = TILE_CONFIG.url.replace(/\{[zxy]\}/gi, "0");
      return new URL(u).host;
    } catch {
      return "your tile host";
    }
  }

  const PAPER_MM = {
    A4: { short: 210, long: 297 },
    A3: { short: 297, long: 420 },
  };

  /** WGS 84 meridional / prime-vertical curvature — ground metres per degree at latitude */
  function metersPerDegreeLat(latDeg) {
    const φ = (latDeg * Math.PI) / 180;
    const a = 6378137;
    const e2 = 6.694379990137e-3;
    return ((Math.PI / 180) * a * (1 - e2)) / Math.pow(1 - e2 * Math.sin(φ) * Math.sin(φ), 1.5);
  }

  function metersPerDegreeLng(latDeg) {
    const φ = (latDeg * Math.PI) / 180;
    const a = 6378137;
    const e2 = 6.694379990137e-3;
    return ((Math.PI / 180) * a * Math.cos(φ)) / Math.sqrt(1 - e2 * Math.sin(φ) * Math.sin(φ));
  }

  /**
   * Geographic bounds whose east–west and north–south extents match paper × scale at the
   * centre (WGS 84 ground metres). Map is still Web Mercator; scale varies slightly across the sheet.
   *
   * @param {number} centerLat
   * @param {number} centerLng
   * @param {number} widthMm
   * @param {number} heightMm
   * @param {number} scaleDenominator e.g. 25000 for 1:25000
   * @returns {L.LatLngBounds}
   */
  function boundsForPaper(centerLat, centerLng, widthMm, heightMm, scaleDenominator) {
    const groundWidthM = (widthMm * scaleDenominator) / 1000;
    const groundHeightM = (heightMm * scaleDenominator) / 1000;
    const halfW = groundWidthM / 2;
    const halfH = groundHeightM / 2;
    const mLat = metersPerDegreeLat(centerLat);
    const mLng = metersPerDegreeLng(centerLat);
    const dLat = halfH / mLat;
    const dLng = halfW / mLng;
    const south = centerLat - dLat;
    const north = centerLat + dLat;
    const west = centerLng - dLng;
    const east = centerLng + dLng;
    return L.latLngBounds([south, west], [north, east]);
  }

  function readExportControls() {
    const paperEl = document.querySelector('input[name="paper"]:checked');
    const orientEl = document.querySelector('input[name="orient"]:checked');
    const paper = paperEl && paperEl.value ? paperEl.value : "A4";
    const orient = orientEl && orientEl.value ? orientEl.value : "portrait";
    const scaleEl = document.getElementById("scale-den");
    const scaleDen = scaleEl ? Number(scaleEl.value) : 25000;
    const dpi = EXPORT_RASTER_DPI;
    /** PDF magnetic export hidden: georef vs rotation still wrong; re-enable when fixed. */
    const magneticNorthUp = false;
    return { paper, orient, scaleDen, dpi, magneticNorthUp };
  }

  function paperDimensionsMm(paper, orient) {
    const d = PAPER_MM[paper];
    const portrait = orient === "portrait";
    return {
      widthMm: portrait ? d.short : d.long,
      heightMm: portrait ? d.long : d.short,
    };
  }

  function tileTmsFromConfig() {
    const q = new URLSearchParams(window.location.search);
    if (q.get("tms") === "1") return true;
    if (q.get("xyz") === "1") return false;
    return TILE_CONFIG.tms;
  }

  function applyTileLayer() {
    if (!map) return;

    const { url, minZoom, maxZoom } = TILE_CONFIG;
    const tms = tileTmsFromConfig();

    if (tileLayer) {
      map.removeLayer(tileLayer);
      tileLayer = null;
    }

    tileLayer = L.tileLayer(url, {
      minZoom,
      maxZoom,
      tms,
      attribution: "Tiles",
      ...leafletTileCrossOriginOptions(),
    });

    tileLayer.on("tileerror", function (ev) {
      console.warn("Tile error", ev?.coords, ev?.error);
    });

    tileLayer.addTo(map);
  }

  function initMap() {
    map = L.map("map", {
      zoomControl: true,
      worldCopyJump: true,
      maxZoom: TILE_CONFIG.maxZoom,
    }).setView([-35.4, 149.05], 12);

    applyTileLayer();

    L.control.scale({ imperial: false, metric: true }).addTo(map);
    bindUtmReadout();

    requestAnimationFrame(function () {
      map.invalidateSize();
      updateMainMapMagnetic();
    });

    map.on("moveend", onMainMapMoveEnd);
  }

  /**
   * Rotate the main tile map so window top ≈ magnetic north (CSS on #map-magnetic-rotor, not the Leaflet root).
   * Declination at map centre.
   */
  function updateMainMapMagnetic() {
    const wrap = document.getElementById("map-magnetic-wrap");
    const rotor = document.getElementById("map-magnetic-rotor");
    const chk = document.getElementById("map-magnetic-north");
    if (!map || !wrap || !rotor || !chk) return;

    const clearInline = function () {
      ["width", "height", "left", "top", "right", "bottom", "inset", "transform", "transformOrigin", "position"].forEach(
        function (k) {
          rotor.style.removeProperty(k);
        },
      );
      wrap.classList.remove("map-magnetic-on");
    };

    if (!chk.checked) {
      mapMagneticLayoutRetries = 0;
      clearInline();
      requestAnimationFrame(function () {
        map.invalidateSize();
      });
      return;
    }

    if (!map.getContainer()) return;

    const c = map.getCenter();
    const dec = magneticDeclinationDeg(c.lat, c.lng);
    if (dec === null && !warnedGeomagMissing) {
      warnedGeomagMissing = true;
      console.warn("geomag unavailable — load ./vendor/geomag.js (or fix the script path) for magnetic north.");
    }
    if (dec === null || Math.abs(dec) < 0.001) {
      mapMagneticLayoutRetries = 0;
      clearInline();
      requestAnimationFrame(function () {
        map.invalidateSize();
      });
      return;
    }

    const rect = wrap.getBoundingClientRect();
    let W = rect.width;
    let H = rect.height;
    if (W < 2 || H < 2) {
      const sz = map.getSize();
      if (sz.x >= 2 && sz.y >= 2) {
        W = sz.x;
        H = sz.y;
      } else {
        if (chk.checked && mapMagneticLayoutRetries < 48) {
          mapMagneticLayoutRetries += 1;
          requestAnimationFrame(function () {
            updateMainMapMagnetic();
          });
        } else {
          mapMagneticLayoutRetries = 0;
        }
        return;
      }
    }
    mapMagneticLayoutRetries = 0;

    const phi = (-dec * Math.PI) / 180;
    const bboxW = Math.ceil(Math.abs(W * Math.cos(phi)) + Math.abs(H * Math.sin(phi)));
    const bboxH = Math.ceil(Math.abs(W * Math.sin(phi)) + Math.abs(H * Math.cos(phi)));

    rotor.style.position = "absolute";
    rotor.style.inset = "auto";
    rotor.style.width = bboxW + "px";
    rotor.style.height = bboxH + "px";
    rotor.style.left = W / 2 - bboxW / 2 + "px";
    rotor.style.top = H / 2 - bboxH / 2 + "px";
    rotor.style.transform = "rotate(" + -dec + "deg)";
    rotor.style.transformOrigin = "center center";
    wrap.classList.add("map-magnetic-on");

    requestAnimationFrame(function () {
      map.invalidateSize();
    });
  }

  function onMainMapMoveEnd() {
    const chk = document.getElementById("map-magnetic-north");
    if (chk && chk.checked) updateMainMapMagnetic();
  }

  /** `load` registered before `addTo`; always finishes by maxWaitMs. */
  function waitForTileLayerReady(leafletMap, layer, done, maxWaitMs) {
    if (!layer) {
      done();
      return;
    }
    let settled = false;
    function finish() {
      if (settled) return;
      settled = true;
      done();
    }
    const hardStop = window.setTimeout(function () {
      console.warn("[actomap PDF] tile wait timeout " + maxWaitMs + "ms");
      finish();
    }, maxWaitMs);
    layer.once("load", function () {
      window.clearTimeout(hardStop);
      finish();
    });
    layer.addTo(leafletMap);
  }

  function setExportStatus(text) {
    const el = document.getElementById("export-status");
    if (el) el.textContent = text;
  }

  /** Leaflet can throw on remove if the container is already torn down; don’t fail the export. */
  function safeRemoveExportMap(m) {
    if (!m) return;
    try {
      m.remove();
    } catch (e) {
      console.warn("[actomap PDF] map.remove()", e);
    }
  }

  /** UMD vs ESM global */
  function getHtml2CanvasFn() {
    const g = window.html2canvas;
    if (typeof g === "function") return g;
    if (g && typeof g.default === "function") return g.default;
    return null;
  }

  /**
   * Axis-aligned bbox in map-container pixels for the four corners of `bounds`.
   * `fitBounds` often letterboxes (visible getBounds() ⊃ bounds); cropping to this rect matches the orange export extent.
   *
   * @param {L.Map} leafletMap
   * @param {L.LatLngBounds} b
   * @returns {{ minX: number; minY: number; maxX: number; maxY: number; w: number; h: number }}
   */
  function exportBoundsContainerPxAabb(leafletMap, b) {
    const corners = [b.getNorthWest(), b.getNorthEast(), b.getSouthEast(), b.getSouthWest()];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < corners.length; i++) {
      const p = leafletMap.latLngToContainerPoint(corners[i]);
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    return { minX: minX, minY: minY, maxX: maxX, maxY: maxY, w: maxX - minX, h: maxY - minY };
  }

  /**
   * @param {HTMLCanvasElement} src
   * @param {number} maxLongEdge
   * @returns {HTMLCanvasElement}
   */
  function clampCanvasLongEdgeForJsPdf(src, maxLongEdge) {
    const w = src.width;
    const h = src.height;
    const long = Math.max(w, h);
    if (long <= maxLongEdge) return src;
    const s = maxLongEdge / long;
    const tw = Math.max(1, Math.round(w * s));
    const th = Math.max(1, Math.round(h * s));
    const out = document.createElement("canvas");
    out.width = tw;
    out.height = th;
    const ctx = out.getContext("2d");
    if (!ctx) return src;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src, 0, 0, tw, th);
    return out;
  }

  /**
   * Paint loaded `.leaflet-tile` images into a canvas (same tiles Leaflet already decoded — no iframe clone).
   * Only for layouts without CSS rotation on the tile pane; rotated magnetic exports still use html2canvas.
   *
   * @param {HTMLElement} rootEl
   * @param {number} widthPx
   * @param {number} heightPx
   * @param {number} pixelScale
   * @returns {HTMLCanvasElement}
   */
  function rasterizeLeafletTilesFromElement(rootEl, widthPx, heightPx, pixelScale) {
    const cw = Math.max(1, Math.round(widthPx * pixelScale));
    const ch = Math.max(1, Math.round(heightPx * pixelScale));
    const canvas = document.createElement("canvas");
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext("2d");
    if (!ctx) return canvas;
    ctx.fillStyle = "#1c2430";
    ctx.fillRect(0, 0, cw, ch);
    const rootRect = rootEl.getBoundingClientRect();
    rootEl.querySelectorAll("img.leaflet-tile").forEach(function (img) {
      if (!img.complete || img.naturalWidth === 0) return;
      const r = img.getBoundingClientRect();
      const dx = (r.left - rootRect.left) * pixelScale;
      const dy = (r.top - rootRect.top) * pixelScale;
      const dw = r.width * pixelScale;
      const dh = r.height * pixelScale;
      if (dw < 0.25 || dh < 0.25) return;
      try {
        ctx.drawImage(img, dx, dy, dw, dh);
      } catch (err) {
        console.warn("[actomap PDF] tile drawImage skipped", err);
      }
    });
    return canvas;
  }

  /**
   * GPTS flat array: SW, NW, NE, SE as lat,lng pairs (PDF measure / GDAL Adobe-style order).
   * @param {L.LatLngBounds} bounds
   * @returns {number[]}
   */
  function gptsFromBoundsBox(bounds) {
    const nw = bounds.getNorthWest();
    const ne = bounds.getNorthEast();
    const se = bounds.getSouthEast();
    const sw = bounds.getSouthWest();
    return [sw.lat, sw.lng, nw.lat, nw.lng, ne.lat, ne.lng, se.lat, se.lng];
  }

  /**
   * Map outer html2canvas pixel (origin top-left of rotated outer) → lat/lng (inverse CSS rotate(-dec)).
   *
   * @param {L.Map} printMap
   * @param {number} decDeg east-positive declination
   * @param {number} W inner map CSS px width
   * @param {number} H inner map CSS px height
   * @param {number} canvasW pre-crop canvas width
   * @param {number} canvasH pre-crop canvas height
   * @param {number} px
   * @param {number} py
   * @param {number} ps pixel scale (html2canvas scale)
   */
  function magneticOuterPxToLatLng(printMap, decDeg, W, H, canvasW, canvasH, px, py, ps) {
    const Ox = canvasW / 2;
    const Oy = canvasH / 2;
    const phi = (-decDeg * Math.PI) / 180;
    const cos = Math.cos(phi);
    const sin = Math.sin(phi);
    const rxo = px - Ox;
    const ryo = py - Oy;
    const dx = rxo * cos - ryo * sin;
    const dy = rxo * sin + ryo * cos;
    const lx = W / 2 + dx / ps;
    const ly = H / 2 + dy / ps;
    return printMap.containerPointToLatLng(L.point(lx, ly));
  }

  /**
   * @param {L.Map} printMap
   * @param {number} decDeg
   * @param {number} W
   * @param {number} H
   * @param {number} canvasW
   * @param {number} canvasH
   * @param {number} sx
   * @param {number} sy
   * @param {number} sw
   * @param {number} sh
   * @param {number} ps
   * @returns {number[]}
   */
  function gptsFromMagneticCropRect(printMap, decDeg, W, H, canvasW, canvasH, sx, sy, sw, sh, ps) {
    function p2ll(px, py) {
      return magneticOuterPxToLatLng(printMap, decDeg, W, H, canvasW, canvasH, px, py, ps);
    }
    const swLL = p2ll(sx, sy + sh);
    const nwLL = p2ll(sx, sy);
    const neLL = p2ll(sx + sw, sy);
    const seLL = p2ll(sx + sw, sy + sh);
    return [swLL.lat, swLL.lng, nwLL.lat, nwLL.lng, neLL.lat, neLL.lng, seLL.lat, seLL.lng];
  }

  /**
   * GPTS flat array for ISO 32000 GEO /Measure: NW, SW, SE, NE as lat,lng pairs (GDAL
   * pdfcreatecopy.cpp / WriteSRS_ISO32000 corner order after geog transform).
   *
   * @param {number[]} gpts8 SW,NW,NE,SE lat/lng from gptsFromBoundsBox
   * @returns {number[]}
   */
  function gpts8ToIso32000MeasureGpts(gpts8) {
    const swLat = gpts8[0];
    const swLng = gpts8[1];
    const nwLat = gpts8[2];
    const nwLng = gpts8[3];
    const neLat = gpts8[4];
    const neLng = gpts8[5];
    const seLat = gpts8[6];
    const seLng = gpts8[7];
    return [nwLat, nwLng, swLat, swLng, seLat, seLng, neLat, neLng];
  }

  /**
   * Resolve a PDF object to PDFDict (inline dict or indirect).
   * @param {*} ctx pdf-lib PDFContext
   * @param {*} obj
   * @param {*} PDFDict pdf-lib PDFDict class
   */
  function lookupPdfDict(ctx, obj, PDFDict) {
    if (!obj) return null;
    if (obj instanceof PDFDict) return obj;
    try {
      return ctx.lookup(obj, PDFDict) || null;
    } catch (e) {
      return null;
    }
  }

  /**
   * ISO 32000 Viewport + GEO /Measure (and the same Measure on jsPDF’s page image XObject).
   *
   * We do **not** write /LGIDict: GDAL tries it before /VP; any present-but-unreadable LGIDict
   * prevents the /VP branch from running, which matches “CRS unknown” after experiments.
   *
   * @param {ArrayBuffer | Uint8Array} input
   * @param {number[]} gpts8 SW,NW,NE,SE lat/lng
   * @param {{ subject?: string } | undefined} options
   * @returns {Promise<Uint8Array>}
   */
  async function embedGeospatialPdf(input, gpts8, options) {
    const P = window.PDFLib;
    if (!P) throw new Error("PDFLib not loaded");

    const { PDFDocument, PDFName, PDFNumber, PDFString, PDFDict, PDFArray } = P;
    if (!PDFDict || typeof PDFDict.withContext !== "function") {
      throw new Error("PDFLib PDFDict missing — use pdf-lib UMD bundle that exports core objects");
    }
    const pdfDoc = await PDFDocument.load(input, { ignoreEncryption: true });
    if (options && options.subject) {
      pdfDoc.setSubject(options.subject);
    }
    const page = pdfDoc.getPage(0);
    const ctx = pdfDoc.context;
    const size = page.getSize();
    const pw = Number(size.width);
    const ph = Number(size.height);

    const wkt =
      'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.017453292519943295]]';

    const wktSafe = String(wkt)
      .replace(/\\/g, "\\\\")
      .replace(/\(/g, "\\(")
      .replace(/\)/g, "\\)");

    const numArray = function (nums) {
      const arr = PDFArray.withContext(ctx);
      for (let i = 0; i < nums.length; i++) arr.push(PDFNumber.of(nums[i]));
      return arr;
    };

    const gptsOrdered = gpts8ToIso32000MeasureGpts(gpts8);
    const boundsLpts = [0, 1, 0, 0, 1, 0, 1, 1];

    const gcs = PDFDict.withContext(ctx);
    gcs.set(PDFName.of("Type"), PDFName.of("GEOGCS"));
    gcs.set(PDFName.of("WKT"), PDFString.of(wktSafe));
    gcs.set(PDFName.of("EPSG"), PDFNumber.of(4326));

    const measure = PDFDict.withContext(ctx);
    measure.set(PDFName.of("Type"), PDFName.of("Measure"));
    measure.set(PDFName.of("Subtype"), PDFName.of("GEO"));
    measure.set(PDFName.of("Bounds"), numArray(boundsLpts));
    measure.set(PDFName.of("GPTS"), numArray(gptsOrdered));
    measure.set(PDFName.of("LPTS"), numArray(boundsLpts));
    measure.set(PDFName.of("GCS"), gcs);

    const measureRef = ctx.register(measure);

    const vpEl = PDFDict.withContext(ctx);
    vpEl.set(PDFName.of("Type"), PDFName.of("Viewport"));
    vpEl.set(PDFName.of("BBox"), numArray([0, 0, pw, ph]));
    vpEl.set(PDFName.of("Name"), PDFString.of("Map Layers"));
    vpEl.set(PDFName.of("Measure"), measureRef);

    const vpArr = PDFArray.withContext(ctx);
    vpArr.push(vpEl);

    const lgName = PDFName.of("LGIDict");
    const vpName = PDFName.of("VP");
    if (page.node.has && page.node.has(lgName)) page.node.delete(lgName);
    if (page.node.has && page.node.has(vpName)) page.node.delete(vpName);
    page.node.set(vpName, vpArr);

    const imgName = PDFName.of("Image");
    let resources = null;
    if (typeof page.node.Resources === "function") {
      resources = page.node.Resources();
    }
    if (!resources) {
      resources = lookupPdfDict(ctx, page.node.get(PDFName.of("Resources")), PDFDict);
    }
    if (resources) {
      const xObjDict = lookupPdfDict(ctx, resources.get(PDFName.of("XObject")), PDFDict);
      if (xObjDict && typeof xObjDict.keys === "function") {
        const keys = xObjDict.keys();
        for (let i = 0; i < keys.length; i++) {
          const imgDict = lookupPdfDict(ctx, xObjDict.get(keys[i]), PDFDict);
          if (!imgDict) continue;
          const st = imgDict.get(PDFName.of("Subtype"));
          const isImage =
            st &&
            (st === imgName ||
              (typeof st.toString === "function" && st.toString() === "/Image"));
          if (isImage) {
            imgDict.set(PDFName.of("Measure"), measureRef);
            break;
          }
        }
      }
    }

    return pdfDoc.save({ useObjectStreams: false });
  }

  function downloadPdfBytes(data, filename) {
    const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
    const blob = new Blob([u8], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  /** Geographic export extent (axis-aligned WGS 84), independent of magnetic preview rotation. */
  /** @type {L.LatLngBounds | null} */
  let exportBounds = null;
  /** @type {L.Polygon | null} */
  let exportOutline = null;

  const rectDrag = {
    active: false,
    anchor: null,
    bounds0: null,
  };

  function cloneBounds(b) {
    return L.latLngBounds(b.getSouthWest(), b.getNorthEast());
  }

  /** NW, NE, SE, SW — same corners as L.rectangle(bounds). */
  function boundsToCornerLatLngs(b) {
    return [b.getNorthWest(), b.getNorthEast(), b.getSouthEast(), b.getSouthWest()];
  }

  /**
   * Rotate export corners in map container space (y down), same sense as PDF `rotate(-declDeg)`.
   * @param {L.Map} leafletMap
   * @param {L.LatLngBounds} b
   * @param {number} declEastDeg magnetic declination, east positive
   */
  function boundsCornersRotatedScreen(leafletMap, b, declEastDeg) {
    const corners = boundsToCornerLatLngs(b);
    const pts = corners.map(function (ll) {
      return leafletMap.latLngToContainerPoint(ll);
    });
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < pts.length; i++) {
      cx += pts[i].x;
      cy += pts[i].y;
    }
    cx /= 4;
    cy /= 4;
    const phi = (-declEastDeg * Math.PI) / 180;
    const cos = Math.cos(phi);
    const sin = Math.sin(phi);
    return corners.map(function (ll, i) {
      const dx = pts[i].x - cx;
      const dy = pts[i].y - cy;
      const rx = dx * cos + dy * sin;
      const ry = -dx * sin + dy * cos;
      return leafletMap.containerPointToLatLng(L.point(cx + rx, cy + ry));
    });
  }

  function refreshExportOutline() {
    if (!map || !exportOutline || !exportBounds) return;
    const { magneticNorthUp } = readExportControls();
    let latlngs;
    if (magneticNorthUp) {
      const c = exportBounds.getCenter();
      const dec = magneticDeclinationDeg(c.lat, c.lng);
      if (dec !== null && Math.abs(dec) > 0.001) {
        latlngs = boundsCornersRotatedScreen(map, exportBounds, dec);
      } else {
        latlngs = boundsToCornerLatLngs(exportBounds);
      }
    } else {
      latlngs = boundsToCornerLatLngs(exportBounds);
    }
    exportOutline.setLatLngs(latlngs);
    exportOutline.bringToFront();
  }

  function onExportMapViewChange() {
    if (exportOutline && exportBounds) refreshExportOutline();
  }

  function teardownRectDrag() {
    if (!map) return;
    map.off("mousemove", onRectDragMove);
    map.off("mouseup", onRectDragEnd);
    document.removeEventListener("mouseup", onRectDragEnd);
    if (map.dragging) map.dragging.enable();
    rectDrag.active = false;
    rectDrag.anchor = null;
    rectDrag.bounds0 = null;
  }

  function onRectDragMove(e) {
    if (!rectDrag.active || !exportBounds) return;
    const a = rectDrag.anchor;
    const b0 = rectDrag.bounds0;
    if (!a || !b0) return;
    const dLat = e.latlng.lat - a.lat;
    const dLng = e.latlng.lng - a.lng;
    exportBounds = L.latLngBounds(
      [b0.getSouth() + dLat, b0.getWest() + dLng],
      [b0.getNorth() + dLat, b0.getEast() + dLng],
    );
    refreshExportOutline();
  }

  function onRectDragEnd() {
    if (!rectDrag.active) return;
    teardownRectDrag();
  }

  function wireExportOutlineDrag(layer) {
    layer.on("mousedown", function (e) {
      if (!map || !exportBounds) return;
      const ev = e.originalEvent;
      if (ev.button !== 0) return;
      L.DomEvent.stopPropagation(ev);
      L.DomEvent.preventDefault(ev);
      map.dragging.disable();
      rectDrag.active = true;
      rectDrag.anchor = e.latlng;
      rectDrag.bounds0 = cloneBounds(exportBounds);
      map.on("mousemove", onRectDragMove);
      map.on("mouseup", onRectDragEnd);
      document.addEventListener("mouseup", onRectDragEnd);
    });
  }

  function syncExportRectangleFromForm() {
    if (!map || !exportBounds || !exportOutline) return;
    const c = exportBounds.getCenter();
    const { paper, orient, scaleDen } = readExportControls();
    const { widthMm, heightMm } = paperDimensionsMm(paper, orient);
    exportBounds = boundsForPaper(c.lat, c.lng, widthMm, heightMm, scaleDen);
    refreshExportOutline();
  }

  function ensureExportRectangle() {
    if (!map) return;
    if (exportOutline && !map.hasLayer(exportOutline)) {
      exportOutline = null;
      exportBounds = null;
    }
    if (exportOutline) return;
    const { paper, orient, scaleDen } = readExportControls();
    const { widthMm, heightMm } = paperDimensionsMm(paper, orient);
    const c = map.getCenter();
    exportBounds = boundsForPaper(c.lat, c.lng, widthMm, heightMm, scaleDen);
    const latlngs = boundsToCornerLatLngs(exportBounds);
    exportOutline = L.polygon(latlngs, {
      className: "export-extent-rect",
      weight: 2,
      color: "#f5a623",
      fillColor: "#f5a623",
      fillOpacity: 0.14,
      interactive: true,
    }).addTo(map);
    wireExportOutlineDrag(exportOutline);
    refreshExportOutline();
  }

  function removeExportRectangle() {
    teardownRectDrag();
    if (map) {
      map.off("zoomend", onExportMapViewChange);
      map.off("moveend", onExportMapViewChange);
    }
    if (exportOutline && map) {
      map.removeLayer(exportOutline);
    }
    exportOutline = null;
    exportBounds = null;
  }

  function beginExportSession() {
    if (!map) {
      setExportStatus("Map is not ready — try refreshing the page.");
      return;
    }
    try {
      ensureExportRectangle();
      syncExportRectangleFromForm();
      map.off("zoomend", onExportMapViewChange);
      map.off("moveend", onExportMapViewChange);
      map.on("zoomend", onExportMapViewChange);
      map.on("moveend", onExportMapViewChange);
      const scaleEl = document.getElementById("scale-den");
      if (scaleEl) scaleEl.focus();
      const det = document.getElementById("export-details");
      if (det) det.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } catch (err) {
      console.error(err);
      setExportStatus("Could not start export — see console.");
    }
  }

  function endExportSession() {
    removeExportRectangle();
    setExportStatus("");
  }

  function closeExportModal() {
    const det = document.getElementById("export-details");
    if (det && det.open) det.open = false;
  }

  async function exportPdf() {
    const { url, minZoom, maxZoom } = TILE_CONFIG;
    const tms = tileTmsFromConfig();
    const { paper, orient, scaleDen, dpi, magneticNorthUp } = readExportControls();
    const jsPdfMod = window.jspdf;
    if (!map || !jsPdfMod) {
      setExportStatus("PDF libraries failed to load.");
      return;
    }
    if (!exportBounds || !exportOutline || !map.hasLayer(exportOutline)) {
      setExportStatus("Expand Export to PDF and position the orange outline first.");
      return;
    }
    if (!tileCrossOriginFromConfig()) {
      setExportStatus(
        "PDF needs CORS on the tile host. Add Access-Control-Allow-Origin on " +
          tileConfigUrlHost() +
          ", then reload without ?tilesCors=0.",
      );
      return;
    }

    const bounds = exportBounds;
    const center = bounds.getCenter();
    const { widthMm, heightMm } = paperDimensionsMm(paper, orient);

    /** Base pixel size from paper × DPI; multiplied for fit zoom (see EXPORT_FIT_ZOOM_PIXEL_SCALE). */
    const wPx = (widthMm / 25.4) * dpi;
    const WBase = Math.max(1, Math.round(wPx));
    const HBase = Math.max(1, Math.round((WBase * heightMm) / widthMm));
    const longestBase = Math.max(WBase, HBase);
    const fitPxDesired = Math.max(1, EXPORT_FIT_ZOOM_PIXEL_SCALE);
    const extraZoomLevels = Math.max(0, Math.floor(EXPORT_PDF_EXTRA_ZOOM_LEVELS));
    const zoomMult = Math.pow(2, extraZoomLevels);
    /** Leave 2^n headroom so W,H after ×zoomMult still fit EXPORT_MAP_MAX_LONG_EDGE_PX. */
    const fitPxCap = Math.max(1, EXPORT_MAP_MAX_LONG_EDGE_PX / longestBase / zoomMult);
    const fitPxScale = Math.min(fitPxDesired, fitPxCap);
    /*
     * One combined W×H from paper aspect (WBase:HBase). Rounding W and H in separate steps
     * (e.g. round(base×scale) then ×2) skews aspect → fitBounds letterboxes differently → wrong 1:scale.
     */
    const wIdeal = WBase * fitPxScale * zoomMult;
    const hIdeal = HBase * fitPxScale * zoomMult;
    const longIdeal = Math.max(wIdeal, hIdeal);
    const mapCap = EXPORT_MAP_MAX_LONG_EDGE_PX;
    const fitShrink = longIdeal > mapCap ? mapCap / longIdeal : 1;
    let W = Math.max(1, Math.round(wIdeal * fitShrink));
    let H = Math.max(1, Math.round((W * HBase) / WBase));
    if (Math.max(W, H) > mapCap) {
      if (H >= W) {
        H = mapCap;
        W = Math.max(1, Math.round((H * WBase) / HBase));
      } else {
        W = mapCap;
        H = Math.max(1, Math.round((W * HBase) / WBase));
      }
    }

    setExportStatus("Preparing export…");

    const stage = document.getElementById("export-stage");
    if (!stage) {
      console.error("[actomap PDF] #export-stage not in DOM");
      setExportStatus("Missing #export-stage — check index.html.");
      return;
    }
    stage.innerHTML = "";

    const container = document.createElement("div");
    container.style.width = W + "px";
    container.style.height = H + "px";

    let captureEl = /** @type {HTMLElement} */ (container);
    let outerW = W;
    let outerH = H;
    let doCrop = false;
    let declUsed = null;

    if (magneticNorthUp) {
      const dec = magneticDeclinationDeg(center.lat, center.lng);
      if (dec === null) {
        setExportStatus("Magnetic model unavailable; PDF uses true north.");
        stage.appendChild(container);
      } else if (Math.abs(dec) <= 0.001) {
        stage.appendChild(container);
        declUsed = dec;
      } else {
        declUsed = dec;
        const rad = (-dec * Math.PI) / 180;
        outerW = Math.ceil(Math.abs(W * Math.cos(rad)) + Math.abs(H * Math.sin(rad)));
        outerH = Math.ceil(Math.abs(W * Math.sin(rad)) + Math.abs(H * Math.cos(rad)));
        const outer = document.createElement("div");
        outer.style.cssText =
          "position:relative;background:#1c2430;width:" + outerW + "px;height:" + outerH + "px;";
        container.style.cssText =
          "position:absolute;left:" +
          (outerW - W) / 2 +
          "px;top:" +
          (outerH - H) / 2 +
          "px;width:" +
          W +
          "px;height:" +
          H +
          "px;transform:rotate(" +
          -dec +
          "deg);transform-origin:center center;";
        outer.appendChild(container);
        stage.appendChild(outer);
        captureEl = outer;
        doCrop = true;
      }
    } else {
      stage.appendChild(container);
    }

    stage.style.width = outerW + "px";
    stage.style.height = outerH + "px";

    /** @type {L.Map | null} */
    let printMap = null;
    try {
      printMap = L.map(container, {
        attributionControl: false,
        zoomControl: false,
        zoomSnap: 0,
        zoomDelta: 0.05,
        maxZoom: maxZoom,
      });
    } catch (err) {
      console.error("[actomap PDF] map init failed", err);
      safeRemoveExportMap(printMap);
      stage.innerHTML = "";
      setExportStatus("Map init failed — see console (search actomap PDF).");
      return;
    }

    await new Promise(function (resolve) {
      requestAnimationFrame(function () {
        requestAnimationFrame(resolve);
      });
    });
    if (!printMap) {
      stage.innerHTML = "";
      setExportStatus("Export failed (map handle lost).");
      return;
    }
    printMap.invalidateSize(false);
    const zFromTable = pdfZoomFromScaleDenTable(scaleDen);
    let zoomFromTableUsed = false;
    /** True when table zoom was increased to fill extent (not EXPORT_PDF_ZOOM_TABLE_STRICT). */
    let tableZoomLiftedToFit = false;
    if (zFromTable !== null) {
      const zTable = Math.min(maxZoom, Math.max(minZoom, zFromTable));
      const zFitExtent = printMap.getBoundsZoom(bounds, false, L.point(0, 0));
      let zUse = zTable;
      if (!EXPORT_PDF_ZOOM_TABLE_STRICT && Number.isFinite(zFitExtent) && zFitExtent > zTable) {
        zUse = Math.min(maxZoom, Math.max(minZoom, zFitExtent));
        tableZoomLiftedToFit = zUse > zTable + 1e-6;
      } else if (EXPORT_PDF_ZOOM_TABLE_STRICT && Number.isFinite(zFitExtent) && zFitExtent > zTable + 1e-6) {
        console.warn("[actomap PDF] table zoom < extent-fit zoom; expect letterbox unless you raise z in the table.", {
          zTable: zTable,
          zFitExtent: zFitExtent,
        });
      }
      printMap.setView(bounds.getCenter(), zUse, { animate: false });
      printMap.invalidateSize(false);
      if (!exportBoundsFullyInMapViewport(printMap, bounds, 2)) {
        console.warn("[actomap PDF] table / blended zoom does not show full export bounds — using fitBounds", {
          scaleDen: scaleDen,
          zUse: zUse,
        });
        printMap.fitBounds(bounds, { animate: false, padding: [0, 0] });
        printMap.invalidateSize(false);
        tableZoomLiftedToFit = false;
      } else {
        zoomFromTableUsed = true;
      }
    } else {
      printMap.fitBounds(bounds, { animate: false, padding: [0, 0] });
      printMap.invalidateSize(false);
    }

    const zFit = printMap.getZoom();
    const zDisplay = Math.min(maxZoom, Math.max(minZoom, Math.round(zFit)));
    const maxNativeZoom = zoomFromTableUsed
      ? zDisplay
      : Math.min(maxZoom, Math.max(minZoom, zDisplay - EXPORT_PDF_TILE_LEVELS_COARSER));
    const layerOpts = {
      minZoom,
      maxZoom,
      maxNativeZoom,
      tms,
      attribution: "Tiles",
      ...leafletTileCrossOriginOptions(),
    };
    if (!doCrop) layerOpts.bounds = bounds;
    const layer = L.tileLayer(url, layerOpts);

    setExportStatus("Loading map tiles for PDF…");
    await new Promise(function (resolve) {
      waitForTileLayerReady(printMap, layer, resolve, 60000);
    });

    await new Promise(function (r) {
      setTimeout(r, 250);
    });

    const captureMaxEdge = Math.max(outerW, outerH, 1);
    const h2cScale = Math.min(
      EXPORT_HTML2CANVAS_SCALE_MAX,
      EXPORT_CAPTURE_MAX_EDGE_PX / captureMaxEdge,
    );

    const winW = Math.ceil(outerW);
    const winH = Math.ceil(outerH);

    let canvas;
    try {
      if (!doCrop) {
        canvas = rasterizeLeafletTilesFromElement(captureEl, winW, winH, h2cScale);
      } else {
        const h2c = getHtml2CanvasFn();
        if (!h2c) {
          throw new Error("html2canvas not available (needed for magnetic-north PDF rotation).");
        }
        /*
         * html2canvas clones into an iframe; wrong window size re-fetches tiles at the wrong z.
         * Oversize the cloned document + stage; windowWidth/Height set the iframe (see html2canvas Bounds).
         */
        canvas = await h2c(captureEl, {
          useCORS: true,
          allowTaint: false,
          backgroundColor: "#1c2430",
          logging: false,
          width: winW,
          height: winH,
          scale: h2cScale,
          windowWidth: winW,
          windowHeight: winH,
          scrollX: 0,
          scrollY: 0,
          onclone: function (clonedDoc) {
            const de = clonedDoc.documentElement;
            const body = clonedDoc.body;
            if (de) {
              de.style.width = winW + "px";
              de.style.height = winH + "px";
              de.style.overflow = "visible";
            }
            if (body) {
              body.style.width = winW + "px";
              body.style.height = winH + "px";
              body.style.margin = "0";
              body.style.padding = "0";
              body.style.overflow = "visible";
            }
            const stCl = clonedDoc.getElementById("export-stage");
            if (stCl) {
              stCl.style.cssText =
                "position:fixed;left:0;top:0;width:" +
                winW +
                "px;height:" +
                winH +
                "px;opacity:1;overflow:visible;pointer-events:none;z-index:0;";
            }
          },
        });
      }
    } catch (e) {
      safeRemoveExportMap(printMap);
      stage.innerHTML = "";
      setExportStatus("Could not rasterise map (often CORS on tiles).");
      console.error(e);
      return;
    }
    /*
     * fitBounds keeps the whole LatLngBounds visible; Mercator vs container aspect often letterboxes,
     * so getBounds() is larger than `bounds` and the raster would show extra map (wrong 1:scale vs orange extent).
     */
    /** @type {{ sx: number; sy: number; sw: number; sh: number; preW: number; preH: number } | null} */
    let magneticCropOnOuter = null;

    if (!doCrop) {
      const aabb = exportBoundsContainerPxAabb(printMap, bounds);
      const loose = 1.5;
      if (aabb.w < W - loose || aabb.h < H - loose) {
        const sxB = Math.max(0, Math.floor(aabb.minX * h2cScale));
        const syB = Math.max(0, Math.floor(aabb.minY * h2cScale));
        let swB = Math.max(1, Math.ceil(aabb.w * h2cScale));
        let shB = Math.max(1, Math.ceil(aabb.h * h2cScale));
        swB = Math.min(swB, canvas.width - sxB);
        shB = Math.min(shB, canvas.height - syB);
        if (swB > 4 && shB > 4 && (swB < canvas.width - 2 || shB < canvas.height - 2)) {
          const cBounds = document.createElement("canvas");
          cBounds.width = swB;
          cBounds.height = shB;
          const ctxB = cBounds.getContext("2d");
          if (ctxB) {
            ctxB.drawImage(canvas, sxB, syB, swB, shB, 0, 0, swB, shB);
            canvas = cBounds;
          }
        }
      }
    } else if (declUsed !== null && Math.abs(declUsed) > 0.001) {
      const aabb = exportBoundsContainerPxAabb(printMap, bounds);
      const padL = (outerW - W) / 2;
      const padT = (outerH - H) / 2;
      const s = h2cScale;
      let sxB = Math.floor((aabb.minX + padL) * s);
      let syB = Math.floor((aabb.minY + padT) * s);
      let swB = Math.max(1, Math.ceil(aabb.w * s));
      let shB = Math.max(1, Math.ceil(aabb.h * s));
      sxB = Math.max(0, Math.min(sxB, canvas.width - 2));
      syB = Math.max(0, Math.min(syB, canvas.height - 2));
      swB = Math.min(swB, canvas.width - sxB);
      shB = Math.min(shB, canvas.height - syB);
      if (swB > 4 && shB > 4) {
        magneticCropOnOuter = { sx: sxB, sy: syB, sw: swB, sh: shB, preW: canvas.width, preH: canvas.height };
        const cMag = document.createElement("canvas");
        cMag.width = swB;
        cMag.height = shB;
        const ctxM = cMag.getContext("2d");
        if (ctxM) {
          ctxM.drawImage(canvas, sxB, syB, swB, shB, 0, 0, swB, shB);
          canvas = cMag;
        }
      }
    }

    let gptsForEmbed = gptsFromBoundsBox(bounds);
    if (magneticCropOnOuter && declUsed !== null && Math.abs(declUsed) > 0.001) {
      const m = magneticCropOnOuter;
      gptsForEmbed = gptsFromMagneticCropRect(
        printMap,
        declUsed,
        W,
        H,
        m.preW,
        m.preH,
        m.sx,
        m.sy,
        m.sw,
        m.sh,
        h2cScale,
      );
    }

    const prePdfEmbedW = canvas.width;
    const prePdfEmbedH = canvas.height;
    canvas = clampCanvasLongEdgeForJsPdf(canvas, EXPORT_JSPDF_MAX_IMAGE_LONG_EDGE_PX);
    const pdfRasterScaledForJsPdf =
      canvas.width !== prePdfEmbedW || canvas.height !== prePdfEmbedH;

    let imgData;
    try {
      imgData = canvas.toDataURL("image/jpeg", EXPORT_PDF_JPEG_QUALITY);
    } catch (err) {
      console.error("[actomap PDF] toDataURL failed (tainted canvas?)", err);
      safeRemoveExportMap(printMap);
      stage.innerHTML = "";
      setExportStatus(
        "PDF blocked: tiles must allow CORS. On your tile server send header Access-Control-Allow-Origin " +
          "(e.g. *). Reload so tiles reload with crossOrigin. See TILE_CONFIG comment in app.js.",
      );
      return;
    }
    const { jsPDF } = jsPdfMod;
    const orientation = widthMm >= heightMm ? "landscape" : "portrait";
    const pdf = new jsPDF({
      orientation,
      unit: "mm",
      format: paper,
    });

    pdf.addImage(imgData, "JPEG", 0, 0, widthMm, heightMm);
    let subjectBase = "Scale 1:" + scaleDen + " · " + paper + " " + orient;
    if (doCrop && declUsed !== null) {
      subjectBase += " · magnetic north up (D≈" + declUsed + "° E)";
    }
    pdf.setProperties({
      title: "ACT O Map export",
      subject: subjectBase,
    });

    const safeScale = String(scaleDen);
    let fname = "act-o-map_1-" + safeScale + "_" + paper + "_" + orient;
    if (doCrop) fname += "_mag";
    fname += ".pdf";

    let outBytes = /** @type {ArrayBuffer} */ (pdf.output("arraybuffer"));
    let geoOk = false;
    let geoErrMsg = "";
    if (window.PDFLib) {
      try {
        outBytes = await embedGeospatialPdf(outBytes, gptsForEmbed, {
          subject: subjectBase + " · georeferenced WGS 84 (VP GEO + image Measure)",
        });
        geoOk = true;
      } catch (err) {
        console.warn("Geospatial PDF embedding failed", err);
        geoErrMsg = err && err.message ? String(err.message) : String(err);
      }
    }

    downloadPdfBytes(outBytes, fname);

    safeRemoveExportMap(printMap);
    stage.innerHTML = "";
    let doneMsg = "Saved " + fname;
    if (doCrop && declUsed !== null) {
      doneMsg += " — declination ≈ " + declUsed + "° E at centre.";
    }
    if (geoOk) {
      doneMsg += " — georeferenced (WGS 84 ISO32000).";
    } else if (geoErrMsg) {
      doneMsg += " — georef embed failed: " + geoErrMsg;
    } else if (!window.PDFLib) {
      doneMsg += " — pdf-lib missing; PDF not georeferenced.";
    }
    if (zoomFromTableUsed) {
      doneMsg += " — z≈" + zFit.toFixed(2) + " (scale table 1:" + scaleDen + (tableZoomLiftedToFit ? ", raised to fit" : "") + ").";
    } else {
      doneMsg += " — z≈" + zFit.toFixed(1) + ", tiles z≤" + maxNativeZoom + ".";
    }
    if (pdfRasterScaledForJsPdf) {
      doneMsg += " — PDF raster ≤" + EXPORT_JSPDF_MAX_IMAGE_LONG_EDGE_PX + "px.";
    }
    setExportStatus(doneMsg);
  }

  function wireUi() {
    const exportDetails = document.getElementById("export-details");
    if (exportDetails) {
      exportDetails.addEventListener("toggle", function () {
        if (exportDetails.open) {
          beginExportSession();
        } else {
          endExportSession();
        }
      });
    }
    const cancelBtn = document.getElementById("export-cancel");
    if (cancelBtn) cancelBtn.addEventListener("click", closeExportModal);
    const pdfBtn = document.getElementById("export-pdf");
    if (pdfBtn) {
      pdfBtn.addEventListener("click", function () {
        exportPdf().catch(function (e) {
          console.error("[actomap PDF] exportPdf rejected", e);
          const msg =
            e && e.message
              ? String(e.message)
              : e
                ? String(e)
                : "unknown error";
          setExportStatus("Export failed: " + msg);
        });
      });
    }

    const syncRect = function () {
      syncExportRectangleFromForm();
    };
    document.querySelectorAll('input[name="paper"]').forEach(function (el) {
      el.addEventListener("change", syncRect);
    });
    document.querySelectorAll('input[name="orient"]').forEach(function (el) {
      el.addEventListener("change", syncRect);
    });
    const scaleDenEl = document.getElementById("scale-den");
    if (scaleDenEl) scaleDenEl.addEventListener("change", syncRect);

    const pdfMag = document.getElementById("pdf-magnetic-north");
    if (pdfMag) {
      pdfMag.checked = false;
      const onPdfMagnetic = function () {
        if (exportOutline && exportBounds) refreshExportOutline();
      };
      pdfMag.addEventListener("change", onPdfMagnetic);
      pdfMag.addEventListener("input", onPdfMagnetic);
    }

    const mapMag = document.getElementById("map-magnetic-north");
    if (mapMag) {
      const onMapMagnetic = function () {
        updateMainMapMagnetic();
      };
      mapMag.addEventListener("change", onMapMagnetic);
      mapMag.addEventListener("input", onMapMagnetic);
    }

    let mapMagResizeTimer = null;
    window.addEventListener("resize", function () {
      clearTimeout(mapMagResizeTimer);
      mapMagResizeTimer = setTimeout(function () {
        updateMainMapMagnetic();
      }, 150);
    });

    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      const det = document.getElementById("export-details");
      if (det && det.open) closeExportModal();
    });

    const toggle = document.getElementById("toggle-controls");
    const panel = document.getElementById("controls");
    if (toggle && panel) {
      toggle.addEventListener("click", function () {
        const collapsed = panel.classList.toggle("collapsed");
        toggle.setAttribute("aria-expanded", String(!collapsed));
      });
    }

  }

  try {
    initMap();
  } catch (err) {
    console.error("Map init failed:", err);
  }
  wireUi();
})();
