document.documentElement.classList.add("js");

const $ = (sel) => document.querySelector(sel);

function reveal() {
  const seen = new IntersectionObserver((entries) => {
    entries.forEach((entry) => { if (entry.isIntersecting) entry.target.classList.add("in"); });
  }, { threshold: 0.08 });
  document.querySelectorAll(".cell").forEach((cell) => {
    seen.observe(cell);
    if (cell.getBoundingClientRect().top < window.innerHeight) cell.classList.add("in");
  });
}

async function fill() {
  try {
    const response = await fetch("/api/site", { headers: { accept: "application/json" } });
    if (!response.ok) return;
    const data = await response.json();
    const email = data?.contact?.email;
    if (email) {
      $("#mail").href = `mailto:${email}`;
      $("#mailText").textContent = email;
    }
    const url = data?.contact?.url;
    if (url) {
      const link = $("#link");
      link.hidden = false;
      link.href = url;
      link.textContent = data.contact.urlLabel || url;
    }
  } catch {
    /* 占位邮箱留在页面上 */
  }
}

reveal();
fill();
