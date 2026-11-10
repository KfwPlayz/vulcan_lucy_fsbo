// Vulcan7 lead sync (FSBO)
// Scrapes contacts from the FSBO view, sends each one to a webhook, and optionally
// moves them into an EXISTING folder (it never creates folders). Settings that differ
// between accounts or lists come from environment variables set in the workflow file.

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
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const CONTACTS_URL = process.env.CONTACTS_URL ||
  "https://www.vulcan7dialer.com/cm/index#params/dmlld19pZD05ODEzMyZwYWdlPTE=";

const MOVE_CONTACTS = (process.env.MOVE_CONTACTS || "true").toLowerCase() === "true";
const PHONE_CELL_ID = process.env.PHONE_CELL_ID || "143332"; // account specific column ids
const EMAIL_CELL_ID = process.env.EMAIL_CELL_ID || "143333";
const LIST_LABEL = process.env.LIST_LABEL || "FSBO"; // only used in log lines
const MIN_LIST_PRICE = Number(process.env.MIN_LIST_PRICE || 150000); // leads listed below this are not sent
const DEBUG_FIELDS = process.env.DEBUG_FIELDS === "1"; // dump labels + phone markup for the first lead

if (!EMAIL || !PASSWORD || !WEBHOOK_URL) {
  console.error("Missing config. EMAIL, PASSWORD and WEBHOOK_URL must all be set.");
  process.exit(1);
}

// Destination folder. It must already exist in Vulcan7, the script only moves into it.
const folderName = process.env.FOLDER_NAME || "Moved to GHL";

// "$249,900" -> 249900. Returns null when the text has no readable number.
function parsePrice(text) {
  const n = parseFloat(String(text || "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : null;
}

// Every field the webhook expects, so a lead whose detail page fails still has all keys
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

        const nameParts = fullName.split(" ");
        out.push({
          full_name: fullName,
          first_name: nameParts[0] || "",
          last_name: nameParts.slice(1).join(" "),
          phone,
          email,
          contact_id: id
        });
      }

      return out;
    }, { phoneCell: PHONE_CELL_ID, emailCell: EMAIL_CELL_ID });

    console.log(`✅ Found ${leads.length} raw leads in "${LIST_LABEL}"`);

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

        await detailPage.waitForFunction(() => {
          const ths = Array.from(document.querySelectorAll("th"));
          return ths.some((th) => th.textContent.includes("MLS Number"));
        }, { timeout: 15000 });

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

    // ---------- Send to webhook ----------
    // Retries each lead up to 3 times. A 404/410 means the webhook is dead, so stop
    // right away. Any lead that still fails stops the run before the move step, so
    // nothing gets moved out of the list unless it was delivered.
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

    for (const lead of toSend) {
      let ok = false;

      for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
        try {
          const res = await axios.post(
            WEBHOOK_URL,
            { timestamp: new Date().toISOString(), lead },
            { timeout: 30000 }
          );
          console.log(`📤 Sent: ${lead.full_name} (${res.status})`);
          ok = true;
        } catch (err) {
          const status = err.response?.status;
          console.error(`❌ Send failed (${attempt}/3) for ${lead.full_name}: ${err.message}`);

          if (status === 404 || status === 410) {
            throw new Error(`Webhook returned ${status}. Stopping before the move step.`);
          }
          await sleep(1000 * attempt);
        }
      }

      if (!ok) failedLeads.push(lead);
      await sleep(500); // gentle pacing
    }

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
