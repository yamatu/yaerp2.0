# WhatsApp integration

## Start

1. Set a long random `WHATSAPP_INTERNAL_SECRET` in `.env`.
2. Run `docker compose up -d --build`.
3. Open `http://localhost:5555/admin/whatsapp` as an administrator.
4. Enable WhatsApp, save, start the session, and scan the QR code.

The linked-device session is stored in the `whatsapp_auth` Docker volume. Rebuilding the containers does not require another scan unless the WhatsApp account logs out or the volume is removed.

## Proxy

The admin page accepts HTTP, HTTPS, and SOCKS5 proxies, including authenticated proxy credentials. Credentials are encrypted in PostgreSQL with a key derived from `JWT_SECRET`. After changing proxy settings, restart the WhatsApp session from the same page.

Do not change `JWT_SECRET` after saving an authenticated proxy password unless you clear or replace that password first.

## Channel sync

Channel owners and administrators can open channel settings and link a WhatsApp contact or group. Each link can independently enable:

- WhatsApp to channel: incoming text and files appear in the channel. Incoming images are also saved under a channel gallery directory named after the WhatsApp chat.
- Channel to WhatsApp: new channel messages are forwarded automatically. Workbook and worksheet messages are exported as XLSX files.

Messages are deduplicated by WhatsApp message ID and channel clients receive a WebSocket event so the message list updates without a page reload.

Gallery images, workbooks, and individual worksheets also expose a direct "Send to WhatsApp" action.

## Operational note

`whatsapp-web.js` automates WhatsApp Web and is not the official WhatsApp Business Cloud API. WhatsApp Web changes can require a dependency update, so monitor the `whatsapp` container logs after upgrades.
