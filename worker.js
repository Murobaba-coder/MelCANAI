// Melcan AI - Cloudflare Worker (v3: akış + resim + internet araması)
// API key "GEMINI_API_KEY" secret olarak saklanır, kodda YOK.

const ALLOWED_ORIGIN = "https://murobaba-coder.github.io";
const RATE_LIMIT = 15;
const MAX_MESSAGE_CHARS = 1500;
const MAX_HISTORY = 10;
const MAX_IMAGE_CHARS = 1500000;     // base64 uzunluğu (~1 MB resim)
const FIRST_CHUNK_TIMEOUT_MS = 20000;

const SYSTEM_PROMPT = `Senin adın Melcan AI. Seni Muro Baba geliştirdi, kurucun odur. Türkçe konuşan, samimi, yardımsever ve genel amaçlı bir sohbet asistanısın. Her konuda yardımcı olabilirsin: sohbet, bilgi, ödev, oyun, fikir. Cevapların net, anlaşılır ve arkadaşça olsun. Kendini Melcan AI olarak tanıt. Dini konularda saygılı ve dengeli ol. İslam'la ilgili sorularda bilgiyi güvenilir kaynaklara dayandırarak ver, mezhepler arasında görüş farkı olan konularda bunu belirt. Kişiye özel fetva gerektiren sorularda Diyanet İşleri Başkanlığı'na ya da yetkili bir âlime danışmasını öner. Ayet ve hadis aktarırken emin olmadığın metni ASLA uydurma; emin değilsen bunu açıkça söyle. Gerektiğinde **kalın yazı**, "- " ile başlayan listeler ve kod için kod bloğu kullanabilirsin; başlık işareti (#) kullanma.`;

const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 60000);
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) hits.clear();
  return arr.length > RATE_LIMIT;
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}

// Gemini'nin SSE akışını düz metin parçalarına çevirir
function toText(body) {
  const dec = new TextDecoder(), enc = new TextEncoder();
  let buf = "";
  return body.pipeThrough(new TransformStream({
    transform(chunk, ctrl) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        try {
          const j = JSON.parse(line.slice(5));
          const t = j.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("");
          if (t) ctrl.enqueue(enc.encode(t));
        } catch (e) {}
      }
    },
  }));
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin",
    };

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST") return json({ error: "Sadece POST" }, 405, cors);
    if (origin !== ALLOWED_ORIGIN) return json({ error: "Yetkisiz kaynak" }, 403, cors);

    const ip = request.headers.get("CF-Connecting-IP") || "bilinmiyor";
    if (rateLimited(ip)) return json({ error: "Çok hızlı yazıyorsun, biraz bekle." }, 429, cors);

    let body;
    try { body = await request.json(); } catch { return json({ error: "Geçersiz istek" }, 400, cors); }

    const message = String(body.message || "").slice(0, MAX_MESSAGE_CHARS).trim();
    if (!message) return json({ error: "Mesaj boş" }, 400, cors);

    let image = null;
    if (body.image) {
      const im = body.image;
      if (typeof im.data === "string" && /^image\/(jpeg|png|webp)$/.test(im.mime || "") && im.data.length <= MAX_IMAGE_CHARS) image = im;
      else return json({ error: "Resim geçersiz ya da çok büyük." }, 413, cors);
    }

    let history = Array.isArray(body.history) ? body.history : [];
    history = history
      .filter((h) => h && (h.role === "user" || h.role === "model") && typeof h.text === "string")
      .slice(-MAX_HISTORY)
      .map((h) => ({ role: h.role, parts: [{ text: h.text.slice(0, MAX_MESSAGE_CHARS) }] }));
    while (history.length && history[0].role !== "user") history.shift();

    const parts = [{ text: message }];
    if (image) parts.push({ inline_data: { mime_type: image.mime, data: image.data } });
    const contents = [...history, { role: "user", parts }];

    if (!env.GEMINI_API_KEY) {
      return json({ error: "Sunucuda GEMINI_API_KEY bulunamadı (Ayarlar > Sır adını kontrol et)." }, 500, cors);
    }

    const payload = {
      system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents,
      generationConfig: { maxOutputTokens: 2048 },
    };
    if (body.search === true) payload.tools = [{ google_search: {} }];

    const models = (env.MODELS || "gemini-flash-lite-latest,gemini-flash-latest,gemini-3.8-flash")
      .split(",").map((s) => s.trim()).filter(Boolean);
    const errors = [];

    for (const model of models) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), FIRST_CHUNK_TIMEOUT_MS);
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`,
          {
            method: "POST",
            signal: ctrl.signal,
            headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
            body: JSON.stringify(payload),
          }
        );
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          errors.push(model + ": " + (d.error?.message || "hata " + res.status).slice(0, 120));
          clearTimeout(timer);
          continue;
        }
        const reader = toText(res.body).getReader();
        const first = await reader.read();
        if (first.done || !first.value) {
          errors.push(model + ": boş cevap");
          clearTimeout(timer);
          continue;
        }
        clearTimeout(timer);
        const out = new ReadableStream({
          start(c) { c.enqueue(first.value); },
          async pull(c) {
            try {
              const { done, value } = await reader.read();
              if (done) c.close(); else c.enqueue(value);
            } catch (e) { c.close(); }
          },
          cancel() { reader.cancel().catch(() => {}); },
        });
        return new Response(out, {
          headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...cors },
        });
      } catch (e) {
        clearTimeout(timer);
        errors.push(model + ": " + (e.name === "AbortError" ? "zaman aşımı" : e.message));
      }
    }
    return json({ error: "Hata: " + errors.join(" | ") }, 502, cors);
  },
};
