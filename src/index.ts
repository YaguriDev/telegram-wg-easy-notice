import "dotenv/config";
import fs from "fs";
import axios from "axios";
import TelegramBot from "node-telegram-bot-api";

interface Client {
  id: number;
  name: string;
  ipv4Address: string;
  endpoint: string | null;
  expiresAt: string | null;
  latestHandshakeAt: string | null;
  transferRx: number;
  transferTx: number;
  enabled: boolean;
}

interface CacheEntry {
  lastDaysLeft: number | null;
  lastNotified: string | null;
}

type Cache = Record<string, CacheEntry>;

const { WG_BASE_URL, WG_USERNAME, WG_PASSWORD, TELEGRAM_TOKEN, TELEGRAM_OWNER_ID, CHECK_INTERVAL_MINUTES, CACHE_PATH, THRESHOLD_DAYS } = process.env;

if (!WG_BASE_URL || !WG_USERNAME || !WG_PASSWORD || !TELEGRAM_TOKEN || !THRESHOLD_DAYS || !TELEGRAM_OWNER_ID) throw new Error("Missing required env vars");

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

const api = axios.create({
  baseURL: WG_BASE_URL,
  auth: { username: WG_USERNAME, password: WG_PASSWORD },
  timeout: 10000,
});

const cacheFile = CACHE_PATH || "./cache.json";

const readCache = (): Cache => {
  try {
    if (!fs.existsSync(cacheFile)) return {};
    return JSON.parse(fs.readFileSync(cacheFile, "utf-8")) as Cache;
  } catch {
    return {};
  }
};

const writeCache = async (data: Cache) => {
  await fs.promises.writeFile(cacheFile, JSON.stringify(data, null, 2));
};

let cache: Cache = readCache();

const fetchClients = async (): Promise<Client[]> => {
  try {
    const res = await api.get("/api/client");
    return res.data;
  } catch (err: any) {
    await notify(`⚠️ Failed to fetch clients: ${err.message}. Check your WireGuard Easy server.`);
    return [];
  }
};

const daysLeft = (expiresAt: string | null): number | null => {
  if (!expiresAt) return null;
  const diff = new Date(expiresAt).getTime() - Date.now();
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
};

const formatClient = (c: Client): string => {
  const online = c.latestHandshakeAt ? "🟢" : "⚫️";
  const date = c.latestHandshakeAt ? new Date(c.latestHandshakeAt).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" }) : "—";
  const rx = (c.transferRx / 1024 / 1024).toFixed(2);
  const tx = (c.transferTx / 1024 / 1024).toFixed(2);
  const daysCount = daysLeft(c.expiresAt);
  const daysStatus = daysCount ? (daysCount <= 0 ? "Expired" : daysCount === 1 ? "1 day left" : `${daysCount} days left`) : "Infinite";

  return (
    `${online} <b>${c.name}</b> (${c.id})\n` +
    `├─ Enabled: <b>${c.enabled}</b>\n` +
    `├─ IP: <b>${c.endpoint || "—"}</b>\n` +
    `├─ Days left: <b>${daysStatus}</b>\n` +
    `├─ Last handshake: <b>${date}</b>\n` +
    `├─ RX: <b>${rx}</b> MB | TX: <b>${tx}</b> MB\n` +
    `└─ IPv4: <b>${c.ipv4Address}</b>\n`
  );
};

const notify = async (text: string) => {
  try {
    await bot.sendMessage(TELEGRAM_OWNER_ID, text, { parse_mode: "HTML" });
  } catch (err: any) {
    console.error("Error during notification:", err.message);
  }
};

const thresholds = THRESHOLD_DAYS.split(",").map(Number);

const processClients = async () => {
  try {
    const clients = await fetchClients();

    for (const c of clients) {
      const id = String(c.id);
      const left = daysLeft(c.expiresAt);
      if (left === null) continue;

      const prev = cache[id] || { lastDaysLeft: null, lastNotified: null };

      const thresholdsToNotify = thresholds.filter((t) => left <= t && (prev.lastDaysLeft ?? Infinity) > t).sort((a, b) => b - a);

      if (thresholdsToNotify.length > 0) {
        const expiresDate = c.expiresAt ? new Date(c.expiresAt) : null;
        await notify(`⏳ <b>${c.name}</b> (${c.id}) subscription expires in <b>${left} day(s)</b>\n📅 ${expiresDate ? expiresDate.toLocaleString("ru-RU", { timeZone: "Europe/Moscow" }) : "∞"}`);
        cache[id] = { lastDaysLeft: left, lastNotified: new Date().toISOString() };
      } else {
        cache[id] = { ...prev, lastDaysLeft: left };
      }
    }

    for (const id of Object.keys(cache)) {
      if (!clients.find((c) => String(c.id) === id)) delete cache[id];
    }

    await writeCache(cache);
  } catch (err: any) {
    console.error("Error during check:", err.message);
  }
};

const changeClientTime = async (id: number, days: number): Promise<boolean> => {
  try {
    const { data: client } = await api.get(`/api/client/${id}`);

    if (!client) {
      await notify(`⚠️ Client ${id} not found.`);
      return false;
    }

    if (!client.expiresAt) {
      await notify(`⚠️ Client ${id} has infinite subscription.`);
      return false;
    }

    let newExpiresAt = new Date(client.expiresAt);
    if (newExpiresAt < new Date()) {
      newExpiresAt = new Date();
    }

    newExpiresAt.setDate(newExpiresAt.getDate() + days);

    const updatedClient = { ...client, expiresAt: newExpiresAt.toISOString() };
    await api.post(`/api/client/${id}`, updatedClient);

    return true;
  } catch (err: any) {
    await notify(`⚠️ Failed to change time for client ${id}: ${err.message}`);
    return false;
  }
};

bot.onText(/\/time (\d+) ([+-]?\d+)/, async (msg, match) => {
  if (!match || String(msg.from?.id) !== TELEGRAM_OWNER_ID) return;

  const [, id, daysStr] = match;
  const days = Number(daysStr);

  if (!id || isNaN(days)) {
    return await bot.sendMessage(msg.chat.id, "❌ Usage: <b>/time <client_id> <days></b>\nExample: <code>/time 1 +30</code> or <code>/time 1 -7</code>", { parse_mode: "HTML" });
  }

  const action = days > 0 ? `extended by <b>+${days}</b>` : `reduced by <b>${days}</b>`;
  const success = await changeClientTime(Number(id), days);

  await bot.sendMessage(msg.chat.id, success ? `✅ Client <b>${id}</b> ${action} days` : `❌ Failed to change time for client <b>${id}</b>`, { parse_mode: "HTML" });
});

bot.onText(/\/client (\d+)/, async (msg, match) => {
  if (!match || String(msg.from?.id) !== TELEGRAM_OWNER_ID) return;

  const [, id] = match;
  if (!id) return await bot.sendMessage(msg.chat.id, "❌ Usage: <b>/client <client_id></b>", { parse_mode: "HTML" });

  try {
    const { data: client } = await api.get(`/api/client/${id}`);
    if (!client) return await bot.sendMessage(msg.chat.id, `❌ Client <b>${id}</b> not found`, { parse_mode: "HTML" });

    await bot.sendMessage(msg.chat.id, formatClient(client), { parse_mode: "HTML" });
  } catch (err: any) {
    await bot.sendMessage(msg.chat.id, `❌ Failed to fetch client <b>${id}</b>`, { parse_mode: "HTML" });
  }
});

bot.onText(/\/clients(?: (\d+))?/, async (msg, match) => {
  if (String(msg.from?.id) !== TELEGRAM_OWNER_ID) return;

  const n = match && match[1] ? Number(match[1]) : undefined;

  try {
    let clients = (await fetchClients()).sort((a, b) => {
      const daysA = daysLeft(a.expiresAt);
      const daysB = daysLeft(b.expiresAt);

      const valueA = daysA === null ? Infinity : daysA <= 0 ? Infinity + 1 : daysA;
      const valueB = daysB === null ? Infinity : daysB <= 0 ? Infinity + 1 : daysB;

      return valueA - valueB;
    });

    if (n) clients = clients.slice(0, n);

    if (!clients.length) {
      await bot.sendMessage(msg.chat.id, "❌ No clients found.");
      return;
    }

    const chunkSize = 10;
    const chunks = [];
    for (let i = 0; i < clients.length; i += chunkSize) {
      chunks.push(clients.slice(i, i + chunkSize));
    }

    await bot.sendMessage(msg.chat.id, `📋 <b>WireGuard Clients</b>\nTotal: <b>${clients.length}</b>`, { parse_mode: "HTML" });

    for (const group of chunks) {
      const text = group.map(formatClient).join("\n");
      await bot.sendMessage(msg.chat.id, text, { parse_mode: "HTML" });
      await new Promise((res) => setTimeout(res, 1000));
    }
  } catch (err: any) {
    console.error("Error in /clients command:", err.message);
    await bot.sendMessage(msg.chat.id, "⚠️ Failed to fetch clients.");
  }
});

const addCommandsInBot = async () => {
  await bot.setMyCommands([
    { command: "clients", description: "List of clients [N]" },
    { command: "client", description: "Info about client <id>" },
    { command: "time", description: "Change time for client <id> <+/-days>" },
  ]);
};

const start = async () => {
  await addCommandsInBot();
  await processClients();

  const interval = Number(CHECK_INTERVAL_MINUTES || 10) * 60 * 1000;
  setInterval(processClients, interval);

  console.log("[TWEN] Bot started");
};

start();
