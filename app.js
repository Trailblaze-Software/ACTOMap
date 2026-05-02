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

  /**
   * Max longest edge of the rasterised bitmap (avoids canvas limits; typical ~8k–16k).
   * The off-screen map can be larger; scale is reduced so output stays within this.
   */
  const EXPORT_CAPTURE_MAX_EDGE_PX = 12288;

  /**
   * Enlarges the off-screen export map (same geographic bounds). Leaflet’s fit zoom increases
   * (~log2 of this factor), so tiles use smaller cartographic type. Can be large because capture
   * scale is lowered automatically (see EXPORT_CAPTURE_MAX_EDGE_PX).
   */
  const EXPORT_FIT_ZOOM_PIXEL_SCALE = 12;

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
   */
  const TILE_CONFIG = {
    url: "http://localhost:8765/{z}/{x}/{y}.png",
    tms: false,
    minZoom: 0,
    maxZoom: 17,
  };

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
    const scaleDen = scaleEl ? Number(scaleEl.value) : 50000;
    const dpi = EXPORT_RASTER_DPI;
    const magEl = document.getElementById("pdf-magnetic-north");
    const magneticNorthUp = !!(magEl && magEl.checked);
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

  /**
   * @param {L.Map} leafletMap
   * @param {L.TileLayer | null} activeLayer
   * @param {() => void} done
   * @param {number} maxWaitMs
   */
  function waitForTiles(leafletMap, activeLayer, done, maxWaitMs) {
    const start = performance.now();
    if (!activeLayer) {
      done();
      return;
    }

    function pending() {
      const el = leafletMap.getContainer();
      const tiles = el.querySelectorAll(".leaflet-tile");
      let loading = 0;
      tiles.forEach(function (img) {
        if (!img.complete) loading += 1;
      });
      return loading;
    }

    function tick() {
      if (pending() === 0 || performance.now() - start > maxWaitMs) {
        done();
        return;
      }
      requestAnimationFrame(tick);
    }

    activeLayer.on("load", function once() {
      activeLayer.off("load", once);
      setTimeout(tick, 80);
    });

    setTimeout(tick, 50);
  }

  function setExportStatus(text) {
    const el = document.getElementById("export-status");
    if (el) el.textContent = text;
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
   * Corners of the centre-cropped page in pre-crop canvas pixels → lat/lng via inverse of CSS rotate(-dec)
   * on the print map (same φ as boundsCornersRotatedScreen).
   *
   * @param {L.Map} printMap
   * @param {number} decDeg east-positive declination
   * @param {number} W crop width / inner map px
   * @param {number} H crop height
   * @param {number} canvasW html2canvas width before centre crop
   * @param {number} canvasH
   * @param {number} sx crop left (centred)
   * @param {number} sy crop top
   * @returns {number[]} GPTS length 8
   */
  function gptsFromMagneticCentreCrop(printMap, decDeg, W, H, canvasW, canvasH, sx, sy, pixelScale) {
    const ps = pixelScale && pixelScale > 0 ? pixelScale : 1;
    const Ox = canvasW / 2;
    const Oy = canvasH / 2;
    const phi = (-decDeg * Math.PI) / 180;
    const cos = Math.cos(phi);
    const sin = Math.sin(phi);

    function pxToLatLng(px, py) {
      const rxo = px - Ox;
      const ryo = py - Oy;
      const dx = rxo * cos - ryo * sin;
      const dy = rxo * sin + ryo * cos;
      const lx = W / 2 + dx / ps;
      const ly = H / 2 + dy / ps;
      return printMap.containerPointToLatLng(L.point(lx, ly));
    }

    const cw = W * ps;
    const ch = H * ps;
    const swLL = pxToLatLng(sx, sy + ch);
    const nwLL = pxToLatLng(sx, sy);
    const neLL = pxToLatLng(sx + cw, sy);
    const seLL = pxToLatLng(sx + cw, sy + ch);
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
    const h2c = window.html2canvas;
    const jsPdfMod = window.jspdf;
    if (!map || !h2c || !jsPdfMod) {
      setExportStatus("PDF libraries failed to load.");
      return;
    }
    if (!exportBounds || !exportOutline || !map.hasLayer(exportOutline)) {
      setExportStatus("Expand Export to PDF and position the orange outline first.");
      return;
    }

    const bounds = exportBounds;
    const center = bounds.getCenter();
    const { widthMm, heightMm } = paperDimensionsMm(paper, orient);

    /** Base pixel size from paper × DPI; multiplied for fit zoom (see EXPORT_FIT_ZOOM_PIXEL_SCALE). */
    const wPx = (widthMm / 25.4) * dpi;
    const WBase = Math.max(1, Math.round(wPx));
    const HBase = Math.max(1, Math.round((WBase * heightMm) / widthMm));
    const fitPxScale = Math.max(1, EXPORT_FIT_ZOOM_PIXEL_SCALE);
    const W = Math.max(1, Math.round(WBase * fitPxScale));
    const H = Math.max(1, Math.round(HBase * fitPxScale));

    setExportStatus("Preparing export…");

    const stage = document.getElementById("export-stage");
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

    const printMap = L.map(container, {
      attributionControl: true,
      zoomControl: false,
      zoomSnap: 0,
      zoomDelta: 0.05,
      maxZoom: maxZoom,
    });

    printMap.fitBounds(bounds, { animate: false, padding: [0, 0] });
    printMap.invalidateSize(false);

    const zFit = printMap.getZoom();
    /*
     * Do not set maxNativeZoom below the map’s rounded zoom: Leaflet would load lower-z tiles and
     * scale them up (huge labels). Omit maxNativeZoom so the grid uses native tiles at Math.round(zFit).
     */
    const layer = L.tileLayer(url, {
      minZoom,
      maxZoom,
      tms,
      attribution: "Tiles",
    });
    layer.addTo(printMap);

    await new Promise(function (resolve) {
      printMap.whenReady(resolve);
    });

    await new Promise(function (resolve) {
      waitForTiles(printMap, layer, resolve, 12000);
    });

    /** Small extra delay so decoded images paint */
    await new Promise(function (r) {
      setTimeout(r, 250);
    });

    const captureMaxEdge = Math.max(outerW, outerH, 1);
    const h2cScale = Math.min(
      EXPORT_HTML2CANVAS_SCALE_MAX,
      EXPORT_CAPTURE_MAX_EDGE_PX / captureMaxEdge,
    );
    let canvas;
    try {
      canvas = await h2c(captureEl, {
        useCORS: true,
        allowTaint: false,
        backgroundColor: "#1c2430",
        width: outerW,
        height: outerH,
        scale: h2cScale,
      });
    } catch (e) {
      printMap.remove();
      stage.innerHTML = "";
      setExportStatus("Could not rasterise map (often CORS on tiles).");
      console.error(e);
      return;
    }

    const sW = Math.round(W * h2cScale);
    const sH = Math.round(H * h2cScale);
    let sxCrop = 0;
    let syCrop = 0;
    if (doCrop && canvas.width >= sW && canvas.height >= sH) {
      sxCrop = Math.round((canvas.width - sW) / 2);
      syCrop = Math.round((canvas.height - sH) / 2);
    }

    let gptsForEmbed = gptsFromBoundsBox(bounds);
    if (doCrop && declUsed !== null && Math.abs(declUsed) > 0.001 && canvas.width >= sW && canvas.height >= sH) {
      gptsForEmbed = gptsFromMagneticCentreCrop(
        printMap,
        declUsed,
        W,
        H,
        canvas.width,
        canvas.height,
        sxCrop,
        syCrop,
        h2cScale,
      );
    }

    if (doCrop && canvas.width >= sW && canvas.height >= sH) {
      const c2 = document.createElement("canvas");
      c2.width = sW;
      c2.height = sH;
      const ctx2 = c2.getContext("2d");
      if (ctx2) ctx2.drawImage(canvas, sxCrop, syCrop, sW, sH, 0, 0, sW, sH);
      canvas = c2;
    }

    const imgData = canvas.toDataURL("image/png");
    const { jsPDF } = jsPdfMod;
    const orientation = widthMm >= heightMm ? "landscape" : "portrait";
    const pdf = new jsPDF({
      orientation,
      unit: "mm",
      format: paper,
    });

    pdf.addImage(imgData, "PNG", 0, 0, widthMm, heightMm);
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

    printMap.remove();
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
    doneMsg +=
      " — export zoom ≈ " +
      zFit.toFixed(2) +
      " (tile z ≈ " +
      Math.round(zFit) +
      ", " +
      fitPxScale +
      "× map, capture scale " +
      h2cScale.toFixed(2) +
      ").";
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
          console.error(e);
          setExportStatus("Export failed — see console.");
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
