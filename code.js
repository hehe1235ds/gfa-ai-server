// =============================================
// GFA Banner Generator - code.js
// 배너 생성 + AI 배경 연장 (ai-mask 방식)
// =============================================

// --------------------------------------------------
// 배너 사이즈별 설정
// --------------------------------------------------
var CONFIGS = [
  {
    name: "1200x628",
    w: 1200, h: 628,
    sx: 60, sy: 60, sp: 120, sq: 120,
    lx: 115, ly: 105,
    imgBoost: 1.0, imgMinScale: 1.3,
    mtx: { x: 115, width: 420, align: "LEFT", fontSize: 44 },
    stx: { x: 115, width: 320, align: "LEFT", fontSize: 32 }
  },
  {
    name: "1200x1200",
    w: 1200, h: 1200,
    sx: 60, sy: 60, sp: 120, sq: 120,
    lx: 535, ly: 115,
    imgBoost: 1.5, imgMinScale: 1.5,
    mtx: { x: 300, width: 600, align: "CENTER", fontSize: 48 },
    stx: { x: 360, width: 480, align: "CENTER", fontSize: 35 }
  },
  {
    name: "1250x560",
    w: 1250, h: 560,
    sx: 240, sy: 50, sp: 480, sq: 85,
    lx: 290, ly: 95,
    imgBoost: 1.0, imgMinScale: 1.2,
    mtx: { x: 290, width: 320, align: "LEFT", fontSize: 40 },
    stx: { x: 290, width: 280, align: "LEFT", fontSize: 30 }
  }
];

var NEED = ["image", "logo", "maintx", "subcopy"];

figma.showUI(__html__, { width: 360, height: 640 });

// --------------------------------------------------
// 메시지 수신
// --------------------------------------------------
figma.ui.onmessage = function (msg) {
  if (msg.type === "generate") {
    generate(msg).catch(function (e) { figma.notify("오류: " + e.message); });
  }
  if (msg.type === "ai-expand") {
    aiExpand(msg).catch(function (e) { figma.notify("AI 오류: " + e.message); });
  }
  if (msg.type === "ai-expand-result") {
    applyAiResult(msg.imageBase64);
  }
  if (msg.type === "ai-expand-error") {
    figma.notify("AI: " + msg.error);
  }
};

// =============================================
// 배너 생성 (기존 기능 전체 유지)
// =============================================
function generate(msg) {
  var asset = findAsset();
  if (!asset) { figma.notify('"asset" 프레임을 찾을 수 없습니다.'); return Promise.resolve(); }
  for (var i = 0; i < NEED.length; i++) {
    if (!findChild(asset, NEED[i])) { figma.notify('"' + NEED[i] + '" 레이어가 없습니다.'); return Promise.resolve(); }
  }

  var tplColor = null;
  if (msg.colorMode === "template") {
    var ot = findChild(asset, "maintx");
    if (ot && ot.type === "TEXT") tplColor = grabColor(ot);
  }

  var oi = findChild(asset, "image");
  var oiW = oi ? oi.width : 400, oiH = oi ? oi.height : 300;

  return loadFonts(asset).then(function () {
    var startX = asset.x + asset.width + 100;
    for (var c = 0; c < CONFIGS.length; c++) {
      var cfg = CONFIGS[c];
      var fr = asset.clone();
      fr.name = cfg.name; fr.resize(cfg.w, cfg.h);
      fr.x = startX; fr.y = asset.y; fr.clipsContent = true;
      startX = fr.x + cfg.w + 60;

      var img = findChild(fr, "image"), logo = findChild(fr, "logo");
      var mtx = findChild(fr, "maintx"), stx = findChild(fr, "subcopy");

      // 복제 시 ai-mask가 따라오면 제거
      var cm = findChild(fr, "ai-mask"); if (cm) cm.remove();

      var saX = cfg.sx, saY = cfg.sy, saW = cfg.w - cfg.sp, saH = cfg.h - cfg.sq;

      if (img) { img.resize(oiW, oiH); coverInSafe(img, saX, saY, saW, saH, cfg.imgBoost, cfg.imgMinScale); }
      if (msg.gradient && img) addGrad(fr, img, msg.gradDir || "top");
      if (logo) { logo.x = cfg.lx; logo.y = cfg.ly; }

      var mSize = 22;
      if (mtx && mtx.type === "TEXT") {
        mtx.textAutoResize = "HEIGHT"; mtx.x = cfg.mtx.x;
        mtx.resize(cfg.mtx.width, mtx.height); mtx.characters = msg.maintx;
        mSize = autoFit(mtx, cfg.mtx.width, Math.min(52, cfg.mtx.fontSize), 22);
        mtx.textAlignHorizontal = cfg.mtx.align;
        if (logo) mtx.y = logo.y + logo.height + 20;
        paintNode(mtx, pickColor(msg.colorMode, msg.manualColor, tplColor, img));
      }
      if (stx && stx.type === "TEXT") {
        stx.textAutoResize = "HEIGHT"; stx.x = cfg.stx.x;
        stx.resize(cfg.stx.width, stx.height); stx.characters = msg.subcopy;
        var sMax = Math.min(cfg.stx.fontSize, mSize - 6); if (sMax < 22) sMax = 22;
        autoFit(stx, cfg.stx.width, sMax, 22);
        stx.textAlignHorizontal = cfg.stx.align;
        if (mtx) stx.y = mtx.y + mtx.height + 20;
        paintNode(stx, hexRgb("#4A4A4A"));
      }
      drawSafe(fr, saX, saY, saW, saH);
    }
    figma.notify("배너 3개 생성 완료!");
  });
}

// =============================================
// AI 배경 연장 (ai-mask 방식)
// =============================================
function aiExpand(msg) {
  var serverUrl = msg.serverUrl;
  var asset = findAsset();
  if (!asset) { figma.notify('"asset" 프레임을 찾을 수 없습니다.'); return Promise.resolve(); }

  var imgNode = findChild(asset, "image");
  if (!imgNode) { figma.notify('"image" 레이어를 찾을 수 없습니다.'); return Promise.resolve(); }

  var maskNode = findChild(asset, "ai-mask");
  if (!maskNode) {
    figma.notify('"ai-mask" 레이어를 만들어주세요.\nimage 위에 사각형을 그리고 이름을 "ai-mask"로 지정하세요.');
    return Promise.resolve();
  }

  // ai-mask 좌표를 image 기준 상대좌표로 계산
  var maskInfo = {
    x: Math.round(maskNode.x - imgNode.x),
    y: Math.round(maskNode.y - imgNode.y),
    w: Math.round(maskNode.width),
    h: Math.round(maskNode.height)
  };

  // image PNG export → UI로 전송
  return imgNode.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 1 } })
    .then(function (pngBytes) {
      figma.ui.postMessage({
        type: "ai-expand-request",
        imageBase64: b64Encode(pngBytes),
        maskInfo: maskInfo,
        serverUrl: serverUrl
      });
    });
}

// AI 결과 적용 + ai-mask 숨김
function applyAiResult(base64Str) {
  var asset = findAsset();
  if (!asset) return;
  var imgNode = findChild(asset, "image");
  if (!imgNode) return;

  var raw = b64Decode(base64Str);
  var imageHash = figma.createImage(raw).hash;
  imgNode.fills = [{ type: "IMAGE", scaleMode: "FILL", imageHash: imageHash }];

  var maskNode = findChild(asset, "ai-mask");
  if (maskNode) maskNode.visible = false;

  figma.notify("AI 배경 연장 완료!");
}

// =============================================
// 유틸 함수
// =============================================
function findAsset() {
  return figma.currentPage.findOne(function (n) { return n.type === "FRAME" && n.name === "asset"; });
}
function findChild(p, name) {
  return p.findOne(function (n) { return n.name === name; });
}
function loadFonts(frame) {
  var nodes = frame.findAll(function (n) { return n.type === "TEXT"; });
  var map = {};
  for (var t = 0; t < nodes.length; t++) {
    var nd = nodes[t], len = nd.characters.length;
    if (len === 0) { var f = nd.fontName; if (f && typeof f === "object" && f.family) map[JSON.stringify(f)] = f; }
    else { for (var i = 0; i < len; i++) { var f = nd.getRangeFontName(i, i + 1); if (f && typeof f === "object" && f.family) map[JSON.stringify(f)] = f; } }
  }
  var arr = [], keys = Object.keys(map);
  for (var k = 0; k < keys.length; k++) arr.push(figma.loadFontAsync(map[keys[k]]));
  return Promise.all(arr);
}
function autoFit(node, w, maxSize, minSize) {
  var size = maxSize; setSizes(node, size); node.resize(w, node.height);
  while (size > minSize && countLines(node) > 4) { size -= 2; if (size < minSize) { size = minSize; break; } setSizes(node, size); }
  return size;
}
function setSizes(n, s) { if (n.characters.length > 0) n.setRangeFontSize(0, n.characters.length, s); }
function countLines(n) {
  if (n.characters.length === 0) return 0;
  var lh = n.lineHeight, lineH;
  if (lh && typeof lh === "object" && lh.unit === "PIXELS") lineH = lh.value;
  else { var fs = n.fontSize; if (typeof fs !== "number") fs = n.getRangeFontSize(0, 1); lineH = fs * 1.2; }
  if (lineH <= 0) lineH = 20; return Math.round(n.height / lineH);
}
function paintNode(n, rgb) { n.fills = [{ type: "SOLID", color: rgb }]; }
function grabColor(n) { try { var f = n.fills; if (f && f.length > 0 && f[0].type === "SOLID") { var c = f[0].color; return { r: c.r, g: c.g, b: c.b }; } } catch (e) {} return null; }
function hexRgb(hex) { var h = hex.replace("#", ""); return { r: parseInt(h.substring(0,2),16)/255, g: parseInt(h.substring(2,4),16)/255, b: parseInt(h.substring(4,6),16)/255 }; }
function pickColor(mode, manualHex, tplColor, imgNode) {
  if (mode === "manual") return hexRgb(manualHex);
  if (mode === "template" && tplColor) return tplColor;
  return isBright(imgNode) ? { r:0,g:0,b:0 } : { r:1,g:1,b:1 };
}
function isBright(n) { if (!n) return true; try { var f = n.fills; if (f && f.length > 0) { for (var i = 0; i < f.length; i++) { if (f[i].type === "SOLID" && f[i].visible !== false) { var c = f[i].color; return (0.299*c.r+0.587*c.g+0.114*c.b)>0.5; } } } } catch(e){} return true; }
function coverInSafe(node, sx, sy, sw, sh, boost, minScale) {
  var ow = node.width, oh = node.height; if (ow <= 0 || oh <= 0) return;
  var scale = Math.max(Math.max(sw/ow, sh/oh), minScale||1.3) * (boost||1.0);
  var nw = ow*scale, nh = oh*scale;
  var maxArea = sw*sh*2.5;
  if (nw*nh > maxArea) { var sh2 = Math.sqrt(maxArea/(nw*nh)); nw*=sh2; nh*=sh2; }
  node.resize(nw, nh); node.x = sx+(sw-nw)/2; node.y = sy+(sh-nh)/2;
}
function addGrad(frame, imgNode, dir) {
  var old = findChild(frame, "gradient-overlay"); if (old) old.remove();
  var rect = figma.createRectangle(); rect.name = "gradient-overlay"; rect.x = 0; rect.y = 0;
  rect.resize(frame.width, frame.height);
  var t = dir === "left" ? [[1,0,0],[0,1,0]] : [[0,1,0],[-1,0,1]];
  rect.fills = [{ type: "GRADIENT_LINEAR", gradientTransform: t, gradientStops: [{ position:0, color:{r:0,g:0,b:0,a:0.5}},{ position:1, color:{r:0,g:0,b:0,a:0}}]}];
  frame.appendChild(rect); var idx = childIdx(frame, imgNode); if (idx >= 0) frame.insertChild(idx+1, rect);
}
function childIdx(p, c) { for (var i = 0; i < p.children.length; i++) { if (p.children[i].id === c.id) return i; } return -1; }
function drawSafe(frame, x, y, w, h) {
  var sa = findChild(frame, "safe-area");
  if (!sa) { sa = figma.createRectangle(); sa.name = "safe-area"; frame.appendChild(sa); }
  sa.x = x; sa.y = y; sa.resize(w, h); sa.fills = [];
  sa.strokes = [{ type: "SOLID", color: hexRgb("#FF0000") }]; sa.strokeWeight = 1; sa.dashPattern = [4,4];
  frame.appendChild(sa); sa.locked = true;
}

// base64 (Figma sandbox 호환)
var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function b64Encode(bytes) { var r="",len=bytes.length; for(var i=0;i<len;i+=3){var b1=bytes[i],b2=i+1<len?bytes[i+1]:0,b3=i+2<len?bytes[i+2]:0;r+=B64[b1>>2];r+=B64[((b1&3)<<4)|(b2>>4)];r+=(i+1<len)?B64[((b2&15)<<2)|(b3>>6)]:"=";r+=(i+2<len)?B64[b3&63]:"=";} return r; }
function b64Decode(str) { var len=str.length,bLen=len*3/4; if(str[len-1]==="=")bLen--;if(str[len-2]==="=")bLen--;var bytes=new Uint8Array(bLen),p=0;for(var i=0;i<len;i+=4){var e1=B64.indexOf(str[i]),e2=B64.indexOf(str[i+1]),e3=B64.indexOf(str[i+2]),e4=B64.indexOf(str[i+3]);bytes[p++]=(e1<<2)|(e2>>4);if(e3!==-1)bytes[p++]=((e2&15)<<4)|(e3>>2);if(e4!==-1)bytes[p++]=((e3&3)<<6)|e4;}return bytes; }
