// Vulcan7 lead sync (FSBO) - direct to GoHighLevel
// Scrapes contacts from the FSBO view and creates/updates each one in GoHighLevel through the
// API (no Zapier), then optionally moves them into an EXISTING Vulcan7 folder (it never
// creates folders). Settings that differ between accounts or lists come from environment
// variables set in the workflow file.

const puppeteer = require("puppeteer");
const axios = require("axios");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// page.goto that survives "net::ERR_ABORTED" (another navigation or redirect cut ours off)
async function gotoWithRetry(pg, url, attempts = 3) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await pg.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
      return;
    } catch (err) {
      if (i === attempts) throw err;
      console.warn(`Navigation failed (${i}/${attempts}): ${err.message}. Retrying...`);
      await sleep(3000 * i);
    }
  }
}

// ---------- Config ----------
const LOGIN_URL = "https://www.vulcan7dialer.com/login";

const EMAIL = process.env.EMAIL;
const PASSWORD = process.env.PASSWORD;
const GHL_TOKEN = process.env.GHL_TOKEN;                 // Private Integration token (GitHub secret)
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;     // sub-account (location) id
const GHL_SOURCE = process.env.GHL_SOURCE || "vulcan";
// Comma separated. Added to the contact, existing tags are kept.
const GHL_TAGS = (process.env.GHL_TAGS || "vulcan lucy fsbo").split(",").map((t) => t.trim()).filter(Boolean);
const CONTACTS_URL = process.env.CONTACTS_URL ||
  "https://www.vulcan7dialer.com/cm/index#params/dmlld19pZD05ODEzMyZwYWdlPTE=";

const MOVE_CONTACTS = (process.env.MOVE_CONTACTS || "true").toLowerCase() === "true";
const PHONE_CELL_ID = process.env.PHONE_CELL_ID || "143332"; // account specific column ids
const EMAIL_CELL_ID = process.env.EMAIL_CELL_ID || "143333";
const LIST_LABEL = process.env.LIST_LABEL || "FSBO"; // only used in log lines
const MIN_LIST_PRICE = Number(process.env.MIN_LIST_PRICE || 150000); // leads listed below this are not sent
const DEBUG_FIELDS = process.env.DEBUG_FIELDS === "1"; // dump labels + phone markup for the first lead

if (!EMAIL || !PASSWORD || !GHL_TOKEN || !GHL_LOCATION_ID) {
  console.error("Missing config. EMAIL, PASSWORD, GHL_TOKEN and GHL_LOCATION_ID must all be set.");
  process.exit(1);
}

// Destination folder. It must already exist in Vulcan7, the script only moves into it.
const folderName = process.env.FOLDER_NAME || "FSBO Moved to GHL";

// "$249,900" -> 249900. Returns null when the text has no readable number.
function parsePrice(text) {
  const n = parseFloat(String(text || "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : null;
}

// Every field the script collects, so a lead whose detail page fails still has all keys
const DEFAULT_DETAIL = {
  street: "", city: "", state: "", zip: "",
  mls_number: "", property_type: "", mls_status: "", status_change_date: "", list_price: "",
  beds: "", baths: "", square_footage: "", days_on_market: "",
  listing_agent: "", listing_office: "",
  zillow_link: "", google_maps_link: "",
  facebook: "", instagram: "", linkedin: "", twitter: "", tiktok: "", youtube: "",

  owner_2_first_name: "", owner_2_last_name: "",

  phone_1: "", phone_1_dnc: "",
  phone_2: "", phone_2_dnc: "",
  phone_3: "", phone_3_dnc: "",
  phone_4: "", phone_4_dnc: "",
  phone_5: "", phone_5_dnc: ""
};

// ---------- GoHighLevel ----------
const GHL_BASE = process.env.GHL_BASE_URL || "https://services.leadconnectorhq.com"; // override only for testing
const GHL_VERSION = "2021-07-28";

// Script field -> GHL custom field name(s). Matching ignores case, spaces and punctuation,
// and also tries the field key. Every field that matches gets the value, and if two fields
// share a name (one per folder, say) both get it. The names below are the ones in Lucy's
// account (Vulcan Info, All Phone Numbers and Contact folders) plus the extra names the Zap
// used (Beds, Sqft, Price, Current Address, Property Address, Twitter, TikTok).
// Add or rename names without editing the script by setting GHL_FIELD_MAP, for example
// {"zillow_link":["Zillow URL"],"twitter":["X Profile"]}
const FIELD_LABELS = {
  street: ["Street Address", "Current Address", "Property Address"],
  mls_number: ["MLS Number"],
  property_type: ["Property Type"],
  mls_status: ["MLS Status"],
  status_change_date: ["Status Change Date"],
  list_price: ["List Price", "Price"],
  beds: ["Bedrooms", "Beds"],
  baths: ["Bathrooms", "Baths"],
  square_footage: ["Square Footage", "Sqft"],
  days_on_market: ["Days on Market"],
  listing_agent: ["Listing Agent"],
  listing_office: ["Listing Office"],
  zillow_link: ["Zillow Link"],
  google_maps_link: ["Google Maps Link"],
  facebook: ["Facebook"],
  instagram: ["Instagram"],
  linkedin: ["LinkedIn"],
  twitter: ["Twitter"],
  tiktok: ["TikTok"],
  youtube: ["YouTube"],
  owner_2_first_name: ["Owner 2 First Name"],
  owner_2_last_name: ["Owner 2 Last Name"],
  date_added: ["Date Added (Vulcan)"],
  // Phone 1 is the contact's main phone (standard Phone field, set separately). Its DNC flag
  // goes to "Phone DNC Status".
  phone_1_dnc: ["Phone DNC Status", "Phone 1 DNC Status"],
  phone_2: ["Phone 2"], phone_2_dnc: ["Phone 2 DNC Status"],
  phone_3: ["Phone 3"], phone_3_dnc: ["Phone 3 DNC Status"],
  phone_4: ["Phone 4"], phone_4_dnc: ["Phone 4 DNC Status"],
  phone_5: ["Phone 5"], phone_5_dnc: ["Phone 5 DNC Status"]
};

// These exist in Lucy's account, so the run stops before scraping if one cannot be found.
// Set GHL_ALLOW_MISSING_FIELDS=1 to continue without them.
const REQUIRED_FIELD_KEYS = [
  "street", "list_price", "beds", "square_footage", "days_on_market", "google_maps_link",
  "owner_2_first_name", "owner_2_last_name",
  "phone_3", "phone_4", "phone_2_dnc", "phone_4_dnc", "phone_5_dnc"
];

const normLabel = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

// "+13057838988" for 10 digit US numbers. Anything else is passed through as typed.
function toPhone(raw) {
  const t = String(raw || "").trim();
  if (!t) return "";
  const digits = t.replace(/\D/g, "");
  if (t.startsWith("+")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return t;
}

async function initGhl() {
  const http = axios.create({
    baseURL: GHL_BASE,
    timeout: 30000,
    headers: {
      Authorization: `Bearer ${GHL_TOKEN}`,
      Version: GHL_VERSION,
      Accept: "application/json",
      "Content-Type": "application/json"
    }
  });

  let res;
  try {
    res = await http.get(`/locations/${GHL_LOCATION_ID}/customFields`, { params: { model: "contact" } });
  } catch (err) {
    const body = err.response?.data ? ` ${JSON.stringify(err.response.data).slice(0, 300)}` : "";
    throw new Error(`Could not read custom fields from GoHighLevel (${err.response?.status || err.message}).${body} The token needs the scopes contacts.write and locations/customFields.readonly, and GHL_LOCATION_ID must belong to the same sub-account as the token.`);
  }

  const fields = res.data?.customFields || [];
  if (!fields.length) {
    throw new Error("GoHighLevel returned no contact custom fields for this location. Wrong GHL_LOCATION_ID, or the token cannot see custom fields.");
  }

  // name or key -> every field that has it
  const index = new Map();
  const addIndex = (k, f) => {
    if (!k) return;
    if (!index.has(k)) index.set(k, []);
    if (!index.get(k).includes(f)) index.get(k).push(f);
  };
  for (const f of fields) {
    addIndex(normLabel(f.name), f);
    if (f.fieldKey) addIndex(normLabel(String(f.fieldKey).replace(/^contact\./, "")), f);
  }

  let labels = FIELD_LABELS;
  if (process.env.GHL_FIELD_MAP) {
    try {
      labels = { ...FIELD_LABELS, ...JSON.parse(process.env.GHL_FIELD_MAP) };
    } catch (e) {
      throw new Error(`GHL_FIELD_MAP is not valid JSON: ${e.message}`);
    }
  }

  const map = {};      // script key -> [GHL field objects]
  const unmatched = [];
  for (const [key, names] of Object.entries(labels)) {
    const hits = [];
    for (const n of [].concat(names)) {
      for (const f of index.get(normLabel(n)) || []) {
        if (!hits.includes(f)) hits.push(f);
      }
    }
    if (hits.length) map[key] = hits; else unmatched.push(key);
  }

  console.log(`ℹ️ GHL: ${fields.length} contact custom fields found. Script fields mapped:`);
  for (const [key, hits] of Object.entries(map)) {
    console.log(`   ${key} -> ${hits.map((f) => `"${f.name}" {${f.fieldKey}} [${f.dataType}]`).join(", ")}`);
  }
  if (unmatched.length) {
    console.warn(`⚠️ No GHL custom field found for: ${unmatched.join(", ")}. These values are NOT sent.`);
  }

  const missingRequired = REQUIRED_FIELD_KEYS.filter((k) => !map[k]);
  if (missingRequired.length && process.env.GHL_ALLOW_MISSING_FIELDS !== "1") {
    throw new Error(`Required GHL custom fields not found for: ${missingRequired.join(", ")}. Fix the field names, set GHL_FIELD_MAP, or set GHL_ALLOW_MISSING_FIELDS=1 to run without them.`);
  }

  return { http, map, verified: false };
}

// Creates or updates one contact, then adds the tags. Safe to retry: the upsert matches on
// phone/email, and adding a tag that is already there changes nothing.
async function sendLeadToGhl(ghl, lead) {
  const clean = (v) => String(v ?? "").trim();

  const customFields = [];
  for (const [key, fields] of Object.entries(ghl.map)) {
    const value = clean(lead[key]);
    if (!value) continue; // never overwrite existing data with a blank

    for (const f of fields) {
      let fieldValue = value;
      if (f.dataType === "MONETORY" || f.dataType === "NUMERICAL") {
        const n = parsePrice(value);
        if (n === null) continue;
        fieldValue = n;
      }
      // Both spellings are accepted by the API (field_value is the older one)
      customFields.push({ id: f.id, fieldValue, field_value: fieldValue });
    }
  }

  const body = {
    locationId: GHL_LOCATION_ID,
    firstName: clean(lead.first_name),
    lastName: clean(lead.last_name),
    name: clean(lead.full_name),
    email: clean(lead.email),
    phone: toPhone(lead.phone),
    address1: clean(lead.street),
    city: clean(lead.city),
    state: clean(lead.state),
    postalCode: clean(lead.zip),
    source: GHL_SOURCE,
    customFields
  };
  for (const k of Object.keys(body)) {
    if (body[k] === "") delete body[k];
  }

  const up = await ghl.http.post("/contacts/upsert", body);
  const contactId = up.data?.contact?.id;
  if (!contactId) {
    throw new Error(`Upsert returned no contact id (HTTP ${up.status}): ${JSON.stringify(up.data).slice(0, 200)}`);
  }

  if (GHL_TAGS.length) {
    await ghl.http.post(`/contacts/${contactId}/tags`, { tags: GHL_TAGS });
  }

  // Check the first lead by reading the contact back, so custom fields that are silently
  // dropped show up in the log on the very first lead instead of after the whole run.
  if (!ghl.verified) {
    ghl.verified = true;
    try {
      const back = await ghl.http.get(`/contacts/${contactId}`);
      const stored = (back.data?.contact?.customFields || []).filter((c) => c.value !== "" && c.value != null);
      console.log(`🔎 Check on first lead (${lead.full_name}): sent ${customFields.length} custom field values, GHL shows ${stored.length} filled.`);
      if (customFields.length && !stored.length) {
        console.warn("⚠️ GHL stored NO custom field values for the first lead. Check the field mapping above and the token scopes.");
      }
    } catch (e) {
      console.log(`ℹ️ Could not read the first contact back (${e.response?.status || e.message}). Open it in GHL to check the custom fields. (Reading needs the contacts.readonly scope.)`);
    }
  }

  return { contactId, isNew: up.data?.new === true };
}

// Runs inside the page. Finds the move-menu entry for the target folder and clicks it.
// The same folder can be listed in more than one menu on the page (Move, Actions), so
// entries that are actually showing win over hidden ones.
const selectFolderInPage = (targetFolderName) => {
  const normalize = (s) => (s || "").replace(/\s+/g, " ").trim();
  const titleOf = (el) => normalize(el.getAttribute("title") || el.textContent || "");
  const target = normalize(targetFolderName);

  let items = Array.from(document.querySelectorAll("li.move-contacts-folder[title]"));
  if (!items.length) {
    items = Array.from(document.querySelectorAll("#cm_move_dropdown li, .dropdown-menu li"));
  }

  const matches = items.filter((el) => titleOf(el) === target);
  if (matches.length === 0) return { status: "missing" };

  // The Move menu was just opened, so its entries are the visible ones
  const visible = matches.filter((el) => el.getClientRects().length > 0);
  const item = (visible.length ? visible : matches)[0];

  const link =
    item.querySelector("a.move-to-folder") ||
    item.querySelector("a") ||
    item;

  link.scrollIntoView({ block: "center" });
  link.click();
  return { status: "clicked", matches: matches.length, visible: visible.length };
};

(async () => {
  const browser = await puppeteer.launch({
    headless: "new",
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/google-chrome",
    timeout: 120000,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-crash-reporter"
    ]
  });

  const page = await browser.newPage();

  // === CI hardening: timeouts, UA, resource blocking, logs ===
  page.setDefaultTimeout(120000);
  page.setDefaultNavigationTimeout(120000);

  await page.setUserAgent(
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36"
  );
  await page.setViewport({ width: 1366, height: 768 });

  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const type = req.resourceType();
    if (type === "image" || type === "font" || type === "media") req.abort();
    else req.continue();
  });

  page.on("console", (msg) => console.log("[BROWSER]", msg.type(), msg.text()));
  page.on("pageerror", (err) => console.log("[PAGEERROR]", err));
  page.on("requestfailed", (req) => console.log("[REQ FAILED]", req.url(), req.failure()?.errorText));
  // === end CI hardening ===

  try {
    // Check the GHL token, location and custom fields BEFORE scraping, so a bad setup
    // fails in seconds instead of after every detail page has been fetched.
    const ghl = await initGhl();

    // ---------- Log in ----------
    await gotoWithRetry(page, LOGIN_URL);
    await page.waitForSelector('input[name="email"], #email, input[name="username"]', { timeout: 120000 });
    await page.waitForSelector('input[name="password"], #password', { timeout: 120000 });

    const emailSel = (await page.$('input[name="email"]'))
      ? 'input[name="email"]'
      : (await page.$("#email"))
        ? "#email"
        : 'input[name="username"]';

    const passSel = (await page.$('input[name="password"]'))
      ? 'input[name="password"]'
      : "#password";

    await page.type(emailSel, EMAIL, { delay: 20 });
    await page.type(passSel, PASSWORD, { delay: 20 });

    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 120000 }),
      page.click('button[type="submit"], .login-button')
    ]);

    // Let the post-login dashboard finish its own redirects before navigating again
    await sleep(3000);

    // ---------- Scrape the contact list ----------
    await gotoWithRetry(page, CONTACTS_URL);
    await page.waitForSelector("tr[data-itemid]", { timeout: 120000 });
    await sleep(1500);

    const leads = await page.evaluate(({ phoneCell, emailCell }) => {
      const rows = document.querySelectorAll("tr[data-itemid]");
      const out = [];

      for (const row of rows) {
        const id = row.getAttribute("data-itemid");
        const nameEl = row.querySelector(".contact-details-link a");
        const fullName = nameEl?.innerText?.trim();
        if (!fullName) continue;

        const phoneDiv = document.querySelector(`div[id='cell-example-${id}-${phoneCell}']`);
        const phone = phoneDiv?.innerText?.trim() || "";

        const emailEl = document.querySelector(`div[id='cell-example-${id}-${emailCell}'] a[href^='mailto:']`);
        const email = emailEl?.getAttribute("href")?.replace("mailto:", "").trim() || "";

        const dateMatch = (row.innerText || "").match(/([A-Z][a-z]{2} \d{1,2}, \d{4} \d{1,2}:\d{2}\s?[ap]m)/i);
        const nameParts = fullName.split(" ");
        out.push({
          full_name: fullName,
          first_name: nameParts[0] || "",
          last_name: nameParts.slice(1).join(" "),
          phone,
          email,
          contact_id: id,
          date_added: dateMatch ? dateMatch[1] : ""
        });
      }

      return out;
    }, { phoneCell: PHONE_CELL_ID, emailCell: EMAIL_CELL_ID });

    console.log(`✅ Found ${leads.length} raw leads in "${LIST_LABEL}"`);
    console.log(`ℹ️ Date Added read for ${leads.filter((l) => l.date_added).length} of ${leads.length} leads${leads[0] ? ` (first: "${leads[0].date_added}")` : ""}.`);

    // ---------- De-duplicate ----------
    const seen = new Set();
    const unsentLeads = [];

    for (const lead of leads) {
      const key = `${lead.full_name}|${lead.phone}`;
      if (lead.full_name.toLowerCase() === "possible owner" || !seen.has(key)) {
        seen.add(key);
        unsentLeads.push(lead);
      }
    }

    // ---------- Pull details for each lead ----------
    let debugPrinted = false;

    for (const lead of unsentLeads) {
      Object.assign(lead, DEFAULT_DETAIL);

      const detailPage = await browser.newPage();

      try {
        const detailUrl = `https://www.vulcan7dialer.com/cm/index#contact/${lead.contact_id}`;
        await gotoWithRetry(detailPage, detailUrl);

        try {
          await detailPage.waitForFunction(() => {
            const ths = Array.from(document.querySelectorAll("th"));
            return ths.some((th) => th.textContent.includes("MLS Number"));
          }, { timeout: 15000 });
        } catch (waitErr) {
          console.warn(`⚠️ No MLS data on the detail page for ${lead.full_name}, reading the phones and address only.`);
          await detailPage.waitForFunction(
            () => document.querySelector('tbody[data-section="phones"] a[data-type="phone"], a[data-type="address"]'),
            { timeout: 10000 }
          );
        }

        // Optional: dump labels + phone markup once so selectors can be confirmed
        if (DEBUG_FIELDS && !debugPrinted) {
          debugPrinted = true;
          const dump = await detailPage.evaluate(() => ({
            labels: Array.from(document.querySelectorAll("tr th")).map((th) =>
              (th.textContent || "").replace(/\s+/g, " ").trim()
            ),
            phonesHtml: document.querySelector('tbody[data-section="phones"]')?.outerHTML || "(no phones section)"
          }));
          console.log("🐞 Detail labels:", JSON.stringify(dump.labels));
          console.log("🐞 Phones HTML:", dump.phonesHtml);
        }

        const detailData = await detailPage.evaluate(() => {
          const clean = (t) => (t || "").replace(/\s+/g, " ").trim();

          const getTextAfterTh = (label) => {
            const ths = Array.from(document.querySelectorAll("tr th"));
            for (const th of ths) {
              const thText = clean(th.textContent || "").toLowerCase();
              if (thText.includes(label.toLowerCase().replace(":", ""))) {
                const td = th.nextElementSibling;
                return td ? clean(td.textContent) : "";
              }
            }
            return "";
          };

          const getBedsAndBaths = () => {
            const val = getTextAfterTh("Beds");
            const [bedsRaw, bathsRaw] = val.split("/").map((v) => clean(v));
            return { beds: bedsRaw || "", baths: bathsRaw || "" };
          };

          // Owner 2 = the second name listed under "Name" (the one that is not #primary_name)
          const getOwner2 = () => {
            const el = document.querySelector(
              'tbody[data-section="names"] a[data-type="fullname"]:not(#primary_name)'
            );
            if (!el) return { first: "", last: "" };

            let parsed = {};
            try {
              parsed = JSON.parse(el.getAttribute("data-value") || "{}");
            } catch {}

            let first = clean(parsed.first_name);
            let last = clean(parsed.last_name);

            // Fallback: split the visible text like the main name
            if (!first && !last) {
              const parts = clean(el.textContent).split(" ");
              first = parts[0] || "";
              last = parts.slice(1).join(" ");
            }

            return { first, last };
          };

          // DNC check for one phone link: "DNC" if flagged, "" if not
          const getDncStatus = (el, parsed) => {
            // National DNC: Vulcan7 adds the "national_dnc" class to the number link
            if (el.classList.contains("national_dnc")) return "DNC";

            // National DNC: "DNC" label next to the number in the same cell
            const cell = el.closest("td");
            const labels = cell ? Array.from(cell.querySelectorAll("span.label")) : [];
            if (labels.some((s) => clean(s.textContent).toUpperCase() === "DNC")) return "DNC";

            // Internal DNC / blacklist flag in the number's data
            if (parsed.do_not_call === true || parsed.do_not_call === "1" || parsed.do_not_call === 1) return "DNC";

            return "";
          };

          const getPhones = () => {
            const phoneLinks = Array.from(
              document.querySelectorAll('tbody[data-section="phones"] a[data-type="phone"]')
            ).slice(0, 5);

            const phones = [];
            const dnc = [];

            for (let i = 0; i < 5; i++) {
              const el = phoneLinks[i];

              if (!el) {
                phones.push("");
                dnc.push("");
                continue;
              }

              let parsed = {};
              try {
                parsed = JSON.parse(el.getAttribute("data-value") || "{}");
              } catch {}

              const rawText = (el.textContent || "").trim();
              const cleanNumber = rawText
                .replace(/\((Home|Work|Mobile|Fax|Other)\)/gi, "")
                .trim();

              phones.push(parsed.phone || parsed.raw_phone || cleanNumber);
              dnc.push(getDncStatus(el, parsed));
            }

            return { phones, dnc };
          };

          // Address object
          let address = { street: "", city: "", state: "", zip: "" };
          const addrEl = document.querySelector('a[data-type="address"]');
          if (addrEl) {
            try {
              const data = JSON.parse(addrEl.getAttribute("data-value") || "{}");
              address = {
                street: data.address || "",
                city: data.city || "",
                state: data.state || "",
                zip: data.zip || ""
              };
            } catch {}
          }

          // Link grabber
          const links = Array.from(document.querySelectorAll("a[href]")).map((a) => a.getAttribute("href"));

          const matchLink = (pattern) => {
            const regex = new RegExp(pattern, "i");
            return links.find((href) => regex.test(href)) || "";
          };

          const zillowRelative = links.find((h) => h.includes("/zillow/go_to_site")) || "";
          const zillowLink = zillowRelative ? `https://www.vulcan7dialer.com${zillowRelative}` : "";

          const { beds, baths } = getBedsAndBaths();
          const { phones, dnc } = getPhones();
          const owner2 = getOwner2();

          return {
            street: address.street,
            city: address.city,
            state: address.state,
            zip: address.zip,
            mls_number: getTextAfterTh("MLS Number"),
            property_type: getTextAfterTh("Property Type"),
            mls_status: getTextAfterTh("MLS Status"),
            status_change_date: getTextAfterTh("Status Change Date"),
            list_price: getTextAfterTh("List Price"),
            beds,
            baths,
            square_footage: getTextAfterTh("Square Footage"),
            days_on_market: getTextAfterTh("Days On Market"),
            listing_agent: getTextAfterTh("Listing Agent"),
            listing_office: getTextAfterTh("Listing Office"),
            zillow_link: zillowLink,
            google_maps_link: matchLink("google\\.(com|ca)/maps|maps\\.google"),
            facebook: matchLink("facebook\\.com"),
            instagram: matchLink("instagram\\.com"),
            linkedin: matchLink("linkedin\\.com"),
            twitter: matchLink("twitter\\.com"),
            tiktok: matchLink("tiktok\\.com"),
            youtube: matchLink("youtube\\.com"),

            owner_2_first_name: owner2.first,
            owner_2_last_name: owner2.last,

            phone_1: phones[0],
            phone_1_dnc: dnc[0],
            phone_2: phones[1],
            phone_2_dnc: dnc[1],
            phone_3: phones[2],
            phone_3_dnc: dnc[2],
            phone_4: phones[3],
            phone_4_dnc: dnc[3],
            phone_5: phones[4],
            phone_5_dnc: dnc[4]
          };
        });

        Object.assign(lead, detailData);

        // Make "phone" match phone_1 from the detail page
        lead.phone = detailData.phone_1 || lead.phone;
      } catch (err) {
        console.error(`⚠️ Detail fetch failed for ${lead.full_name}: ${err.message}`);
        try {
          await detailPage.screenshot({ path: `failure_${lead.contact_id}.png`, fullPage: true });
        } catch {}
      } finally {
        await detailPage.close();
        await sleep(300);
      }
    }

    // ---------- Send to GoHighLevel ----------
    // Retries each lead up to 3 times. A 401/403 means the token or location is wrong, so
    // stop right away. A 400/422 (bad data) is not retried. Any lead that still fails stops
    // the run before the move step, so nothing gets moved out of the list unless it was
    // delivered.
    const failedLeads = [];

    // Price filter. List price only exists on the detail page, so this runs after the
    // detail fetch. A lead with no readable price is still sent, so a failed detail
    // page never silently drops a lead.
    const toSend = [];
    const belowMin = [];

    for (const lead of unsentLeads) {
      const price = parsePrice(lead.list_price);

      if (price !== null && price < MIN_LIST_PRICE) {
        belowMin.push(lead);
      } else {
        if (price === null) console.log(`ℹ️ No readable list price for ${lead.full_name}, sending anyway.`);
        toSend.push(lead);
      }
    }

    console.log(`ℹ️ ${toSend.length} lead(s) at or above $${MIN_LIST_PRICE.toLocaleString("en-US")}, ${belowMin.length} below and not sent.`);
    for (const lead of belowMin) {
      console.log(`⏭️ Skipped (list price ${lead.list_price}): ${lead.full_name}`);
    }

    let created = 0, updated = 0;

    for (const lead of toSend) {
      let ok = false;

      for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
        try {
          const r = await sendLeadToGhl(ghl, lead);
          if (r.isNew) created++; else updated++;
          console.log(`📤 Sent: ${lead.full_name} (${r.isNew ? "created" : "updated"}, ${r.contactId})`);
          ok = true;
        } catch (err) {
          const status = err.response?.status;
          const body = err.response?.data ? ` ${JSON.stringify(err.response.data).slice(0, 300)}` : "";
          console.error(`❌ Send failed (${attempt}/3) for ${lead.full_name}: ${err.message}${body}`);

          if (status === 401 || status === 403) {
            throw new Error(`GoHighLevel returned ${status}. Check GHL_TOKEN scopes and GHL_LOCATION_ID. Stopping before the move step.`);
          }
          // Other 4xx means the data was rejected, retrying the same data will not help
          if (status && status >= 400 && status < 500 && status !== 429) break;
          await sleep(1000 * attempt);
        }
      }

      if (!ok) failedLeads.push(lead);
      await sleep(500); // gentle pacing
    }

    console.log(`ℹ️ GHL: ${created} created, ${updated} updated, ${failedLeads.length} failed.`);

    if (failedLeads.length > 0) {
      throw new Error(`${failedLeads.length} lead(s) failed to send. Skipping the move step.`);
    }

    if (!MOVE_CONTACTS) {
      console.log("ℹ️ MOVE_CONTACTS is off, leaving contacts where they are.");
      return;
    }

    // ---------- Move contacts ----------
    await gotoWithRetry(page, CONTACTS_URL);
    await page.waitForSelector("tr[data-itemid]", { timeout: 120000 });
    await page.waitForSelector("#master_checkbox", { timeout: 120000 }); // no visible:true, it can read as hidden with images/fonts blocked
    await sleep(5000); // let all rows render and the select-all handler bind

    const readChecked = () =>
      page.$eval("#master_checkbox", (el) => !!el.checked).catch(() => false);

    // Try three ways to tick it: real click, DOM click, label click
    const attempts = [
      async () => { await page.click("#master_checkbox"); },
      async () => {
        await page.evaluate(() => {
          const cb = document.querySelector("#master_checkbox");
          cb.scrollIntoView({ block: "center" });
          cb.click();
        });
      },
      async () => {
        await page.evaluate(() => {
          const cb = document.querySelector("#master_checkbox");
          const label = cb.closest("label") || document.querySelector(`label[for="${cb.id}"]`);
          (label || cb.parentElement).click();
        });
      }
    ];

    let isChecked = await readChecked();
    for (const attempt of attempts) {
      if (isChecked) break;
      try { await attempt(); } catch (e) { console.warn("Checkbox attempt failed:", e.message); }
      await sleep(1000);
      isChecked = await readChecked();
    }

    if (!isChecked) {
      // Diagnostics so the next failure explains itself
      const info = await page.evaluate(() => {
        const cb = document.querySelector("#master_checkbox");
        const r = cb?.getBoundingClientRect();
        return {
          rect: r ? { w: r.width, h: r.height, x: r.x, y: r.y } : null,
          parentHtml: cb?.parentElement?.outerHTML?.slice(0, 500) || null
        };
      });
      console.log("Master checkbox diagnostics:", JSON.stringify(info));
      throw new Error("Master checkbox was not checked.");
    }

    console.log("✅ Selected all contacts via master checkbox.");

    // Open move menu
    await page.waitForSelector("#cm_move_button", { visible: true, timeout: 120000 });
    await page.click("#cm_move_button");
    await sleep(1500);

    // Wait for dropdown items
    await page.waitForFunction(() => {
      return document.querySelectorAll("li.move-contacts-folder[title]").length > 0 ||
             document.querySelectorAll("#cm_move_dropdown li, .dropdown-menu li").length > 0;
    }, { timeout: 10000 });

    // Click exact folder entry
    const picked = await page.evaluate(selectFolderInPage, folderName);

    if (picked.status === "missing") {
      const available = await page.evaluate(() =>
        Array.from(document.querySelectorAll("li.move-contacts-folder[title]")).map((li) => li.getAttribute("title"))
      );
      console.log("Folders offered in the move menu:", JSON.stringify(available));
      throw new Error(`Could not find move folder "${folderName}". Create it in Vulcan7 first, then re-run.`);
    }

    console.log(
      `✅ Clicked folder "${folderName}" in move menu ` +
      `(${picked.matches} matching entr${picked.matches === 1 ? "y" : "ies"}, ${picked.visible} visible).`
    );
    if (picked.visible > 1) {
      console.warn("⚠️ More than one visible entry has this name and the first was clicked. If contacts land in the wrong folder, give the folders unique names.");
    }
    await sleep(1500);

    // Confirm modal if it appears
    try {
      await page.waitForSelector("#bulk_actions_modal", { visible: true, timeout: 5000 });

      const confirmed = await page.evaluate(() => {
        const modal = document.querySelector("#bulk_actions_modal");
        if (!modal) return false;

        const buttons = Array.from(modal.querySelectorAll("button"));
        const btn = buttons.find((b) =>
          /okay|ok|move|confirm/i.test((b.textContent || "").trim())
        );

        if (btn) {
          btn.click();
          return true;
        }

        const primary = modal.querySelector("button.btn.btn-primary");
        if (primary) {
          primary.click();
          return true;
        }

        return false;
      });

      if (confirmed) {
        console.log("🟢 Confirmed move modal.");
        await sleep(3000);
      } else {
        console.warn("⚠️ Move modal appeared, but confirm button was not found.");
      }
    } catch {
      console.log("ℹ️ No confirmation modal appeared.");
    }

    // Give Vulcan7 time to process
    await sleep(4000);
    console.log(`✅ Move attempt finished for folder "${folderName}"`);
  } catch (err) {
    console.error("❌ Script Error:", err);
    try {
      await page.screenshot({ path: "failure.png", fullPage: true });
    } catch {}
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
