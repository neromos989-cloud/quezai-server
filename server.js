import express from "express";

const app = express();
app.use(express.json({ limit: "50kb" }));

// CORS: halaman lokal di APK (file/asset origin) perlu boleh manggil server ini.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.static(".")); // nyajiin index.html

// Setting untuk Gemini API (endpoint OpenAI-compatible dari Google AI Studio)
const API_URL = process.env.AI_API_URL || "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const API_KEY = process.env.AI_API_KEY; 
const MODEL   = process.env.AI_MODEL || "gemini-2.5-flash";

const MAX_ATTEMPTS = 3;
const TIMEOUT_MS = 20000;
const MAX_MESSAGES = 30;
const MAX_CHARS = 2000;
const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function friendlyError(status) {
  if (status === 400 || status === 401 || status === 403) return "Konfigurasi API lagi bermasalah. Coba hubungi admin ya.";
  if (status === 404) return "Model AI yang dipakai nggak ditemukan. Coba hubungi admin ya.";
  if (status === 429) return "Lagi rame banget nih. Tunggu sebentar terus coba lagi ya.";
  if (status === 408 || status >= 500) return "AI lagi sibuk. Coba lagi beberapa saat lagi ya.";
  return "Permintaanmu nggak bisa diproses. Coba ulang dengan kalimat yang lain.";
}

// Bersihin pesan dari client: cuma role user/assistant, dibatasi jumlah dan panjangnya.
function sanitizeMessages(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const cleaned = raw
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_CHARS) }))
    .slice(-MAX_MESSAGES);
  if (cleaned.length === 0 || cleaned[cleaned.length - 1].role !== "user") return null;
  return cleaned;
}

// Panggil Gemini dengan retry + exponential backoff untuk error sementara.
async function callAI(messages) {
  let lastStatus = 503;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const r = await fetch(API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({ model: MODEL, messages }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (r.ok) {
        const data = await r.json();
        const reply = data.choices?.[0]?.message?.content;
        if (reply) return { ok: true, reply };
        lastStatus = 502;
      } else {
        lastStatus = r.status;
        if (!RETRY_STATUS.has(r.status)) return { ok: false, status: r.status };
      }
    } catch {
      lastStatus = 503;
    }

    if (attempt < MAX_ATTEMPTS) {
      await sleep(1000 * 2 ** (attempt - 1) + Math.random() * 250);
    }
  }
  return { ok: false, status: lastStatus };
}

app.get("/api/health", (req, res) => {
  const configured = Boolean(API_KEY);
  res.status(configured ? 200 : 500).json({
    ok: configured,
    message: configured ? "Server online." : "Server belum dikonfigurasi. Cek environment variable.",
  });
});

app.post("/api/chat", async (req, res) => {
  if (!API_KEY) {
    return res.status(500).json({ error: "Server belum dikonfigurasi. Coba hubungi admin ya." });
  }

  const messages = sanitizeMessages(req.body?.messages);
  if (!messages) {
    return res.status(400).json({ error: "Pesannya kosong nih, tulis sesuatu dulu ya." });
  }

  const result = await callAI(messages);
  if (result.ok) return res.json({ reply: result.reply });

  res.status(result.status >= 400 && result.status < 600 ? result.status : 500)
     .json({ error: friendlyError(result.status) });
});

const PORT = process.env.PORT || process.env.SERVER_PORT || 3000;
app.listen(PORT, () => console.log(`Jalan di port ${PORT}`));
