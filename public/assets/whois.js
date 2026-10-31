document.documentElement.classList.add("js");

const $ = (sel) => document.querySelector(sel);

const ERROR_ZH = {
  NOT_CONFIGURED: "WHOIS 接口还没接上。请设置 WHOIS_API_BASE，指向本仓库的 who-dat。",
  INVALID_DOMAIN: "这不像一个可以注册的域名。试试 example.com。",
  UNSUPPORTED_TLD: "这个后缀暂时没有 RDAP 或 WHOIS 源。",
  RATE_LIMITED: "查询太密了，稍后再试。",
  UPSTREAM_TIMEOUT: "注册局超时。可以再查一次。",
  UPSTREAM_ERROR: "连不上 WHOIS API，或注册局没有返回可用数据。",
  NOT_FOUND: "没有这个接口。",
  METHOD_NOT_ALLOWED: "这个接口只接受 GET。",
  INTERNAL_ERROR: "查询服务内部出错。",
};

const ROLES = [
  ["registrant", "注册人"],
  ["admin", "管理联系人"],
  ["tech", "技术联系人"],
  ["billing", "账单联系人"],
];

let lastPayload = null;
let toastTimer = 0;

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function toast(text) {
  const el = $("#toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 1700);
}

function cleanQuery(raw) {
  let value = String(raw || "").trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try { value = new URL(value).hostname; } catch { /* keep */ }
  }
  return value.split(/[/?#]/)[0].replace(/:\d+$/, "").replace(/\.$/, "").toLowerCase();
}

function fmtDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return `${new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(date)} UTC`;
}

function field(value) {
  if (value === null || value === undefined || String(value).trim() === "") return "—";
  return String(value);
}

function paintError(message) {
  $("#resultEmpty").hidden = false;
  $("#resultEmpty").querySelector("p").textContent = message;
  $("#resultBody").hidden = true;
  $("#copyJson").hidden = true;
  $("#peopleBadge").textContent = "失败";
  $("#peopleBody").innerHTML = `<p class="dnsrec-empty">${esc(message)}</p>`;
  $("#statusPills").innerHTML = `<span class="pill pill-coral">失败</span>`;
  $("#nsList").innerHTML = "";
  $("#dnssecLine").textContent = "没有 DNSSEC 数据。";
  $("#metaKv").innerHTML = `<div class="kv-row"><dt>结果</dt><dd>${esc(message)}</dd></div>`;
}

function contactLine(contact) {
  if (!contact) return "未公开";
  const bits = [contact.organization, contact.name, contact.email, contact.phone].filter(Boolean);
  const address = contact.address || {};
  const place = [address.street, address.city, address.state, address.postalCode, address.country].filter(Boolean);
  if (place.length) bits.push(place.join("，"));
  if (!bits.length) return contact.redacted ? "未公开" : "没有填写";
  return bits.join(" · ");
}

function paintResult(data, ms) {
  lastPayload = data;
  const domain = data.domain || data.query || "—";
  $("#resultEmpty").hidden = true;
  $("#resultBody").hidden = false;
  $("#copyJson").hidden = false;
  $("#dTitle").textContent = "查询结果";
  $("#rDomain").textContent = domain;
  const unicode = data.domainUnicode && data.domainUnicode !== domain ? data.domainUnicode : "";
  $("#rUnicode").hidden = !unicode;
  $("#rUnicode").textContent = unicode;
  $("#rId").textContent = data.id ? `注册局编号 ${data.id}` : `后缀 ${data.tld || "—"}`;
  $("#rReg").textContent = data.isRegistered ? "已注册" : "未注册";
  $("#rReg").style.background = data.isRegistered ? "var(--lime)" : "var(--coral)";
  $("#rReg").style.color = data.isRegistered ? "var(--ink)" : "#fff";

  const registrar = data.registrar || {};
  const dates = data.dates || {};
  const rows = [
    ["注册商", field(registrar.name)],
    ["IANA ID", field(registrar.ianaId)],
    ["注册商网站", field(registrar.url)],
    ["WHOIS 服务器", field(registrar.whoisServer)],
    ["滥用邮箱", field(registrar.abuseEmail)],
    ["滥用电话", field(registrar.abusePhone)],
    ["经销商", field(registrar.reseller)],
    ["注册时间", fmtDate(dates.created)],
    ["更新时间", fmtDate(dates.updated)],
    ["到期时间", fmtDate(dates.expires)],
  ];
  $("#rKv").innerHTML = rows.map(([key, value]) => `<div class="kv-row"><dt>${esc(key)}</dt><dd>${esc(value)}</dd></div>`).join("");
  $("#rNote").textContent = `耗时 ${ms} ms。来源 ${data.meta?.source || "—"}。`;

  const statuses = Array.isArray(data.status) && data.status.length ? data.status : ["没有状态码"];
  $("#statusPills").innerHTML = statuses.map((item) => `<span class="pill">${esc(item)}</span>`).join("");

  const servers = Array.isArray(data.nameservers) ? data.nameservers : [];
  $("#nsList").innerHTML = servers.length
    ? servers.map((ns) => {
      const glue = [...(ns.ipv4 || []), ...(ns.ipv6 || [])];
      return `<div class="ns-item"><b>${esc(ns.name || "—")}</b>${glue.length ? `<span class="fine">${esc(glue.join("  "))}</span>` : ""}</div>`;
    }).join("")
    : `<p class="dnsrec-empty">没有名字服务器。</p>`;
  const dnssec = data.dnssec || {};
  const ds = Array.isArray(dnssec.dsData) ? dnssec.dsData.length : 0;
  $("#dnssecLine").textContent = dnssec.signed
    ? `DNSSEC 已签名${ds ? `，${ds} 条 DS` : ""}。`
    : "DNSSEC 未签名，或注册局没有给出 DS。";

  const contacts = data.contacts || {};
  const hiddenCount = ROLES.filter(([key]) => contacts[key]?.redacted && !contactLine(contacts[key]).includes("@") && contactLine(contacts[key]) === "未公开").length;
  $("#peopleBadge").textContent = hiddenCount === ROLES.length ? "均未公开" : "已返回";
  $("#peopleBody").innerHTML = ROLES.map(([key, label]) => {
    const line = contactLine(contacts[key]);
    return `<article class="person"><h3>${esc(label)}</h3><p>${esc(line)}</p></article>`;
  }).join("");

  const meta = data.meta || {};
  const metaRows = [
    ["协议", field(meta.source)],
    ["上游", field(meta.server)],
    ["取回时间", fmtDate(meta.fetchedAt)],
    ["缓存", meta.cached ? "命中" : "未命中"],
    ["本页耗时", `${ms} ms`],
  ];
  $("#metaKv").innerHTML = metaRows.map(([key, value]) => `<div class="kv-row"><dt>${esc(key)}</dt><dd>${esc(value)}</dd></div>`).join("");
  $("#ipLink").href = `/?q=${encodeURIComponent(domain)}`;
  $("#ipLink").textContent = `到 IP 页查 ${domain}`;
  $("#status").innerHTML = `<span class="dot dot-lime"></span>已返回 ${esc(domain)}`;
}

async function lookup(raw) {
  const domain = cleanQuery(raw);
  const err = $("#qErr");
  err.hidden = true;
  if (!domain || !domain.includes(".")) {
    err.textContent = "请输入域名，例如 example.com。";
    err.hidden = false;
    return;
  }
  $("#qInput").value = domain;
  $("#goBtn").disabled = true;
  $("#status").innerHTML = `<span class="dot dot-violet"></span>正在查询 ${esc(domain)} …`;
  const started = performance.now();
  try {
    const response = await fetch(`/api/whois/${encodeURIComponent(domain)}`, { headers: { accept: "application/json" } });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data || data.error) {
      const code = data?.error?.code || "UPSTREAM_ERROR";
      const message = ERROR_ZH[code] || data?.error?.message || `查询失败（HTTP ${response.status}）`;
      paintError(message);
      $("#status").innerHTML = `<span class="dot dot-coral"></span>${esc(message)}`;
      return;
    }
    paintResult(data, Math.round(performance.now() - started));
    const url = new URL(location.href);
    url.searchParams.set("q", domain);
    history.replaceState(null, "", url);
  } catch {
    const message = "网络请求失败。请确认页面和 WHOIS API 都在运行。";
    paintError(message);
    $("#status").innerHTML = `<span class="dot dot-coral"></span>${message}`;
  } finally {
    $("#goBtn").disabled = false;
  }
}

function reveal() {
  const seen = new IntersectionObserver((entries) => {
    entries.forEach((entry) => { if (entry.isIntersecting) entry.target.classList.add("in"); });
  }, { threshold: 0.08 });
  document.querySelectorAll(".cell").forEach((cell) => {
    seen.observe(cell);
    if (cell.getBoundingClientRect().top < window.innerHeight) cell.classList.add("in");
  });
}

const input = $("#qInput");
const unlock = () => input.removeAttribute("readonly");
input.addEventListener("focus", unlock);
input.addEventListener("pointerdown", unlock);
$("#qForm").addEventListener("submit", (event) => {
  event.preventDefault();
  lookup(input.value);
});
document.querySelectorAll("#chips .chip").forEach((button) => {
  button.addEventListener("click", () => {
    input.value = button.dataset.q;
    lookup(button.dataset.q);
  });
});
$("#copyJson").addEventListener("click", async () => {
  if (!lastPayload) return;
  try {
    await navigator.clipboard.writeText(JSON.stringify(lastPayload, null, 2));
    toast("已复制 JSON");
  } catch {
    toast("复制失败");
  }
});

reveal();
const initial = new URLSearchParams(location.search).get("q");
if (initial) {
  input.value = cleanQuery(initial);
  lookup(initial);
}
