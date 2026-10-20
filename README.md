# multiple-gmail

All your Gmail accounts, in your AI apps.

multiple-gmail is a small Windows program that lets AI apps such as Claude, Gemini CLI, Cursor or VS Code work with
several Gmail accounts at once (personal Gmail and Google Workspace). It runs on your own computer, asks Google for
access with your own Google Cloud project, and stores everything encrypted on your disk. Nothing goes to any server
of mine.

Inspired by [Vinksj/claude-gmail-multi](https://github.com/Vinksj/claude-gmail-multi). The code is written from scratch.

Project pages: [home](https://efk44.github.io/multiple-gmail/) and
[privacy policy](https://efk44.github.io/multiple-gmail/privacy.html).

## What it does

You double-click `multiple-gmail.exe`. A setup wizard opens in your browser and walks you through the one-time Google
setup and connecting your accounts. After that, any AI app that speaks MCP (Model Context Protocol) can use all your
connected accounts. Every tool takes an `account` argument, and searching can run on `"all"` accounts at once.

### Tools

| Tool | What it does |
|---|---|
| `list_accounts` | Shows connected accounts and their status |
| `search_threads` | Gmail search syntax; works on one account or `"all"` |
| `get_thread`, `get_message` | Read a conversation or a message (plain text by default) |
| `list_drafts` | Lists drafts; one account or `"all"` |
| `create_draft` | Creates a draft or a reply draft. It never sends |
| `send_message` | Sends a new message, a reply, or an existing draft |
| `reply` | Sends a reply in a thread |
| `list_labels` | Lists labels; one account or `"all"` |
| `label_thread`, `unlabel_thread` | Adds or removes labels on a thread |

The tools follow the same names and parameters as Claude's official Gmail connector, plus the `account` argument.

## Safety model

- **No delete tools.** There is no tool to delete, trash or empty anything: not mail, not drafts, not labels.
- **Sending needs your approval.** `send_message` and `reply` are marked as destructive and their descriptions tell the
  AI to use them only after you approved that exact message. The recommended flow is: create a draft, you look at it,
  then send it.
- **Smallest useful permission.** Only the `gmail.modify` scope is requested. It covers reading, drafting, sending and
  labeling. Google also requires it for changing labels on a thread. The permission to delete mail permanently
  (`https://mail.google.com/`) is never requested.
- **Everything stays local.** The local server listens on `127.0.0.1` only, requires a secret key, and checks the
  `Host` and `Origin` headers. Tokens and your OAuth client are encrypted with AES-256-GCM. On Windows the encryption
  key is protected by DPAPI for your user account.
- **Removing an account** is possible only in the wizard or on the command line. An AI cannot disconnect accounts.

## Install

There are no prebuilt downloads yet, so build from source. You need Node.js 24 and npm.

```sh
npm ci
npm test
npm run build:exe
```

The result is `build/multiple-gmail.exe`. Copy it anywhere, for example a folder in your user profile, and
double-click it.

The exe is not code-signed. Windows SmartScreen may say "Windows protected your PC". Click **More info**, then
**Run anyway**. You built it yourself, so this is expected.

When you run it, a console window shows its status. Closing that window stops the server. Starting the exe a second
time does not start another server: it opens the wizard of the running one.

## Google Cloud setup (once)

Google must know that your copy of multiple-gmail may use Gmail. You tell it in Google Cloud. It is free and needs no
credit card. The wizard shows these same steps with direct links; this is the short version. Google changes its
website now and then, so a name may differ slightly.

1. **Create a project** at https://console.cloud.google.com/projectcreate (any name, for example `multiple-gmail`).
2. **Turn on the Gmail API** for that project:
   https://console.cloud.google.com/apis/library/gmail.googleapis.com and click Enable.
3. **Describe your app.** Open https://console.cloud.google.com/auth/overview and click Get started. Use any app
   name, your email as support and contact email, and Audience **External**. Accept the user data policy.
4. **Fill in the branding links.** Open the Branding page. Under App domain, fill **Application home page**,
   **Application privacy policy link** and **Authorized domains**, then Save. Google keeps the Publish button
   disabled until these are set. If you have no website, use this project's public pages:
   - Application home page: `https://efk44.github.io/multiple-gmail/`
   - Application privacy policy link: `https://efk44.github.io/multiple-gmail/privacy.html`
   - Authorized domain: `efk44.github.io`

   If you own a domain, you may use your own instead.
5. **Allow Gmail access.** Open Data access, click Add or remove scopes, and under Manually add scopes paste
   `https://www.googleapis.com/auth/gmail.modify`. Add to table, Update, Save.
6. **Create the key file.** Open https://console.cloud.google.com/auth/clients and click Create client. Application
   type **Desktop app**. If you see a checkbox **Use this client for an AI-powered agent**, tick it. Click Create, then
   Download JSON and keep the file.
7. **Publish the app.** Open Audience and click Publish app, then Confirm. If the button is disabled, hover over it:
   it tells you what is missing, almost always the Branding fields from step 4. Google may say the app needs
   verification; ignore that, verification is for apps that other people use.

   **Alternative without publishing:** stay in Testing mode and add every Gmail address you want to use under
   Audience > Test users. In Testing mode Google expires the sign-in every 7 days, so each account will show
   **Reconnect** in the wizard weekly.

When you later sign in, Google will say "Google hasn't verified this app". That is expected, because the app is yours.
Click Advanced, then Go to (your app name) (unsafe). If the Gmail permission checkbox is empty, tick it.

## Add your accounts

In the wizard, upload the JSON file, then type any name you like for the account (up to 40 characters, for example
`Work` or `İş Hesabı`) and click the Google sign-in button. Repeat for each account. Names are matched without regard
to case, and `all` is reserved. You can rename an account later in the control panel. Your AI can refer to an account
by its name or by its email address.

The same thing works from a terminal:

```sh
multiple-gmail.exe accounts list
multiple-gmail.exe accounts add --name "Work"
multiple-gmail.exe accounts reconnect work
multiple-gmail.exe accounts rename work "Shop"
multiple-gmail.exe accounts remove "Shop"
```

## Connect your AI app

The last wizard step does most of this with a button. By hand:

- **Claude Desktop:** the wizard has an "Add to Claude Desktop" button. It makes a backup of
  `claude_desktop_config.json` first and adds the server without touching your other settings. Restart Claude Desktop
  afterwards.
- **Claude Code:** run the command the wizard shows, which has this form:
  `claude mcp add --scope user multiple-gmail -- "C:\path\to\multiple-gmail.exe" --stdio`
- **Gemini CLI:** the wizard can add the server to `~/.gemini/settings.json` (with a backup), or add a `multiple-gmail`
  entry under `mcpServers` with the command `multiple-gmail.exe` and the argument `--stdio`.
- **Other apps (Cursor, VS Code, LM Studio, and so on):** use the HTTP address `http://127.0.0.1:47110/mcp` and the
  header `Authorization: Bearer <your local key>`. The wizard shows ready-to-copy JSON with your key. The HTTP server
  runs while the exe is running.
- **ChatGPT and claude.ai in the browser** cannot reach a program on your computer. For those, run multiple-gmail on a
  server you control. See [DEPLOY.md](DEPLOY.md).

## Problems

- **An account says "needs reconnect".** Google signed it out, most often because the app is still in Testing mode (7
  days) or you changed the account password. Click Reconnect in the wizard and sign in again.
- **Google says the app is blocked by your administrator.** Your Google Workspace admin blocks unverified apps. They can
  mark your client as trusted in Admin console > Security > Access and data control > API controls > Manage third-party
  app access. The wizard shows these steps when it detects the block.
- **"This setup link has expired or was already used".** Each setup link works once, and the browser uses it
  right away. Close that tab and open multiple-gmail again: it opens a fresh tab (if it is already running, the new
  tab may appear in another browser window). To get a link to paste by hand, run `multiple-gmail.exe --print-url`.
- **Port in use.** The default port is 47110. Change `port` in `config.json` in the data folder (see
  `config.example.json`) and start again.
- **Claude Desktop does not show the tools.** Fully quit Claude Desktop (also from the tray) and start it again. Check
  that `claude_desktop_config.json` contains `multiple-gmail`. The wizard keeps timestamped backups next to that
  file, so you can restore one if something looks wrong. The Microsoft Store version of Claude Desktop (3.x) keeps its
  config in `%LOCALAPPDATA%\Claude-Data\claude_<id>\claude_desktop_config.json`; the installer version uses
  `%APPDATA%\Claude\claude_desktop_config.json`. The wizard writes to whichever of these exist.
- **SmartScreen blocks the exe.** More info, then Run anyway (see Install).

## Where your data lives, and how to uninstall

Everything is in `%LOCALAPPDATA%\multiple-gmail` (on other systems `~/.multiple-gmail`; set `MULTIPLE_GMAIL_HOME` to
change it). It holds `config.json` (no secrets), your encrypted OAuth client and tokens, and the protected key.

To remove everything:

1. Remove each account in the wizard (or `accounts remove <name>`). This also asks Google to revoke the token.
2. Delete the data folder.
3. Check https://myaccount.google.com/permissions and remove your app if it is still listed.
4. Delete the exe. If you turned on "Start with Windows", turn it off first in the wizard.
5. Optionally delete the Google Cloud project.

## Server mode

For web AI apps, multiple-gmail can run on your own server behind HTTPS with OAuth 2.1 and an admin password. This is
optional and separate from the Windows exe. See [DEPLOY.md](DEPLOY.md).

## Development

```sh
npm ci
npm test
npx tsc --noEmit
npm run build:exe
```

Privacy policy: https://efk44.github.io/multiple-gmail/privacy.html . Issues and questions:
https://github.com/EFK44/multiple-gmail/issues .

## License

[MIT](LICENSE)
