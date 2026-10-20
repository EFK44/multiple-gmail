# Deploying multiple-gmail in server mode

Server mode lets web AI apps (claude.ai in the browser, ChatGPT) use your Gmail accounts. They cannot reach a program on
your own computer, so multiple-gmail runs on a server you control, behind HTTPS, and protects itself with OAuth 2.1 and
a single admin password.

Read this whole page once before you start. It assumes a small Linux VPS with Docker and a domain name you control.

## How it fits together

```
claude.ai / ChatGPT  --HTTPS-->  Caddy (TLS, ports 80/443)  --HTTP-->  multiple-gmail (port 8080, private)
                                                                         |
                                                                         +-- /data (encrypted accounts and tokens)
```

- multiple-gmail speaks plain HTTP on port 8080 and must never be reachable from the internet directly. Caddy in front
  of it gets and renews a TLS certificate automatically.
- The AI app finds the server's sign-in page through standard OAuth discovery. You approve each app once with your admin
  password. The app then receives a token that expires after one hour and is renewed automatically.
- You, the owner, are the only user. Anyone who knows the admin password can approve an app, so treat it like the
  password of your mailbox.

## 1. Prepare the server

1. Point a DNS name at the server, for example `mail.example.com` (an `A` and/or `AAAA` record).
2. Open ports 80 and 443 in the server firewall. Do not open 8080.
3. Install Docker with the Compose plugin (see the Docker documentation for your distribution).
4. Copy this repository to the server, for example with `git clone`, and `cd` into it.
5. Build the image:

   ```sh
   docker build -t multiple-gmail .
   ```

## 2. Create the master key and the admin password hash

Every secret in `/data` is encrypted with a 32-byte master key that you keep outside the server's data folder.

```sh
docker run --rm multiple-gmail node build/main.cjs gen-key
```

Copy the printed value. This is `MULTIPLE_GMAIL_MASTER_KEY`. Store a copy in your password manager: without it, the
data in `/data` cannot be decrypted, and a lost key means connecting every account again.

Then create the admin password hash (the password itself is never stored):

```sh
docker run --rm -it multiple-gmail node build/main.cjs hash-password
```

Type a long password (at least 12 characters; a passphrase of several words is best). Input is hidden. The command
prints a line that starts with `scrypt$`. This is `ADMIN_PASSWORD_HASH`.

The hash contains `$` characters. Wherever you put it, keep it in single quotes so no shell or Compose file expands it.

## 3. Configure and start

Create a file named `.env` next to the compose file. It holds secrets: `chmod 600 .env`, and never commit it.

```sh
PUBLIC_URL=https://mail.example.com
MULTIPLE_GMAIL_MASTER_KEY='paste the gen-key output here'
ADMIN_PASSWORD_HASH='paste the scrypt$... line here'
```

Create `compose.yml`:

```yaml
services:
  multiple-gmail:
    image: multiple-gmail
    restart: unless-stopped
    environment:
      PUBLIC_URL: ${PUBLIC_URL}
      MULTIPLE_GMAIL_MASTER_KEY: ${MULTIPLE_GMAIL_MASTER_KEY}
      ADMIN_PASSWORD_HASH: ${ADMIN_PASSWORD_HASH}
      TRUST_PROXY: "1"
    volumes:
      - mg-data:/data
    # Reachable only by Caddy on the compose network, never published on the host.
    expose:
      - "8080"

  caddy:
    image: caddy:2
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config
    depends_on:
      - multiple-gmail

volumes:
  mg-data:
  caddy-data:
  caddy-config:
```

Create `Caddyfile` (replace the host name):

```
mail.example.com {
	reverse_proxy multiple-gmail:8080
}
```

Start everything:

```sh
docker compose up -d
docker compose logs -f multiple-gmail
```

The log shows the connector address (`https://mail.example.com/mcp`) and the setup address
(`https://mail.example.com/admin/login`). If a required variable is missing, the container exits with a message that
names it.

### Without Compose

If you run your own reverse proxy, a single container is enough. Bind it to localhost only, so that only the proxy can
reach it:

```sh
docker run -d --name multiple-gmail --restart unless-stopped \
  -p 127.0.0.1:8080:8080 \
  -v mg-data:/data \
  -e PUBLIC_URL=https://mail.example.com \
  -e MULTIPLE_GMAIL_MASTER_KEY='...' \
  -e ADMIN_PASSWORD_HASH='scrypt$...' \
  -e TRUST_PROXY=1 \
  multiple-gmail
```

The proxy must forward the original `Host` header (Caddy does this by default) and add `X-Forwarded-For`.

### Without Docker

Node.js 24 is required. In the repository:

```sh
npm ci
node scripts/build-exe.mjs --bundle-only
PUBLIC_URL=https://mail.example.com MULTIPLE_GMAIL_MASTER_KEY='...' ADMIN_PASSWORD_HASH='scrypt$...' \
  HOST=127.0.0.1 TRUST_PROXY=1 \
  MULTIPLE_GMAIL_HOME=/var/lib/multiple-gmail node build/main.cjs serve --remote
```

`HOST=127.0.0.1` keeps the port reachable only from the same machine, where your reverse proxy runs. Keep
`build/main.cjs` and `src/web` together; the setup pages are read from `src/web`.

## Environment variables

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `PUBLIC_URL` | yes | | The public HTTPS address, scheme and host only, for example `https://mail.example.com`. Must start with `https://`. |
| `MULTIPLE_GMAIL_MASTER_KEY` | yes | | 32 random bytes, base64, from `gen-key`. Encrypts everything in the data folder. |
| `ADMIN_PASSWORD_HASH` | yes | | The `scrypt$...` line from `hash-password`. |
| `PORT` | no | `8080` | Port to listen on (plain HTTP). |
| `HOST` | no | `0.0.0.0` | Address to listen on. Inside Docker keep the default; elsewhere prefer `127.0.0.1`. |
| `MULTIPLE_GMAIL_HOME` | no | `/data` | Data folder: encrypted Google client, account tokens, registered apps and issued tokens. |
| `TRUST_PROXY` | no | off | Set to `1` only behind a reverse proxy. The rightmost `X-Forwarded-For` entry is then used as the client address for rate limiting. Without a proxy, leave it off, or clients could spoof their address. |
| `MULTIPLE_GMAIL_ALLOW_INSECURE` | no | off | Development only: allows `PUBLIC_URL=http://localhost`. Never set it on a server. |

## 4. Create the Google OAuth client (Web application)

Server mode uses a Google OAuth client of type "Web application". (The desktop app uses a "Desktop app" client; they
are not interchangeable.) You can reuse the Google Cloud project from the desktop setup or create a new one.

1. Sign in at `https://mail.example.com/admin/login` with the admin password. The setup guide opens.
2. Follow the Google Cloud steps in the guide: create a project, enable the Gmail API, configure the consent screen, add
   the scope `https://www.googleapis.com/auth/gmail.modify`, and publish the app (Audience > Publish app) so sign-ins do
   not expire every 7 days.
3. At the step "Create the key file": in Google Cloud Console open Google Auth Platform > Clients > Create client,
   choose Application type "Web application", and under "Authorized redirect URIs" add exactly:

   ```
   https://mail.example.com/oauth/google/callback
   ```

   The guide shows this address with a copy button. Click Create, then download the JSON file.
4. Upload the JSON in the guide. The server refuses a Desktop app client, or a Web client whose redirect URIs do not
   contain the address above.
5. Connect your Gmail accounts. Each one gets a short nickname (alias). Google Workspace accounts may need the
   administrator step shown in the guide.

## 5. Add the connector to your AI app

The connector address is `https://mail.example.com/mcp`. The app discovers the sign-in page by itself (OAuth 2.1 with
dynamic client registration and PKCE). When the sign-in page of your server opens, check that the app name and the
"sent back to" address look right, enter the admin password, and choose Allow.

### claude.ai

The steps below match the Claude help pages at the time of writing. Menu names can change and custom connectors depend
on your plan; check the current Claude documentation if something differs.

1. Open claude.ai, then Settings > Connectors.
2. Choose "Add custom connector".
3. Enter a name (for example "Gmail accounts") and the URL `https://mail.example.com/mcp`. Leave the advanced OAuth
   client fields empty: the server registers the client automatically.
4. Click Add, then Connect. Approve on your server's sign-in page.
5. In a chat, enable the connector from the tools menu.

### ChatGPT

ChatGPT supports remote MCP servers as connectors through developer mode, and availability varies by plan and changes
over time. Check the current OpenAI documentation (search for "ChatGPT developer mode" and "connectors") before you
start. In general:

1. Enable developer mode in ChatGPT settings, if your plan offers it.
2. Create a new connector, enter the URL `https://mail.example.com/mcp`, and choose OAuth as the authentication method.
3. Approve on your server's sign-in page.

### Other MCP clients

Any client that supports MCP authorization (protected resource metadata, authorization server metadata, dynamic client
registration and PKCE) works with the same URL.

## Backups

Back up two things, and keep them in different places:

1. The data volume (`/data`, the `mg-data` Docker volume). It contains only encrypted files.
2. The master key (`MULTIPLE_GMAIL_MASTER_KEY`). The backup is useless without it, and anyone who has both can read your
   Gmail tokens.

Example backup of the volume:

```sh
docker run --rm -v mg-data:/data -v "$PWD":/backup busybox tar czf /backup/mg-data.tgz -C /data .
```

To restore, stop the container, extract the archive into an empty volume, and start it again with the same master key.

## Security notes

- Single owner. There are no user accounts: whoever knows the admin password can approve new AI apps and manage the
  Gmail accounts. Use a long, unique password.
- Failed passwords are rate limited: after 5 failures within 15 minutes from one address, further attempts are refused
  until the window passes.
- Changing the password: run `hash-password` again, replace `ADMIN_PASSWORD_HASH`, and restart. Admin sign-ins end on
  restart. Apps that were already approved keep their tokens.
- Revoking every connected AI app: stop the container, delete `remote-tokens.enc` from the data folder, and start it
  again. Every token is gone and every app has to be approved again. Your Gmail accounts stay connected.
- Disconnecting a Gmail account: use Remove in the control panel. It also revokes the access at Google. You can review
  access at any time at `https://myaccount.google.com/permissions`.
- Tokens issued to AI apps are random values; the server stores only their SHA-256 digests, encrypted. Access tokens
  last one hour; refresh tokens last 30 days and are replaced on every use. If an old refresh token is ever presented
  again within 7 days of its replacement, the server revokes that whole session.
- Only the reverse proxy may reach port 8080. With `TRUST_PROXY=1` the server believes the last `X-Forwarded-For`
  entry, so anyone who could reach the port directly could send a forged header and dodge the rate limits. If requests
  carry `X-Forwarded-For` while `TRUST_PROXY` is off, the server logs a one-time hint.
- Opening the sign-in pages without a password is also limited (60 page loads per 15 minutes per address), so a flood
  cannot push out a sign-in you have open.
- Keep the server updated. Rebuild the image from time to time to pick up Node.js security fixes:
  `docker build --pull -t multiple-gmail . && docker compose up -d`.
- The AI app can read, label and draft mail in all connected accounts. Sending requires the model to ask for your
  approval in the chat first; read what it wants to send before you agree.
