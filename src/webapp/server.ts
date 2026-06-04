import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import type { AxiosInstance } from "axios";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface StartWebAppOptions {
  port: number;
  botToken: string;
  wgApi: AxiosInstance;
  getUsersByTgId: (tgId: string) => string[];
  fetchClients: () => Promise<any[]>;
}

function verifyInitData(initData: string, botToken: string): string | null {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    if (!hash) return null;
    params.delete("hash");

    const dataCheckString = Array.from(params.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");

    const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
    const expected = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
    if (expected !== hash) return null;

    const authDate = Number(params.get("auth_date"));
    if (!authDate || Date.now() / 1000 - authDate > 3600) return null;

    const user = JSON.parse(params.get("user") ?? "{}");
    return user.id ? String(user.id) : null;
  } catch {
    return null;
  }
}

function extractTgId(req: express.Request, botToken: string): string | null {
  const fromHeader = (req.headers["x-telegram-init-data"] as string) ?? "";
  const fromQuery = (req.query.init_data as string) ?? "";
  const raw = fromHeader || decodeURIComponent(fromQuery);
  if (raw) return verifyInitData(raw, botToken);

  if (process.env.NODE_ENV !== "production" && req.query.tg_id) {
    return String(req.query.tg_id);
  }
  return null;
}

const sseClients = new Map<string, express.Response[]>();

function addSse(id: string, res: express.Response) {
  const arr = sseClients.get(id) ?? [];
  arr.push(res);
  sseClients.set(id, arr);
}

function removeSse(id: string, res: express.Response) {
  const filtered = (sseClients.get(id) ?? []).filter((r) => r !== res);
  if (filtered.length) sseClients.set(id, filtered);
  else sseClients.delete(id);
}

export function startWebApp(opts: StartWebAppOptions) {
  const { port, botToken, wgApi, getUsersByTgId, fetchClients } = opts;
  const app = express();

  app.use(express.static(__dirname));
  app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "webapp.html")));

  const auth = (req: express.Request, res: express.Response): string | null => {
    const tgId = extractTgId(req, botToken);
    if (!tgId) {
      res.status(401).json({ error: "Unauthorized" });
      return null;
    }
    return tgId;
  };

  app.get("/api/clients", async (req, res) => {
    const tgId = auth(req, res);
    if (!tgId) return;

    const wgIds = getUsersByTgId(tgId);
    if (!wgIds.length) return res.status(403).json({ error: "not_registered" });

    try {
      const all = await fetchClients();
      const clients = all.filter((c) => wgIds.includes(String(c.id)));
      res.json({ clients });
    } catch (e: any) {
      console.error("[WEBAPP] clients:", e.message);
      res.status(502).json({ error: "upstream" });
    }
  });

  app.get("/api/config/:id", async (req, res) => {
    const tgId = auth(req, res);
    if (!tgId) return;

    const { id } = req.params;
    if (!getUsersByTgId(tgId).includes(id)) return res.status(403).send("Forbidden");

    try {
      const { data } = await wgApi.get(`/api/client/${id}/configuration`);
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="vpn-${id}.conf"`);
      res.send(data);
    } catch (e: any) {
      console.error("[WEBAPP] config:", e.message);
      res.status(502).send("Error");
    }
  });

  app.get("/api/stream", async (req, res) => {
    const tgId = extractTgId(req, botToken);
    if (!tgId) return res.status(401).end();

    const wgIds = getUsersByTgId(tgId);
    if (!wgIds.length) return res.status(403).end();

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    try {
      const all = await fetchClients();
      const clients = all.filter((c) => wgIds.includes(String(c.id)));
      res.write(`data: ${JSON.stringify({ clients })}\n\n`);
    } catch {}

    addSse(tgId, res);
    req.on("close", () => removeSse(tgId, res));
  });

  setInterval(async () => {
    for (const [tgId, responses] of sseClients.entries()) {
      if (!responses.length) continue;
      try {
        const wgIds = getUsersByTgId(tgId);
        const all = await fetchClients();
        const clients = all.filter((c) => wgIds.includes(String(c.id)));
        const msg = `data: ${JSON.stringify({ clients })}\n\n`;
        for (const res of responses) {
          try {
            res.write(msg);
          } catch {}
        }
      } catch {}
    }
  }, 15_000);

  app.listen(port, "127.0.0.1", () => console.log(`[WEBAPP] http://127.0.0.1:${port}`));
}
