// Vulcan7 FSBO lead sync (no move step)
// Scrapes the FSBO view, skips leads already in the cache file, pulls each lead's
// detail page, and sends it to the webhook.

const puppeteer = require("puppeteer");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LOGIN_URL = "https://www.vulcan7dialer.com/login";
const CONTACTS_URL = "https://www.vulcan7dialer.com/cm/index#params/dmlld19pZD05ODEzMyZwYWdlPTE=";
const EMAIL = process.env.EMAIL;
const PASSWORD = process.env.PASSWORD;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const CACHE_FILE = path.join(__dirname, "sent-leads-cache-fsbo.json");

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

  // CI hardening: timeouts, UA, resource blocking, logs
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

  try {
    // ---------- Log in ----------
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForSelector('input[name="email"], #email, input[name="username"]', { timeout: 120000 });
    await page.waitForSelector('input[name="password"], #password', { timeout: 120000 });

    const emailSel = (await page.$('input[name="email"]'))
      ? 'input[name="email"]'
      : (await page.$("#email"))
        ? "#email"
        : 'input[name="username"]';
    const passSel = (await page.$('input[name="password"]')) ? 'input[name="password"]' : "#password";

    await page.type(emailSel, EMAIL, { delay: 20 });
    await page.type(passSel, PASSWORD, { delay: 20 });

    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 120000 }),
      page.click('button[type="submit"], .login-button')
    ]);

    // ---------- Scrape the FSBO list ----------
    await page.goto(CONTACTS_URL, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForSelector("tr[data-itemid]", { timeout: 120000 });
    await sleep(1500);

    const leads = await page.evaluate(() => {
      const out = [];

      for (const row of document.querySelectorAll("tr[data-itemid]")) {
        const id = row.getAttribute("data-itemid");
        const fullName = row.querySelector(".contact-details-link a")?.innerText?.trim();
        if (!fullName) continue;

        const phone = document.querySelector(`div[id='cell-example-${id}-143332']`)?.innerText?.trim() || "";
        const email = document
          .querySelector(`div[id='cell-example-${id}-143333'] a[href^='mailto:']`)
          ?.getAttribute("href")
          ?.replace("mailto:", "")
          .trim() || "";

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
    });

    console.log(`✅ Found ${leads.length} raw leads in "FSBO"`);

    // ---------- De-duplicate and skip anything already sent ----------
    let sentCache = new Set();
    if (fs.existsSync(CACHE_FILE)) {
      try {
        sentCache = new Set(JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8")));
      } catch {
        // ignore a bad cache file
      }
    }

    // Each entry keeps the cache key from the list view, because lead.phone is
    // overwritten with the detail-page phone later
    const queue = [];
    const seen = new Set();

    for (const lead of leads) {
      const key = `${lead.full_name}|${lead.phone}`;
      const isPossibleOwner = lead.full_name.toLowerCase() === "possible owner";

      if (!isPossibleOwner && seen.has(key)) continue; // duplicate within this run
      seen.add(key);

      if (sentCache.has(key)) continue; // already sent on an earlier run
      queue.push({ lead, key });
    }

    console.log(`ℹ️ ${queue.length} new lead(s) to send (${leads.length - queue.length} skipped).`);

    // ---------- Pull details for each lead ----------
    for (const { lead } of queue) {
      Object.assign(lead, DEFAULT_DETAIL);

      const detailPage = await browser.newPage();

      try {
        const detailUrl = `https://www.vulcan7dialer.com/cm/index#contact/${lead.contact_id}`;
        await detailPage.goto(detailUrl, { waitUntil: "domcontentloaded", timeout: 120000 });

        await detailPage.waitForFunction(() => {
          const ths = Array.from(document.querySelectorAll("th"));
          return ths.some((th) => th.textContent.includes("MLS Number"));
        }, { timeout: 15000 });

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

              const cleanNumber = (el.textContent || "")
                .trim()
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
    // Only leads that were actually delivered go into the cache, so anything that
    // fails is retried on the next run. A 404/410 means the webhook is dead, so stop.
    const sentKeys = [];
    let failedCount = 0;

    try {
      for (const { lead, key } of queue) {
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
              throw new Error(`Webhook returned ${status}. Stopping.`);
            }
            await sleep(1000 * attempt);
          }
        }

        if (ok) sentKeys.push(key);
        else failedCount++;

        await sleep(500); // gentle pacing
      }
    } finally {
      // Save progress even if the loop aborted part way through
      fs.writeFileSync(CACHE_FILE, JSON.stringify([...sentCache, ...sentKeys], null, 2));
      console.log(`💾 Cache updated with ${sentKeys.length} new lead(s).`);
    }

    if (failedCount > 0) {
      throw new Error(`${failedCount} lead(s) failed to send and will be retried next run.`);
    }
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
