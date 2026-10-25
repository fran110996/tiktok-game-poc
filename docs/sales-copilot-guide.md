# Sales Copilot — User & setup guide

The Sales Copilot is a private assistant for meetings and messages. It lives inside the same app as the TikTok LIVE games but is a separate module at **`/copilot`**. The game dashboard, overlays and teleprompter are unchanged.

---

## 1. Supported setup

| Device | What works |
|---|---|
| Windows / macOS — Chrome or Edge (116+ for the pop-out) | Everything |
| Android — Chrome | In-person mode, follow a session from another device, "Read my screen" via photo/screenshot, replies, contacts, morning summary |
| iPhone / iPad — Safari, iOS 16.4+ (Chrome on iOS behaves the same) | Same as Android |
| Firefox, Safari on Mac | Not supported |

Phones cannot capture audio from other apps (Zoom, LINE calls) or stay on top of other apps. Those features need a computer.

- **Capturing the other side of a call:**
  - **Windows:** share the **entire screen** and tick **“Share system audio”**. This captures desktop apps (Zoom, Teams, LINE calls). You can also share just the browser tab of the meeting and tick **“Share tab audio”**.
  - **macOS:** run the meeting in a **browser tab** (Meet, Zoom web, Teams web) and share **that tab** with **“Share tab audio”**. macOS browsers cannot capture audio from desktop apps.
- **Company computers:** managed computers may block screen capture, the microphone or pop-up windows. IT has to allow the site.
- **Privacy:** audio and text are processed by OpenAI. Only use the copilot with company data once the company approves external AI.
- **Screen sharing:** the copilot is a website, and a website cannot hide itself from screen sharing or recordings (only a desktop app can). In the meeting, share only the meeting window or tab, not the whole screen.
- **Phones (in-person mode):** keep the page open and the screen on. The copilot asks the phone to stay awake, but if the phone locks or you switch apps, the browser stops the microphone. Come back and tap **Resume audio capture**.
- **Bluetooth earphones / smart glasses** (e.g. Ray-Ban Meta): pair them with the phone or computer. They then work as a normal microphone and speaker, and you can pick them under **Microphone**. This is best-effort: there is no direct integration with the glasses.
- **Earphones:** wear earphones so the meeting does not hear the copilot's voice. On Windows, if you share the entire screen with system audio, the copilot's voice can be captured too. To avoid that, share only the meeting tab, or pick a different output device in the playback bar (Chrome shows a device picker when there is more than one).

---

## 2. Logging in

1. Open `https://<your-app>/copilot`. A custom domain can point to the same app later.
2. Sign in with the email and password set in the server settings (`COPILOT_USER_EMAIL`, `COPILOT_USER_PASSWORD`).
3. You stay logged in for 14 days on that browser. Use **Log out** at the bottom left to end the session.

Every copilot page and API route requires this login.

---

## 3. OpenAI API key (Settings) and demo mode

- **Settings → OpenAI API key:** paste a key from platform.openai.com. It is checked with OpenAI, stored **encrypted** on the server, and only shown masked (`sk-proj…ab12`). Usage is billed by OpenAI to the owner of the key. Set a monthly budget in OpenAI → Settings → Limits.
- A key in the `OPENAI_API_KEY` server variable also works. A key saved in Settings takes priority.
- **Demo mode:** without any key, the copilot runs with **example answers** and shows a blue "Demo mode" banner. Every screen works, but nothing is really transcribed, read or searched, and the read-aloud uses the browser's own voice. `COPILOT_DEMO=true` forces demo mode even when a key exists.

---

## 4. Before a session: context & documents

**Context & documents** (left menu):

- **Context profiles:** describe who you are, your company, products, key prices you are allowed to share, goals and tone. You can keep several profiles, for example one per brand.
- **Documents:** upload price lists, catalogues or presentations (PDF, DOCX, TXT or MD, max 10 MB each). The text is extracted on the server. During a session, only the parts relevant to the conversation are sent to the AI.
  - Scanned PDFs (images only, no text) cannot be read.

---

## 5. Live meeting assistant

**New session:**

1. Pick a **context profile**. Its text appears below the selector, and you can edit it just for this session.
2. Tick the **documents** to use.
3. Optionally pick a **contact**. Their tags, preferences and notes are used in the suggestions.
4. Choose **my language** (default English) and **their language** (auto-detect by default).
5. Choose the audio sources:
   - **Microphone = Me.**
   - **Screen / tab with audio = Them.** Untick it for in-person meetings (microphone only).
6. Click **Start session**, allow the microphone, then choose the screen or tab to share. Remember to tick the **audio** checkbox in Chrome's dialog.

The three panels:

| Panel | What it shows |
|---|---|
| **1 · Transcript & translation** | Every ~5 s of speech becomes a line labelled **ME** or **THEM**, with a timestamp and a translation into your language. |
| **2 · What they are asking for** | Their request in one line, the requested actions as a checklist (tick them off as you go), and open questions. Updates every ~20 s, or sooner when they ask a question. |
| **3 · Suggested replies & solutions** | 1–3 short replies you can say now (in their language, with your-language meaning), plus an answer that uses your context, documents and the conversation. When public facts are needed it searches the web and lists the **sources**. |

- **⚠ Uncertain** means the AI is not sure: check before you use it. **Unverified link** means a link was not confirmed by the web search.
- **↻ Update now** refreshes panels 2 and 3 immediately.
- **■ Stop** ends the session, writes a summary with next steps, and saves everything to **History**.
- If you reload the page during a session, it reopens. Click **Resume audio capture** to continue listening.

### Earphone playback

In the bar under the panels, choose which panel is read aloud (1, 2, 3 or Off). Only **new** content from that panel is spoken.

- Panel 1 reads what **they** say, translated.
- Panel 2 reads new requests and questions.
- Panel 3 reads the new suggested replies.

Controls: **Play**, **Pause**, **Replay last**, **Mute**. Audio plays only on the copilot page and is not sent into the meeting.

### Pop-out window

**⧉ Pop out** opens a small window that stays on top of other apps (Chrome/Edge 116+, Document Picture-in-Picture). It shows the three panels as tabs, a 📷 tab for **Read my screen**, and the playback controls. You can drag it anywhere; **✕** hides it, and **Pop out** brings it back. If your browser does not support it, a normal popup opens instead and a notice says it will not stay on top. If nothing opens, allow pop-ups for the site.

### In-person mode (microphone only, phone or computer)

For lunches, office visits and events, without Zoom or Meet:

1. **New session** → **In person**. This is the only option on phones.
2. Pick the languages and the context, press **Start** and allow the microphone.
3. Put the phone between you, screen up, and keep the page open.
4. On a phone, the three panels are tabs: **1 · Transcript**, **2 · They ask**, **3 · Replies**.

One microphone hears both people, so the AI guesses the speaker. Lines show **ME?**, **THEM?** or **VOICE** when it cannot tell. Panels 2 and 3 work the same as in online meetings.

### Follow on another device

**📱 Other device** shows a link and a QR code. Open it on a phone or tablet where you are logged in with the same account. That device shows the three panels live and can read them aloud with play, pause, replay and mute, while the computer does the listening.

### Read my screen

**📷 Read screen**, in the session bar or the pop-out, and **📷 Read my screen** on the Reply assistant page, capture the window you choose: an email, document, slide, image or chart. You get:

- the text that was read
- a translation into your language
- a summary
- draft replies with **Copy** buttons

During a meeting you can also read the shared meeting screen, for example their slides. On phones, the button takes a photo or lets you pick a screenshot instead. Images are sent to OpenAI for reading but are not stored; only the extracted text and the result are saved in History.

---

## 6. Reply assistant (any channel)

Personal LINE and LinkedIn accounts have no API: LINE allows it only for Official Accounts, and LinkedIn only for approved partners. So for personal accounts, paste-and-copy (or **Read my screen**) is the only option, and you always send the message yourself.

1. Choose the **channel**: Email, LINE, WhatsApp, LinkedIn, Messenger, SMS or Other.
2. Optionally choose a **contact** and a **context profile**, and tick **documents**.
3. Paste the conversation or email. Optionally add a note, such as “decline politely” or “ask for the price list”.
4. Click **Draft replies**. To write a **new** one-to-one message, with no conversation to paste, leave the text empty and describe the message in the note, for example "thank Khun Ann for lunch and send the catalogue". You get a summary of what they want and 2–3 drafts in the channel's style, each with a **Copy** button.

When a draft needs a fact the copilot does not have, such as one of your prices, it writes a placeholder like `[confirm price]` and marks the result **Uncertain**. Nothing is ever sent automatically. Drafts are saved in **History** and on the contact's page.

---

## 7. Contacts

**Contacts → New contact:**

- Name, company, tags (journalist, KOL, new customer, existing customer, ongoing client, or your own custom tags).
- Channels and handles (LINE, email, WhatsApp…), preferred language, tone and best time.
- Notes and a follow-up date. You can set a birthday directly when you create the contact.

On a contact's page:

- **Events:** birthday, wedding, illness, promotion or custom, each with a date and a note. Birthdays and weddings repeat every year.
- **History:** meetings and reply drafts linked to this contact.
- Shortcuts to **Start session** or **Draft a reply** with the contact preselected.

## 8. Upcoming & greetings

**Upcoming** lists events and follow-ups in the next 14 days (overdue follow-ups too). Each one comes with a suggested personal message and a **Copy** button: congratulations, get-well wishes, or a check-in. **Regenerate messages** writes new ones.

**Group message helper:** pick a tag, untick anyone to skip, and describe the purpose. You get one personalised message per contact to copy and send yourself.

## 9. Morning summary

1. **Morning summary → Settings:** add brands, products and keywords, one per line. Write `Brand: product` to group a product or keyword under a brand. Optionally add sites to check first, and pick the languages (the first one ticked is the summary language). Click **Save**.
2. Click **Run now**, or just open the copilot: the first time it is opened each day, the summary starts automatically in the background. This does not rely on a schedule, because the free server sleeps.
3. The report is grouped by brand or keyword. Each item has its source link and date, and the report clearly says when nothing was found. Social networks are best-effort only.
4. Past reports are listed by date on the right.

---

## 10. Server setup (for whoever deploys)

1. **Supabase:** open the SQL editor and run `copilot_setup.sql` once. It creates the `copilot_*` tables with RLS on and no public policies.
2. **Environment variables** (Render → Environment). See `.env.example`:
   - `COPILOT_USER_EMAIL`, `COPILOT_USER_PASSWORD`, `COPILOT_SESSION_SECRET` (a long random string)
   - `OPENAI_API_KEY` (optional: the key can also be pasted in **Settings**; without any key the copilot runs in demo mode)
   - `SUPABASE_SERVICE_ROLE_KEY`: required so the server can use the private copilot tables. Keep it secret; it is only used on the server.
   - Optional: `COPILOT_LLM_MODEL` (default `gpt-4.1-mini`), `COPILOT_TRANSCRIBE_MODEL` (default `gpt-4o-mini-transcribe`), `COPILOT_TTS_MODEL` (default `gpt-4o-mini-tts`), `COPILOT_TTS_VOICE`, `COPILOT_TIMEZONE` (default `Asia/Bangkok`), `COPILOT_WEB_SEARCH_TOOL` (default `web_search`).
3. Run `npm install`. This adds `pdf-parse` and `mammoth` for document text extraction.
4. If Supabase is not reachable or the service key is missing, the copilot keeps working but saves to `data/copilot-store.json` on the server. A yellow banner warns about this. On the free Render plan that file is lost on every restart or deploy.
5. **HTTPS is required** for the microphone, screen capture and pop-out (Render provides it).

### Code layout

```
server/copilot/
  index.js            mounts pages, API and the Socket.io namespace /copilot
  config.js           env vars
  routes/             pages.js (/copilot), api.js, crm.js (/api/copilot/*)
  services/           auth, store (Supabase + JSON fallback), openai, documents,
                      live (meeting pipeline), reply, contacts, monitor, prompts
public/copilot/       pages (*.html) and assets/ (css + js per page)
copilot_setup.sql     Supabase tables
```

### Out of scope for this pilot

- **Milestone 2:** voice cloning, so the system can speak on your behalf.
- **Not included, can be quoted separately:**
  - KOL PowerPoint coverage reports. TikTok, Instagram and Facebook block automatic reading of posts.
  - Automatic sending of messages or broadcasts. This needs business accounts and their APIs.
  - Multiple users and workspaces, credits and payments.
  - A desktop app that hides itself from screen sharing.
  - A native mobile app.
  - Direct integration with smart glasses beyond working as a Bluetooth headset.

The data already has a `user_id` column everywhere, ready for multiple users later.
