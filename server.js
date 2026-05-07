// =============================================
// GFA AI Server — Outpainting via Gemini
//
// 핵심 전략:
//   1. image + ai-mask 영역을 합친 큰 캔버스를 만든다
//   2. 원본 image는 그대로 보이게 배치한다
//   3. 확장할 빈 영역은 원본 가장자리 픽셀을 얇게 블리드시켜
//      AI가 "이어서 그려야 할 배경"을 인식하게 한다
//   4. Gemini에 원본+확장 캔버스를 보내면서
//      "기존 배경을 참고해서 빈 영역을 seamless하게 채워라" 지시
//   5. 결과 PNG 반환
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

// ── 가장자리 색상 추출 → 블리드용 ──
async function getEdgeColor(imgBuffer, edge, origW, origH) {
  // 가장자리 4px 스트립에서 평균 색상 추출
  const strip = { left: 0, top: 0, width: origW, height: origH };
  const size = 4;

  if (edge === "top") { strip.height = size; }
  else if (edge === "bottom") { strip.top = origH - size; strip.height = size; }
  else if (edge === "left") { strip.width = size; }
  else if (edge === "right") { strip.left = origW - size; strip.width = size; }

  try {
    const { dominant } = await sharp(imgBuffer)
      .extract(strip)
      .stats()
      .then(s => ({ dominant: { r: Math.round(s.channels[0].mean), g: Math.round(s.channels[1].mean), b: Math.round(s.channels[2].mean) } }));
    return dominant;
  } catch {
    return { r: 128, g: 128, b: 128 };
  }
}

// =============================================
// POST /edit — Outpainting
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

      const maskInfoRaw = req.body.mask_info;

      // ── 1) 원본 이미지 ──
      const origBuffer = imageFile.buffer;
      const origMeta = await sharp(origBuffer).metadata();
      const origW = origMeta.width;
      const origH = origMeta.height;
      console.log(`[outpaint] original: ${origW}x${origH}`);

      // ── 2) mask 좌표 파싱 ──
      let expandTop = 0, expandRight = 0, expandBottom = 0, expandLeft = 0;
      let hasMask = false;

      if (maskInfoRaw) {
        try {
          const mask = JSON.parse(maskInfoRaw);
          if (mask.x < 0) expandLeft = Math.abs(mask.x);
          if (mask.y < 0) expandTop = Math.abs(mask.y);
          if (mask.x + mask.w > origW) expandRight = (mask.x + mask.w) - origW;
          if (mask.y + mask.h > origH) expandBottom = (mask.y + mask.h) - origH;
          hasMask = true;
          console.log(`[outpaint] mask: x=${mask.x} y=${mask.y} w=${mask.w} h=${mask.h}`);
        } catch (e) {
          console.warn("[outpaint] mask parse failed:", e.message);
        }
      }

      const hasExpansion = expandTop > 0 || expandRight > 0 || expandBottom > 0 || expandLeft > 0;
      console.log(`[outpaint] expand: T=${expandTop} R=${expandRight} B=${expandBottom} L=${expandLeft}`);

      // ── 3) 확장 캔버스 생성 ──
      let canvasBuffer;
      let canvasW = origW;
      let canvasH = origH;

      if (hasExpansion) {
        canvasW = Math.round(expandLeft + origW + expandRight);
        canvasH = Math.round(expandTop + origH + expandBottom);
        const imgLeft = Math.round(expandLeft);
        const imgTop = Math.round(expandTop);

        console.log(`[outpaint] canvas: ${canvasW}x${canvasH}, image at (${imgLeft}, ${imgTop})`);

        // ★ 핵심: 빈 영역을 가장자리 색으로 블리드
        // AI가 "배경이 이어지는 느낌"을 잡을 수 있게 해줌
        const composites = [];

        // 각 확장 방향에 대해 가장자리 색상으로 블리드 스트립 생성
        if (expandTop > 0) {
          const color = await getEdgeColor(origBuffer, "top", origW, origH);
          const bleed = await sharp({
            create: { width: origW, height: Math.round(expandTop), channels: 4,
              background: { ...color, alpha: 255 } }
          }).png().toBuffer();
          composites.push({ input: bleed, left: imgLeft, top: 0 });
        }
        if (expandBottom > 0) {
          const color = await getEdgeColor(origBuffer, "bottom", origW, origH);
          const bleed = await sharp({
            create: { width: origW, height: Math.round(expandBottom), channels: 4,
              background: { ...color, alpha: 255 } }
          }).png().toBuffer();
          composites.push({ input: bleed, left: imgLeft, top: imgTop + origH });
        }
        if (expandLeft > 0) {
          const color = await getEdgeColor(origBuffer, "left", origW, origH);
          const bleed = await sharp({
            create: { width: Math.round(expandLeft), height: canvasH, channels: 4,
              background: { ...color, alpha: 255 } }
          }).png().toBuffer();
          composites.push({ input: bleed, left: 0, top: 0 });
        }
        if (expandRight > 0) {
          const color = await getEdgeColor(origBuffer, "right", origW, origH);
          const bleed = await sharp({
            create: { width: Math.round(expandRight), height: canvasH, channels: 4,
              background: { ...color, alpha: 255 } }
          }).png().toBuffer();
          composites.push({ input: bleed, left: imgLeft + origW, top: 0 });
        }

        // 원본 이미지를 맨 위에 배치 (블리드 위에)
        composites.push({ input: origBuffer, left: imgLeft, top: imgTop });

        canvasBuffer = await sharp({
          create: {
            width: canvasW,
            height: canvasH,
            channels: 4,
            background: { r: 128, g: 128, b: 128, alpha: 255 },
          },
        })
          .composite(composites)
          .png()
          .toBuffer();
      } else {
        canvasBuffer = origBuffer;
      }

      // ── 4) Gemini API 호출 ──
      const canvasBase64 = canvasBuffer.toString("base64");

      // ★ 프롬프트: 원본이 보이는 상태에서 확장 영역만 자연스럽게 채우도록 지시
      let fullPrompt;
      if (hasExpansion) {
        const directions = [];
        if (expandTop > 0) directions.push(`top (${expandTop}px)`);
        if (expandBottom > 0) directions.push(`bottom (${expandBottom}px)`);
        if (expandLeft > 0) directions.push(`left (${expandLeft}px)`);
        if (expandRight > 0) directions.push(`right (${expandRight}px)`);

        fullPrompt =
          `This image contains an original photo in the center with extended areas on the ${directions.join(", ")} side(s). ` +
          `The extended areas currently show a rough color bleed from the original edges.\n\n` +
          `YOUR TASK: Replace the extended areas with a photorealistic, seamless continuation of the original background.\n\n` +
          `CRITICAL REQUIREMENTS:\n` +
          `- Study the original photo's background carefully: its color gradients, lighting direction, shadow angles, texture patterns, surface materials, and depth of field.\n` +
          `- The extended areas must seamlessly continue the SAME background — same colors, same gradients, same textures, same lighting.\n` +
          `- The transition between the original and extended areas must be COMPLETELY INVISIBLE — no seams, no color shifts, no texture discontinuities.\n` +
          `- Do NOT create flat color fills, solid areas, or simplified versions of the background.\n` +
          `- Do NOT modify, move, distort, or alter the original photo content in any way — especially any product, logo, text, or main subject.\n` +
          `- Do NOT add any new objects, text, watermarks, or elements.\n` +
          `- The final result must look like the original photo was simply taken with a wider-angle lens, showing more of the same scene.\n` +
          `- Pay special attention to: gradient continuity, shadow direction consistency, surface texture repetition, and perspective alignment.`;
      } else if (hasMask) {
        fullPrompt =
          `Extend the existing background seamlessly into the masked area. ` +
          `Use the surrounding background from the original image as reference. ` +
          `Match the original color, lighting, gradient, texture, shadow, and perspective. ` +
          `Do not create a flat color fill. Do not add new objects. ` +
          `Do not modify the product, logo, or main subject. ` +
          `The result must look like a natural continuation of the original photo.`;
      } else {
        fullPrompt = req.body.prompt || "Edit this image.";
      }

      console.log(`[outpaint] sending ${Math.round(canvasBuffer.length / 1024)} KB to Gemini...`);

      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash-image",
        contents: [
          { inlineData: { mimeType: "image/png", data: canvasBase64 } },
          { text: fullPrompt },
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
        if (part.inlineData?.data) { imageData = part.inlineData.data; break; }
      }

      if (!imageData) {
        const textParts = parts.filter(p => p.text).map(p => p.text);
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
  console.log(`   Model: gemini-2.5-flash-image (outpainting)`);
  console.log(`   POST /edit     — image + mask_info → outpainted PNG`);
  console.log(`   POST /generate — prompt → generated PNG`);
});
