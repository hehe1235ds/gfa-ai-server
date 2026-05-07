// =============================================
// GFA AI Server — Google Gemini (gemini-2.5-flash-image)
// 배경 확장 + 이미지 편집 + 이미지 생성
// =============================================

import express from "express";
import multer from "multer";
import { GoogleGenAI } from "@google/genai";

const app = express();
const PORT = process.env.PORT || 3000;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

// ── Gemini 클라이언트 ──
const ai = new GoogleGenAI({ apiKey: GOOGLE_API_KEY });

// ── CORS: Figma 플러그인은 origin: null 환경 ──
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

// ── Multer: 메모리 저장 (최대 10MB) ──
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// ── Health check ──
app.get("/", (_req, res) => {
  res.json({ status: "ok", model: "gemini-2.5-flash-image", provider: "google" });
});

// ── 이미지 편집 엔드포인트 ──
app.post(
  "/edit",
  upload.fields([
    { name: "image", maxCount: 1 },
    { name: "mask", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      // 1) 입력 검증
      if (!GOOGLE_API_KEY) {
        return res.status(500).json({ error: "GOOGLE_API_KEY not configured" });
      }

      const imageFile = req.files?.["image"]?.[0];
      if (!imageFile) {
        return res.status(400).json({ error: '"image" file is required' });
      }

      const prompt = req.body.prompt || "Expand the background naturally. Keep the style, lighting, and perspective consistent.";
      const maskInfoRaw = req.body.mask_info;

      // 2) 이미지를 base64로 변환
      const imageBase64 = imageFile.buffer.toString("base64");
      const imageMimeType = imageFile.mimetype || "image/png";

      // 3) 프롬프트 구성 (마스크 정보가 있으면 포함)
      let fullPrompt = prompt;
      if (maskInfoRaw) {
        try {
          const mask = JSON.parse(maskInfoRaw);
          fullPrompt += ` The area to expand/edit is at position x:${mask.x}, y:${mask.y} with size ${mask.w}x${mask.h} pixels relative to the image. Seamlessly extend the background into this region.`;
        } catch (e) {
          // mask_info 파싱 실패 시 무시
        }
      }

      console.log(`[edit] prompt: ${fullPrompt.substring(0, 100)}...`);

      // 4) Gemini API 호출
      const contents = [
        {
          inlineData: {
            mimeType: imageMimeType,
            data: imageBase64,
          },
        },
        {
          text: fullPrompt,
        },
      ];

      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash-image",
        contents: contents,
        config: {
          responseModalities: ["IMAGE"],
        },
      });

      // 5) 응답에서 이미지 추출
      const parts = response.candidates?.[0]?.content?.parts;
      if (!parts || parts.length === 0) {
        return res.status(502).json({ error: "No response from Gemini" });
      }

      let imageData = null;
      for (const part of parts) {
        if (part.inlineData && part.inlineData.data) {
          imageData = part.inlineData.data;
          break;
        }
      }

      if (!imageData) {
        // 텍스트 응답만 온 경우 (이미지 생성 실패)
        const textParts = parts.filter((p) => p.text).map((p) => p.text);
        return res.status(502).json({
          error: "Gemini did not return an image",
          detail: textParts.join(" ") || "No details available",
        });
      }

      // 6) PNG 바이너리로 응답
      const imgBuffer = Buffer.from(imageData, "base64");
      res.set({
        "Content-Type": "image/png",
        "Content-Length": imgBuffer.length,
        "Content-Disposition": 'inline; filename="edited.png"',
      });
      return res.send(imgBuffer);
    } catch (err) {
      console.error("Server error:", err);

      // Gemini API 에러 구조 파싱
      const errMsg = err.message || String(err);
      const status = err.status || 500;
      return res.status(status).json({ error: errMsg });
    }
  }
);

// ── 이미지 생성 엔드포인트 ──
app.post("/generate", express.json(), async (req, res) => {
  try {
    if (!GOOGLE_API_KEY) {
      return res.status(500).json({ error: "GOOGLE_API_KEY not configured" });
    }

    const { prompt } = req.body;
    if (!prompt) {
      return res.status(400).json({ error: '"prompt" field is required' });
    }

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash-image",
      contents: prompt,
      config: {
        responseModalities: ["IMAGE"],
      },
    });

    const parts = response.candidates?.[0]?.content?.parts;
    let imageData = null;
    if (parts) {
      for (const part of parts) {
        if (part.inlineData && part.inlineData.data) {
          imageData = part.inlineData.data;
          break;
        }
      }
    }

    if (!imageData) {
      return res.status(502).json({ error: "No image data in response" });
    }

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

// ── 서버 시작 ──
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`   Model: gemini-2.5-flash-image (Google)`);
  console.log(`   POST /edit     — image + prompt → edited PNG`);
  console.log(`   POST /generate — prompt → generated PNG`);
});
