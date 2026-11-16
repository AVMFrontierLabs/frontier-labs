"""
Frontier Labs: a small Python server for the website.

It serves the site and passes questions to an AI for you, so your API key stays on your computer and never
goes into the page code. Only the Python standard library is needed (Python 3.9 or newer).

Pick ONE AI (or none):

  Google Gemini (free tier, reads images)   get a key at https://aistudio.google.com/apikey
      Mac/Linux:  export GEMINI_API_KEY=your_key             Windows:  set GEMINI_API_KEY=your_key
      optional:   GEMINI_MODEL=gemini-2.5-flash   (the default)

  Claude (Anthropic)
      Mac/Linux:  export ANTHROPIC_API_KEY=your_key          Windows:  set ANTHROPIC_API_KEY=your_key

  Any OpenAI-compatible service (OpenAI, Groq, Together, OpenRouter, LM Studio ...)
      export OPENAI_API_KEY=your_key
      export OPENAI_BASE_URL=https://api.openai.com/v1      (the service's base URL)
      export AI_MODEL=the-model-name                         (required: the model to use)

  A free model on your own computer with Ollama (https://ollama.com), no key needed
      ollama pull llama3.1
      export OPENAI_BASE_URL=http://localhost:11434/v1
      export AI_MODEL=llama3.1

Then run   python server.py   in this folder and open http://localhost:8000
The page finds the server by itself and turns on the AI assessment, legend reading and Marvin-AI.
With no AI set, everything still works: the built-in assessment, and Marvin-AI's built-in mode.

If you set more than one key, Gemini is used first. Force another with AI_PROVIDER=anthropic (or gemini, openai).

Optional: ALLOWED_ORIGIN=https://avmfrontierlabs.github.io   lets a page on another site (for example GitHub Pages) call this server.
          AI_NAME=Llama   changes the name the page shows for the AI (default "Claude", or "AI" for other services).
          PORT=8000        changes the port.

Routes:
    GET  /api/health   {"ai": bool, "claude": bool, "vision": bool, "provider": str|null, "name": str}
    POST /api/claude   {"prompt": str, "image"?: {"base64": str, "mediaType": str}}  ->  {"text": str}
    POST /api/interpret-image  {"image": {"base64": str, "mediaType": str}, "audience": str, "language"?: str, "metrics"?: {...}}
                               ->  {"result": {...}, "provider": str}   (503 when no AI key is set, the page then analyses the image itself)
    POST /api/helper   {"messages": [{"role", "content"}], "context": {...}}          ->  {"reply": str}
"""
import base64
import binascii
import json
import os
import re
import sys
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("PORT", "8000"))
ANTHROPIC_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
GEMINI_KEY = os.environ.get("GEMINI_API_KEY", "") or os.environ.get("GOOGLE_API_KEY", "")
OPENAI_KEY = os.environ.get("OPENAI_API_KEY", "")
OPENAI_BASE = os.environ.get("OPENAI_BASE_URL", "").rstrip("/")
ALLOWED_ORIGIN = os.environ.get("ALLOWED_ORIGIN", "").strip()
WANT = os.environ.get("AI_PROVIDER", "").strip().lower()
if WANT == "gemini" and GEMINI_KEY or (not WANT and GEMINI_KEY):
    PROVIDER, MODEL, AI_NAME = "gemini", os.environ.get("AI_MODEL") or os.environ.get("GEMINI_MODEL", "gemini-2.5-flash"), os.environ.get("AI_NAME", "Gemini")
elif ANTHROPIC_KEY and WANT in ("", "anthropic"):
    PROVIDER, MODEL, AI_NAME = "anthropic", os.environ.get("AI_MODEL", "claude-sonnet-5-5"), os.environ.get("AI_NAME", "Claude")
elif OPENAI_BASE or OPENAI_KEY:
    PROVIDER, MODEL, AI_NAME = "openai", os.environ.get("AI_MODEL", ""), os.environ.get("AI_NAME", "AI")
    OPENAI_BASE = OPENAI_BASE or "https://api.openai.com/v1"
    if not MODEL:
        sys.exit("Set AI_MODEL to the model name for your service, for example: export AI_MODEL=llama3.1")
else:
    PROVIDER, MODEL, AI_NAME = None, "", "Claude"
MAX_BODY = 12 * 1024 * 1024          # map images can be a few MB
MAX_TURNS, MAX_CHARS = 12, 2000      # limits for the Marvin-AI chat
REFUSE = "[[REFUSE]]"                # the page turns this into "I'm afraid I can't answer that" in the chosen language

# Reuse the writing rules from the Python engine when it is next to this folder (../python/analog_engine.py).
sys.path.insert(0, os.path.join(HERE, "..", "python"))
try:
    from analog_engine import tidy_text
except ImportError:
    tidy_text = lambda t: t  # noqa: E731

# Marvin-AI never curses. Same word list as the page (js/app.js).
PROFANITY = re.compile(r"\b(f+u+c+k\w*|f+[*@#]+k\w*|wtf|stfu|fml|motherf\w*|sh[i1]+t\w*|bullsh\w*|b[i1]tch\w*|bastard\w*|a+ss+h[o0]le\w*|dumbass\w*|jackass\w*|asshat\w*|damn\w*|goddam\w*|crap\w*|hell|piss\w*|d[i1]ck(s|head\w*)?|c[o0]cks?|cunt\w*|tw[a@]t\w*|wh[o0]re\w*|slut\w*|pricks?|bollocks|wank\w*)\b", re.I)


def helper_guide():
    """Marvin-AI's instructions live in one place, js/app.js, so the page and this server always agree."""
    try:
        src = open(os.path.join(HERE, "js", "app.js"), encoding="utf-8").read()
        m = re.search(r"const HELPER_GUIDE = `([\s\S]*?)`;", src)
        if m:
            return m.group(1)
    except OSError:
        pass
    return ("You are Marvin-AI, the statistics helper inside Frontier Labs. Explain the person's results in plain, "
            "friendly words using only the numbers given. Never curse. If a message is off topic or inappropriate, reply with exactly [[REFUSE]].")


def post_json(url, body, headers, timeout=180):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"content-type": "application/json", **headers})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return json.loads(res.read())
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"AI service error {e.code}: {e.read().decode(errors='replace')[:300]}")


def ask_ai(messages, system=None, max_tokens=2000, image=None, json_mode=False, timeout=180):
    """messages: [{'role': 'user'|'assistant', 'content': str}]. image (optional) goes with the last message."""
    if PROVIDER == "gemini":
        contents = [{"role": "model" if m["role"] == "assistant" else "user", "parts": [{"text": m["content"]}]} for m in messages]
        if image:
            contents[-1]["parts"].insert(0, {"inline_data": {"mime_type": image["mediaType"], "data": image["base64"]}})
        body = {"contents": contents, "generationConfig": {"maxOutputTokens": max_tokens}}
        if json_mode:
            body["generationConfig"]["responseMimeType"] = "application/json"
        if system:
            body["system_instruction"] = {"parts": [{"text": system}]}
        # The key goes in a header, never in the URL, so it cannot end up in logs.
        j = post_json(f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent", body, {"x-goog-api-key": GEMINI_KEY}, timeout)
        cand = (j.get("candidates") or [{}])[0]
        text = "".join(p.get("text", "") for p in (cand.get("content") or {}).get("parts", []))
        if not text:
            raise RuntimeError("Gemini returned no text" + (f" ({cand.get('finishReason')})" if cand.get("finishReason") else ""))
        return text
    if PROVIDER == "anthropic":
        msgs = [dict(m) for m in messages]
        if image:
            msgs[-1]["content"] = [{"type": "image", "source": {"type": "base64", "media_type": image["mediaType"], "data": image["base64"]}},
                                   {"type": "text", "text": msgs[-1]["content"]}]
        body = {"model": MODEL, "max_tokens": max_tokens, "messages": msgs}
        if system:
            body["system"] = system
        j = post_json("https://api.anthropic.com/v1/messages", body, {"x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01"}, timeout)
        return "".join(b.get("text", "") for b in j.get("content", []) if b.get("type") == "text")
    if PROVIDER == "openai":
        msgs = ([{"role": "system", "content": system}] if system else []) + [dict(m) for m in messages]
        if image:
            msgs[-1]["content"] = [{"type": "text", "text": msgs[-1]["content"]},
                                   {"type": "image_url", "image_url": {"url": f"data:{image['mediaType']};base64,{image['base64']}"}}]
        j = post_json(f"{OPENAI_BASE}/chat/completions", {"model": MODEL, "max_tokens": max_tokens, "messages": msgs},
                      {"authorization": f"Bearer {OPENAI_KEY}"} if OPENAI_KEY else {}, timeout)
        return (j.get("choices") or [{}])[0].get("message", {}).get("content") or ""
    raise RuntimeError("No AI is set up on the server.")


def clean_history(messages):
    """Keep the last few turns, plain text only, starting with the person and alternating roles."""
    out = []
    for m in (messages or [])[-MAX_TURNS:]:
        role = m.get("role") if isinstance(m, dict) else None
        text = str(m.get("content", ""))[:MAX_CHARS].strip() if role else ""
        if role not in ("user", "assistant") or not text:
            continue
        if out and out[-1]["role"] == role:
            out[-1]["content"] += "\n\n" + text
        else:
            out.append({"role": role, "content": text})
    while out and out[0]["role"] != "user":
        out.pop(0)
    if not out or out[-1]["role"] != "user":
        raise ValueError("The last message must come from the person.")
    return out


# ============================== image interpreter ==============================
IMAGE_TYPES = {"image/jpeg": b"\xff\xd8\xff", "image/png": b"\x89PNG\r\n\x1a\n", "image/webp": b"RIFF", "image/gif": b"GIF8"}
MAX_IMAGE_BYTES = 6 * 1024 * 1024    # decoded size. The page sends at most about 1 MB after resizing to 1024 px.
AUDIENCES = {"kids": "Kids", "students": "Students", "educators": "Educators", "scientists": "Scientists", "scientist": "Scientists",
             "managers": "Managers", "manager": "Managers", "auto": "Students"}
AUDIENCE_STYLE = {
    "Kids": "Ages 8 to 12. Short, friendly sentences, everyday words, one fun comparison. No jargon and no numbers beyond simple percents.",
    "Students": "Ages 13 to 18. Clear and curious. Explain the reasoning in plain words and name the colours and textures you used.",
    "Educators": "A teacher. Say what the picture shows, then end the summary with one short classroom activity.",
    "Scientists": "Technical readers. Use precise terms (albedo, iron-oxide reddening, regolith, relief, shadowing). State limits and what extra data would confirm it.",
    "Managers": "Decision makers. Lead with the bottom line, keep it brief, say how confident it is and what the sensible next step costs or saves.",
}
SITES = ("Atacama Desert (Yungay)", "Utah desert (MDRS)", "Devon Island (Haughton crater)", "Mauna Kea (Hawaii)",
         "Hawaii volcanic fields", "McMurdo Dry Valleys", "Death Valley", "Svalbard")


class BadRequest(ValueError):
    pass


def clean_image(img):
    """Check the image the page sent. Returns {'base64', 'mediaType'} or raises BadRequest."""
    if not isinstance(img, dict):
        raise BadRequest("Send an image as {base64, mediaType}.")
    data, mt = str(img.get("base64") or "").strip(), str(img.get("mediaType") or "").lower().strip()
    m = re.match(r"^data:(image/[a-z+.-]+);base64,", data, re.I)      # tolerate a data: prefix
    if m:
        mt, data = mt or m.group(1).lower(), data[m.end():]
    mt = "image/jpeg" if mt == "image/jpg" else mt
    if mt not in IMAGE_TYPES:
        raise BadRequest("Use a JPEG, PNG, WebP or GIF image.")
    try:
        raw = base64.b64decode(data, validate=True)
    except (binascii.Error, ValueError):
        raise BadRequest("The image data is not valid base64.")
    if not raw or len(raw) > MAX_IMAGE_BYTES:
        raise BadRequest("The image is empty or larger than 6 MB.")
    if not raw.startswith(IMAGE_TYPES[mt]):
        raise BadRequest("The image data does not match its type.")
    return {"base64": data, "mediaType": mt}


def interpret_prompt(audience, language, metrics):
    m = json.dumps(metrics, default=str)[:3000] if isinstance(metrics, dict) else "none"
    return (
        "You are the image interpreter inside Frontier Labs, a NASA Space Apps tool that compares places on Earth with the Moon and Mars. "
        "Look at the picture of a terrain, satellite view or rover photo. Decide whether the surface looks more like Mars, more like the Moon, "
        "a mix, or neither (for example a green or watery Earth scene). Base the answer only on what is visible: colour, brightness, texture, "
        "craters, rocks, dunes, shadows. Do not invent measurements. This is a visual screening, not a measurement, so say so in the caveats.\n\n"
        f"AUDIENCE: {audience}. {AUDIENCE_STYLE[audience]}\n"
        f"LANGUAGE: write every text field in the language with code \"{language}\".\n"
        "STYLE: plain sentences, no em dashes, no semicolons, no hype.\n"
        f"PIXEL MEASUREMENTS made in the browser (use them as a cross-check, they are not ground truth): {m}\n\n"
        "Reply with JSON only, no markdown:\n"
        '{"best_analog":"Mars|Moon|Mixed|Neither","mars_score":0-100,"moon_score":0-100,"terrain":"short label",'
        '"headline":"one sentence","summary":"3 to 5 sentences for this audience","findings":["3 to 5 short observations"],'
        f'"suggested_sites":[{{"name":"one of: {", ".join(SITES)}","why":"one sentence"}}],'
        '"confidence":"Low|Medium|High","caveats":["1 to 3 short limits"]}\n'
        "mars_score and moon_score say how much the scene resembles each world on a 0 to 100 scale. Give 1 to 3 suggested_sites."
    )


def _str(v, n):
    return str(v or "").strip()[:n]


def normalise_interpretation(raw):
    """Turn whatever the AI returned into the exact shape the page expects."""
    num = lambda v: max(0.0, min(100.0, float(v))) if isinstance(v, (int, float)) and not isinstance(v, bool) else None
    best = _str(raw.get("best_analog"), 12).capitalize()
    out = {
        "best_analog": best if best in ("Mars", "Moon", "Mixed", "Neither") else "Mixed",
        "mars_score": num(raw.get("mars_score")), "moon_score": num(raw.get("moon_score")),
        "terrain": _str(raw.get("terrain"), 80), "headline": _str(raw.get("headline"), 300), "summary": _str(raw.get("summary"), 1600),
        "findings": [_str(x, 260) for x in (raw.get("findings") or [])[:6] if _str(x, 260)],
        "suggested_sites": [{"name": _str(x.get("name"), 80), "why": _str(x.get("why"), 240)} for x in (raw.get("suggested_sites") or [])[:3] if isinstance(x, dict) and _str(x.get("name"), 80)],
        "confidence": (_str(raw.get("confidence"), 8).capitalize() if _str(raw.get("confidence"), 8).capitalize() in ("Low", "Medium", "High") else "Low"),
        "caveats": [_str(x, 260) for x in (raw.get("caveats") or [])[:4] if _str(x, 260)],
    }
    if not out["headline"] or not out["summary"]:
        raise ValueError("The AI reply had no headline or summary.")
    for k in ("headline", "summary"):
        out[k] = tidy_text(out[k])
    for k in ("findings", "caveats"):
        out[k] = [tidy_text(x) for x in out[k]]
    for x in out["suggested_sites"]:
        x["why"] = tidy_text(x["why"])
    return out


def interpret_image(req):
    img = clean_image(req.get("image"))
    audience = AUDIENCES.get(str(req.get("audience") or "auto").strip().lower())
    if not audience:
        raise BadRequest("Audience must be Kids, Students, Educators, Scientists or Managers.")
    language = re.sub(r"[^A-Za-z-]", "", str(req.get("language") or "en"))[:12] or "en"
    prompt = interpret_prompt(audience, language, req.get("metrics"))
    text = ask_ai([{"role": "user", "content": prompt}], image=img, max_tokens=1400, json_mode=True, timeout=45)
    m = re.search(r"\{[\s\S]*\}", text)
    if not m:
        raise ValueError("The AI reply had no JSON.")
    return normalise_interpretation(json.loads(m.group(0)))


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=HERE, **kw)

    def send_json(self, code, obj):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.send_cors()
        self.end_headers()
        self.wfile.write(data)

    def send_cors(self):
        """Only when ALLOWED_ORIGIN is set: lets the site on GitHub Pages call this server from the browser."""
        if ALLOWED_ORIGIN and self.headers.get("origin", "") == ALLOWED_ORIGIN:
            self.send_header("access-control-allow-origin", ALLOWED_ORIGIN)
            self.send_header("vary", "Origin")

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_cors()
        self.send_header("access-control-allow-methods", "GET, POST, OPTIONS")
        self.send_header("access-control-allow-headers", "content-type")
        self.send_header("access-control-max-age", "600")
        self.end_headers()

    def do_GET(self):
        route = self.path.split("?")[0]
        if route == "/api/health":
            return self.send_json(200, {"ai": bool(PROVIDER), "claude": bool(PROVIDER), "vision": bool(PROVIDER), "provider": PROVIDER, "name": AI_NAME})
        if route.endswith(".py"):     # don't serve the server's own code
            return self.send_error(404)
        return super().do_GET()

    def do_POST(self):
        route = self.path.split("?")[0]
        if route not in ("/api/claude", "/api/helper", "/api/interpret-image"):
            return self.send_error(404)
        if not PROVIDER:
            return self.send_json(503, {"error": "No AI is set up on the server. See the top of server.py."})
        size = int(self.headers.get("content-length") or 0)
        if size > MAX_BODY:
            return self.send_json(413, {"error": "Request too large."})
        try:
            req = json.loads(self.rfile.read(size) or b"{}")
            if route == "/api/interpret-image":
                return self.send_json(200, {"result": interpret_image(req), "provider": PROVIDER})
            if route == "/api/claude":
                return self.send_json(200, {"text": ask_ai([{"role": "user", "content": str(req.get("prompt", ""))}], image=req.get("image"))})
            history = clean_history(req.get("messages"))
            if PROFANITY.search(history[-1]["content"]):
                return self.send_json(200, {"reply": REFUSE})
            context = req.get("context") or {}
            language = str(context.get("language") or "English")[:40]
            system = f"{helper_guide()}\n\nReply in {language}.\n\nPAGE STATE (JSON):\n{json.dumps(context)[:60000]}"
            reply = ask_ai(history, system=system, max_tokens=800).strip()
            if REFUSE in reply:
                return self.send_json(200, {"reply": REFUSE})
            if PROFANITY.search(reply):   # a reply with a curse is thrown away: the page then uses Marvin-AI's built-in answer
                return self.send_json(200, {"reply": ""})
            return self.send_json(200, {"reply": tidy_text(reply)})
        except (ValueError, json.JSONDecodeError) as e:   # BadRequest is a ValueError too
            if route == "/api/interpret-image" and not isinstance(e, BadRequest):
                return self.send_json(502, {"error": "The AI reply could not be read: " + str(e)[:200]})
            return self.send_json(400, {"error": str(e)})
        except Exception as e:   # network or AI problem: report it, keep the server running
            return self.send_json(502, {"error": str(e)[:400]})

    def log_message(self, fmt, *args):
        if "/api/" in str(args[0] if args else "") or fmt.startswith("code"):
            sys.stderr.write("%s\n" % (fmt % args))


if __name__ == "__main__":
    print(f"Frontier Labs on http://localhost:{PORT}")
    print(f"AI: {AI_NAME} ({PROVIDER}, model {MODEL})" if PROVIDER else "AI: off. Marvin-AI uses its built-in mode. See the top of server.py to connect one.")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
