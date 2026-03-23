import "dotenv/config";
import fs from "fs";
import axios from "axios";
import TelegramBot from "node-telegram-bot-api";

interface WgClient {
  id: string;
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

interface TgUser {
  tgId: number;
  wgIds: string[];
  linkedAt: string;
}

interface PendingLink {
  wgId: string;
  tgId: number;
  tgUsername: string | null;
  tgFirstName: string | null;
  requestedAt: string;
}

const { WG_BASE_URL, WG_USERNAME, WG_PASSWORD, TELEGRAM_TOKEN, TELEGRAM_OWNER_ID, CHECK_INTERVAL_MINUTES, CACHE_PATH, THRESHOLD_DAYS, CLIENTS_DB_PATH, INVITE_CODES_PATH } = process.env;

if (!WG_BASE_URL || !WG_USERNAME || !WG_PASSWORD || !TELEGRAM_TOKEN || !THRESHOLD_DAYS || !TELEGRAM_OWNER_ID) throw new Error("Missing required env vars");

const OWNER_ID = Number(TELEGRAM_OWNER_ID);
const HANDSHAKE_ONLINE_MS = 3 * 60 * 1000;

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

const api = axios.create({
  baseURL: WG_BASE_URL,
  auth: { username: WG_USERNAME, password: WG_PASSWORD },
  timeout: 10000,
});

const cacheFile = CACHE_PATH || "./cache.json";
const clientsDbFile = CLIENTS_DB_PATH || "./clients.json";
const inviteCodesFile = INVITE_CODES_PATH || "./invite_codes.json";

const readJson = <T>(path: string, fallback: T): T => {
  try {
    if (!fs.existsSync(path)) return fallback;
    return JSON.parse(fs.readFileSync(path, "utf-8")) as T;
  } catch {
    return fallback;
  }
};

const writeJson = (path: string, data: unknown) => fs.promises.writeFile(path, JSON.stringify(data, null, 2));

const sid = (v: unknown): string => String(v);

let cache: Cache = readJson<Cache>(cacheFile, {});
let usersDb: Record<string, TgUser> = readJson<Record<string, TgUser>>(clientsDbFile, {});
let inviteCodes: Record<string, string> = readJson<Record<string, string>>(inviteCodesFile, {});
const pendingLinks: Record<string, PendingLink> = {};

const saveUsers = () => writeJson(clientsDbFile, usersDb);
const saveInviteCodes = () => writeJson(inviteCodesFile, inviteCodes);

const migrateDb = () => {
  const keys = Object.keys(usersDb);
  if (!keys.length) return;
  const needsMigration = keys.some((k) => {
    const v = usersDb[k] as any;
    return v && "wgId" in v && "tgId" in v && !("wgIds" in v);
  });
  if (!needsMigration) return;

  const newDb: Record<string, TgUser> = {};
  for (const key of keys) {
    const v = usersDb[key] as any;
    if (v && "wgId" in v && "tgId" in v) {
      const tgKey = sid(v.tgId);
      const wgKey = sid(v.wgId);
      if (!newDb[tgKey]) {
        newDb[tgKey] = { tgId: v.tgId, wgIds: [wgKey], linkedAt: v.linkedAt || new Date().toISOString() };
      } else if (!newDb[tgKey].wgIds.includes(wgKey)) {
        newDb[tgKey].wgIds.push(wgKey);
      }
    }
  }
  usersDb = newDb;
  saveUsers();
  console.log("[WG-BOT] DB migrated");
};

const getUserByTg = (tgId: number): TgUser | null => usersDb[sid(tgId)] ?? null;

const getUsersByWg = (wgId: string): TgUser[] => {
  const n = sid(wgId);
  return Object.values(usersDb).filter((u) => u.wgIds.map(sid).includes(n));
};

const linkWgToTg = (wgId: string, tgId: number) => {
  const key = sid(tgId);
  const wk = sid(wgId);
  if (!usersDb[key]) usersDb[key] = { tgId, wgIds: [wk], linkedAt: new Date().toISOString() };
  else if (!usersDb[key].wgIds.map(sid).includes(wk)) usersDb[key].wgIds.push(wk);
  saveUsers();
};

const unlinkWgFromTg = (wgId: string, tgId: number) => {
  const key = sid(tgId);
  const wk = sid(wgId);
  if (!usersDb[key]) return;
  usersDb[key].wgIds = usersDb[key].wgIds.filter((id) => sid(id) !== wk);
  if (!usersDb[key].wgIds.length) delete usersDb[key];
  saveUsers();
};

const isOwner = (id: number | undefined) => id === OWNER_ID;

const daysLeft = (expiresAt: string | null): number | null => {
  if (!expiresAt) return null;
  return Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 86400000);
};

const isOnline = (h: string | null): boolean => {
  if (!h) return false;
  return Date.now() - new Date(h).getTime() < HANDSHAKE_ONLINE_MS;
};

const fmtBytes = (raw: unknown): string => {
  const b = Number(raw);
  if (isNaN(b) || b === 0) return "0 B";
  if (b >= 1073741824) return `${(b / 1073741824).toFixed(2)} GB`;
  if (b >= 1048576) return `${(b / 1048576).toFixed(2)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${b} B`;
};

const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" }) : "—");

const fmtDays = (days: number | null): string => {
  if (days === null) return "♾ Бессрочно";
  if (days <= 0) return "❌ Истёк";
  if (days === 1) return "⚠️ 1 день";
  return `📅 ${days} дн.`;
};

const normalizeClient = (raw: any): WgClient => ({
  id: sid(raw.id),
  name: raw.name ?? "",
  ipv4Address: raw.ipv4Address ?? "",
  endpoint: raw.endpoint ?? null,
  expiresAt: raw.expiresAt ?? null,
  latestHandshakeAt: raw.latestHandshakeAt ?? null,
  transferRx: Number(raw.transferRx ?? 0),
  transferTx: Number(raw.transferTx ?? 0),
  enabled: !!raw.enabled,
});

const formatClientFull = (c: WgClient): string => {
  const icon = isOnline(c.latestHandshakeAt) ? "🟢" : "⚫️";
  const days = daysLeft(c.expiresAt);
  const users = getUsersByWg(c.id);
  const linked = users.length ? users.map((u) => `🔗 tg:<code>${u.tgId}</code>`).join(", ") : "🔗 Не привязан";

  return (
    `${icon} <b>${c.name}</b>\n` +
    `├─ ID: <code>${c.id}</code>\n` +
    `├─ Статус: <b>${c.enabled ? "Включён" : "Выключен"}</b>\n` +
    `├─ IP: <b>${c.endpoint || "—"}</b> (${c.ipv4Address})\n` +
    `├─ Подписка: <b>${fmtDays(days)}</b>\n` +
    `├─ Истекает: <b>${fmtDate(c.expiresAt)}</b>\n` +
    `├─ Handshake: <b>${fmtDate(c.latestHandshakeAt)}</b>\n` +
    `├─ ⬇️ Скачано: <b>${fmtBytes(c.transferTx)}</b>\n` +
    `├─ ⬆️ Загружено: <b>${fmtBytes(c.transferRx)}</b>\n` +
    `└─ ${linked}\n`
  );
};

const formatClientLine = (c: WgClient): string => {
  const icon = c.enabled ? "✅" : "🚫";
  const users = getUsersByWg(c.id);
  const link = users.length ? ` 🔗 ${users.map((u) => u.tgId).join(",")}` : "";
  return `${icon} <code>${c.id}</code> — <b>${c.name}</b> — ${fmtDays(daysLeft(c.expiresAt))}${link}`;
};

const formatClientForUser = (c: WgClient): string => {
  const online = isOnline(c.latestHandshakeAt) ? "🟢 Активен" : "⚫️ Нет подключения";
  return (
    `🔐 <b>Ваш VPN-конфиг</b>\n\n` +
    `👤 <b>${c.name}</b>\n` +
    `📡 Статус: ${online}\n` +
    `📅 Подписка: <b>${fmtDays(daysLeft(c.expiresAt))}</b>\n` +
    `⏱ Истекает: <b>${fmtDate(c.expiresAt)}</b>\n` +
    `⬇️ Скачано: <b>${fmtBytes(c.transferTx)}</b>\n` +
    `⬆️ Загружено: <b>${fmtBytes(c.transferRx)}</b>\n` +
    `🌐 Последнее подключение: <b>${fmtDate(c.latestHandshakeAt)}</b>`
  );
};

let clientsCache: WgClient[] = [];
let clientsCacheTs = 0;
const CACHE_TTL = 5000;

const fetchClients = async (): Promise<WgClient[]> => {
  try {
    const { data } = await api.get("/api/client");
    const list = (Array.isArray(data) ? data : [data]).map(normalizeClient);
    clientsCache = list;
    clientsCacheTs = Date.now();
    return list;
  } catch (err: any) {
    await notifyOwner(`⚠️ Ошибка загрузки клиентов: ${err.message}`);
    return [];
  }
};

const fetchClient = async (id: string): Promise<WgClient | null> => {
  const n = sid(id);
  if (Date.now() - clientsCacheTs < CACHE_TTL && clientsCache.length) {
    const found = clientsCache.find((c) => c.id === n);
    if (found) return found;
  }
  const all = await fetchClients();
  return all.find((c) => c.id === n) ?? null;
};

const fetchClientRaw = async (id: string): Promise<any | null> => {
  try {
    const { data } = await api.get(`/api/client/${id}`);
    return Array.isArray(data) ? data[0] : data;
  } catch {
    return null;
  }
};

const extendClient = async (id: string, days: number): Promise<WgClient | null> => {
  try {
    const raw = await fetchClientRaw(id);
    if (!raw) {
      await notifyOwner(`⚠️ Клиент <code>${id}</code> не найден.`);
      return null;
    }
    if (!raw.expiresAt) {
      await notifyOwner(`⚠️ <b>${raw.name}</b> — бессрочный, изменение не нужно.`);
      return null;
    }

    let base = new Date(raw.expiresAt);
    if (base < new Date()) base = new Date();
    base.setDate(base.getDate() + days);

    const payload = { ...raw, expiresAt: base.toISOString() };
    delete payload.transferRx;
    delete payload.transferTx;
    delete payload.latestHandshakeAt;
    delete payload.endpoint;

    await api.post(`/api/client/${id}`, payload);

    clientsCacheTs = 0;
    const updated = await fetchClient(id);
    return updated;
  } catch (err: any) {
    await notifyOwner(`⚠️ Ошибка при изменении клиента <code>${id}</code>: ${err.message}`);
    return null;
  }
};

const notifyOwner = async (text: string) => {
  try {
    await bot.sendMessage(OWNER_ID, text, { parse_mode: "HTML" });
  } catch (err: any) {
    console.error("notifyOwner:", err.message);
  }
};

const notifyUser = async (tgId: number, text: string): Promise<boolean> => {
  try {
    await bot.sendMessage(tgId, text, { parse_mode: "HTML" });
    return true;
  } catch {
    return false;
  }
};

const notifyLinkedUsersAboutTimeChange = async (c: WgClient, days: number) => {
  const users = getUsersByWg(c.id);
  if (!users.length) return;

  const verb = days > 0 ? `продлена на <b>${days}</b> дн.` : `сокращена на <b>${Math.abs(days)}</b> дн.`;
  const dLeft = daysLeft(c.expiresAt);

  for (const u of users) {
    await notifyUser(u.tgId, `📢 <b>Изменение подписки</b>\n\n` + `👤 Конфиг: <b>${c.name}</b>\n` + `🔄 Подписка ${verb}\n` + `📅 Новая дата: <b>${fmtDate(c.expiresAt)}</b>\n` + `⏳ Осталось: <b>${fmtDays(dLeft)}</b>`);
  }
};

const notifyClientAboutExpiry = async (c: WgClient, days: number) => {
  const users = getUsersByWg(c.id);
  const exp = fmtDate(c.expiresAt);

  await notifyOwner(`⏳ <b>${c.name}</b> — истекает через <b>${days} дн.</b>\n📅 ${exp}` + (users.length ? `\n🔗 ${users.map((u) => `tg:<code>${u.tgId}</code>`).join(", ")}` : "\n🔗 Не привязан"));

  for (const u of users) {
    await notifyUser(u.tgId, `⚠️ <b>VPN «${c.name}» истекает через ${days} дн.</b>\n` + `📅 ${exp}\n\nСвяжитесь с администратором для продления.`);
  }
};

const broadcastAll = async (text: string): Promise<{ total: number; ok: number }> => {
  const entries = Object.values(usersDb);
  let ok = 0;
  for (const u of entries) {
    if (await notifyUser(u.tgId, text)) ok++;
  }
  return { total: entries.length, ok };
};

const clientKeyboard = (wgId: string): TelegramBot.InlineKeyboardMarkup => ({
  inline_keyboard: [
    [
      { text: "+30 дней", callback_data: `ext:${wgId}:30` },
      { text: "-30 дней", callback_data: `ext:${wgId}:-30` },
    ],
    [
      { text: "🔄 Обновить", callback_data: `info:${wgId}` },
      { text: "📣 Уведомить", callback_data: `notif:${wgId}` },
    ],
  ],
});

const thresholds = THRESHOLD_DAYS.split(",").map(Number);

const processClients = async () => {
  try {
    const clients = await fetchClients();
    for (const c of clients) {
      const left = daysLeft(c.expiresAt);
      if (left === null) continue;

      const prev = cache[c.id] || { lastDaysLeft: null, lastNotified: null };
      const toNotify = thresholds.filter((t) => left <= t && (prev.lastDaysLeft ?? Infinity) > t);

      if (toNotify.length > 0) {
        await notifyClientAboutExpiry(c, left);
        cache[c.id] = { lastDaysLeft: left, lastNotified: new Date().toISOString() };
      } else {
        cache[c.id] = { ...prev, lastDaysLeft: left };
      }
    }
    for (const id of Object.keys(cache)) {
      if (!clients.find((c) => c.id === id)) delete cache[id];
    }
    await writeJson(cacheFile, cache);
  } catch (err: any) {
    console.error("processClients:", err.message);
  }
};

const generateCode = (wgId: string): string => {
  const code = Math.random().toString(36).slice(2, 10).toUpperCase();
  inviteCodes[code] = sid(wgId);
  saveInviteCodes();
  return code;
};

const sortByExpiry = (clients: WgClient[]) => [...clients].sort((a, b) => (daysLeft(a.expiresAt) ?? Infinity) - (daysLeft(b.expiresAt) ?? Infinity));

bot.onText(/\/list(?:\s+(\d+))?/, async (msg, match) => {
  if (!isOwner(msg.from?.id)) return;
  let clients = sortByExpiry(await fetchClients());
  const n = match?.[1] ? Number(match[1]) : undefined;
  if (n) clients = clients.slice(0, n);
  if (!clients.length) return bot.sendMessage(msg.chat.id, "❌ Нет клиентов.");

  const lines = clients.map(formatClientLine).join("\n");
  await bot.sendMessage(msg.chat.id, `📋 <b>Клиенты (${clients.length})</b>\n\n${lines}\n\nДетали: /client &lt;id&gt;`, { parse_mode: "HTML" });
});

bot.onText(/\/clients(?:\s+(\d+))?/, async (msg, match) => {
  if (!isOwner(msg.from?.id)) return;
  let clients = sortByExpiry(await fetchClients());
  const n = match?.[1] ? Number(match[1]) : undefined;
  if (n) clients = clients.slice(0, n);
  if (!clients.length) return bot.sendMessage(msg.chat.id, "❌ Нет клиентов.");

  await bot.sendMessage(msg.chat.id, `📋 <b>WireGuard клиенты</b> — всего: <b>${clients.length}</b>`, {
    parse_mode: "HTML",
  });
  for (const c of clients) {
    await bot.sendMessage(msg.chat.id, formatClientFull(c), {
      parse_mode: "HTML",
      reply_markup: clientKeyboard(c.id),
    });
    await new Promise((r) => setTimeout(r, 300));
  }
});

bot.onText(/\/client\s+(\S+)/, async (msg, match) => {
  if (!isOwner(msg.from?.id)) return;
  const id = match?.[1]?.trim();
  if (!id) return bot.sendMessage(msg.chat.id, "❌ /client &lt;id&gt;", { parse_mode: "HTML" });
  const c = await fetchClient(id);
  if (!c) return bot.sendMessage(msg.chat.id, `❌ Клиент <code>${id}</code> не найден`, { parse_mode: "HTML" });
  await bot.sendMessage(msg.chat.id, formatClientFull(c), {
    parse_mode: "HTML",
    reply_markup: clientKeyboard(c.id),
  });
});

bot.onText(/\/time\s+(\S+)\s+([+-]?\d+)/, async (msg, match) => {
  if (!isOwner(msg.from?.id)) return;
  const id = match![1];
  const days = Number(match![2]);
  if (isNaN(days)) return bot.sendMessage(msg.chat.id, "❌ Неверное число дней");
  const updated = await extendClient(id, days);
  const label = days > 0 ? `+${days}` : `${days}`;
  if (updated) {
    await bot.sendMessage(msg.chat.id, `✅ <b>${updated.name}</b>: <b>${label} дн.</b>\n📅 Новая дата: <b>${fmtDate(updated.expiresAt)}</b>`, { parse_mode: "HTML" });
    await notifyLinkedUsersAboutTimeChange(updated, days);
  } else {
    await bot.sendMessage(msg.chat.id, `❌ Не удалось изменить <code>${id}</code>`, { parse_mode: "HTML" });
  }
});

bot.onText(/\/extend\s+(\S+)/, async (msg, match) => {
  if (!isOwner(msg.from?.id)) return;
  const id = match?.[1]?.trim();
  if (!id) return bot.sendMessage(msg.chat.id, "❌ /extend &lt;id&gt;", { parse_mode: "HTML" });
  const updated = await extendClient(id, 30);
  if (updated) {
    await bot.sendMessage(msg.chat.id, `✅ <b>${updated.name}</b> +30 дней.\n📅 Новая дата: <b>${fmtDate(updated.expiresAt)}</b>`, { parse_mode: "HTML" });
    await notifyLinkedUsersAboutTimeChange(updated, 30);
  } else {
    await bot.sendMessage(msg.chat.id, `❌ Не удалось продлить <code>${id}</code>`, { parse_mode: "HTML" });
  }
});

bot.onText(/\/link\s+(\S+)\s+(\d+)/, async (msg, match) => {
  if (!isOwner(msg.from?.id)) return;
  const wgId = match?.[1]?.trim();
  const tgId = Number(match?.[2]);
  if (!wgId || isNaN(tgId)) return bot.sendMessage(msg.chat.id, "❌ /link &lt;wg_id&gt; &lt;tg_id&gt;", { parse_mode: "HTML" });
  const c = await fetchClient(wgId);
  if (!c) return bot.sendMessage(msg.chat.id, `❌ WG <code>${wgId}</code> не найден`, { parse_mode: "HTML" });
  linkWgToTg(c.id, tgId);
  await bot.sendMessage(msg.chat.id, `✅ <b>${c.name}</b> → tg:<code>${tgId}</code>`, { parse_mode: "HTML" });
  await notifyUser(tgId, `✅ <b>VPN-конфиг привязан!</b>\n\n👤 <b>${c.name}</b>\nИспользуйте /me для статуса.`);
});

bot.onText(/\/unlink\s+(\S+)\s+(\d+)/, async (msg, match) => {
  if (!isOwner(msg.from?.id)) return;
  const wgId = match?.[1]?.trim();
  const tgId = Number(match?.[2]);
  if (!wgId || isNaN(tgId)) return bot.sendMessage(msg.chat.id, "❌ /unlink &lt;wg_id&gt; &lt;tg_id&gt;", { parse_mode: "HTML" });
  unlinkWgFromTg(wgId, tgId);
  await bot.sendMessage(msg.chat.id, `✅ <code>${wgId}</code> отвязан от tg:<code>${tgId}</code>`, {
    parse_mode: "HTML",
  });
});

bot.onText(/\/gencode\s+(\S+)/, async (msg, match) => {
  if (!isOwner(msg.from?.id)) return;
  const wgId = match?.[1]?.trim();
  if (!wgId) return bot.sendMessage(msg.chat.id, "❌ /gencode &lt;wg_id&gt;", { parse_mode: "HTML" });
  const c = await fetchClient(wgId);
  if (!c) return bot.sendMessage(msg.chat.id, `❌ <code>${wgId}</code> не найден`, { parse_mode: "HTML" });
  const code = generateCode(c.id);
  const me = await bot.getMe();
  await bot.sendMessage(msg.chat.id, `🔑 Код для <b>${c.name}</b>:\n\n<code>${code}</code>\n\n` + `Ссылка: <code>https://t.me/${me.username}?start=${code}</code>\n⚠️ Одноразовый.`, { parse_mode: "HTML" });
});

bot.onText(/\/linked/, async (msg) => {
  if (!isOwner(msg.from?.id)) return;
  const entries = Object.values(usersDb);
  if (!entries.length) return bot.sendMessage(msg.chat.id, "📭 Нет привязанных пользователей.");
  const clients = await fetchClients();

  const lines = entries.map((u) => {
    const names = u.wgIds
      .map((wid) => {
        const c = clients.find((cl) => sid(cl.id) === sid(wid));
        return c ? `<b>${c.name}</b> (<code>${c.id}</code>)` : `<code>${wid}</code>`;
      })
      .join(", ");
    return `• tg:<code>${u.tgId}</code> → ${names}`;
  });
  await bot.sendMessage(msg.chat.id, `🔗 <b>Привязки</b>\n\n${lines.join("\n")}`, { parse_mode: "HTML" });
});

bot.onText(/\/broadcast\s+([\s\S]+)/, async (msg, match) => {
  if (!isOwner(msg.from?.id)) return;
  const text = match?.[1]?.trim();
  if (!text) return bot.sendMessage(msg.chat.id, "❌ /broadcast &lt;текст&gt;", { parse_mode: "HTML" });
  const { total, ok } = await broadcastAll(`📢 <b>Объявление</b>\n\n${text}`);
  await bot.sendMessage(msg.chat.id, `✅ Рассылка: <b>${ok}/${total}</b>.`, { parse_mode: "HTML" });
});

bot.onText(/\/msg\s+(\d+)\s+([\s\S]+)/, async (msg, match) => {
  if (!isOwner(msg.from?.id)) return;
  const tgId = Number(match?.[1]);
  const text = match?.[2]?.trim();
  if (!tgId || !text) return bot.sendMessage(msg.chat.id, "❌ /msg &lt;tg_id&gt; &lt;текст&gt;", { parse_mode: "HTML" });
  const sent = await notifyUser(tgId, `📣 <b>От администратора:</b>\n\n${text}`);
  await bot.sendMessage(msg.chat.id, sent ? `✅ → tg:<code>${tgId}</code>` : `❌ Не доставлено (бот заблокирован?)`, { parse_mode: "HTML" });
});

bot.onText(/\/msgwg\s+(\S+)\s+([\s\S]+)/, async (msg, match) => {
  if (!isOwner(msg.from?.id)) return;
  const wgId = match?.[1]?.trim();
  const text = match?.[2]?.trim();
  if (!wgId || !text) return bot.sendMessage(msg.chat.id, "❌ /msgwg &lt;wg_id&gt; &lt;текст&gt;", { parse_mode: "HTML" });
  const users = getUsersByWg(wgId);
  if (!users.length) return bot.sendMessage(msg.chat.id, `❌ <code>${wgId}</code> — не привязан.`, { parse_mode: "HTML" });
  let ok = 0;
  for (const u of users) {
    if (await notifyUser(u.tgId, `📣 <b>От администратора:</b>\n\n${text}`)) ok++;
  }
  await bot.sendMessage(msg.chat.id, `✅ <b>${ok}/${users.length}</b> для <code>${wgId}</code>.`, {
    parse_mode: "HTML",
  });
});

bot.on("callback_query", async (query) => {
  if (!isOwner(query.from.id)) {
    await bot.answerCallbackQuery(query.id, { text: "⛔ Нет прав" });
    return;
  }

  const data = query.data ?? "";
  const parts = data.split(":");
  const action = parts[0];
  const wgId = parts[1] ?? "";
  const extra = parts.slice(2).join(":");

  if (action === "ext") {
    const days = Number(extra) || 30;
    const updated = await extendClient(wgId, days);
    const label = days > 0 ? `+${days}` : `${days}`;
    await bot.answerCallbackQuery(query.id, { text: updated ? `✅ ${label} дней` : "❌ Ошибка" });
    if (updated && query.message) {
      await bot
        .editMessageText(formatClientFull(updated), {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,
          parse_mode: "HTML",
          reply_markup: clientKeyboard(updated.id),
        })
        .catch(() => {});
      await notifyLinkedUsersAboutTimeChange(updated, days);
    }
    return;
  }

  if (action === "info") {
    clientsCacheTs = 0;
    const c = await fetchClient(wgId);
    await bot.answerCallbackQuery(query.id, { text: "🔄 Обновлено" });
    if (c && query.message) {
      await bot
        .editMessageText(formatClientFull(c), {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,
          parse_mode: "HTML",
          reply_markup: clientKeyboard(c.id),
        })
        .catch(() => {});
    }
    return;
  }

  if (action === "notif") {
    const users = getUsersByWg(wgId);
    if (!users.length) {
      await bot.answerCallbackQuery(query.id, { text: "❌ Не привязан" });
      return;
    }
    const c = await fetchClient(wgId);
    if (!c) {
      await bot.answerCallbackQuery(query.id, { text: "❌ Не найден" });
      return;
    }
    let ok = 0;
    for (const u of users) {
      if (await notifyUser(u.tgId, `📣 <b>Уведомление</b>\n\n${formatClientForUser(c)}`)) ok++;
    }
    await bot.answerCallbackQuery(query.id, { text: `✅ ${ok}/${users.length}` });
    return;
  }

  if (action === "approve_link") {
    const pendingKey = extra;
    const pending = pendingLinks[pendingKey];
    if (!pending) {
      await bot.answerCallbackQuery(query.id, { text: "❌ Устарел" });
      return;
    }
    const c = await fetchClient(pending.wgId);
    if (!c) {
      await bot.answerCallbackQuery(query.id, { text: "❌ WG не найден" });
      return;
    }
    linkWgToTg(c.id, pending.tgId);
    delete pendingLinks[pendingKey];
    await bot.answerCallbackQuery(query.id, { text: "✅ Подтверждено" });
    if (query.message) {
      await bot
        .editMessageText(`✅ <b>Привязано</b>\n${c.name} → tg:<code>${pending.tgId}</code>`, {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,
          parse_mode: "HTML",
        })
        .catch(() => {});
    }
    await notifyUser(pending.tgId, `✅ <b>Привязка подтверждена!</b>\n\n👤 <b>${c.name}</b>\nИспользуйте /me для статуса.`);
    return;
  }

  if (action === "reject_link") {
    const pendingKey = extra;
    const pending = pendingLinks[pendingKey];
    delete pendingLinks[pendingKey];
    await bot.answerCallbackQuery(query.id, { text: "❌ Отклонено" });
    if (query.message) {
      await bot
        .editMessageText("❌ <b>Запрос отклонён</b>", {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,
          parse_mode: "HTML",
        })
        .catch(() => {});
    }
    if (pending) await notifyUser(pending.tgId, "❌ Запрос на привязку отклонён.");
    return;
  }

  await bot.answerCallbackQuery(query.id);
});

bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  const tgId = msg.from?.id;
  if (!tgId) return;

  if (isOwner(tgId)) {
    await bot.sendMessage(
      msg.chat.id,
      `👋 <b>Привет, админ!</b>\n\n` +
        `<b>Клиенты:</b>\n` +
        `/list [N] — быстрый список\n` +
        `/clients [N] — карточки с кнопками\n` +
        `/client &lt;id&gt; — одна карточка\n` +
        `/extend &lt;id&gt; — +30 дней\n` +
        `/time &lt;id&gt; &lt;±дни&gt; — изменить срок\n\n` +
        `<b>Привязки:</b>\n` +
        `/link &lt;wg_id&gt; &lt;tg_id&gt;\n` +
        `/unlink &lt;wg_id&gt; &lt;tg_id&gt;\n` +
        `/gencode &lt;wg_id&gt; — инвайт\n` +
        `/linked — все привязки\n\n` +
        `<b>Сообщения:</b>\n` +
        `/msg &lt;tg_id&gt; &lt;текст&gt;\n` +
        `/msgwg &lt;wg_id&gt; &lt;текст&gt;\n` +
        `/broadcast &lt;текст&gt; — всем`,
      { parse_mode: "HTML" },
    );
    return;
  }

  const code = match?.[1]?.trim();

  if (!code) {
    const user = getUserByTg(tgId);
    if (user?.wgIds.length) {
      for (const wgId of user.wgIds) {
        const c = await fetchClient(wgId);
        if (c) await bot.sendMessage(msg.chat.id, formatClientForUser(c), { parse_mode: "HTML" });
      }
    } else {
      await bot.sendMessage(msg.chat.id, `👋 Привет!\n\nБот для отслеживания VPN-подписки.\nПопросите инвайт-ссылку у администратора.`);
    }
    return;
  }

  const wgId = inviteCodes[code];
  if (!wgId) return bot.sendMessage(msg.chat.id, "❌ Неверный или использованный код.");

  const c = await fetchClient(wgId);
  if (!c) return bot.sendMessage(msg.chat.id, "❌ VPN не найден. Обратитесь к администратору.");

  const existing = getUserByTg(tgId);
  if (existing?.wgIds.map(sid).includes(sid(c.id))) {
    return bot.sendMessage(msg.chat.id, `ℹ️ <b>${c.name}</b> уже привязан.`, { parse_mode: "HTML" });
  }

  const pendingKey = `${c.id}_${tgId}`;
  pendingLinks[pendingKey] = {
    wgId: c.id,
    tgId,
    tgUsername: msg.from?.username ?? null,
    tgFirstName: msg.from?.first_name ?? null,
    requestedAt: new Date().toISOString(),
  };

  const userName = `${msg.from?.first_name ?? ""}${msg.from?.username ? ` (@${msg.from.username})` : ""}`.trim();

  await notifyOwner(`🔔 <b>Запрос на привязку</b>\n\n` + `👤 <b>${userName}</b>\n🆔 <code>${tgId}</code>\n` + `📡 <b>${c.name}</b> (<code>${c.id}</code>)`);
  await bot.sendMessage(OWNER_ID, "Подтвердить?", {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Да", callback_data: `approve_link:${c.id}:${pendingKey}` },
          { text: "❌ Нет", callback_data: `reject_link:${c.id}:${pendingKey}` },
        ],
      ],
    },
  });

  delete inviteCodes[code];
  await saveInviteCodes();

  await bot.sendMessage(msg.chat.id, `⏳ Запрос отправлен. Ожидайте подтверждения.`);
});

bot.onText(/\/me/, async (msg) => {
  const tgId = msg.from?.id;
  if (!tgId || isOwner(tgId)) return;

  const user = getUserByTg(tgId);
  if (!user?.wgIds.length) {
    return bot.sendMessage(msg.chat.id, "❌ Не привязаны к VPN.\nПопросите инвайт у администратора.");
  }

  for (const wgId of user.wgIds) {
    const c = await fetchClient(wgId);
    if (c) await bot.sendMessage(msg.chat.id, formatClientForUser(c), { parse_mode: "HTML" });
  }
});

const setupCommands = async () => {
  await bot.setMyCommands(
    [
      { command: "list", description: "📋 Список клиентов [N]" },
      { command: "clients", description: "🗂 Карточки клиентов [N]" },
      { command: "client", description: "👤 Клиент <id>" },
      { command: "extend", description: "➕ +30 дней <id>" },
      { command: "time", description: "⏱ Срок <id> <±дни>" },
      { command: "link", description: "🔗 Привязать <wg_id> <tg_id>" },
      { command: "unlink", description: "✂️ Отвязать <wg_id> <tg_id>" },
      { command: "gencode", description: "🔑 Инвайт <wg_id>" },
      { command: "linked", description: "📎 Все привязки" },
      { command: "msg", description: "✉️ Написать <tg_id> <текст>" },
      { command: "msgwg", description: "📨 Написать по WG <wg_id> <текст>" },
      { command: "broadcast", description: "📢 Рассылка <текст>" },
    ],
    { scope: { type: "chat", chat_id: OWNER_ID } },
  );

  await bot.setMyCommands(
    [
      { command: "start", description: "🚀 Начало / привязка" },
      { command: "me", description: "📊 Мой статус" },
    ],
    { scope: { type: "all_private_chats" } },
  );
};

const start = async () => {
  migrateDb();
  await setupCommands();
  await processClients();
  setInterval(processClients, Number(CHECK_INTERVAL_MINUTES || 10) * 60 * 1000);
  console.log("[WG-BOT] Started ✅");
};

start();
