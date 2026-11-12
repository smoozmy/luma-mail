const sanitize = require("sanitize-html");
const crypto = require("node:crypto");
const PROVIDERS = {
  icloud: { label: "iCloud", host: "imap.mail.me.com" },
  gmail: { label: "Google", host: "imap.gmail.com" },
  yandex: { label: "Яндекс", host: "imap.yandex.ru" },
  microsoft: { label: "Microsoft 365", host: "outlook.office365.com" },
  exchange: { label: "Exchange / OWA", host: "" },
};
function validateAccount(input) {
  if (!input || !Object.hasOwn(PROVIDERS, input.provider))
    throw new Error("Выберите почтовую службу.");
  const email = String(input.email || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new Error("Введите полный адрес электронной почты.");
  if (
    input.provider !== "microsoft" &&
    (typeof input.password !== "string" ||
      !input.password ||
      input.password.length > 1024)
  )
    throw new Error("Введите пароль приложения.");
  if (
    input.provider === "microsoft" &&
    !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(
      input.clientId || "",
    )
  )
    throw new Error("Введите Application (client) ID приложения Microsoft.");
  return {
    id: crypto.randomUUID(),
    provider: input.provider,
    email,
    name: String(input.name || PROVIDERS[input.provider].label).slice(0, 80),
    host: PROVIDERS[input.provider].host,
    clientId: input.clientId || undefined,
  };
}
function normalizedText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("ru");
}
function emailContent(html) {
  const source = String(html || "");
  const body = source.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  const content = body ? body[1] : source;
  return content
    .replace(/<!doctype\b[^>]*>/gi, "")
    .replace(/<head\b[\s\S]*?<\/head>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/<title\b[\s\S]*?<\/title>/gi, "")
    .replace(/<(?:meta|link)\b[^>]*>/gi, "");
}
function safeEmailStyles(html, remote) {
  const styles = [...String(html || "").matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)]
    .map((match) => String(match[1] || ""))
    .map((css) =>
      css
        .replace(/<\/?style[^>]*>/gi, "")
        .replace(/@import\b[^;{}]*(?:;|$)/gi, "")
        .replace(/@font-face\b[^{]*\{[\s\S]*?\}/gi, "")
        .replace(/url\s*\(\s*(['"]?)([^)]*?)\1\s*\)/gi, (full, quote, value) => {
          const url = String(value || "").trim();
          if (/^data:image\/(?:png|jpe?g|gif|webp);base64,/i.test(url)) return `url("${url}")`;
          if (remote && /^https?:\/\//i.test(url)) return `url("${url}")`;
          return "none";
        })
        .replace(/(?:javascript|vbscript|file)\s*:/gi, "")
        .replace(/<\/?script[^>]*>/gi, "")
        .trim(),
    )
    .filter(Boolean);
  return styles.length ? `<style>${styles.join("\n")}</style>` : "";
}
function cleanHtml(html, attachments = [], remote = true, subject = "") {
  const inline = new Map(
    attachments
      .filter(
        (a) =>
          a.cid &&
          /^image\/(png|jpeg|gif|webp)$/.test(a.type) &&
          a.content?.length < 7e6,
      )
      .map((a) => [a.cid, `data:${a.type};base64,${a.content}`]),
  );
  const duplicateSubject = normalizedText(subject);
  let removedDuplicateSubject = false;
  const styles = safeEmailStyles(html, remote);
  const sanitized = sanitize(emailContent(html), {
    allowedTags: sanitize.defaults.allowedTags.concat([
      "article",
      "center",
      "figure",
      "figcaption",
      "font",
      "footer",
      "header",
      "h1",
      "h2",
      "hr",
      "img",
      "main",
      "section",
    ]),
    allowedAttributes: {
      "*": [
        "style",
        "class",
        "id",
        "dir",
        "lang",
        "title",
        "align",
        "valign",
        "width",
        "height",
        "bgcolor",
        "background",
        "role",
      ],
      a: ["href", "title", "target", "name"],
      font: ["color", "face", "size"],
      img: ["src", "alt", "width", "height", "border", "align"],
      td: ["colspan", "rowspan", "width", "height", "align", "valign"],
      th: ["colspan", "rowspan", "width", "height", "align", "valign"],
      table: [
        "width",
        "height",
        "cellpadding",
        "cellspacing",
        "border",
        "align",
        "valign",
      ],
    },
    allowedSchemes: ["https", "http", "mailto"],
    allowedSchemesByTag: { img: ["https", "http", "data"] },
    allowProtocolRelative: false,
    allowedStyles: {
      "*": {
        color: [/^#[a-f\d]{3,8}$/i, /^[a-z]+$/i, /^rgba?\([\d\s.,%]+\)$/],
        "background-color": [/^#[a-f\d]{3,8}$/i, /^[a-z]+$/i],
        background: [/^#[a-f\d]{3,8}$/i, /^[a-z]+$/i, /^rgba?\([\d\s.,%]+\)$/i],
        "background-image": [
          /^none$/i,
          /^url\(\s*["']?(?:https?:\/\/[^"')\s]+|data:image\/(?:png|jpe?g|gif|webp);base64,[^"')\s]+)["']?\s*\)$/i,
        ],
        "font-family": [/^(?!.*url\()[^<>]{1,160}$/i],
        "font-size": [/^-?\d+(\.\d+)?(px|pt|em|rem|%)$/],
        "font-style": [/^(normal|italic|oblique)$/i],
        "font-weight": [/^(normal|bold|[1-9]00)$/],
        "letter-spacing": [/^-?[\d.]+(px|pt|em|rem|%)$/],
        "line-height": [/^(normal|[\d.]+|[\d.]+(px|pt|em|rem|%))$/i],
        "text-align": [/^(left|right|center|justify|start|end)$/],
        "text-decoration": [/^(none|underline|overline|line-through)(\s+[a-z-]+)*$/i],
        "vertical-align": [/^(baseline|top|middle|bottom|sub|super)$/i],
        border: [/^(?!.*url\()[^<>]{1,120}$/i],
        "border-radius": [/^(?!.*url\()[\d\s.%pxemrem-]{1,80}$/i],
        padding: [/^(?!.*url\()[\d\s.%pxemrem-]{1,80}$/i],
        margin: [/^(?!.*url\()[\d\s.%pxemrem-]{1,80}$/i],
        width: [/^(?!.*url\()\d+(\.\d+)?(px|pt|em|rem|%)?$/i],
        height: [/^(?!.*url\()\d+(\.\d+)?(px|pt|em|rem|%)?$/i],
        "min-width": [/^(?!.*url\()\d+(\.\d+)?(px|pt|em|rem|%)?$/i],
        "max-width": [/^(?!.*url\()\d+(\.\d+)?(px|pt|em|rem|%)?$/i],
        display: [/^(block|inline|inline-block|table|table-row|table-cell|none)$/i],
      },
    },
    exclusiveFilter: (frame) => {
      if (
        removedDuplicateSubject ||
        duplicateSubject.length < 4 ||
        !/^h[1-6]$/i.test(frame.tag) ||
        normalizedText(frame.text) !== duplicateSubject
      )
        return false;
      removedDuplicateSubject = true;
      return true;
    },
    transformTags: {
      img: (tag, attrs) => {
        const src = attrs.src || "";
        return {
          tagName: "img",
          attribs: {
            ...attrs,
            src: src.startsWith("cid:")
              ? inline.get(src.slice(4)) || ""
              : remote && /^https?:\/\//i.test(src)
                ? src
                : "",
          },
        };
      },
    },
  });
  return `${styles}${sanitized}`;
}
function threadKey(message) {
  return (
    message.accountId +
    ":" +
    (message.references?.[0] ||
      message.inReplyTo ||
      message.messageId ||
      message.id)
  );
}
function publicAccount({ secret, ...account }) {
  return account;
}
function safeError(error) {
  if (error.exchangeAuthenticationFailed)
    return "Exchange/OWA не принял адрес или пароль. Проверьте данные и подключение к корпоративной сети/VPN.";
  if (error.exchangeDiscovery)
    return "Не удалось найти Exchange через Autodiscover. Проверьте VPN или обратитесь к ИТ за адресом EWS.";
  if (error.exchangeResponseCode) {
    const code = String(error.exchangeResponseCode).replace(/[^A-Za-z0-9_.-]/g, "");
    const field = String(error.exchangeFieldUri || "").replace(/[^A-Za-z0-9_:.-]/g, "");
    return `Exchange отклонил запрос (${code || "ошибка"})${field ? `: ${field}` : ""}.`;
  }
  if (error.exchangeHttpStatus) {
    const snippet = String(error.exchangeResponseSnippet || "")
      .replace(/[<>]/g, "")
      .replace(/[^\p{L}\p{N}\s.,:;_()\-/]/gu, "")
      .trim();
    return `Exchange вернул HTTP ${Number(error.exchangeHttpStatus) || "ошибку"}.${snippet ? ` ${snippet}` : " Проверьте адрес EWS и доступ к корпоративной сети/VPN."}`;
  }
  if (
    error.authenticationFailed ||
    /AUTH|credential|password|login|Exchange не принял/i.test(error.message || "")
  )
    return "Не удалось войти. Проверьте адрес, пароль и разрешение IMAP/EWS на сервере.";
  if (/ENOTFOUND|ETIMEDOUT|ECONN|socket|timeout/i.test(error.message || ""))
    return "Нет соединения с почтовым сервером. Проверьте интернет; подключение будет повторено.";
  return "Не удалось выполнить действие. Попробуйте ещё раз.";
}
module.exports = {
  PROVIDERS,
  validateAccount,
  cleanHtml,
  safeEmailStyles,
  threadKey,
  publicAccount,
  safeError,
};
