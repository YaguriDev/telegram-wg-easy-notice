# WireGuard Easy Telegram Bot

A reliable Telegram bot for monitoring and management WireGuard Easy clients and notifying when VPN subscriptions are about to expire.

### Features

- Fetches clients from `/api/client` via Basic Auth
- Notifies by thresholds days before expiration
- Safe cache updates and auto-cleanup
- `/clients` command (owner-only)
- `/clients <count>` command (see only N clients sort by days left) (owner-only)
- `/client <id>` command (owner-only)
- `/time <id> <-+days>` command (owner only)
- Auto resets cache

### Setup

- Create and edit .env file (see .env.example), after execute:

```bash
npm install
npm run start
```

### DevOps

```bash
# Download Node + Npm
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Clone Repo + Build
git clone https://github.com/YaguriDev/telegram-wg-easy-notice.git
cd telegram-wg-easy-notice
npm install
npm run build

# Startup
sudo npm install -g pm2
pm2 start dist/index.js --name "wg-bot"
pm2 save
pm2 startup
```
