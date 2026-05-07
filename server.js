// =============================================
// GFA AI Server — Outpainting via Gemini
// 서버에서 확장 캔버스 + 마스크를 생성하고
// Gemini에 "이 이미지를 자연스럽게 채워줘" 요청
// =============================================

import express from "express";
import multer from "multer";
import sharp from "sharp";
import { GoogleGenAI } from "@google/genai";

const app = express();
const PORT = process.env.PORT || 3000;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

const ai = new GoogleGenAI({ apiKey: GOOGLE_API_KEY });

// ── CORS ──
app.use((req, res, next) => {
  res.set({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  });
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

// ── Multer ──
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// ── Health check ──
app.get("/", (_req, res) => {
  res.json({ status: "ok", model: "gemini-2.5-flash-image", mode: "outpainting" });
});

// =============================================
// POST /edit — Outpainting 엔드포인트
//
// 클라이언트가 보내는 것:
//   - image: 원본 PNG
//   - mask_info: JSON { x, y, w, h } — ai-mask의 상대좌표 (image 기준)
//     음수 x,y = 이미지 밖으로 확장하려는 의도
//   - prompt: (선택) 확장 영역 설명
//
// 서버 처리:
//   1. 원본 + ai-mask 합쳐서 "확장된 캔버스" 크기 계산
//   2. 큰 캔버스에 원본을 배치 (확장 방향에 따라 오프셋)
//   3. 캔버스 전체를 Gemini에 전송 + outpainting 프롬프트
//   4. Gemini 결과 PNG 반환
// =============================================
app.post(
  "/edit",
  upload.fields([{ name: "image", maxCount: 1 }]),
  async (req, res) => {
    try {
      if (!GOOGLE_API_KEY) {
        return res.status(500).json({ error: "GOOGLE_API_KEY not configured" });
      }

      const imageFile = req.files?.["image"]?.[0];
      if (!imageFile) {
        return res.status(400).json({ error: '"image" file is required' });
      }

      const prompt = req.body.prompt || "Seamlessly extend and fill the empty transparent areas of this image with natural background that matches the existing content's style, lighting, color palette, and perspective. Do not alter the existing image content.";
      const maskInfoRaw = req.body.mask_info;

      // ── 1) 원본 이미지 메타데이터 ──
      const origBuffer = imageFile.buffer;
      const origMeta = await sharp(origBuffer).metadata();
      const origW = origMeta.width;
      const origH = origMeta.height;

      console.log(`[outpaint] original: ${origW}x${origH}`);

      // ── 2) ai-mask 좌표에서 확장 캔버스 크기 계산 ──
      let expandTop = 0, expandRight = 0, expandBottom = 0, expandLeft = 0;

      if (maskInfoRaw) {
        try {
          const mask = JSON.parse(maskInfoRaw);
          // mask.x, mask.y는 image 좌상단 기준 상대좌표
          // 음수 = 이미지 밖 (위쪽 or 왼쪽으로 확장)
          // mask 영역이 image를 넘어가는 만큼이 확장량

          if (mask.x < 0) expandLeft = Math.abs(mask.x);
          if (mask.y < 0) expandTop = Math.abs(mask.y);
          if (mask.x + mask.w > origW) expandRight = (mask.x + mask.w) - origW;
          if (mask.y + mask.h > origH) expandBottom = (mask.y + mask.h) - origH;

          console.log(`[outpaint] mask: x=${mask.x} y=${mask.y} w=${mask.w} h=${mask.h}`);
        } catch (e) {
          console.warn("[outpaint] mask_info parse failed:", e.message);
        }
      }

      // 최소 확장 보장 (mask가 image 안에만 있어도 기본 확장)
      const hasExpansion = expandTop > 0 || expandRight > 0 || expandBottom > 0 || expandLeft > 0;

      console.log(`[outpaint] expand: top=${expandTop} right=${expandRight} bottom=${expandBottom} left=${expandLeft}`);

      // ── 3) 확장 캔버스 생성 ──
      let canvasBuffer;

      if (hasExpansion) {
        const newW = Math.round(expandLeft + origW + expandRight);
        const newH = Math.round(expandTop + origH + expandBottom);

        console.log(`[outpaint] canvas: ${newW}x${newH}, image at (${Math.round(expandLeft)}, ${Math.round(expandTop)})`);

        // 투명 캔버스에 원본 배치
        canvasBuffer = await sharp({
          create: {
            width: newW,
            height: newH,
            channels: 4,
            background: { r: 0, g: 0, b: 0, alpha: 0 },
          },
        })
          .composite([
            {
              input: origBuffer,
              left: Math.round(expandLeft),
              top: Math.round(expandTop),
            },
          ])
          .png()
          .toBuffer();
      } else {
        // 확장 없이 기존 이미지 그대로 (inpainting 모드)
        canvasBuffer = origBuffer;
      }

      // ── 4) Gemini API 호출 ──
      const canvasBase64 = canvasBuffer.toString("base64");

      let fullPrompt;
      if (hasExpansion) {
        fullPrompt =
          prompt +
          "\n\nThis image has transparent (empty) areas around the edges where the background needs to be generated. " +
          "The existing content is placed within the image — fill ONLY the transparent/empty areas with a natural continuation of the scene. " +
          "Do NOT modify or regenerate the existing content. Match lighting, perspective, color palette, and style exactly.";
      } else {
        fullPrompt = prompt;
      }

      console.log(`[outpaint] sending to Gemini (${Math.round(canvasBuffer.length / 1024)} KB)...`);

      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash-image",
        contents: [
          {
            inlineData: {
              mimeType: "image/png",
              data: canvasBase64,
            },
          },
          {
            text: fullPrompt,
          },
        ],
        config: {
          responseModalities: ["IMAGE"],
        },
      });

      // ── 5) 응답 이미지 추출 ──
      const parts = response.candidates?.[0]?.content?.parts;
      if (!parts || parts.length === 0) {
        return res.status(502).json({ error: "No response from Gemini" });
      }

      let imageData = null;
      for (const part of parts) {
        if (part.inlineData?.data) {
          imageData = part.inlineData.data;
          break;
        }
      }

      if (!imageData) {
        const textParts = parts.filter((p) => p.text).map((p) => p.text);
        return res.status(502).json({
          error: "Gemini did not return an image",
          detail: textParts.join(" ") || "Unknown",
        });
      }

      // ── 6) PNG 반환 ──
      const imgBuffer = Buffer.from(imageData, "base64");
      console.log(`[outpaint] result: ${Math.round(imgBuffer.length / 1024)} KB`);

      res.set({
        "Content-Type": "image/png",
        "Content-Length": imgBuffer.length,
        "Content-Disposition": 'inline; filename="outpainted.png"',
      });
      return res.send(imgBuffer);
    } catch (err) {
      console.error("Server error:", err);
      return res.status(err.status || 500).json({ error: err.message || String(err) });
    }
  }
);

// ── 이미지 생성 ──
app.post("/generate", express.json(), async (req, res) => {
  try {
    if (!GOOGLE_API_KEY) return res.status(500).json({ error: "GOOGLE_API_KEY not configured" });

    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: '"prompt" field is required' });

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash-image",
      contents: prompt,
      config: { responseModalities: ["IMAGE"] },
    });

    const parts = response.candidates?.[0]?.content?.parts;
    let imageData = null;
    if (parts) {
      for (const part of parts) {
        if (part.inlineData?.data) { imageData = part.inlineData.data; break; }
      }
    }
    if (!imageData) return res.status(502).json({ error: "No image data" });

    const imgBuffer = Buffer.from(imageData, "base64");
    res.set({
      "Content-Type": "image/png",
      "Content-Length": imgBuffer.length,
      "Content-Disposition": 'inline; filename="generated.png"',
    });
    return res.send(imgBuffer);
  } catch (err) {
    console.error("Server error:", err);
    return res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`   Model: gemini-2.5-flash-image (outpainting mode)`);
  console.log(`   POST /edit     — image + mask_info → outpainted PNG`);
  console.log(`   POST /generate — prompt → generated PNG`);
});
