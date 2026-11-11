import express from "express";

const app = express();
app.use(express.json());

// CORS: halaman lokal di APK (file/asset origin) perlu boleh manggil server ini.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(express.static(".")); // nyajiin index.html

const API_URL = process.env.AI_API_URL;  // contoh: https://provider.com/v1/chat/completions
const API_KEY = process.env.AI_API_KEY;
const MODEL   = process.env.AI_MODEL || "glm-5.3";

const MAX_ATTEMPTS = 3;
const TIMEOUT_MS = 20000;
const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function friendlyError(status) {
  if (status === 401 || status === 403) return "Konfigurasi API lagi bermasalah. Coba hubungi admin ya.";
  if (status === 429) return "Lagi rame banget nih. Tunggu sebentar terus coba lagi ya.";
  if (status === 408 || status >= 500) return "AI lagi sibuk. Coba lagi beberapa saat lagi ya.";
  return "Permintaanmu nggak bisa diproses. Coba ulang dengan kalimat yang lain.";
}

// Panggil provider dengan retry + exponential backoff untuk error sementara.
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
        lastStatus = 502; // respons kosong, anggap error sementara
      } else {
        lastStatus = r.status;
        if (!RETRY_STATUS.has(r.status)) return { ok: false, status: r.status }; // 4xx selain 408/429 nggak di-retry
      }
    } catch {
      lastStatus = 503; // network error atau timeout
    }

    if (attempt < MAX_ATTEMPTS) {
      await sleep(1000 * 2 ** (attempt - 1) + Math.random() * 250);
    }
  }
  return { ok: false, status: lastStatus };
}

app.get("/api/health", (req, res) => {
  const configured = Boolean(API_URL && API_KEY);
  res.status(configured ? 200 : 500).json({
    ok: configured,
    message: configured ? "Server online." : "Server belum dikonfigurasi. Cek environment variable.",
  });
});

app.post("/api/chat", async (req, res) => {
  if (!API_URL || !API_KEY) {
    return res.status(500).json({ error: "Server belum dikonfigurasi. Coba hubungi admin ya." });
  }

  const messages = req.body?.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "Pesannya kosong nih, tulis sesuatu dulu ya." });
  }

  const result = await callAI(messages);
  if (result.ok) return res.json({ reply: result.reply });

  res.status(result.status >= 400 && result.status < 600 ? result.status : 500)
     .json({ error: friendlyError(result.status) });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Jalan di port ${PORT}`));
