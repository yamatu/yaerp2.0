# WhatsApp integration

## Start

1. Set a long random `WHATSAPP_INTERNAL_SECRET` in `.env`.
2. Run `docker compose up -d --build`.
3. Open `http://localhost:5555/admin/whatsapp` as an administrator and enable the service.
4. Each employee opens `http://localhost:5555/whatsapp` and scans their own QR code. Administrators can also select an employee and operate that account from the admin page.

Every employee uses an independent `LocalAuth` client ID and session directory in the `whatsapp_auth` Docker volume. Rebuilding the containers does not require another scan unless that employee logs out or the volume is removed.

## Proxy

The admin page accepts HTTP, HTTPS, and SOCKS5 proxies, including authenticated proxy credentials. The proxy is global and is never exposed on the employee WhatsApp page. Credentials are encrypted in PostgreSQL with a key derived from `JWT_SECRET`. After changing proxy settings, restart the affected employee sessions.

Do not change `JWT_SECRET` after saving an authenticated proxy password unless you clear or replace that password first.

## Channel sync

Channel owners can link their own WhatsApp account. Administrators can select any employee WhatsApp account and then select one of that account's contacts or groups. Each link can independently enable:

- WhatsApp to channel: incoming text and files appear in the channel. Incoming images are also saved under a channel gallery directory named after the WhatsApp chat.
- Channel to WhatsApp: new channel messages are forwarded automatically. Workbook and worksheet messages are exported as XLSX files.

Messages are deduplicated by WhatsApp message ID and channel clients receive a WebSocket event so the message list updates without a page reload.

Gallery images, workbooks, and individual worksheets also expose a direct "Send to WhatsApp" action.

## Operational note

`whatsapp-web.js` automates WhatsApp Web and is not the official WhatsApp Business Cloud API. WhatsApp Web changes can require a dependency update, so monitor the `whatsapp` container logs after upgrades.
