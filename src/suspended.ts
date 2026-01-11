const params = new URLSearchParams(window.location.search);
const target = params.get("target") ?? "";
const title = params.get("title") ?? "";
const favicon = params.get("favicon") ?? "";

const titleEl = document.querySelector<HTMLHeadingElement>("#title");
const urlEl = document.querySelector<HTMLParagraphElement>("#url");
const faviconEl = document.querySelector<HTMLImageElement>("#favicon");
const openButton = document.querySelector<HTMLButtonElement>("#openNow");
const faviconLink = document.querySelector<HTMLLinkElement>("#faviconLink");

let displayTitle = "Pinned tab";
if (target) {
  try {
    displayTitle = new URL(target).hostname;
  } catch {
    displayTitle = target;
  }
}
if (title) {
  displayTitle = title;
}

if (titleEl) {
  titleEl.textContent = displayTitle;
}
document.title = displayTitle;

if (urlEl) {
  urlEl.textContent = target;
}

const fallbackFavicon = target
  ? `https://www.google.com/s2/favicons?sz=64&domain_url=${encodeURIComponent(target)}`
  : "";
const faviconSrc = favicon || fallbackFavicon;

if (faviconEl) {
  if (faviconSrc) {
    faviconEl.src = faviconSrc;
    faviconEl.alt = "";
  } else {
    faviconEl.remove();
  }
}

if (faviconLink && faviconSrc) {
  faviconLink.href = faviconSrc;
}

if (openButton) {
  openButton.addEventListener("click", () => {
    if (target) {
      window.location.href = target;
    }
  });
}
