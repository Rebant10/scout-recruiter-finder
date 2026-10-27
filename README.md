# Scout — find recruiters at any company

Scout is a personal Chrome extension (that also runs as a small local web app). It works like Apollo's "type a company, see its people" search: enter a company name or website and get its **recruiters and their work emails**, with each email's verification status and where it came from.

Scout does not have its own database and does not guess addresses. It looks people up in **Hunter.io** and/or **Apollo.io** using **your own API key**, and shows exactly what those services return.

## What you get

- Company search with autocomplete. Type `Razorpay` or `stripe.com`.
- Three filters: **Recruiters** (default), **HR & People**, or **Everyone**. If a company has nobody with a recruiter title, Scout shows its HR team instead and tells you.
- A **location** picker, set to **India** by default, so global companies like Stripe or Google show only the people based there. Pick another country or **Anywhere** at any time; Scout remembers your choice. If a company has no one in that country, Scout says so and offers to search all locations.
- For every person: name, title, work email, a **Verified / Catch-all / Unverified** badge, the provider's confidence score, LinkedIn when available, and (for Hunter) the public pages the email was found on.
- Apollo results work like Apollo itself: searching is free, and you click **Get email** to reveal an address for 1 Apollo credit. Revealed emails are cached, so you never pay twice for the same person.
- **Your sheet**: everyone Scout finds with an email is added automatically (you can turn this off in Settings), with Company, Name, Title, Email, Email status, Location, LinkedIn, Domain, Source, and the date added. It lives in your browser, and you can **copy it as a table** to paste into any spreadsheet or **download it as a CSV** for Excel or Google Sheets.
- **Google Sheets sync** (optional): new rows are also appended to a Google Sheet you own. See [Send your sheet to Google Sheets](#send-your-sheet-to-google-sheets).
- Credit-aware: Scout shows your remaining Hunter credits and tells you what each action costs before you click.

## Data sources and what they cost

| Source | Free plan | Cost in Scout |
| --- | --- | --- |
| [Hunter.io](https://hunter.io/api-keys) | 50 credits a month | 1 credit per company search, charged only when people are found. Up to 10 people per company on the free plan. Repeat searches in the same month are free. |
| [Apollo.io](https://docs.apollo.io/docs/create-api-key) | Varies by plan | Searching is free. Revealing an email costs 1 Apollo credit. Free Apollo accounts must be registered with a **work email** to use API search. |

You only need one of them. Hunter is the easiest place to start: sign up, copy the key from the API page, and paste it into Scout's **Settings**.

For Apollo, create a key under **Settings → Integrations → API Keys → Create new key** and either turn on **Set as master key** or give it access to **People API Search** and **People Enrichment**.

## Install the Chrome extension

1. Download this repository to your computer.
2. Open `chrome://extensions` (or `edge://extensions`).
3. Turn on **Developer mode** (top-right).
4. Click **Load unpacked** and choose this folder (the one that contains `manifest.json`).
5. Scout opens its Settings page. Paste your Hunter and/or Apollo key and click **Save**.
6. Pin Scout from the puzzle-piece menu, click it, and search for a company. Use the arrow button in the popup to open Scout in a full tab.

No build step and no `npm install` are needed for the extension. If you update the files later, click the reload icon on Scout's card in `chrome://extensions`.

## Send your sheet to Google Sheets

Scout writes to Google Sheets through a small Apps Script that you paste into your own sheet. There's no Google Cloud project or sign-in screen to set up, and the script only adds rows to that one sheet.

1. Create a new Google Sheet (<https://sheets.new>).
2. In it, open **Extensions → Apps Script**, delete the sample code, and paste the script from Scout (**Settings → Google Sheets → Copy script**). The script contains a secret code unique to your Scout, so nobody else can write to your sheet.
3. Click **Deploy → New deployment**, choose **Web app**, set **Execute as: Me** and **Who has access: Anyone**, and click **Deploy**. Google asks you to allow access; since you made the script yourself, it may say the app isn't verified. Choose **Advanced → Go to (project name)**.
4. Copy the **Web app URL** (it ends in `/exec`), paste it into Scout, and click **Connect**.

Scout then sends every row in your sheet, and every new row from then on, to a tab called **Scout**. Rows are de-duplicated by email. The script finds its columns by their header names, so you can add your own columns (like "Applied?") or reorder them. Deleting a row in Scout doesn't delete it from Google Sheets.

If you change the script later, publish the change with **Deploy → Manage deployments → Edit → Version: New version**. If you set the script up before Scout added the Location column, copy it again from Scout and publish a new version to get that column.

## Run it as a local web app (optional)

Requires Node.js 20 or newer. There are no dependencies to install.

```bash
npm start
```

Open <http://127.0.0.1:43145>. The web version is the same app. It talks to Hunter, Apollo, and your Google Sheets script through `server.mjs`, a tiny local proxy that only forwards the few endpoints Scout needs (and only to Apps Script web app URLs for Sheets).

You can give the server your keys instead of pasting them into the page:

```bash
HUNTER_API_KEY=your-hunter-key APOLLO_API_KEY=your-apollo-key npm start
```

Other settings: `PORT` (default `43145`), `HOST` (default `127.0.0.1`), and `ALLOWED_HOSTS` (comma-separated extra host names, if you open the app through a forwarded port).

## Tests

```bash
npm test
```

These tests cover the Hunter and Apollo response parsing (using Hunter's real API response shape), recruiter filtering and fallbacks, merging results from both sources, paging, the sheet (de-duplication, sync tracking, CSV and table export), the Google Sheets Apps Script (run against an in-memory spreadsheet), and the proxy's allowlist and host checks.

## Privacy

- API keys, your sheet, recent searches, and revealed Apollo emails are stored only in your browser (extension storage, or `localStorage` for the web version).
- Searches go from your browser (or your local Scout server) directly to Hunter or Apollo. Company-name suggestions come from Clearbit's public autocomplete, and company logos from Hunter's logo service.
- If you connect Google Sheets, rows go to your own Apps Script and nowhere else.
- Use the contacts you find responsibly. Follow anti-spam rules and the providers' terms, and honor opt-out requests.

## Project layout

```
manifest.json            Chrome extension (Manifest V3)
background/              Opens Settings on first install
app/                     The UI: popup.html (extension popup), index.html (full tab, options page, web app)
src/providers/           Hunter, Apollo, and company-autocomplete API clients
src/search.js            Runs a search across providers: filters, location, fallbacks, merging, paging
src/locations.js         Countries you can limit a search to (India by default)
src/sheet.js             Your sheet: rows, de-duplication, sync tracking, CSV / table export
src/gsheets.js           Google Sheets: the Apps Script template and the client that sends rows
src/store.js             Local storage for keys, settings, your sheet, and cached reveals
server.mjs               Optional local server and API proxy for the web version
test/                    node:test suites
```
