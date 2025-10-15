# WireGuard Easy Telegram Bot

A reliable Telegram bot for monitoring WireGuard Easy clients and notifying when VPN subscriptions are about to expire.

### Features

- Fetches clients from `/api/client` via Basic Auth
- Notifies by thresholds days before expiration
- Safe cache updates and auto-cleanup
- `/clients` command (owner-only)
- Auto resets cache

### Setup

```bash
npm install
npm run start
```
