// =============================================
// GFA AI 배경 연장 서버 - server.js
// =============================================
//
// 공용 배포용 서버
// Figma 플러그인 → 이 서버 → OpenAI API → Figma 플러그인
//
// 배포 방법 (택 1):
//
// [Render.com - 무료]
//   1. GitHub에 server 폴더 push
//   2. render.com → New Web Service → repo 연결
//   3. Build Command: npm install
//   4. Start Command: node server.js
//   5. Environment → OPENAI_API_KEY 추가
//   6. 배포 완료 → URL을 Figma plugin UI에 입력
//
// [Railway.app]
//   1. GitHub 연결 → Deploy
//   2. Variables → OPENAI_API_KEY 추가
//
// [Fly.io]
//   1. fly launch → fly secrets set OPENAI_API_KEY=sk-xxx → fly deploy
//
// [로컬 테스트]
//   cp .env.example .env → API 키 입력 → npm install → node server.js
//
// =============================================

const dotenv = require("dotenv");
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");

// .env 로드 (로컬 개발용, 배포 시에는 환경변수 직접 설정)
dotenv.config();

// --------------------------------------------------
// 설정
// --------------------------------------------------
const API_KEY = process.env.OPENAI_API_KEY;
const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS; // 쉼표 구분

// API 키 확인
if (!API_KEY || API_KEY.includes("여기에")) {
  console.error("\n❌ OPENAI_API_KEY가 설정되지 않았습니다!");
  console.error("   로컬: .env 파일에 API 키를 입력하세요.");
  console.error("   배포: 환경변수에 OPENAI_API_KEY를 추가하세요.\n");
  process.exit(1);
}

// --------------------------------------------------
// Express 앱
// --------------------------------------------------
const app = express();

// CORS 설정
// ALLOWED_ORIGINS가 있으면 해당 도메인만 허용, 없으면 전체 허용
if (ALLOWED_ORIGINS) {
  var origins = ALLOWED_ORIGINS.split(",").map(function (s) { return s.trim(); });
  app.use(cors({ origin: origins }));
  console.log("  CORS 허용:", origins.join(", "));
} else {
  app.use(cors());
}

// 파일 업로드 (메모리 저장 - 디스크 불필요)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 } // 최대 20MB
});

// OpenAI 클라이언트
const openai = new OpenAI({ apiKey: API_KEY });

// --------------------------------------------------
// GET / - 헬스 체크
// --------------------------------------------------
// 배포 플랫폼이 서버 상태를 확인하는 용도
// 브라우저에서 서버 URL 접속 시 상태 확인 가능
app.get("/", function (req, res) {
  res.json({
    status: "ok",
    service: "GFA AI Background Extend",
    mode: "ai-mask",
    timestamp: new Date().toISOString()
  });
});

// --------------------------------------------------
// GET /health - 헬스 체크 (배포 플랫폼용)
// --------------------------------------------------
app.get("/health", function (req, res) {
  res.status(200).send("ok");
});

// --------------------------------------------------
// POST /expand - AI 배경 연장
// --------------------------------------------------
app.post("/expand", upload.single("image"), async function (req, res) {
  var startTime = Date.now();

  try {
    console.log("\n📥 [" + new Date().toISOString() + "] AI 배경 연장 요청");

    // 이미지 확인
    if (!req.file) {
      return res.status(400).json({ error: "이미지 파일이 없습니다." });
    }

    // maskInfo 파싱
    var maskInfo;
    try {
      maskInfo = JSON.parse(req.body.maskInfo);
    } catch (e) {
      return res.status(400).json({ error: "maskInfo가 올바르지 않습니다." });
    }

    console.log("  mask 좌표:", JSON.stringify(maskInfo));

    // ① 원본 이미지 크기 읽기
    var imgBuffer = req.file.buffer;
    var meta = await sharp(imgBuffer).metadata();
    var imgW = meta.width;
    var imgH = meta.height;
    console.log("  이미지:", imgW + "x" + imgH);

    // ② 마스크 좌표를 이미지 범위 내로 클램핑
    var mx = Math.max(0, maskInfo.x);
    var my = Math.max(0, maskInfo.y);
    var mw = Math.min(maskInfo.w, imgW - mx);
    var mh = Math.min(maskInfo.h, imgH - my);

    if (mw <= 0 || mh <= 0) {
      return res.status(400).json({ error: "ai-mask 영역이 이미지 범위를 벗어났습니다." });
    }

    console.log("  마스크:", mx + "," + my + " " + mw + "x" + mh);

    // ③ 마스크 PNG 생성 (메모리에서 처리, 디스크 사용 안 함)
    //    OpenAI 규칙:
    //    - image와 mask는 같은 크기 RGBA PNG
    //    - mask에서 투명(alpha=0) = AI가 채움
    //    - mask에서 불투명 = 보존

    // 전체 불투명(보존) 캔버스
    var maskBase = await sharp({
      create: { width: imgW, height: imgH, channels: 4,
                background: { r: 0, g: 0, b: 0, alpha: 255 } }
    }).png().toBuffer();

    // ai-mask 영역만 투명(AI가 채울 곳)
    var transparentBlock = await sharp({
      create: { width: mw, height: mh, channels: 4,
                background: { r: 0, g: 0, b: 0, alpha: 0 } }
    }).png().toBuffer();

    // 합성
    var maskPng = await sharp(maskBase)
      .composite([{ input: transparentBlock, left: mx, top: my }])
      .png()
      .toBuffer();

    console.log("  마스크 PNG:", maskPng.length, "bytes");

    // ④ 원본을 RGBA PNG로 변환
    var rgbaPng = await sharp(imgBuffer).ensureAlpha().png().toBuffer();

    // ⑤ OpenAI Image Edit API 호출
    console.log("  OpenAI API 호출 중...");

    // OpenAI SDK는 파일 객체를 요구하므로 임시 파일 생성
    var tmpDir = path.join("/tmp", "gfa-" + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });
    var imgPath = path.join(tmpDir, "image.png");
    var mskPath = path.join(tmpDir, "mask.png");
    fs.writeFileSync(imgPath, rgbaPng);
    fs.writeFileSync(mskPath, maskPng);

    var aiSize = getBestSize(imgW, imgH);

    var response = await openai.images.edit({
      model: "gpt-image-1",
      image: fs.createReadStream(imgPath),
      mask: fs.createReadStream(mskPath),
      prompt:
        "Extend only the background naturally. " +
        "Do not modify, move, or distort any existing objects, products, or logos. " +
        "Keep all existing pixels exactly as they are. " +
        "Fill the masked area with a natural extension of the surrounding background. " +
        "Match the colors, lighting, texture, and style seamlessly.",
      n: 1,
      size: aiSize
    });

    // 임시 파일 즉시 정리
    try { fs.unlinkSync(imgPath); fs.unlinkSync(mskPath); fs.rmdirSync(tmpDir); } catch (e) {}

    console.log("  OpenAI 응답 수신 ✅");

    // ⑥ 결과 다운로드
    var resultUrl = response.data[0].url;
    var fetchRes = await fetch(resultUrl);
    var resultBuffer = Buffer.from(await fetchRes.arrayBuffer());

    // ⑦ 원본 크기로 리사이즈 (OpenAI는 정사각형 반환)
    var finalBuffer = await sharp(resultBuffer)
      .resize(imgW, imgH, { fit: "cover" })
      .png()
      .toBuffer();

    var elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log("  ✅ 완료! (" + elapsed + "초)");
    console.log("  결과:", finalBuffer.length, "bytes\n");

    // ⑧ 결과 전송
    res.set("Content-Type", "image/png");
    res.send(finalBuffer);

  } catch (err) {
    console.error("\n❌ 오류:", err.message);

    var userMsg = err.message;
    if (err.message.includes("401") || err.message.includes("API key"))
      userMsg = "서버 API 키 오류. 관리자에게 문의하세요.";
    else if (err.message.includes("429"))
      userMsg = "요청 한도 초과. 잠시 후 다시 시도해주세요.";
    else if (err.message.includes("billing"))
      userMsg = "서버 API 크레딧 부족. 관리자에게 문의하세요.";

    res.status(500).json({ error: userMsg });
  }
});

// --------------------------------------------------
// 유틸
// --------------------------------------------------
function getBestSize(w, h) {
  var max = Math.max(w, h);
  if (max <= 256) return "256x256";
  if (max <= 512) return "512x512";
  return "1024x1024";
}

// --------------------------------------------------
// 서버 시작
// --------------------------------------------------
app.listen(PORT, function () {
  console.log("");
  console.log("==========================================");
  console.log("  ✅ GFA AI Background Extend Server");
  console.log("  🌐 Port: " + PORT);
  console.log("  🔑 API Key: 설정됨");
  console.log("  📐 모드: ai-mask 레이어 방식");
  console.log("==========================================");
  console.log("");
});
