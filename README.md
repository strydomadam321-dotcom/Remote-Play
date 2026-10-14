# Remote Play

A small Parsec-style setup: play your Windows PC from a browser, at up to 60 fps,
with full keyboard and mouse (WASD, Space, Esc, F-keys, hotbar scrolling, and so on).

```
 Laptop browser  ◄──── video (WebRTC, H.264) ────  Host app on your PC
 (your website)  ───── keys + mouse (data channel) ►  (Electron, Windows)
        │                                                │
        └──────────── signaling only ──── Render server ─┘
```

- **`server/`** runs on Render. It serves the viewer page and introduces the two
  sides to each other. Video does not pass through it.
- **`host/`** runs on the gaming PC. It captures the screen with the GPU's hardware
  encoder and types the keys and mouse input it receives from the viewer.

A website can't control a PC by itself, so the host app always has to be running on the PC.

---

## 1. Deploy the server to Render

1. Push this folder to a GitHub repo.
2. In Render, click **New → Blueprint** and pick the repo. `render.yaml` sets up everything
   and generates a random `ACCESS_KEY`.
   (Or create a **Web Service** by hand: root directory `server`, build `npm install`,
   start `npm start`, and add an `ACCESS_KEY` env var with 16+ random characters.)
3. Open the service's **Environment** tab and copy `ACCESS_KEY`. Anyone who has this
   key can control your PC, so treat it like a password.

### Optional: show the page on your own Netlify site

Netlify can host the page but not the server, so the server still runs on Render.

1. Open `server/public/config.js` and put your Render address in it:
   `window.REMOTE_PLAY_SERVER = 'https://YOUR-APP.onrender.com';`
2. In Netlify, go to your site's **Deploys** tab and drag in the **`server/public` folder**,
   not the whole project folder. Netlify serves the dropped folder as the site's root.

The host app's `config.json` still points at Render (`wss://YOUR-APP.onrender.com/ws`).

## 2. Set up a TURN relay (needed for library wifi)

Library and school networks usually block direct peer-to-peer connections. A TURN relay
on port 443 gets through almost anything. Without one, the viewer will say it can't
reach your PC.

**Cloudflare TURN** (recommended, has a free tier):
1. In the Cloudflare dashboard go to **Realtime → TURN Server** and create a TURN key.
2. Add its **Key ID** and **API token** in Render as `CF_TURN_KEY_ID` and `CF_TURN_API_TOKEN`.

**Any other TURN provider:** set `TURN_URLS` (comma separated, include a
`turns:…:443?transport=tcp` URL), `TURN_USERNAME` and `TURN_CREDENTIAL`.

Bandwidth guide: 6 Mbps is about 2.7 GB per hour of streaming.

## 3. Run the host on your PC

Install [Node.js](https://nodejs.org) (LTS), then:

```bash
cd host
npm install
copy config.example.json config.json
```

Edit `host/config.json`:

```json
{
  "serverUrl": "wss://YOUR-APP.onrender.com/ws",
  "accessKey": "the ACCESS_KEY from Render"
}
```

Start it with `npm start`, or double-click `start-host.bat`. To start it on login, press
Win+R, type `shell:startup`, and put a shortcut to `start-host.bat` in that folder.

The host window shows whether it's online, who's watching, the resolution and fps it's
sending, and which encoder it's using. You can minimize the window, but closing it ends
remote access.

## 4. Play from the laptop

Open `https://YOUR-APP.onrender.com` in **Chrome or Edge**, enter the key, then click the video.

| Action | What it does |
| --- | --- |
| Click the video | Goes fullscreen and captures the mouse. From here every key goes to the PC |
| **Esc** (tap) | Sent to the game, e.g. opens Minecraft's pause menu |
| **Esc** (hold) | Leaves fullscreen and releases the mouse |
| Screen menu | Switches which monitor you see. No reconnect needed |
| Quality menu | Use 540p/720p on weak wifi and 1080p on good connections |
| Mouse: Desktop | Shows a normal pointer that clicks where you point. Good for the Windows desktop |

The stats in the toolbar show resolution · fps · bitrate · round-trip time · route.
`relay/tcp` means traffic is going through TURN. That's normal on library wifi and
adds some latency.

Firefox and Safari work too, but they can't capture Esc in fullscreen. There, Esc
releases the mouse and is also sent to the game.

---

## Minecraft tips

- **Options → Controls → Mouse Settings → Raw Input: ON** makes the camera match your laptop's mouse exactly.
- Run Minecraft windowed, borderless, or F11 fullscreen. All three capture fine.
- Don't run Minecraft **as administrator** unless the host also runs as admin.
  Windows blocks input from normal programs to admin windows.

## Keep the PC reachable

- The PC must stay **on, awake, and logged in**. The host app stops the PC from sleeping
  and keeps the display awake while someone is watching. Windows' lock screen and UAC
  prompts can't be controlled remotely, so turn off auto-lock if you need it.
- Render's free plan sleeps the server when it's idle. The host reconnects on its own,
  and opening the site wakes the server up (allow about a minute).

## Local testing

```bash
cd server
npm install
node --env-file=.env.local server.js
```

Then set `"serverUrl": "ws://localhost:3000/ws"` and the key from `server/.env.local`
in `host/config.json`, and open http://localhost:3000.

## Security notes

- Every connection must present `ACCESS_KEY`. Ten wrong guesses lock out that IP for
  15 minutes.
- The host only accepts a fixed set of key and mouse messages. There is no file
  access or shell, and when the viewer disconnects, all held keys are released.
- **Sign out** in the viewer forgets the saved key on that device.
- `host/config.json` and `.env*` files are gitignored. Don't commit your key.
