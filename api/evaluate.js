// Vercel Serverless Function: secure server-side AI evaluation via Vercel AI Gateway.
// Required environment variable: AI_GATEWAY_API_KEY (never expose it in browser code).
const MODEL = 'openai/gpt-4.1-mini';
const MAX_ANSWER_CHARS = 12000;
const MAX_QUESTION_CHARS = 1800;
const MAX_OUTPUT_TOKENS = 900;

// Best-effort per-instance rate limit. For a larger public rollout, add a shared
// rate-limit store or Vercel Firewall rules; serverless memory is not global.
const windows = globalThis.__masterDriverRateWindows || (globalThis.__masterDriverRateWindows = new Map());

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return send(res, 405, { error: 'Nur POST-Anfragen sind erlaubt.' });
  }

  const origin = req.headers.origin;
  const host = req.headers.host;
  if (origin) {
    try {
      const parsed = new URL(origin);
      if (parsed.host !== host) return send(res, 403, { error: 'Anfrage von einer fremden Website blockiert.' });
    } catch (_) {
      return send(res, 403, { error: 'Ungültiger Seitenursprung.' });
    }
  }

  const ip = String(req.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim();
  const now = Date.now();
  const bucket = windows.get(ip);
  if (bucket && now - bucket.start < 60_000 && bucket.count >= 4) {
    return send(res, 429, { error: 'Zu viele Auswertungen in kurzer Zeit. Bitte warte eine Minute.' });
  }
  if (!bucket || now - bucket.start >= 60_000) windows.set(ip, { start: now, count: 1 });
  else bucket.count += 1;

  if (!process.env.AI_GATEWAY_API_KEY) {
    return send(res, 503, { error: 'Die KI ist noch nicht eingerichtet. Der Betreiber muss den AI-Gateway-Schlüssel in Vercel hinterlegen.' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_) { return send(res, 400, { error: 'Ungültige Anfrage.' }); }
  }
  if (!body || typeof body !== 'object') return send(res, 400, { error: 'Ungültige Anfrage.' });

  const question = String(body.question || '').trim().slice(0, MAX_QUESTION_CHARS);
  const answer = String(body.answer || '').trim().slice(0, MAX_ANSWER_CHARS);
  const area = String(body.area || 'Fahrlehrerprüfung Klasse BE').slice(0, 160);
  const mode = body.mode === 'oral' ? 'mündliche Prüfung' : 'Themenübung';
  if (question.length < 8 || answer.length < 10) {
    return send(res, 400, { error: 'Bitte gib eine Prüfungsfrage und eine etwas ausführlichere Antwort ein.' });
  }

  const instructions = `Du bist ein sachlicher, anspruchsvoller und fairer Prüfungstrainer für die Fahrlehrerprüfung Klasse BE in Deutschland. Bewerte ausschließlich die vorliegende Antwort zur gestellten Frage. Erfinde keine Rechtsgrundlagen oder Prüfervorgaben. Wenn eine Rechtslage unsicher oder möglicherweise geändert ist, kennzeichne das ausdrücklich.\n\nNutze die folgende Lernorientierung mit maximal 15 Punkten, nicht als offiziellen Bewertungsschlüssel: Begriff/Grundlage ca. 2 Punkte; Hauptteil ca. 7–8 Punkte; Praxisbezug ca. 3–4 Punkte; Abschluss ca. 1–2 Punkte. Vergib eine nachvollziehbare vorläufige Punktzahl und erkläre kurz, wofür Punkte vergeben oder abgezogen werden.\n\nAntworte auf Deutsch in dieser Struktur:\n1. Vorläufige Bewertung: X/15 Punkte\n2. Was fachlich richtig und gut erklärt war\n3. Was fehlt, unklar oder fachlich falsch ist\n4. So könnte eine stärkere Prüfungsantwort lauten (kompakt und mündlich formulierbar)\n5. Eine gezielte Prüfer-Nachfrage – stelle genau eine Frage und verrate die Antwort nicht.\n\nBei der mündlichen Prüfung bleibst du prüfungsnah und respektvoll. Beurteile keine Rechtschreibung, sondern Fachinhalt, Struktur, Verständlichkeit und Praxisbezug.`;

  const input = `${instructions}\n\nPrüfungsbereich: ${area}\nFormat: ${mode}\nPrüfungsfrage: ${question}\n\nAntwort des Teilnehmers:\n${answer}`;

  try {
    const upstream = await fetch('https://ai-gateway.vercel.sh/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.AI_GATEWAY_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ model: MODEL, input, max_output_tokens: MAX_OUTPUT_TOKENS })
    });
    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      console.error('AI Gateway error', upstream.status, data && data.error ? data.error : 'no error details');
      return send(res, 502, { error: 'Die KI-Auswertung ist gerade nicht verfügbar. Bitte versuche es später erneut.' });
    }
    let text = data.output_text;
    if (!text && Array.isArray(data.output)) {
      text = data.output.flatMap(item => Array.isArray(item.content) ? item.content : [])
        .filter(part => part.type === 'output_text' || part.type === 'text')
        .map(part => part.text || '').join('\n');
    }
    if (!text) return send(res, 502, { error: 'Die KI hat keine auswertbare Antwort geliefert.' });
    return send(res, 200, { evaluation: text, model: MODEL });
  } catch (error) {
    console.error('Evaluation request failed', error && error.message ? error.message : 'unknown');
    return send(res, 502, { error: 'Verbindungsfehler bei der KI-Auswertung. Bitte versuche es erneut.' });
  }
};
