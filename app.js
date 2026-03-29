/**
 * SAPZCODES – Google Sheets CMS Engine
 * ─────────────────────────────────────
 * HOW IT WORKS:
 *  1. Reads your published Google Sheet via the opensheet.elk.sh API
 *  2. Builds navigation from _CONFIG > nav_order
 *  3. Routes pages based on URL hash (#home, #about-us, etc.)
 *  4. Each sheet name = one page
 *  5. Adding/renaming a sheet auto-updates nav
 *
 * SETUP:
 *  - Publish your Google Sheet (File > Share > Publish to web > Entire document > CSV)
 *  - Copy the Sheet ID from the URL: docs.google.com/spreadsheets/d/SHEET_ID/...
 *  - Paste it below as SHEET_ID
 */

const SHEET_ID = "1DSXBNUEa4CXs-DkkBvmfJwsADmUC2F2s5-FZsPKf7pQ"; // ← REPLACE THIS after publishing your sheet
const API_BASE = `https://opensheet.elk.sh/${SHEET_ID}`;

// ── Global state ──────────────────────────────────────────────
let CONFIG = {};
let SHEETS_CACHE = {};
let currentPage = "";

// ── Bootstrap ─────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  try {
    await loadConfig();
    buildNav();
    buildFooter();
    document.getElementById("site-footer").style.display = "";
    setupHashRouting();
    navigateToHash();
  } catch (err) {
    showError("Failed to load site content. Please check your Google Sheet connection.", err);
  }
});

// ── Load _CONFIG sheet ─────────────────────────────────────────
async function loadConfig() {
  const raw = await fetchSheet("_CONFIG");
  raw.forEach(row => {
    const key = (row["CONFIG KEY"] || "").trim();
    const val = (row["VALUE"] || "").trim();
    if (key) CONFIG[key] = val;
  });
}

// ── Fetch a sheet by name ──────────────────────────────────────
async function fetchSheet(sheetName) {
  if (SHEETS_CACHE[sheetName]) return SHEETS_CACHE[sheetName];
  const encoded = encodeURIComponent(sheetName);
  const res = await fetch(`${API_BASE}/${encoded}`);
  if (!res.ok) throw new Error(`Sheet "${sheetName}" not found (${res.status})`);
  const data = await res.json();
  SHEETS_CACHE[sheetName] = data;
  return data;
}

// ── Parse key-value sheet into object ─────────────────────────
async function getPageData(sheetName) {
  const raw = await fetchSheet(sheetName);
  const out = {};
  raw.forEach(row => {
    const key = (row["CONTENT KEY"] || "").trim();
    const val = (row["VALUE — Edit this column"] || row["VALUE"] || "").trim();
    if (key) out[key] = val;
  });
  return out;
}

// ── Build Navigation ──────────────────────────────────────────
function buildNav() {
  const navOrder = (CONFIG["nav_order"] || "").split(",").map(s => s.trim()).filter(Boolean);
  const ul = document.getElementById("nav-links");
  ul.innerHTML = "";

  // If nav_order is empty, just show nothing extra
  if (!navOrder.length) return;

  navOrder.forEach(name => {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = `#${toSlug(name)}`;
    a.textContent = name;
    a.dataset.page = name;
    a.addEventListener("click", () => closeMobileMenu());
    li.appendChild(a);
    ul.appendChild(li);
  });

  // Footer nav mirror
  const footerNav = document.getElementById("footer-nav");
  const h4 = footerNav.querySelector("h4");
  footerNav.innerHTML = "";
  if (h4) footerNav.appendChild(h4);
  else {
    const fh = document.createElement("h4");
    fh.textContent = "Navigate";
    footerNav.appendChild(fh);
  }
  navOrder.forEach(name => {
    const a = document.createElement("a");
    a.href = `#${toSlug(name)}`;
    a.textContent = name;
    footerNav.appendChild(a);
  });

  // WhatsApp CTA
  const wa = CONFIG["whatsapp_number"] || "";
  document.getElementById("nav-whatsapp").href = `https://wa.me/${wa}`;

  // Logo link
  document.getElementById("nav-logo-link").href = `#${toSlug(navOrder[0] || "home")}`;

  // Hamburger
  document.getElementById("hamburger").addEventListener("click", toggleMobileMenu);
}

// ── Build Footer ───────────────────────────────────────────────
function buildFooter() {
  const ig = CONFIG["contact_instagram"] || "";
  const wa = CONFIG["whatsapp_number"] || "";
  const email = CONFIG["contact_email"] || "";
  const phone = CONFIG["contact_phone"] || "";
  const address = CONFIG["contact_address"] || "";

  document.getElementById("footer-instagram").href = `https://instagram.com/${ig}`;
  document.getElementById("footer-whatsapp").href = `https://wa.me/${wa}`;
  document.getElementById("footer-email").href = `mailto:${email}`;
  document.getElementById("footer-tagline").textContent = CONFIG["site_tagline"] || "";
  document.getElementById("footer-phone-display").textContent = phone;
  document.getElementById("footer-email-display").textContent = email;
  document.getElementById("footer-address-display").textContent = address;
  document.getElementById("footer-copyright").textContent = CONFIG["footer_text"] || "";
}

// ── Hash Routing ───────────────────────────────────────────────
function setupHashRouting() {
  window.addEventListener("hashchange", navigateToHash);
}

function navigateToHash() {
  const hash = window.location.hash.slice(1) || "home";
  const navOrder = (CONFIG["nav_order"] || "").split(",").map(s => s.trim());

  // Find matching sheet name by slug
  const match = navOrder.find(name => toSlug(name) === hash.toLowerCase()) || navOrder[0];
  if (match && match !== currentPage) {
    currentPage = match;
    setActiveNav(hash);
    renderPage(match);
  }
}

function setActiveNav(hash) {
  document.querySelectorAll(".nav-links a").forEach(a => {
    a.classList.toggle("active", a.getAttribute("href") === `#${hash}`);
  });
}

// ── Page Renderer ──────────────────────────────────────────────
async function renderPage(sheetName) {
  const content = document.getElementById("page-content");
  content.innerHTML = `<div class="page-loading"><div class="spinner"></div></div>`;

  try {
    let html = "";
    const slug = toSlug(sheetName);

    switch (slug) {
      case "home":          html = await renderHome(); break;
      case "about-us":      html = await renderAboutUs(); break;
      case "career":        html = await renderCareer(); break;
      case "corporate-training": html = await renderCorporate(); break;
      case "consulting":    html = await renderConsulting(); break;
      case "our-clients":   html = await renderClients(); break;
      case "enquiry":       html = await renderEnquiry(); break;
      case "tc":
      case "t&c":           html = await renderTC(); break;
      default:              html = await renderGeneric(sheetName); break;
    }

    content.innerHTML = html;
    window.scrollTo({ top: 0, behavior: "smooth" });
    attachFormHandlers();
  } catch (err) {
    content.innerHTML = `<div class="error-page"><h2>Couldn't load this page</h2><p>${err.message}</p></div>`;
  }
}

// ── PAGE: Home ────────────────────────────────────────────────
async function renderHome() {
  const d = await getPageData("Home");
  const wa = CONFIG["whatsapp_number"] || "";

  const stats = [1,2,3,4].map(n => `
    <div class="stat-card">
      <span class="stat-num">${d[`stat_${n}_number`] || ""}</span>
      <span class="stat-label">${d[`stat_${n}_label`] || ""}</span>
    </div>`).join("");

  // Services
  const services = [1,2,3,4].filter(n => d[`service_${n}_title`]).map(n => `
    <div class="card">
      <div class="card-icon">${d[`service_${n}_icon`] || "⚙️"}</div>
      <h3>${d[`service_${n}_title`]}</h3>
      <p>${d[`service_${n}_desc`] || ""}</p>
    </div>`).join("");

  // Why cards
  const whyCards = [1,2,3,4,5,6].filter(n => d[`why_${n}_title`]).map(n => `
    <div class="card">
      <div class="card-icon">${d[`why_${n}_icon`] || ""}</div>
      <h3>${d[`why_${n}_title`]}</h3>
      <p>${d[`why_${n}_desc`] || ""}</p>
    </div>`).join("");

  return `
  <section class="hero">
    <div class="hero-bg-dots"></div>
    <div class="hero-content">
      <span class="hero-badge">${d.hero_badge || ""}</span>
      <h1>${(d.hero_heading || "").replace(/\\n/g, "<br>")}</h1>
      <p class="hero-sub">${d.hero_subtext || ""}</p>
      <div class="hero-btns">
        <a href="https://wa.me/${wa}" target="_blank" class="btn btn-primary">${d.hero_cta_primary || "WhatsApp Us"}</a>
        <a href="#career" class="btn btn-outline">${d.hero_cta_secondary || "Explore Courses →"}</a>
      </div>
    </div>
    <div class="hero-ticker">
      <div class="ticker-track">
        ${["SAP ABAP","SAP FICO","SAP MM","SAP SD","SAP HCM","SAP BASIS","SAP PP","SAP QM","SAP S/4HANA","100% Placement","Certification Support"]
          .map(t => `<span>${t}</span>`).join("")}
        ${["SAP ABAP","SAP FICO","SAP MM","SAP SD","SAP HCM","SAP BASIS","SAP PP","SAP QM","SAP S/4HANA","100% Placement","Certification Support"]
          .map(t => `<span>${t}</span>`).join("")}
      </div>
    </div>
  </section>

  <section class="stats-bar">
    ${stats}
  </section>

  <section class="section">
    <div class="section-head">
      <h2>${d.services_heading || "What We Offer"}</h2>
      <p>${d.services_subheading || ""}</p>
    </div>
    <div class="card-grid">${services}</div>
  </section>

  <section class="section section-alt">
    <div class="section-head">
      <h2>${d.why_heading || "Built for Your Success."}</h2>
    </div>
    <div class="card-grid">${whyCards}</div>
  </section>

  <section class="cta-banner">
    <div class="cta-inner">
      <h2>Ready to start your SAP journey?</h2>
      <p>Talk to our counsellors for free — honest guidance, zero pressure.</p>
      <div class="cta-btns">
        <a href="https://wa.me/${wa}" target="_blank" class="btn btn-primary">📲 WhatsApp Now</a>
        <a href="mailto:${CONFIG["contact_email"] || ""}" class="btn btn-outline-dark">✉ Email Us</a>
      </div>
    </div>
  </section>`;
}

// ── PAGE: About Us ────────────────────────────────────────────
async function renderAboutUs() {
  const d = await getPageData("About Us");
  const trainers = [1,2,3].filter(n => d[`trainer_${n}_name`] && d[`trainer_${n}_name`] !== "Trainer Name").map(n => `
    <div class="trainer-card">
      <div class="trainer-avatar">${d[`trainer_${n}_name`][0]}</div>
      <div>
        <strong>${d[`trainer_${n}_name`]}</strong>
        <span>${d[`trainer_${n}_role`] || ""}</span>
        <span class="tag">${d[`trainer_${n}_exp`] || ""}</span>
      </div>
    </div>`).join("");

  return `
  <section class="page-hero">
    <h1>${d.page_title || "About Us"}</h1>
  </section>

  <section class="section">
    <div class="two-col">
      <div>
        <h2>${d.intro_heading || "Who We Are"}</h2>
        <p>${d.intro_text || ""}</p>
        <div class="info-pills">
          <span>📍 ${d.location || ""}</span>
          <span>🗓 Est. ${d.founded_year || ""}</span>
        </div>
      </div>
      <div class="about-graphic">
        <img src="logoforwhite.png" alt="SAPZCODES" style="max-width:300px;opacity:0.12;" />
      </div>
    </div>
  </section>

  <section class="section section-alt">
    <div class="two-col">
      <div class="mission-card">
        <h3>🎯 ${d.mission_heading || "Our Mission"}</h3>
        <p>${d.mission_text || ""}</p>
      </div>
      <div class="mission-card">
        <h3>🔭 ${d.vision_heading || "Our Vision"}</h3>
        <p>${d.vision_text || ""}</p>
      </div>
    </div>
  </section>

  ${trainers ? `
  <section class="section">
    <div class="section-head">
      <h2>${d.team_heading || "Our Team"}</h2>
      <p>${d.team_desc || ""}</p>
    </div>
    <div class="trainers-grid">${trainers}</div>
  </section>` : ""}`;
}

// ── PAGE: Career ──────────────────────────────────────────────
async function renderCareer() {
  const d = await getPageData("Career");
  const raw = await fetchSheet("Career");

  // Rows with course_icon in col A (these are the course table rows, header row has "course_icon")
  const courses = raw.filter(row => {
    const keys = Object.keys(row);
    return row[keys[0]] && row[keys[0]] !== "course_icon" && row[keys[0]] !== "CONTENT KEY" && !row[keys[0]].startsWith("──");
  }).filter(row => {
    const firstKey = Object.keys(row)[0];
    const val = row[firstKey] || "";
    return val.match(/[\u{1F300}-\u{1FFFF}]|[🎯🏆📜👨🖥📅💻💰📦🛒👥✅⚡🏭]/u) || val.length <= 3;
  });

  const courseCards = courses.map(row => {
    const keys = Object.keys(row);
    const icon = row[keys[0]] || "";
    const title = row[keys[1]] || "";
    const type = row[keys[2]] || "";
    const desc = row[keys[3]] || "";
    if (!title) return "";
    const typeClass = type.toLowerCase().replace(/[^a-z]/g, "");
    return `
    <div class="course-card">
      <div class="course-icon">${icon}</div>
      <div class="course-badge ${typeClass}">${type}</div>
      <h3>${title}</h3>
      <p>${desc}</p>
    </div>`;
  }).join("");

  return `
  <section class="page-hero">
    <h1>${d.page_title || "Career & Courses"}</h1>
    <p>${d.page_subtext || ""}</p>
  </section>

  <section class="section">
    <div class="section-head">
      <h2>All SAP Modules. One Roof.</h2>
      <p>From functional to technical — every major SAP module with real project scenarios and industry-veteran trainers.</p>
    </div>
    <div class="courses-grid">${courseCards}</div>
  </section>

  <section class="cta-banner">
    <div class="cta-inner">
      <h2>Not sure which module to choose?</h2>
      <p>Talk to our counsellors — free, no-pressure guidance.</p>
      <a href="https://wa.me/${CONFIG["whatsapp_number"] || ""}" target="_blank" class="btn btn-primary">📲 WhatsApp Us</a>
    </div>
  </section>`;
}

// ── PAGE: Corporate Training ──────────────────────────────────
async function renderCorporate() {
  const d = await getPageData("Corporate Training");
  const offerings = [1,2,3,4].filter(n => d[`offering_${n}_title`]).map(n => `
    <div class="card">
      <h3>${d[`offering_${n}_title`]}</h3>
      <p>${d[`offering_${n}_desc`] || ""}</p>
    </div>`).join("");

  return `
  <section class="page-hero">
    <h1>${d.page_title || "Corporate Training"}</h1>
    <p>${d.page_subtext || ""}</p>
  </section>
  <section class="section">
    <div class="two-col">
      <div>
        <h2>${d.intro_heading || "Upskill Your Team"}</h2>
        <p>${d.intro_text || ""}</p>
      </div>
      <div class="corp-visual">
        <div class="big-icon">🏢</div>
      </div>
    </div>
  </section>
  <section class="section section-alt">
    <div class="section-head"><h2>What We Offer</h2></div>
    <div class="card-grid">${offerings}</div>
  </section>
  <section class="cta-banner">
    <div class="cta-inner">
      <h2>${d.cta_text || "Get a Custom Quote"}</h2>
      <p>${d.cta_note || ""}</p>
      <a href="https://wa.me/${CONFIG["whatsapp_number"] || ""}" target="_blank" class="btn btn-primary">📲 WhatsApp Us</a>
    </div>
  </section>`;
}

// ── PAGE: Consulting ──────────────────────────────────────────
async function renderConsulting() {
  const d = await getPageData("Consulting");
  const services = [1,2,3,4,5].filter(n => d[`service_${n}_title`]).map(n => `
    <div class="card">
      <h3>${d[`service_${n}_title`]}</h3>
      <p>${d[`service_${n}_desc`] || ""}</p>
    </div>`).join("");

  return `
  <section class="page-hero">
    <h1>${d.page_title || "SAP Consulting"}</h1>
    <p>${d.page_subtext || ""}</p>
  </section>
  <section class="section">
    <div class="two-col">
      <div>
        <h2>${d.intro_heading || "Your SAP Partner"}</h2>
        <p>${d.intro_text || ""}</p>
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
      <p>Let's discuss your requirements. Contact us today.</p>
      <a href="https://wa.me/${CONFIG["whatsapp_number"] || ""}" target="_blank" class="btn btn-primary">📲 WhatsApp Us</a>
    </div>
  </section>`;
}

// ── PAGE: Our Clients ─────────────────────────────────────────
async function renderClients() {
  const d = await getPageData("Our Clients");
  const raw = await fetchSheet("Our Clients");

  // Filter client rows
  const clientRows = raw.filter(r => {
    const v = r["client_name"] || r[Object.keys(r)[0]] || "";
    return v && v !== "client_name" && v !== "CONTENT KEY" && v !== "Client Name" && !v.startsWith("──");
  });

  const clients = clientRows.map(r => {
    const name = r["client_name"] || r[Object.keys(r)[0]] || "";
    const logo = r["client_logo_url (optional — leave blank if none)"] || r[Object.keys(r)[1]] || "";
    if (!name || name === "Client Name") return "";
    return logo
      ? `<div class="client-badge"><img src="${logo}" alt="${name}" /></div>`
      : `<div class="client-badge client-text">${name}</div>`;
  }).join("");

  // Testimonials
  const testRows = raw.filter(r => {
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
      <p class="testimonial-text">"${text}"</p>
      <div class="testimonial-author">
        <strong>${name}</strong>
        <span>${role}</span>
      </div>
    </div>`;
  }).join("");

  return `
  <section class="page-hero">
    <h1>${d.page_title || "Our Clients"}</h1>
    <p>${d.page_subtext || ""}</p>
  </section>
  <section class="section">
    <p style="text-align:center;max-width:680px;margin:0 auto 2rem;">${d.intro_text || ""}</p>
    ${clients ? `<div class="clients-grid">${clients}</div>` : ""}
  </section>
  ${testimonials ? `
  <section class="section section-alt">
    <div class="section-head"><h2>What Our Students Say</h2></div>
    <div class="testimonials-grid">${testimonials}</div>
  </section>` : ""}`;
}

// ── PAGE: Enquiry ─────────────────────────────────────────────
async function renderEnquiry() {
  const d = await getPageData("Enquiry");
  const wa = CONFIG["whatsapp_number"] || "";
  const phone = CONFIG["contact_phone"] || "";
  const email = CONFIG["contact_email"] || "";
  const address = CONFIG["contact_address"] || "";
  const ig = CONFIG["contact_instagram"] || "";

  return `
  <section class="page-hero">
    <h1>${d.page_title || "Get in Touch"}</h1>
    <p>${d.page_subtext || ""}</p>
  </section>
  <section class="section enquiry-section">
    <div class="enquiry-grid">
      <div class="contact-info">
        <h2>Contact Details</h2>
        <div class="contact-item">
          <span>📞</span><div><strong>Phone</strong><p><a href="tel:${phone}">${phone}</a></p></div>
        </div>
        <div class="contact-item">
          <span>✉️</span><div><strong>Email</strong><p><a href="mailto:${email}">${email}</a></p></div>
        </div>
        <div class="contact-item">
          <span>📍</span><div><strong>Address</strong><p>${address}</p></div>
        </div>
        <div class="contact-item">
          <span>📸</span><div><strong>Instagram</strong><p><a href="https://instagram.com/${ig}" target="_blank">@${ig}</a></p></div>
        </div>
        <div class="contact-item">
          <span>🕐</span><div><strong>Office Hours</strong><p>${d.office_hours || ""}</p></div>
        </div>
        <p class="wa-note">${d.whatsapp_cta_text || ""}</p>
        <a href="https://wa.me/${wa}" target="_blank" class="btn btn-primary" style="display:inline-block;margin-top:0.5rem;">📲 WhatsApp Us</a>
      </div>
      <div class="enquiry-form-wrap">
        <h2>${d.form_heading || "Send Us a Message"}</h2>
        <form id="enquiry-form" class="enquiry-form">
          <div class="form-group">
            <label>Your Name</label>
            <input type="text" name="name" placeholder="John Doe" required />
          </div>
          <div class="form-group">
            <label>Phone Number</label>
            <input type="tel" name="phone" placeholder="+91 XXXXX XXXXX" required />
          </div>
          <div class="form-group">
            <label>Email</label>
            <input type="email" name="email" placeholder="you@email.com" />
          </div>
          <div class="form-group">
            <label>Course Interested In</label>
            <select name="course">
              <option value="">Select a course...</option>
              <option>SAP ABAP</option>
              <option>SAP FICO</option>
              <option>SAP MM</option>
              <option>SAP SD</option>
              <option>SAP HCM</option>
              <option>SAP BASIS</option>
              <option>SAP PP</option>
              <option>SAP QM</option>
              <option>SAP S/4HANA</option>
              <option>Corporate Training</option>
              <option>SAP Consulting</option>
            </select>
          </div>
          <div class="form-group">
            <label>Message</label>
            <textarea name="message" placeholder="Tell us about yourself or your requirement..." rows="4"></textarea>
          </div>
          <button type="submit" class="btn btn-primary" style="width:100%;">Send via WhatsApp →</button>
          <p class="form-note">This form sends your message directly to our WhatsApp.</p>
        </form>
      </div>
    </div>
  </section>`;
}

// ── PAGE: T&C ─────────────────────────────────────────────────
async function renderTC() {
  const d = await getPageData("T&C");
  const sections = [1,2,3,4,5,6,7,8,9,10].filter(n => d[`section_${n}_heading`]).map(n => `
    <div class="tc-section">
      <h3>${d[`section_${n}_heading`]}</h3>
      <p>${d[`section_${n}_text`] || ""}</p>
    </div>`).join("");

  return `
  <section class="page-hero">
    <h1>${d.page_title || "Terms & Conditions"}</h1>
    <p>Last updated: ${d.last_updated || ""}</p>
  </section>
  <section class="section tc-page">
    <div class="tc-container">
      <p class="tc-intro">${d.intro_text || ""}</p>
      ${sections}
      ${d.contact_note ? `<div class="tc-contact-note">${d.contact_note}</div>` : ""}
    </div>
  </section>`;
}

// ── PAGE: Generic fallback ────────────────────────────────────
async function renderGeneric(sheetName) {
  const d = await getPageData(sheetName);
  const wa = CONFIG["whatsapp_number"] || "";

  const rows = Object.entries(d).map(([k, v]) => {
    if (!v || k.startsWith("_")) return "";
    const label = k.replace(/_/g, " ").replace(/\b\w/g, l => l.toUpperCase());
    return `<div class="generic-row"><strong>${label}</strong><p>${v}</p></div>`;
  }).join("");

  return `
  <section class="page-hero">
    <h1>${d.page_title || sheetName}</h1>
    ${d.page_subtext ? `<p>${d.page_subtext}</p>` : ""}
  </section>
  <section class="section">
    <div class="generic-content">${rows}</div>
    <div style="text-align:center;margin-top:2rem;">
      <a href="https://wa.me/${wa}" target="_blank" class="btn btn-primary">📲 Get in Touch</a>
    </div>
  </section>`;
}

// ── Enquiry Form → WhatsApp ───────────────────────────────────
function attachFormHandlers() {
  const form = document.getElementById("enquiry-form");
  if (!form) return;
  form.addEventListener("submit", e => {
    e.preventDefault();
    const name = form.name.value;
    const phone = form.phone.value;
    const email = form.email.value;
    const course = form.course.value;
    const message = form.message.value;
    const wa = CONFIG["whatsapp_number"] || "";
    const text = encodeURIComponent(
      `Hi SAPZCODES! I'd like to enquire.\n\n*Name:* ${name}\n*Phone:* ${phone}\n*Email:* ${email}\n*Course:* ${course}\n*Message:* ${message}`
    );
    window.open(`https://wa.me/${wa}?text=${text}`, "_blank");
  });
}

// ── Helpers ───────────────────────────────────────────────────
function toSlug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function toggleMobileMenu() {
  document.getElementById("nav-links").classList.toggle("open");
  document.getElementById("hamburger").classList.toggle("active");
}

function closeMobileMenu() {
  document.getElementById("nav-links").classList.remove("open");
  document.getElementById("hamburger").classList.remove("active");
}

function showError(msg, err) {
  console.error(err);
  document.getElementById("page-content").innerHTML = `
    <div class="error-page">
      <img src="logoforwhite.png" alt="SAPZCODES" style="max-width:200px;margin-bottom:1rem;opacity:0.3;" />
      <h2>Setup Required</h2>
      <p>${msg}</p>
      <p style="font-size:0.85rem;color:#999;margin-top:0.5rem;">Open <code>app.js</code> and set your <code>SHEET_ID</code>.</p>
    </div>`;
}
