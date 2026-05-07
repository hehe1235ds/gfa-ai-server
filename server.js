import express from "express";
import multer from "multer";
import FormData from "form-data";

const app = express();
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// ── Multer: 메모리 저장 (최대 10MB) ──
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// ── Health check ──
app.get("/", (_req, res) => {
  res.json({ status: "ok", model: "gpt-image-1" });
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
      if (!OPENAI_API_KEY) {
        return res.status(500).json({ error: "OPENAI_API_KEY not configured" });
      }

      const imageFile = req.files?.["image"]?.[0];
      if (!imageFile) {
        return res.status(400).json({ error: '"image" file is required' });
      }

      const prompt = req.body.prompt;
      if (!prompt) {
        return res.status(400).json({ error: '"prompt" field is required' });
      }

      // 2) OpenAI /v1/images/edits 용 multipart/form-data 구성
      const form = new FormData();
      form.append("model", "gpt-image-1");
      form.append("prompt", prompt);
      form.append("image", imageFile.buffer, {
        filename: imageFile.originalname || "image.png",
        contentType: imageFile.mimetype || "image/png",
      });

      // 마스크가 있으면 첨부 (투명 영역 = 편집 대상)
      const maskFile = req.files?.["mask"]?.[0];
      if (maskFile) {
        form.append("mask", maskFile.buffer, {
          filename: maskFile.originalname || "mask.png",
          contentType: "image/png",
        });
      }

      // 선택적 파라미터
      const size = req.body.size || "auto";
      form.append("size", size);

      const quality = req.body.quality || "auto";
      form.append("quality", quality);

      // gpt-image-1은 항상 b64_json 반환 — output_format으로 png 지정
      form.append("output_format", "png");
      form.append("n", "1");

      // 3) OpenAI API 호출 (타임아웃 5분)
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5 * 60 * 1000);

      const response = await fetch("https://api.openai.com/v1/images/edits", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          ...form.getHeaders(),
        },
        body: form.getBuffer(),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      // 4) 응답 처리
      const data = await response.json();

      if (!response.ok) {
        console.error("OpenAI error:", JSON.stringify(data, null, 2));
        return res.status(response.status).json({
          error: data.error?.message || "OpenAI API error",
          detail: data.error,
        });
      }

      const b64 = data.data?.[0]?.b64_json;
      if (!b64) {
        return res.status(502).json({ error: "No image data in response" });
      }

      // 5) PNG 바이너리로 응답
      const imgBuffer = Buffer.from(b64, "base64");
      res.set({
        "Content-Type": "image/png",
        "Content-Length": imgBuffer.length,
        "Content-Disposition": 'inline; filename="edited.png"',
      });
      return res.send(imgBuffer);
    } catch (err) {
      if (err.name === "AbortError") {
        return res.status(504).json({ error: "OpenAI request timed out" });
      }
      console.error("Server error:", err);
      return res.status(500).json({ error: err.message });
    }
  }
);

// ── 이미지 생성 엔드포인트 (보너스) ──
app.post("/generate", express.json(), async (req, res) => {
  try {
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: "OPENAI_API_KEY not configured" });
    }

    const { prompt, size = "1024x1024", quality = "auto" } = req.body;
    if (!prompt) {
      return res.status(400).json({ error: '"prompt" field is required' });
    }

    const response = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-image-1",
        prompt,
        n: 1,
        size,
        quality,
        output_format: "png",
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("OpenAI error:", JSON.stringify(data, null, 2));
      return res.status(response.status).json({
        error: data.error?.message || "OpenAI API error",
        detail: data.error,
      });
    }

    const b64 = data.data?.[0]?.b64_json;
    if (!b64) {
      return res.status(502).json({ error: "No image data in response" });
    }

    const imgBuffer = Buffer.from(b64, "base64");
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
  console.log(`   Model: gpt-image-1`);
  console.log(`   POST /edit     — image + mask + prompt → edited PNG`);
  console.log(`   POST /generate — prompt → generated PNG`);
});
