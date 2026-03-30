/**
 * bake.js — SAPZCODES Static Site Generator
 * ─────────────────────────────────────────────────────────────
 * Run by GitHub Actions every 6 hours (or manually).
 * 
 * What it does:
 *   1. Hits Google Sheets API to discover ALL sheet names dynamically
 *   2. Fetches every sheet's data
 *   3. Writes content.json (full site data snapshot)
 *   4. Generates one static HTML page per sheet (in /pages/)
 *   5. Regenerates index.html with current nav
 *
 * Usage:
 *   SHEET_ID=your_sheet_id node bake.js
 *
 * Requirements:
 *   node >= 18 (built-in fetch)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ────────────────────────────────────────────────────
const SHEET_ID = "1DSXBNUEa4CXs-DkkBvmfJwsADmUC2F2s5-FZsPKf7pQ";


// Base path for GitHub Pages — set to "" for custom domain, "/reponame" for github.io/reponame
const BASE = process.env.BASE_PATH || "/zcodes";

const OUT_DIR   = path.join(__dirname);
const PAGES_DIR = path.join(__dirname, "pages");

// ── Helpers ───────────────────────────────────────────────────
function toSlug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function esc(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function nl2br(str = "") {
  return esc(str).replace(/\\n/g, "<br>");
}

async function fetchJSON(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
  return res.json();
}

// ── Google Sheets helpers ─────────────────────────────────────

/** Get list of all visible sheet names via the Sheets API metadata */
async function getSheetNames() {
  // Public spreadsheet metadata endpoint (no API key needed for public sheets)
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not fetch spreadsheet metadata: ${res.status}`);
  const text = await res.text();
  // Google wraps it in: google.visualization.Query.setResponse({...})
  const json = JSON.parse(text.replace(/^[^(]+\(/, "").replace(/\);?\s*$/, ""));
  // This endpoint doesn't give sheet list directly — use a different trick
  throw new Error("USE_FALLBACK");
}

/** Fetch all sheet names by reading the HTML export (reliable, no API key) */
async function getSheetNamesFromHTML() {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; SAPZCODES-Baker/1.0)"
    }
  });
  if (!res.ok) throw new Error(`Could not access spreadsheet: ${res.status}`);
  const html = await res.text();
  // Extract sheet names from the page (they appear in data-name attributes)
  const matches = [...html.matchAll(/data-name="([^"]+)"/g)];
  const names = [...new Set(matches.map(m => decodeURIComponent(m[1])))];
  if (!names.length) throw new Error("No sheet names found in HTML");
  return names;
}

/** 
 * Most reliable: use opensheet or CSV export per sheet.
 * We discover sheet names from _CONFIG nav_order first, 
 * then also check for any extra sheets via the sheets feed.
 */
async function getAllSheetNames() {
  // Primary: Google Sheets GID feed (works for published sheets)
  try {
    const url = `https://spreadsheets.google.com/feeds/worksheets/${SHEET_ID}/public/basic?alt=json`;
    const data = await fetchJSON(url);
    const entries = data.feed?.entry || [];
    const names = entries.map(e => e.title?.$t).filter(Boolean);
    if (names.length) {
      console.log(`  ✓ Discovered ${names.length} sheets via Sheets feed`);
      return names;
    }
  } catch (e) {
    console.log(`  ↷ Sheets feed unavailable (${e.message}), falling back...`);
  }

  // Fallback: read _CONFIG sheet and use nav_order
  try {
    const configRows = await fetchSheet("_CONFIG");
    const configMap = rowsToMap(configRows);
    const navOrder = (configMap["nav_order"] || "").split(",").map(s => s.trim()).filter(Boolean);
    if (navOrder.length) {
      console.log(`  ✓ Discovered ${navOrder.length} pages via nav_order in _CONFIG`);
      // Always include _CONFIG even if not in nav
      return ["_CONFIG", ...navOrder.filter(n => n !== "_CONFIG")];
    }
  } catch (e) {
    console.log(`  ↷ _CONFIG fallback failed: ${e.message}`);
  }

  throw new Error("Could not discover sheet names. Is the spreadsheet published publicly?");
}

/** Fetch a single sheet as array of row objects via opensheet */
async function fetchSheet(sheetName) {
  const encoded = encodeURIComponent(sheetName);
  const url = `https://opensheet.elk.sh/${SHEET_ID}/${encoded}`;
  const data = await fetchJSON(url);
  return Array.isArray(data) ? data : [];
}

/** Convert key-value sheet rows to plain object */
function rowsToMap(rows) {
  const map = {};
  rows.forEach(row => {
    const key = (row["CONFIG KEY"] || row["CONTENT KEY"] || "").trim();
    const val = (row["VALUE — Edit this column"] || row["VALUE"] || "").trim();
    if (key) map[key] = val;
  });
  return map;
}

// ── Main ──────────────────────────────────────────────────────
async function bake() {
  console.log("\n🔥 SAPZCODES Baker starting...\n");

  // Ensure output dirs exist
  fs.mkdirSync(OUT_DIR,   { recursive: true });
  fs.mkdirSync(PAGES_DIR, { recursive: true });

  // ── Step 1: Discover all sheet names ──
  console.log("📋 Discovering sheets...");
  const allSheetNames = await getAllSheetNames();
  console.log(`   Sheets found: ${allSheetNames.join(", ")}\n`);

  // ── Step 2: Fetch all sheets in parallel ──
  console.log("📥 Fetching all sheet data in parallel...");
  const sheetResults = await Promise.allSettled(
    allSheetNames.map(async name => {
      const rows = await fetchSheet(name);
      console.log(`   ✓ ${name} (${rows.length} rows)`);
      return { name, rows };
    })
  );

  const sheets = {};
  sheetResults.forEach(result => {
    if (result.status === "fulfilled") {
      sheets[result.value.name] = result.value.rows;
    } else {
      console.warn(`   ✗ Failed: ${result.reason?.message}`);
    }
  });

  // ── Step 3: Parse CONFIG ──
  const configMap = rowsToMap(sheets["_CONFIG"] || []);
  const navOrder = (configMap["nav_order"] || "")
    .split(",").map(s => s.trim()).filter(Boolean);

  console.log(`\n⚙️  Nav order: ${navOrder.join(" → ")}\n`);

  // ── Step 4: Build content.json snapshot ──
  const contentJson = {
    generated_at: new Date().toISOString(),
    config: configMap,
    nav_order: navOrder,
    pages: {}
  };

  navOrder.forEach(name => {
    if (sheets[name]) {
      contentJson.pages[name] = rowsToMap(sheets[name]);
      // For Career / Clients — also store raw rows for tables
      contentJson.pages[name].__rows = sheets[name];
    }
  });

  fs.writeFileSync(
    path.join(OUT_DIR, "content.json"),
    JSON.stringify(contentJson, null, 2)
  );
  console.log("✅  content.json written\n");

  // ── Step 5: Copy static assets ──
  const assets = ["styles.css", "logoforwhite.png", "favicon.png"];
  assets.forEach(file => {
    const src = path.join(__dirname, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(OUT_DIR, file));
    }
  });

  // ── Step 6: Generate one HTML page per nav item ──
  console.log("🏗️  Generating pages...");
  for (const sheetName of navOrder) {
    const data = contentJson.pages[sheetName] || {};
    const slug = toSlug(sheetName);
    const html = buildPageHTML(sheetName, slug, data, sheets[sheetName] || [], configMap, navOrder);
    const outPath = path.join(PAGES_DIR, `${slug}.html`);
    fs.writeFileSync(outPath, html);
    console.log(`   ✓ pages/${slug}.html`);
  }

  // ── Step 7: Generate index.html (redirects to first page) ──
  const firstSlug = navOrder.length ? toSlug(navOrder[0]) : "home";
  const indexHtml = buildShell(configMap, navOrder, firstSlug);
  fs.writeFileSync(path.join(OUT_DIR, "index.html"), indexHtml);
  console.log(`\n✅  index.html written`);

  // ── Step 8: Generate 404.html ──
  const notFoundHtml = build404(configMap, navOrder);
  fs.writeFileSync(path.join(OUT_DIR, "404.html"), notFoundHtml);
  console.log(`✅  404.html written`);

  console.log(`\n🎉 Bake complete! ${navOrder.length} pages generated.\n`);
  console.log(`   Output: ${OUT_DIR}\n`);
}

// ══════════════════════════════════════════════════════════════
// HTML BUILDERS
// ══════════════════════════════════════════════════════════════

function navHTML(navOrder, configMap, activeSlug = "") {
  const wa = esc(configMap["whatsapp_number"] || "");
  const links = navOrder.map(name => {
    const slug = toSlug(name);
    const active = slug === activeSlug ? ' class="active"' : "";
    return `<li><a href="${BASE}/pages/${slug}.html"${active}>${esc(name)}</a></li>`;
  }).join("\n        ");

  return `
  <header id="site-header">
    <nav class="navbar">
      <a href="${BASE}/index.html" class="nav-logo">
        <img src="${BASE}/logoforwhite.png" alt="${esc(configMap["site_name"] || "SAPZCODES")}" />
      </a>
      <button class="hamburger" id="hamburger" aria-label="Menu" onclick="this.classList.toggle('active');document.getElementById('nav-links').classList.toggle('open')">
        <span></span><span></span><span></span>
      </button>
      <ul class="nav-links" id="nav-links">
        ${links}
      </ul>
      <a class="nav-cta" href="https://wa.me/${wa}" target="_blank">📲 WhatsApp</a>
    </nav>
  </header>`;
}

function footerHTML(configMap, navOrder) {
  const ig    = esc(configMap["contact_instagram"] || "");
  const wa    = esc(configMap["whatsapp_number"] || "");
  const email = esc(configMap["contact_email"] || "");
  const phone = esc(configMap["contact_phone"] || "");
  const addr  = esc(configMap["contact_address"] || "");
  const copy  = esc(configMap["footer_text"] || `© ${new Date().getFullYear()} SAPZCODES · All Rights Reserved`);
  const tag   = esc(configMap["site_tagline"] || "");

  const footerLinks = navOrder.map(name =>
    `<a href="${BASE}/pages/${toSlug(name)}.html">${esc(name)}</a>`
  ).join("\n        ");

  return `
  <footer id="site-footer">
    <div class="footer-inner">
      <div class="footer-brand">
        <img src="/logoforwhite.png" alt="SAPZCODES" class="footer-logo" />
        <p>${tag}</p>
        <div class="footer-socials">
          <a href="https://instagram.com/${ig}" target="_blank" title="Instagram">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z"/></svg>
          </a>
          <a href="https://wa.me/${wa}" target="_blank" title="WhatsApp">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z"/></svg>
          </a>
          <a href="mailto:${email}" title="Email">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/></svg>
          </a>
        </div>
      </div>
      <div class="footer-links">
        <h4>Navigate</h4>
        ${footerLinks}
      </div>
      <div class="footer-contact">
        <h4>Contact</h4>
        <p>${phone}</p>
        <p>${email}</p>
        <p>${addr}</p>
      </div>
    </div>
    <div class="footer-bottom">
      <span>${copy}</span>
    </div>
  </footer>`;
}

function htmlShell({ title, slug, metaDesc, bodyContent, configMap, navOrder }) {
  const siteName = esc(configMap["site_name"] || "SAPZCODES");
  const siteTag  = esc(configMap["site_tagline"] || "SAP Training & Consulting | Coimbatore");
  const pageTitle = title ? `${esc(title)} — ${siteName}` : `${siteName} — ${siteTag}`;
  const desc = esc(metaDesc || siteTag);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${pageTitle}</title>
  <meta name="description" content="${desc}" />
  <link rel="icon" href="${BASE}/favicon.png" />
  <link rel="stylesheet" href="${BASE}/styles.css" />
</head>
<body>
${navHTML(navOrder, configMap, slug)}
<main id="page-content">
${bodyContent}
</main>
${footerHTML(configMap, navOrder)}
<script>
// Scroll reveal
const _io = new IntersectionObserver(entries => {
  entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('visible'); _io.unobserve(e.target); } });
}, { threshold: 0.1 });
document.querySelectorAll('.card,.course-card,.stat-card,.mission-card,.trainer-card,.testimonial-card,.section-head,.two-col > div,.generic-row,.tc-section,.contact-item').forEach((el, i) => {
  el.classList.add('reveal');
  if (i % 4 === 1) el.classList.add('reveal-delay-1');
  if (i % 4 === 2) el.classList.add('reveal-delay-2');
  if (i % 4 === 3) el.classList.add('reveal-delay-3');
  _io.observe(el);
});
// Navbar shadow on scroll
window.addEventListener('scroll', () => {
  document.getElementById('site-header').classList.toggle('scrolled', window.scrollY > 12);
}, { passive: true });
</script>
</body>
</html>`;
}

// ── Page content builders ──────────────────────────────────────

function buildPageHTML(sheetName, slug, data, rawRows, configMap, navOrder) {
  let bodyContent = "";
  const wa = esc(configMap["whatsapp_number"] || "");
  const email = esc(configMap["contact_email"] || "");

  switch (slug) {
    case "home":                bodyContent = buildHome(data, wa, email, configMap); break;
    case "about-us":            bodyContent = buildAbout(data); break;
    case "career":              bodyContent = buildCareer(data, rawRows, wa, configMap); break;
    case "corporate-training":  bodyContent = buildCorporate(data, wa, configMap); break;
    case "consulting":          bodyContent = buildConsulting(data, wa, configMap); break;
    case "our-clients":         bodyContent = buildClients(data, rawRows); break;
    case "enquiry":             bodyContent = buildEnquiry(data, configMap); break;
    case "tc":
    case "t-c":
    case "t&c":                 bodyContent = buildTC(data); break;
    default:                    bodyContent = buildGeneric(sheetName, data, wa); break;
  }

  return htmlShell({
    title: data["page_title"] || sheetName,
    slug,
    metaDesc: data["page_subtext"] || data["hero_subtext"] || "",
    bodyContent,
    configMap,
    navOrder
  });
}

// ── HOME ─────────────────────────────────────────────────────
function buildHome(d, wa, email, cfg) {
  const stats = [1,2,3,4].map(n => `
    <div class="stat-card">
      <span class="stat-num">${esc(d[`stat_${n}_number`] || "")}</span>
      <span class="stat-label">${esc(d[`stat_${n}_label`] || "")}</span>
    </div>`).join("");

  const services = [1,2,3,4,5,6].filter(n => d[`service_${n}_title`]).map(n => `
    <div class="card">
      <div class="card-icon">${d[`service_${n}_icon`] || "⚙️"}</div>
      <h3>${esc(d[`service_${n}_title`])}</h3>
      <p>${esc(d[`service_${n}_desc`] || "")}</p>
    </div>`).join("");

  const whyCards = [1,2,3,4,5,6].filter(n => d[`why_${n}_title`]).map(n => `
    <div class="card">
      <div class="card-icon">${d[`why_${n}_icon`] || ""}</div>
      <h3>${esc(d[`why_${n}_title`])}</h3>
      <p>${esc(d[`why_${n}_desc`] || "")}</p>
    </div>`).join("");

  const ticker = ["SAP ABAP","SAP FICO","SAP MM","SAP SD","SAP HCM","SAP BASIS","SAP PP","SAP QM","SAP S/4HANA","100% Placement","Certification Support"];
  const tickerHTML = [...ticker, ...ticker].map(t => `<span>${t}</span>`).join("");

  return `
<section class="hero">
  <div class="hero-bg-dots"></div>
  <div class="hero-content">
    <span class="hero-badge">${esc(d.hero_badge || "")}</span>
    <h1>${nl2br(d.hero_heading || "")}</h1>
    <p class="hero-sub">${esc(d.hero_subtext || "")}</p>
    <div class="hero-btns">
      <a href="https://wa.me/${wa}" target="_blank" class="btn btn-primary">${esc(d.hero_cta_primary || "📲 WhatsApp Us")}</a>
      <a href="${BASE}/pages/career.html" class="btn btn-outline">${esc(d.hero_cta_secondary || "Explore Courses →")}</a>
    </div>
  </div>
  <div class="hero-ticker">
    <div class="ticker-track">${tickerHTML}</div>
  </div>
</section>

<section class="stats-bar">${stats}</section>

<section class="section">
  <div class="section-head">
    <h2>${esc(d.services_heading || "What We Offer")}</h2>
    <p>${esc(d.services_subheading || "")}</p>
  </div>
  <div class="card-grid">${services}</div>
</section>

<section class="section section-alt">
  <div class="section-head">
    <h2>${esc(d.why_heading || "Built for Your Success.")}</h2>
  </div>
  <div class="card-grid">${whyCards}</div>
</section>

<section class="cta-banner">
  <div class="cta-inner">
    <h2>Ready to start your SAP journey?</h2>
    <p>Talk to our counsellors for free — honest guidance, zero pressure.</p>
    <div class="cta-btns">
      <a href="https://wa.me/${wa}" target="_blank" class="btn btn-primary">📲 WhatsApp Now</a>
      <a href="mailto:${email}" class="btn btn-outline-dark">✉ Email Us</a>
    </div>
  </div>
</section>`;
}

// ── ABOUT ────────────────────────────────────────────────────
function buildAbout(d) {
  const trainers = [1,2,3,4].filter(n => d[`trainer_${n}_name`] && d[`trainer_${n}_name`] !== "Trainer Name").map(n => `
    <div class="trainer-card">
      <div class="trainer-avatar">${esc(d[`trainer_${n}_name`][0])}</div>
      <div>
        <strong>${esc(d[`trainer_${n}_name`])}</strong>
        <span>${esc(d[`trainer_${n}_role`] || "")}</span>
        <span class="tag">${esc(d[`trainer_${n}_exp`] || "")}</span>
      </div>
    </div>`).join("");

  return `
<section class="page-hero">
  <h1>${esc(d.page_title || "About Us")}</h1>
</section>
<section class="section">
  <div class="two-col">
    <div>
      <h2>${esc(d.intro_heading || "Who We Are")}</h2>
      <p>${esc(d.intro_text || "")}</p>
      <div class="info-pills">
        ${d.location ? `<span>📍 ${esc(d.location)}</span>` : ""}
        ${d.founded_year ? `<span>🗓 Est. ${esc(d.founded_year)}</span>` : ""}
      </div>
    </div>
    <div class="about-graphic">
      <img src="${BASE}/logoforwhite.png" alt="SAPZCODES" style="max-width:260px;opacity:0.1;" />
    </div>
  </div>
</section>
<section class="section section-alt">
  <div class="two-col">
    <div class="mission-card">
      <h3>🎯 ${esc(d.mission_heading || "Our Mission")}</h3>
      <p>${esc(d.mission_text || "")}</p>
    </div>
    <div class="mission-card">
      <h3>🔭 ${esc(d.vision_heading || "Our Vision")}</h3>
      <p>${esc(d.vision_text || "")}</p>
    </div>
  </div>
</section>
${trainers ? `
<section class="section">
  <div class="section-head">
    <h2>${esc(d.team_heading || "Our Team")}</h2>
    <p>${esc(d.team_desc || "")}</p>
  </div>
  <div class="trainers-grid">${trainers}</div>
</section>` : ""}`;
}

// ── CAREER ───────────────────────────────────────────────────
function buildCareer(d, rawRows, wa, cfg) {
  // Detect course table rows: rows where first column looks like an emoji or short icon
  const courseRows = rawRows.filter(row => {
    const keys = Object.keys(row);
    if (!keys.length) return false;
    const first = (row[keys[0]] || "").trim();
    // Course rows: first col is emoji/icon, second is course name
    return first && first !== "course_icon" && first !== "CONTENT KEY" &&
           !first.startsWith("──") && !first.includes("_");
  });

  const courseCards = courseRows.map(row => {
    const keys = Object.keys(row);
    const icon  = row[keys[0]] || "";
    const title = row[keys[1]] || "";
    const type  = row[keys[2]] || "";
    const desc  = row[keys[3]] || "";
    if (!title || title === "course_title") return "";
    const typeClass = type.toLowerCase().replace(/[^a-z]/g, "");
    return `
    <div class="course-card">
      <div class="course-icon">${icon}</div>
      <div class="course-badge ${typeClass}">${esc(type)}</div>
      <h3>${esc(title)}</h3>
      <p>${esc(desc)}</p>
    </div>`;
  }).join("");

  return `
<section class="page-hero">
  <h1>${esc(d.page_title || "Career & Courses")}</h1>
  <p>${esc(d.page_subtext || "")}</p>
</section>
<section class="section">
  <div class="section-head">
    <h2>All SAP Modules. One Roof.</h2>
    <p>From functional to technical — every major SAP module with real project scenarios.</p>
  </div>
  <div class="courses-grid">${courseCards}</div>
</section>
<section class="cta-banner">
  <div class="cta-inner">
    <h2>Not sure which module to choose?</h2>
    <p>Talk to our counsellors — free, no-pressure guidance.</p>
    <a href="https://wa.me/${wa}" target="_blank" class="btn btn-primary">📲 WhatsApp Us</a>
  </div>
</section>`;
}

// ── CORPORATE ────────────────────────────────────────────────
function buildCorporate(d, wa, cfg) {
  const offerings = [1,2,3,4,5].filter(n => d[`offering_${n}_title`]).map(n => `
    <div class="card">
      <h3>${esc(d[`offering_${n}_title`])}</h3>
      <p>${esc(d[`offering_${n}_desc`] || "")}</p>
    </div>`).join("");

  return `
<section class="page-hero">
  <h1>${esc(d.page_title || "Corporate Training")}</h1>
  <p>${esc(d.page_subtext || "")}</p>
</section>
<section class="section">
  <div class="two-col">
    <div>
      <h2>${esc(d.intro_heading || "Upskill Your Team")}</h2>
      <p>${esc(d.intro_text || "")}</p>
    </div>
    <div class="corp-visual"><div class="big-icon">🏢</div></div>
  </div>
</section>
<section class="section section-alt">
  <div class="section-head"><h2>What We Offer</h2></div>
  <div class="card-grid">${offerings}</div>
</section>
<section class="cta-banner">
  <div class="cta-inner">
    <h2>${esc(d.cta_text || "Get a Custom Quote")}</h2>
    <p>${esc(d.cta_note || "")}</p>
    <a href="https://wa.me/${wa}" target="_blank" class="btn btn-primary">📲 WhatsApp Us</a>
  </div>
</section>`;
}

// ── CONSULTING ───────────────────────────────────────────────
function buildConsulting(d, wa, cfg) {
  const services = [1,2,3,4,5,6].filter(n => d[`service_${n}_title`]).map(n => `
    <div class="card">
      <h3>${esc(d[`service_${n}_title`])}</h3>
      <p>${esc(d[`service_${n}_desc`] || "")}</p>
    </div>`).join("");

  return `
<section class="page-hero">
  <h1>${esc(d.page_title || "SAP Consulting")}</h1>
  <p>${esc(d.page_subtext || "")}</p>
</section>
<section class="section">
  <div class="two-col">
    <div>
      <h2>${esc(d.intro_heading || "Your SAP Partner")}</h2>
      <p>${esc(d.intro_text || "")}</p>
    </div>
    <div class="corp-visual"><div class="big-icon">🔧</div></div>
  </div>
</section>
<section class="section section-alt">
  <div class="section-head"><h2>Our Services</h2></div>
  <div class="card-grid">${services}</div>
</section>
<section class="cta-banner">
  <div class="cta-inner">
    <h2>Looking for SAP Consulting?</h2>
    <p>Let's discuss your requirements.</p>
    <a href="https://wa.me/${wa}" target="_blank" class="btn btn-primary">📲 WhatsApp Us</a>
  </div>
</section>`;
}

// ── CLIENTS ──────────────────────────────────────────────────
function buildClients(d, rawRows) {
  const clientRows = rawRows.filter(r => {
    const v = r["client_name"] || r[Object.keys(r)[0]] || "";
    return v && v !== "client_name" && v !== "CONTENT KEY" && v !== "Client Name" && !v.startsWith("──");
  });
  const clients = clientRows.map(r => {
    const keys  = Object.keys(r);
    const name  = r["client_name"] || r[keys[0]] || "";
    const logo  = r["client_logo_url (optional — leave blank if none)"] || r[keys[1]] || "";
    if (!name || name === "Client Name") return "";
    return logo
      ? `<div class="client-badge"><img src="${esc(logo)}" alt="${esc(name)}" loading="lazy" /></div>`
      : `<div class="client-badge client-text">${esc(name)}</div>`;
  }).join("");

  const testRows = rawRows.filter(r => {
    const v = r["testimonial_name"] || "";
    return v && v !== "testimonial_name";
  });
  const testimonials = testRows.map(r => {
    const name = r["testimonial_name"] || "";
    const text = r["testimonial_text"] || "";
    const role = r["testimonial_role"] || "";
    if (!name) return "";
    return `
    <div class="testimonial-card">
      <p class="testimonial-text">"${esc(text)}"</p>
      <div class="testimonial-author">
        <strong>${esc(name)}</strong>
        <span>${esc(role)}</span>
      </div>
    </div>`;
  }).join("");

  return `
<section class="page-hero">
  <h1>${esc(d.page_title || "Our Clients")}</h1>
  <p>${esc(d.page_subtext || "")}</p>
</section>
<section class="section">
  <p style="text-align:center;max-width:680px;margin:0 auto 2rem;">${esc(d.intro_text || "")}</p>
  ${clients ? `<div class="clients-grid">${clients}</div>` : ""}
</section>
${testimonials ? `
<section class="section section-alt">
  <div class="section-head"><h2>What Our Students Say</h2></div>
  <div class="testimonials-grid">${testimonials}</div>
</section>` : ""}`;
}

// ── ENQUIRY ──────────────────────────────────────────────────
function buildEnquiry(d, cfg) {
  const wa    = esc(cfg["whatsapp_number"] || "");
  const phone = esc(cfg["contact_phone"] || "");
  const email = esc(cfg["contact_email"] || "");
  const addr  = esc(cfg["contact_address"] || "");
  const ig    = esc(cfg["contact_instagram"] || "");

  return `
<section class="page-hero">
  <h1>${esc(d.page_title || "Get in Touch")}</h1>
  <p>${esc(d.page_subtext || "")}</p>
</section>
<section class="section enquiry-section">
  <div class="enquiry-grid">
    <div class="contact-info">
      <h2>Contact Details</h2>
      <div class="contact-item"><span>📞</span><div><strong>Phone</strong><p><a href="tel:${phone}">${phone}</a></p></div></div>
      <div class="contact-item"><span>✉️</span><div><strong>Email</strong><p><a href="mailto:${email}">${email}</a></p></div></div>
      <div class="contact-item"><span>📍</span><div><strong>Address</strong><p>${addr}</p></div></div>
      <div class="contact-item"><span>📸</span><div><strong>Instagram</strong><p><a href="https://instagram.com/${ig}" target="_blank">@${ig}</a></p></div></div>
      ${d.office_hours ? `<div class="contact-item"><span>🕐</span><div><strong>Office Hours</strong><p>${esc(d.office_hours)}</p></div></div>` : ""}
      <p class="wa-note">${esc(d.whatsapp_cta_text || "Or reach us directly on WhatsApp")}</p>
      <a href="https://wa.me/${wa}" target="_blank" class="btn btn-primary" style="display:inline-block;margin-top:0.5rem;">📲 WhatsApp Us</a>
    </div>
    <div class="enquiry-form-wrap">
      <h2>${esc(d.form_heading || "Send Us a Message")}</h2>
      <form id="enquiry-form" class="enquiry-form" onsubmit="submitEnquiry(event,'${wa}')">
        <div class="form-group"><label>Your Name</label><input type="text" name="name" placeholder="John Doe" required /></div>
        <div class="form-group"><label>Phone Number</label><input type="tel" name="phone" placeholder="+91 XXXXX XXXXX" required /></div>
        <div class="form-group"><label>Email</label><input type="email" name="email" placeholder="you@email.com" /></div>
        <div class="form-group">
          <label>Course Interested In</label>
          <select name="course">
            <option value="">Select a course...</option>
            <option>SAP ABAP</option><option>SAP FICO</option><option>SAP MM</option>
            <option>SAP SD</option><option>SAP HCM</option><option>SAP BASIS</option>
            <option>SAP PP</option><option>SAP QM</option><option>SAP S/4HANA</option>
            <option>Corporate Training</option><option>SAP Consulting</option>
          </select>
        </div>
        <div class="form-group"><label>Message</label><textarea name="message" rows="4" placeholder="Tell us about yourself..."></textarea></div>
        <button type="submit" class="btn btn-primary" style="width:100%;">Send via WhatsApp →</button>
        <p class="form-note">This form sends your message directly to our WhatsApp.</p>
      </form>
    </div>
  </div>
</section>
<script>
function submitEnquiry(e, wa) {
  e.preventDefault();
  const f = e.target;
  const text = encodeURIComponent(
    'Hi SAPZCODES! I would like to enquire.\\n\\n*Name:* ' + f.name.value +
    '\\n*Phone:* ' + f.phone.value +
    '\\n*Email:* ' + f.email.value +
    '\\n*Course:* ' + f.course.value +
    '\\n*Message:* ' + f.message.value
  );
  window.open('https://wa.me/' + wa + '?text=' + text, '_blank');
}
</script>`;
}

// ── T&C ──────────────────────────────────────────────────────
function buildTC(d) {
  const sections = [1,2,3,4,5,6,7,8,9,10].filter(n => d[`section_${n}_heading`]).map(n => `
    <div class="tc-section">
      <h3>${esc(d[`section_${n}_heading`])}</h3>
      <p>${esc(d[`section_${n}_text`] || "")}</p>
    </div>`).join("");

  return `
<section class="page-hero">
  <h1>${esc(d.page_title || "Terms & Conditions")}</h1>
  <p>Last updated: ${esc(d.last_updated || "")}</p>
</section>
<section class="section tc-page">
  <div class="tc-container">
    ${d.intro_text ? `<p class="tc-intro">${esc(d.intro_text)}</p>` : ""}
    ${sections}
    ${d.contact_note ? `<div class="tc-contact-note">${esc(d.contact_note)}</div>` : ""}
  </div>
</section>`;
}

// ── GENERIC FALLBACK ─────────────────────────────────────────
function buildGeneric(sheetName, d, wa) {
  const rows = Object.entries(d)
    .filter(([k, v]) => v && !k.startsWith("_") && k !== "__rows")
    .map(([k, v]) => {
      const label = k.replace(/_/g, " ").replace(/\b\w/g, l => l.toUpperCase());
      return `<div class="generic-row"><strong>${esc(label)}</strong><p>${esc(v)}</p></div>`;
    }).join("");

  return `
<section class="page-hero">
  <h1>${esc(d.page_title || sheetName)}</h1>
  ${d.page_subtext ? `<p>${esc(d.page_subtext)}</p>` : ""}
</section>
<section class="section">
  <div class="generic-content">${rows}</div>
  <div style="text-align:center;margin-top:2rem;">
    <a href="https://wa.me/${wa}" target="_blank" class="btn btn-primary">📲 Get in Touch</a>
  </div>
</section>`;
}

// ── INDEX.HTML (landing redirect) ─────────────────────────────
function buildShell(configMap, navOrder, firstSlug) {
  const siteName = esc(configMap["site_name"] || "SAPZCODES");
  const siteTag  = esc(configMap["site_tagline"] || "SAP Training & Consulting");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${siteName} — ${siteTag}</title>
  <meta name="description" content="${siteTag}" />
  <link rel="icon" href="${BASE}/favicon.png" />
  <link rel="stylesheet" href="${BASE}/styles.css" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=Inter:wght@400;500;600&display=swap" rel="stylesheet" />
  <!-- Immediate redirect to first page; no flash -->
  <script>window.location.replace("${BASE}/pages/${firstSlug}.html");</script>
  <noscript><meta http-equiv="refresh" content="0;url=${BASE}/pages/${firstSlug}.html" /></noscript>
</head>
<body>
  <div style="display:flex;align-items:center;justify-content:center;min-height:100vh;flex-direction:column;gap:1rem;">
    <img src="${BASE}/logoforwhite.png" alt="${siteName}" style="height:48px;opacity:0.2;" />
  </div>
</body>
</html>`;
}

// ── 404 ──────────────────────────────────────────────────────
function build404(configMap, navOrder) {
  const siteName = esc(configMap["site_name"] || "SAPZCODES");
  const wa = esc(configMap["whatsapp_number"] || "");

  return htmlShell({
    title: "Page Not Found",
    slug: "404",
    metaDesc: "Page not found",
    bodyContent: `
<section class="error-page" style="min-height:70vh;">
  <img src="/logoforwhite.png" alt="${siteName}" style="height:48px;opacity:0.2;margin-bottom:1rem;" />
  <h2>Page Not Found</h2>
  <p>This page doesn't exist or may have been moved.</p>
  <div style="display:flex;gap:1rem;margin-top:1.5rem;flex-wrap:wrap;justify-content:center;">
    <a href="${BASE}/index.html" class="btn btn-primary">← Go Home</a>
    <a href="https://wa.me/${wa}" target="_blank" class="btn btn-outline">📲 WhatsApp Us</a>
  </div>
</section>`,
    configMap,
    navOrder
  });
}

// ── Run ────────────────────────────────────────────────────────
bake().catch(err => {
  console.error("\n❌ Bake failed:", err.message);
  process.exit(1);
});
