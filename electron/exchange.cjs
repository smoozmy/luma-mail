const https = require("node:https");
const { URL } = require("node:url");
const { ntlm } = require("httpntlm");
const { XMLParser } = require("fast-xml-parser");

const EWS_NS = "http://schemas.microsoft.com/exchange/services/2006/";
const parser = new XMLParser({
  removeNSPrefix: true,
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: false,
});

const text = (value) => {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (typeof value === "object") return String(value["#text"] ?? "");
  return "";
};
const one = (value) => (Array.isArray(value) ? value[0] : value);
const list = (value) => (value == null ? [] : Array.isArray(value) ? value : [value]);

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function findNodes(value, name, result = []) {
  if (!value || typeof value !== "object") return result;
  for (const [key, child] of Object.entries(value)) {
    if (key === name) result.push(...list(child));
    if (child && typeof child === "object") findNodes(child, name, result);
  }
  return result;
}

function ewsEnvelope(body) {
  return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:m="${EWS_NS}messages" xmlns:t="${EWS_NS}types">
  <s:Header><t:RequestServerVersion Version="Exchange2016" /></s:Header>
  <s:Body>${body}</s:Body>
</s:Envelope>`;
}

function requestRaw(urlString, options, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    if (url.protocol !== "https:") return reject(new Error("Exchange требует защищённое HTTPS-соединение."));
    const payload = body == null ? "" : Buffer.from(String(body), "utf8");
    const headers = {
      Accept: "text/xml",
      ...(options.headers || {}),
      "Content-Length": payload.length,
      Connection: options.connection || "close",
    };
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: options.method || "POST",
        headers,
        agent: options.agent,
        timeout: options.timeout || 30000,
        rejectUnauthorized: true,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            statusCode: res.statusCode || 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on("timeout", () => req.destroy(new Error("Время ожидания Exchange истекло.")));
    req.on("error", reject);
    if (payload.length) req.write(payload);
    req.end();
  });
}

function ntlmChallenge(headers) {
  const values = Array.isArray(headers?.["www-authenticate"])
    ? headers["www-authenticate"]
    : [String(headers?.["www-authenticate"] || "")];
  for (const value of values) {
    const match = String(value).match(/(?:^|,\s*)NTLM\s+([A-Za-z0-9+/=]+)/i);
    if (match) return `NTLM ${match[1]}`;
  }
  return null;
}

function ntlmTargetDomain(type2) {
  const value = Buffer.isBuffer(type2?.targetName)
    ? type2.targetName.toString("utf16le")
    : String(type2?.targetName || "");
  const domain = value.replace(/\0/g, "").trim();
  return /^[a-z\d._-]{1,64}$/i.test(domain) ? domain : "";
}

async function ntlmRequest({ url, email, password, method = "POST", body = "", headers = {}, timeout = 30000 }) {
  const base = { username: email, password, domain: "", workstation: "Luma" };
  const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });
  const type1 = ntlm.createType1Message(base);
  const first = await requestRaw(url, {
    method,
    headers: { ...headers, Authorization: type1 },
    agent,
    connection: "keep-alive",
    timeout,
  }, body);
  if (first.statusCode !== 401) return first;
  const challenge = ntlmChallenge(first.headers);
  if (!challenge) throw new Error("Exchange не предложил NTLM-аутентификацию.");
  const type2 = ntlm.parseType2Message(challenge);
  const targetDomain = ntlmTargetDomain(type2);
  const localName = String(email).split("@")[0];
  const credentials = targetDomain
    ? { ...base, username: localName, domain: targetDomain }
    : base;
  const type3 = ntlm.createType3Message(type2, credentials);
  return requestRaw(url, {
    method,
    headers: { ...headers, Authorization: type3 },
    agent,
    connection: "close",
    timeout,
  }, body);
}

function responseError(parsed, fallback = "Exchange отклонил запрос.") {
  const response = one(parsed?.Envelope?.Body);
  const responseMessages = [
    "ResponseMessage",
    "FindItemResponseMessage",
    "GetFolderResponseMessage",
    "GetItemResponseMessage",
    "UpdateItemResponseMessage",
    "MoveItemResponseMessage",
    "DeleteItemResponseMessage",
    "CreateItemResponseMessage",
  ].flatMap((name) => findNodes(response, name));
  const error = responseMessages.find((item) => text(item?.ResponseClass) === "Error");
  if (!error) return null;
  return {
    message: text(error.MessageText) || fallback,
    code: text(error.ResponseCode),
    fieldUri: text(error.FieldURI),
  };
}

function folderShape() {
  return `<m:FolderShape><t:BaseShape>Default</t:BaseShape></m:FolderShape>`;
}

function itemShape(minimal = false) {
  const fields = minimal
    ? [
        "item:Subject", "item:DateTimeReceived", "item:Size",
        "item:HasAttachments", "message:From", "message:IsRead",
      ]
    : [
    "item:Subject", "item:DateTimeReceived", "item:Size", "item:HasAttachments",
    "message:From", "message:Sender", "item:DisplayTo", "item:DisplayCc",
    "message:IsRead", "message:InternetMessageId", "item:InReplyTo", "item:Flag",
      ];
  return `<m:ItemShape><t:BaseShape>IdOnly</t:BaseShape><t:AdditionalProperties>${fields
    .map((field) => `<t:FieldURI FieldURI="${field}" />`).join("")}</t:AdditionalProperties></m:ItemShape>`;
}

function findItemRequest(info, offset, limit, shape = itemShape()) {
  return `<m:FindItem Traversal="Shallow">${shape}<m:IndexedPageItemView MaxEntriesReturned="${limit}" Offset="${offset}" BasePoint="Beginning" /><m:SortOrder><t:FieldOrder Order="Descending"><t:FieldURI FieldURI="item:DateTimeReceived" /></t:FieldOrder></m:SortOrder><m:ParentFolderIds><t:FolderId Id="${escapeXml(info.ewsId)}" /></m:ParentFolderIds></m:FindItem>`;
}

const specialFolders = [
  ["inbox", "\\Inbox", "INBOX"],
  ["drafts", "\\Drafts", "Drafts"],
  ["sentitems", "\\Sent", "Sent Items"],
  ["junkemail", "\\Junk", "Junk Email"],
  ["deleteditems", "\\Trash", "Deleted Items"],
  ["archivemsgfolderroot", "\\Archive", "Archive"],
];

function folderFromNode(node, specialUse = null, forcedPath = null) {
  const id = one(node?.FolderId);
  const displayName = text(node?.DisplayName) || forcedPath || "Папка";
  return {
    ewsId: id?.["@_Id"],
    changeKey: id?.["@_ChangeKey"],
    name: specialUse ? forcedPath === "INBOX" ? "Входящие" : forcedPath : displayName,
    path: forcedPath || `ews:${id?.["@_Id"]}`,
    specialUse,
    total: Number(text(node?.TotalCount)) || 0,
    unread: Number(text(node?.UnreadCount)) || 0,
    delimiter: "/",
  };
}

function messageFromNode(node, folder) {
  const id = one(node?.ItemId);
  const from = one(node?.From?.Mailbox) || one(node?.Sender?.Mailbox) || {};
  return {
    ewsId: id?.["@_Id"],
    ewsChangeKey: id?.["@_ChangeKey"],
    folder,
    subject: text(node?.Subject) || "(Без темы)",
    from: text(from?.Name) || text(from?.EmailAddress) || "Неизвестный отправитель",
    fromAddress: text(from?.EmailAddress),
    replyTo: text(from?.EmailAddress),
    to: text(node?.DisplayTo),
    cc: text(node?.DisplayCc),
    date: text(node?.DateTimeReceived),
    read: text(node?.IsRead).toLowerCase() === "true",
    flagged: text(node?.Flag?.FlagStatus).toLowerCase() === "flagged",
    subjectId: id?.["@_Id"],
    hasAttachments: text(node?.HasAttachments).toLowerCase() === "true",
    size: Number(text(node?.Size)) || 0,
    messageId: text(node?.InternetMessageId),
    inReplyTo: text(node?.InReplyTo),
  };
}

function stableNumber(value) {
  let hash = 2166136261;
  for (const char of String(value || "")) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return Math.abs(hash >>> 0) || 1;
}

class ExchangeClient {
  constructor(account, secret) {
    this.account = account;
    this.email = account.email;
    this.password = secret.password;
    this.endpoint = account.host;
    this.folderCache = new Map();
    this.usable = false;
  }

  async call(body) {
    const response = await ntlmRequest({
      url: this.endpoint,
      email: this.email,
      password: this.password,
      headers: { "Content-Type": "text/xml; charset=utf-8" },
      body: ewsEnvelope(body),
    });
    if (response.statusCode === 401) {
      const error = new Error("Exchange не принял логин или пароль.");
      error.authenticationFailed = true;
      error.exchangeAuthenticationFailed = true;
      throw error;
    }
    const raw = response.body.toString("utf8");
    let parsed;
    try { parsed = parser.parse(raw); } catch { throw new Error("Exchange вернул некорректный XML."); }
    const error = responseError(parsed);
    if (error) {
      const failure = new Error(error.message);
      failure.exchangeResponseCode = error.code;
      failure.exchangeFieldUri = error.fieldUri;
      throw failure;
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      const failure = new Error(`Exchange вернул HTTP ${response.statusCode}.`);
      failure.exchangeHttpStatus = response.statusCode;
      failure.exchangeResponseSnippet = raw
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 260);
      throw failure;
    }
    return parsed;
  }

  async connect() {
    await this.getSpecialFolder("inbox");
    this.usable = true;
    return this;
  }

  close() {
    this.usable = false;
  }

  async getSpecialFolder(id) {
    const response = await this.call(`<m:GetFolder>${folderShape()}<m:FolderIds><t:DistinguishedFolderId Id="${id}" /></m:FolderIds></m:GetFolder>`);
    const node = findNodes(response, "Folder")[0];
    if (!node) throw new Error("Exchange не вернул папку.");
    return node;
  }

  async listFolders() {
    const result = [];
    const byId = new Map();
    let offset = 0;
    while (true) {
      const response = await this.call(`<m:FindFolder Traversal="Deep">${folderShape()}<m:IndexedPageFolderView MaxEntriesReturned="500" Offset="${offset}" BasePoint="Beginning" /><m:ParentFolderIds><t:DistinguishedFolderId Id="msgfolderroot" /></m:ParentFolderIds></m:FindFolder>`);
      const root = findNodes(response, "RootFolder")[0] || {};
      const nodes = findNodes(root, "Folder");
      for (const node of nodes) {
        const folder = folderFromNode(node);
        if (folder.ewsId && !byId.has(folder.ewsId)) { byId.set(folder.ewsId, folder); result.push(folder); }
      }
      const total = Number(root["@_TotalItemsInView"]) || 0;
      const last = String(root["@_IncludesLastItemInRange"]).toLowerCase() === "true";
      if (last || !nodes.length || offset + nodes.length >= total) break;
      offset += nodes.length;
    }
    for (const [id, specialUse, path] of specialFolders) {
      try {
        const node = await this.getSpecialFolder(id);
        const folder = folderFromNode(node, specialUse, path);
        if (!folder.ewsId) continue;
        const existing = byId.get(folder.ewsId);
        if (existing) Object.assign(existing, folder);
        else { byId.set(folder.ewsId, folder); result.push(folder); }
      } catch (error) {
        if (id === "inbox") throw error;
      }
    }
    this.folderCache.clear();
    for (const folder of result) this.folderCache.set(folder.path, folder);
    return result;
  }

  async findMessages(folder, offset = 0, limit = 300) {
    const safeLimit = Math.min(Math.max(Number(limit) || 300, 1), 1000);
    const safeOffset = Math.max(Number(offset) || 0, 0);
    const info = this.folderCache.get(folder) || folder;
    const request = (shape) => this.call(findItemRequest(info, safeOffset, safeLimit, shape));
    let response;
    try {
      response = await request(itemShape());
    } catch (error) {
      const retryable = ["ErrorInvalidPropertyRequest", "ErrorSchemaValidation", "ErrorInvalidPropertyForOperation"];
      if (!retryable.includes(error.exchangeResponseCode) && error.exchangeHttpStatus !== 500) throw error;
      response = await request(itemShape(true));
    }
    const root = findNodes(response, "RootFolder")[0] || {};
    return {
      total: Number(root["@_TotalItemsInView"]) || 0,
      items: findNodes(root, "Message").map((node) => messageFromNode(node, folder)),
    };
  }

  async getRawMessage(ewsId, changeKey) {
    const response = await this.call(`<m:GetItem><m:ItemShape><t:BaseShape>IdOnly</t:BaseShape><t:IncludeMimeContent>true</t:IncludeMimeContent></m:ItemShape><m:ItemIds><t:ItemId Id="${escapeXml(ewsId)}" ChangeKey="${escapeXml(changeKey || "")}" /></m:ItemIds></m:GetItem>`);
    const item = findNodes(response, "Message")[0];
    const content = text(item?.MimeContent).replace(/^<!\[CDATA\[|\]\]>$/g, "");
    if (!content) throw new Error("Exchange не вернул содержимое письма.");
    return Buffer.from(content, "base64");
  }

  async updateItem(ewsId, changeKey, field, value) {
    const fieldXml = field === "read"
      ? `<t:FieldURI FieldURI="message:IsRead" /><t:Message><t:IsRead>${value ? "true" : "false"}</t:IsRead></t:Message>`
      : `<t:FieldURI FieldURI="item:Flag" /><t:Item><t:Flag><t:FlagStatus>${value ? "Flagged" : "NotFlagged"}</t:FlagStatus></t:Flag></t:Item>`;
    await this.call(`<m:UpdateItem MessageDisposition="SaveOnly" ConflictResolution="AutoResolve"><m:ItemChange><t:Updates><t:SetItemField>${fieldXml}</t:SetItemField></t:Updates><t:ItemId Id="${escapeXml(ewsId)}" ChangeKey="${escapeXml(changeKey || "")}" /></m:ItemChange></m:UpdateItem>`);
  }

  async moveItem(ewsId, changeKey, destination) {
    const target = this.folderCache.get(destination) || destination;
    await this.call(`<m:MoveItem><m:ToFolderId><t:FolderId Id="${escapeXml(target.ewsId)}" ChangeKey="${escapeXml(target.changeKey || "")}" /></m:ToFolderId><m:ItemIds><t:ItemId Id="${escapeXml(ewsId)}" ChangeKey="${escapeXml(changeKey || "")}" /></m:ItemIds></m:MoveItem>`);
  }

  async markAllRead(folder) {
    let offset = 0;
    while (true) {
      const page = await this.findMessages(folder, offset, 1000);
      for (const item of page.items) {
        if (!item.read) await this.updateItem(item.ewsId, item.ewsChangeKey, "read", true);
      }
      if (!page.items.length || offset + page.items.length >= page.total) break;
      offset += page.items.length;
    }
  }

  async deleteItems(folder) {
    const result = await this.findMessages(folder, 0, 1000);
    if (!result.items.length) return;
    await this.call(`<m:DeleteItem DeleteType="HardDelete" SendMeetingCancellations="SendToNone" AffectedTaskOccurrences="AllOccurrences"><m:ItemIds>${result.items.map((item) => `<t:ItemId Id="${escapeXml(item.ewsId)}" ChangeKey="${escapeXml(item.ewsChangeKey || "")}" />`).join("")}</m:ItemIds></m:DeleteItem>`);
  }

  async sendMime(message) {
    await this.call(`<m:CreateItem MessageDisposition="SendAndSaveCopy"><m:SavedItemFolderId><t:DistinguishedFolderId Id="sentitems" /></m:SavedItemFolderId><m:Items><t:Message><t:MimeContent CharacterSet="UTF-8">${Buffer.from(message).toString("base64")}</t:MimeContent></t:Message></m:Items></m:CreateItem>`);
  }
}

function domainOf(email) {
  const domain = String(email).split("@")[1]?.toLowerCase();
  if (!domain || !/^[a-z\d.-]+$/.test(domain)) throw new Error("Некорректный домен Exchange.");
  return domain;
}

function isAllowedHost(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

async function discover(email, password) {
  const domain = domainOf(email);
  const candidates = [
    `https://autodiscover.${domain}/autodiscover/autodiscover.xml`,
    `https://${domain}/autodiscover/autodiscover.xml`,
  ];
  const requestBody = `<?xml version="1.0" encoding="utf-8"?><Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/requestschema/2006"><Request><EMailAddress>${escapeXml(email)}</EMailAddress><AcceptableResponseSchema>http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a</AcceptableResponseSchema></Request></Autodiscover>`;
  let authenticationFailed = false;
  for (const url of candidates) {
    try {
      const host = new URL(url).hostname;
      if (!isAllowedHost(host, domain)) continue;
      const response = await ntlmRequest({
        url, email, password, body: requestBody,
        headers: { "Content-Type": "text/xml; charset=utf-8" },
      });
      if (response.statusCode === 401) authenticationFailed = true;
      if (response.statusCode < 200 || response.statusCode >= 300) continue;
      const match = response.body.toString("utf8").match(/<EwsUrl[^>]*>([^<]+)<\/EwsUrl>/i);
      if (match) {
        const endpoint = new URL(match[1].trim());
        if (endpoint.protocol === "https:" && isAllowedHost(endpoint.hostname, domain)) return endpoint.href;
      }
    } catch (error) {
      if (error.authenticationFailed || error.exchangeAuthenticationFailed)
        authenticationFailed = true;
    }
  }
  const hosts = [`owa.${domain}`, `mail.${domain}`, `exchange.${domain}`, domain];
  for (const host of hosts) {
    const endpoint = `https://${host}/EWS/Exchange.asmx`;
    try {
      const client = new ExchangeClient({ email, host: endpoint }, { password });
      await client.connect();
      return endpoint;
    } catch (error) {
      if (error.authenticationFailed || error.exchangeAuthenticationFailed)
        authenticationFailed = true;
    }
  }
  if (authenticationFailed) {
    const error = new Error("Exchange не принял логин или пароль.");
    error.authenticationFailed = true;
    error.exchangeAuthenticationFailed = true;
    throw error;
  }
  const error = new Error("Не удалось найти Exchange EWS по Autodiscover. Проверьте VPN или обратитесь к ИТ за адресом EWS.");
  error.exchangeDiscovery = true;
  throw error;
}

module.exports = { ExchangeClient, discover, stableNumber, itemShape, findItemRequest };
