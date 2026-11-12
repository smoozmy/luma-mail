const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");
const { publicAccount, safeError } = require("./core.cjs");
const microsoft = require("./microsoft.cjs");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const nodemailer = require("nodemailer");
const { SMTP, validateOutgoing, buildOutgoing } = require("./outgoing.cjs");
const { ExchangeClient, stableNumber } = require("./exchange.cjs");
const folderKey = (id, folder) =>
  folder === "INBOX" ? id : `${id}::${folder}`;
const messageKey = (id, folder, validity, uid) =>
  `${folder === "INBOX" ? id : id + "-f" + createHash("sha256").update(folder).digest("hex").slice(0, 16)}_${validity}_${uid}`;
const inFolder = (m, id, folder) =>
  m.accountId === id && (m.folder || "INBOX") === folder;
const hasAttachment = (node) =>
  !!node &&
  (node.disposition?.toLowerCase() === "attachment" ||
    !!node.dispositionParameters?.filename ||
    node.childNodes?.some(hasAttachment));
class MailService {
  constructor(store, emit) {
    this.store = store;
    this.emit = emit;
    this.connections = new Map();
    this.connecting = new Map();
    this.pendingClients = new Set();
    this.busy = new Map();
    this.timers = new Map();
    this.folderRefresh = new Map();
    this.sending = new Set();
    this.transportFactory = (options) => nodemailer.createTransport(options);
    this.status = {};
    this.stopped = false;
  }
  snapshot() {
    return {
      accounts: this.store.state.accounts.map(publicAccount),
      messages: this.store.state.messages,
      settings: this.store.state.settings,
      status: this.status,
      folders: this.store.state.folders,
      smartBoxes: this.store.state.smartBoxes,
      assistant: {
        verdicts: this.store.state.assistant?.verdicts || {},
      },
      drafts: this.store.state.drafts.map((d) => ({
        ...d,
        attachments: (d.attachmentIds || [])
          .map((id) => this.store.state.files[id])
          .filter(Boolean),
      })),
    };
  }
  change() {
    this.emit("state", this.snapshot());
  }
  async client(account, signal) {
    if (this.connecting.has(account.id)) return this.connecting.get(account.id);
    const job = this.openClient(account, signal).finally(() =>
      this.connecting.delete(account.id),
    );
    this.connecting.set(account.id, job);
    return job;
  }
  async openClient(account, signal) {
    let client = this.connections.get(account.id);
    if (client?.usable) return client;
    const secret = this.store.decrypt(account.secret);
    if (account.provider === "exchange") {
      client = new ExchangeClient(account, secret);
      const abort = () => client.close?.();
      signal?.addEventListener("abort", abort, { once: true });
      try {
        signal?.throwIfAborted();
        await client.connect();
        signal?.throwIfAborted();
        this.connections.set(account.id, client);
        return client;
      } catch (e) {
        client.close?.();
        throw e;
      } finally {
        signal?.removeEventListener("abort", abort);
      }
    }
    let auth = { user: account.email, pass: secret.password };
    if (account.provider === "microsoft") {
      if (!secret.expiresAt || secret.expiresAt < Date.now() + 60000) {
        const next = await microsoft.refresh(
          account.clientId,
          secret.refresh_token,
        );
        Object.assign(secret, next, {
          expiresAt: Date.now() + next.expires_in * 1000,
        });
        account.secret = this.store.encrypt(secret);
        this.store.save();
      }
      auth = { user: account.email, accessToken: secret.access_token };
    }
    client = new ImapFlow({
      host: account.host,
      port: 993,
      secure: true,
      auth,
      logger: false,
      socketTimeout: 120000,
      maxIdleTime: 60000,
      tls: { minVersion: "TLSv1.2" },
    });
    client.on("error", () => {});
    client.on("exists", () => {
      if (!this.busy.has(account.id)) this.sync(account.id).catch(() => {});
    });
    client.on("close", () => {
      if (this.connections.get(account.id) === client) {
        this.connections.delete(account.id);
        if (!this.stopped) {
          this.status[account.id] = {
            state: "offline",
            error: "Соединение прервано. Переподключение…",
          };
          this.change();
        }
      }
    });
    this.pendingClients.add(client);
    const abort = () => client.close();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      signal?.throwIfAborted();
      await client.connect();
      signal?.throwIfAborted();
      this.connections.set(account.id, client);
      return client;
    } catch (e) {
      client.close();
      throw e;
    } finally {
      this.pendingClients.delete(client);
      signal?.removeEventListener("abort", abort);
    }
  }
  async add(account, secret, signal) {
    account.secret = this.store.encrypt(secret);
    const client = await this.client(account, signal);
    try {
      signal?.throwIfAborted();
      if (account.provider === "exchange") await client.getSpecialFolder("inbox");
      else await client.mailboxOpen("INBOX", { readOnly: false });
    } catch (e) {
      client.close();
      throw e;
    }
    signal?.throwIfAborted();
    this.store.state.accounts.push(account);
    this.store.save();
    this.schedule(account.id);
    this.sync(account.id).catch(() => {});
    return publicAccount(account);
  }
  schedule(id) {
    if (this.timers.has(id)) clearInterval(this.timers.get(id));
    this.timers.set(
      id,
      setInterval(() => this.sync(id).catch(() => {}), 60000),
    );
  }
  start() {
    for (const a of this.store.state.accounts) {
      this.schedule(a.id);
      this.sync(a.id).catch(() => {});
    }
  }
  sync(id, older = false, folder = "INBOX") {
    const key = folderKey(id, folder);
    if (this.busy.has(key)) return this.busy.get(key);
    const job = this.performSync(id, older, folder)
      .then(async () => {
        const pending = this.store.state.messages
          .filter(
            (m) =>
              inFolder(m, id, folder) &&
              !m.previewLoaded &&
              m.size < 512 * 1024,
          )
          .sort((a, b) => new Date(b.date) - new Date(a.date))
          .slice(0, 20);
        for (const m of pending) {
          if (
            this.stopped ||
            !this.store.state.accounts.some((a) => a.id === id)
          )
            break;
          try {
            await this.body(m.id);
          } catch {
            break;
          }
        }
      })
      .finally(() => this.busy.delete(key));
    this.busy.set(key, job);
    return job;
  }
  async performSync(id, older, folder = "INBOX") {
    const account = this.store.state.accounts.find((a) => a.id === id);
    if (!account) return;
    this.status[id] = { ...this.status[id], state: "syncing", error: null };
    this.change();
    if (account.provider === "exchange")
      return this.performExchangeSync(account, older, folder);
    let lock;
    try {
      const client = await this.client(account);
      if (
        !this.folderRefresh.has(id) ||
        Date.now() - this.folderRefresh.get(id) > 300000
      )
        await this.listFolders(id);
      if (
        !this.store.state.folders.some(
          (f) => f.accountId === id && f.path === folder,
        )
      )
        throw new Error("Папка не найдена на сервере.");
      lock = await client.getMailboxLock(folder);
      const validity = Number(client.mailbox.uidValidity);
      const syncKey = folderKey(id, folder);
      let meta = this.store.state.sync[syncKey];
      if (!meta || meta.validity !== validity) {
        for (const m of this.store.state.messages.filter((m) =>
          inFolder(m, id, folder),
        ))
          this.store.dropBody(m.id);
        this.store.state.messages = this.store.state.messages.filter(
          (m) => !inFolder(m, id, folder),
        );
        meta = this.store.state.sync[syncKey] = { validity, loaded: 0 };
      }
      const all = (await client.search({ all: true }, { uid: true })) || [];
      const oldIds = new Set(
        this.store.state.messages
          .filter((m) => inFolder(m, id, folder))
          .map((m) => m.uid),
      );
      const targetCount = Math.min(
        all.length,
        Math.max(meta.loaded || 0, 300) + (older ? 300 : 0),
      );
      const desired = all.slice(-targetCount);
      const desiredSet = new Set(all);
      for (const m of this.store.state.messages.filter(
        (m) => inFolder(m, id, folder) && !desiredSet.has(m.uid),
      ))
        this.store.dropBody(m.id);
      this.store.state.messages = this.store.state.messages.filter(
        (m) => !inFolder(m, id, folder) || desiredSet.has(m.uid),
      );
      let newCount = 0;
      for (let offset = 0; offset < desired.length; offset += 100) {
        for await (const m of client.fetch(
          desired.slice(offset, offset + 100).join(","),
          {
            uid: true,
            envelope: true,
            flags: true,
            size: true,
            bodyStructure: true,
          },
          { uid: true },
        )) {
          const key = messageKey(id, folder, validity, m.uid);
          const existing = this.store.state.messages.find((x) => x.id === key);
          const env = m.envelope || {};
          const parsedDate = new Date(env.date || Date.now());
          const next = {
            id: key,
            accountId: id,
            folder,
            folderRole:
              this.store.state.folders.find(
                (f) => f.accountId === id && f.path === folder,
              )?.specialUse || null,
            hasAttachments:
              existing?.hasAttachments || !!hasAttachment(m.bodyStructure),
            uid: m.uid,
            validity,
            subject: env.subject || "(Без темы)",
            from:
              env.from?.[0]?.name ||
              env.from?.[0]?.address ||
              "Неизвестный отправитель",
            fromAddress: env.from?.[0]?.address || "",
            replyTo: env.replyTo?.[0]?.address || env.from?.[0]?.address || "",
            cc:
              env.cc
                ?.map((x) => x.address)
                .filter(Boolean)
                .join(", ") || "",
            to: env.to?.map((x) => x.address).join(", ") || account.email,
            date: (Number.isNaN(parsedDate.getTime())
              ? new Date()
              : parsedDate
            ).toISOString(),
            read: m.flags.has("\\Seen"),
            flagged: m.flags.has("\\Flagged"),
            messageId: env.messageId,
            inReplyTo: env.inReplyTo,
            preview: existing?.preview || "",
            previewLoaded: existing?.previewLoaded || false,
            references: existing?.references || [],
            searchText: existing?.searchText || "",
            size: m.size,
          };
          if (existing) Object.assign(existing, next);
          else {
            this.store.state.messages.push(next);
            if (!oldIds.has(m.uid)) newCount++;
          }
        }
      }
      const hadSync = !!meta.lastSync;
      Object.assign(meta, {
        loaded: desired.length,
        total: all.length,
        lastSync: new Date().toISOString(),
      });
      const folderInfo = this.store.state.folders.find(
        (f) => f.accountId === id && f.path === folder,
      );
      if (folderInfo) {
        const serverStatus =
          typeof client.status === "function"
            ? await client.status(folder, { unseen: true })
            : null;
        Object.assign(folderInfo, {
          total: all.length,
          loaded: desired.length,
          unread:
            serverStatus?.unseen ??
            this.store.state.messages.filter(
              (m) => inFolder(m, id, folder) && !m.read,
            ).length,
        });
      }
      this.store.save();
      this.status[id] = {
        state: "online",
        total: all.length,
        loaded: desired.length,
        lastSync: meta.lastSync,
      };
      this.change();
      if (folder === "INBOX" && hadSync && newCount && !older)
        this.emit("new-mail", {
          account: publicAccount(account),
          count: newCount,
        });
    } catch (error) {
      this.status[id] = {
        ...this.status[id],
        state: "error",
        error: safeError(error),
      };
      this.change();
      throw new Error(safeError(error));
    } finally {
      lock?.release();
    }
  }

  async performExchangeSync(account, older, folder = "INBOX") {
    const id = account.id;
    try {
      const client = await this.client(account);
      if (
        !this.folderRefresh.has(id) ||
        Date.now() - this.folderRefresh.get(id) > 300000
      )
        await this.listFolders(id);
      const folderInfo = this.store.state.folders.find(
        (item) => item.accountId === id && item.path === folder,
      );
      if (!folderInfo?.ewsId) throw new Error("Папка Exchange не найдена на сервере.");
      const validity = stableNumber(folderInfo.ewsId);
      const syncKey = folderKey(id, folder);
      let meta = this.store.state.sync[syncKey];
      if (!meta || meta.validity !== validity) {
        for (const message of this.store.state.messages.filter((m) =>
          inFolder(m, id, folder),
        )) this.store.dropBody(message.id);
        this.store.state.messages = this.store.state.messages.filter(
          (m) => !inFolder(m, id, folder),
        );
        meta = this.store.state.sync[syncKey] = { validity, loaded: 0 };
      }
      const targetCount = Math.min(
        1000,
        Math.max(meta.loaded || 0, 300) + (older ? 300 : 0),
      );
      const result = await client.findMessages(folder, 0, targetCount);
      const oldIds = new Set(
        this.store.state.messages
          .filter((m) => inFolder(m, id, folder))
          .map((m) => m.uid),
      );
      const desiredSet = new Set(result.items.map((item) => stableNumber(item.ewsId)));
      for (const message of this.store.state.messages.filter(
        (m) => inFolder(m, id, folder) && !desiredSet.has(m.uid),
      )) this.store.dropBody(message.id);
      this.store.state.messages = this.store.state.messages.filter(
        (m) => !inFolder(m, id, folder) || desiredSet.has(m.uid),
      );
      let newCount = 0;
      for (const item of result.items) {
        const uid = stableNumber(item.ewsId);
        const key = messageKey(id, folder, validity, uid);
        const existing = this.store.state.messages.find((message) => message.id === key);
        const parsedDate = new Date(item.date || Date.now());
        const next = {
          id: key,
          accountId: id,
          folder,
          folderRole: folderInfo.specialUse || null,
          ewsId: item.ewsId,
          ewsChangeKey: item.ewsChangeKey,
          hasAttachments: existing?.hasAttachments || item.hasAttachments,
          uid,
          validity,
          subject: item.subject,
          from: item.from,
          fromAddress: item.fromAddress,
          replyTo: item.replyTo || item.fromAddress,
          cc: item.cc || "",
          to: item.to || account.email,
          date: Number.isNaN(parsedDate.getTime()) ? new Date().toISOString() : parsedDate.toISOString(),
          read: item.read,
          flagged: item.flagged,
          messageId: item.messageId,
          inReplyTo: item.inReplyTo,
          preview: existing?.preview || "",
          previewLoaded: existing?.previewLoaded || false,
          references: existing?.references || [],
          searchText: existing?.searchText || "",
          size: item.size,
        };
        if (existing) Object.assign(existing, next);
        else {
          this.store.state.messages.push(next);
          if (!oldIds.has(uid)) newCount++;
        }
      }
      const hadSync = !!meta.lastSync;
      Object.assign(meta, {
        loaded: result.items.length,
        total: result.total,
        lastSync: new Date().toISOString(),
      });
      Object.assign(folderInfo, {
        total: result.total,
        loaded: result.items.length,
        unread: result.items.filter((item) => !item.read).length,
      });
      this.store.save();
      this.status[id] = {
        state: "online",
        total: result.total,
        loaded: result.items.length,
        lastSync: meta.lastSync,
      };
      this.change();
      if (folder === "INBOX" && hadSync && newCount && !older)
        this.emit("new-mail", { account: publicAccount(account), count: newCount });
    } catch (error) {
      this.status[id] = { ...this.status[id], state: "error", error: safeError(error) };
      this.change();
      throw new Error(safeError(error));
    }
  }
  async body(id) {
    const message = this.store.state.messages.find((m) => m.id === id);
    if (!message) throw new Error("Письмо не найдено.");
    const cached = this.store.body(id);
    if (cached) return cached;
    const account = this.store.state.accounts.find(
      (a) => a.id === message.accountId,
    );
    const client = await this.client(account);
    if (account.provider === "exchange") {
      if (message.size > 40 * 1024 * 1024)
        throw new Error("Письмо больше 40 МБ. Откройте его в веб-почте.");
      const raw = await client.getRawMessage(message.ewsId, message.ewsChangeKey);
      const parsed = await simpleParser(raw, {
        skipHtmlToText: false,
        skipTextToHtml: true,
        maxHtmlLengthToParse: 5 * 1024 * 1024,
      });
      const body = {
        text: parsed.text || "",
        html: parsed.html || "",
        attachments: parsed.attachments.map((a, i) => ({
          index: i,
          name: a.filename || "Вложение",
          type: a.contentType,
          size: a.size,
          cid: a.contentId?.replace(/[<>]/g, "") || null,
          inline:
            a.contentDisposition === "inline" &&
            /^image\//.test(a.contentType) &&
            !!a.contentId,
          content: a.content.toString("base64"),
        })),
      };
      this.store.saveBody(id, body);
      message.hasAttachments = body.attachments.some((a) => !a.inline);
      message.searchText = body.text.slice(0, 100000);
      message.previewLoaded = true;
      message.preview = body.text.replace(/\s+/g, " ").slice(0, 220);
      message.references = Array.isArray(parsed.references)
        ? parsed.references
        : parsed.references
          ? [parsed.references]
          : [];
      this.store.save();
      this.change();
      return body;
    }
    const lock = await client.getMailboxLock(message.folder || "INBOX");
    try {
      if (Number(client.mailbox.uidValidity) !== message.validity)
        throw new Error("Содержимое ящика изменилось. Обновите почту.");
      if (message.size > 40 * 1024 * 1024)
        throw new Error("Письмо больше 40 МБ. Откройте его в веб-почте.");
      const raw = await client.fetchOne(
        message.uid,
        { source: true },
        { uid: true },
      );
      if (!raw) throw new Error("Письмо больше не доступно на сервере.");
      const parsed = await simpleParser(raw.source, {
        skipHtmlToText: false,
        skipTextToHtml: true,
        maxHtmlLengthToParse: 5 * 1024 * 1024,
      });
      const body = {
        text: parsed.text || "",
        html: parsed.html || "",
        attachments: parsed.attachments.map((a, i) => ({
          index: i,
          name: a.filename || "Вложение",
          type: a.contentType,
          size: a.size,
          cid: a.contentId?.replace(/[<>]/g, "") || null,
          inline:
            a.contentDisposition === "inline" &&
            /^image\//.test(a.contentType) &&
            !!a.contentId,
          content: a.content.toString("base64"),
        })),
      };
      this.store.saveBody(id, body);
      message.hasAttachments = body.attachments.some((a) => !a.inline);
      message.searchText = body.text.slice(0, 100000);
      message.previewLoaded = true;
      message.preview = body.text.replace(/\s+/g, " ").slice(0, 220);
      message.references = Array.isArray(parsed.references)
        ? parsed.references
        : parsed.references
          ? [parsed.references]
          : [];
      this.store.save();
      this.change();
      return body;
    } finally {
      lock.release();
    }
  }
  async flag(id, type, value) {
    if (!["read", "flagged"].includes(type) || typeof value !== "boolean")
      throw new Error("Некорректная команда.");
    const m = this.store.state.messages.find((m) => m.id === id);
    if (!m) return;
    const account = this.store.state.accounts.find((a) => a.id === m.accountId);
    const client = await this.client(account);
    if (account.provider === "exchange") {
      await client.updateItem(m.ewsId, m.ewsChangeKey, type, value);
      if (type === "read" && m.read !== value) {
        const folder = this.store.state.folders.find(
          (f) => f.accountId === m.accountId && f.path === (m.folder || "INBOX"),
        );
        if (folder && typeof folder.unread === "number")
          folder.unread = Math.max(0, folder.unread + (value ? -1 : 1));
      }
      m[type] = value;
      this.store.save();
      this.change();
      return;
    }
    const lock = await client.getMailboxLock(m.folder || "INBOX");
    try {
      if (Number(client.mailbox.uidValidity) !== m.validity)
        throw new Error("Обновите ящик.");
      const flags = [type === "read" ? "\\Seen" : "\\Flagged"];
      await client[value ? "messageFlagsAdd" : "messageFlagsRemove"](
        m.uid,
        flags,
        { uid: true },
      );
      if (type === "read" && m.read !== value) {
        const folder = this.store.state.folders.find(
          (f) =>
            f.accountId === m.accountId && f.path === (m.folder || "INBOX"),
        );
        if (folder && typeof folder.unread === "number")
          folder.unread = Math.max(0, folder.unread + (value ? -1 : 1));
      }
      m[type] = value;
      this.store.save();
      this.change();
    } finally {
      lock.release();
    }
  }

  async bulk(ids, action, destination) {
    const allowed = new Set(["read", "unread", "flag", "unflag", "move"]);
    if (!Array.isArray(ids) || !ids.length || !allowed.has(action))
      throw new Error("Некорректная массовая команда.");
    const unique = [...new Set(ids.map((id) => String(id)).filter(Boolean))];
    for (const id of unique) {
      if (action === "move") {
        if (!destination) throw new Error("Не указана папка назначения.");
        await this.move(id, destination);
      } else if (action === "read" || action === "unread") {
        await this.flag(id, "read", action === "read");
      } else {
        await this.flag(id, "flagged", action === "flag");
      }
    }
    return true;
  }

  async renameAccount(id, name) {
    const account = this.store.state.accounts.find((a) => a.id === id);
    const value = String(name || "").trim();
    if (!account) throw new Error("Учётная запись не найдена.");
    if (!value || value.length > 80)
      throw new Error("Название ящика должно содержать от 1 до 80 символов.");
    account.name = value;
    this.store.save();
    this.change();
    return account;
  }

  async markAccountRead(id) {
    const account = this.store.state.accounts.find((a) => a.id === id);
    if (!account) throw new Error("Учётная запись не найдена.");
    const folders = await this.listFolders(id);
    const client = await this.client(account);
    for (const folder of folders) {
      if (account.provider === "exchange") {
        await client.markAllRead(folder.path);
        continue;
      }
      const lock = await client.getMailboxLock(folder.path);
      try {
        const unseen = (await client.search({ seen: false }, { uid: true })) || [];
        if (unseen.length)
          await client.messageFlagsAdd(unseen, ["\\Seen"], { uid: true });
      } finally {
        lock.release();
      }
    }
    for (const message of this.store.state.messages) {
      if (message.accountId === id) message.read = true;
    }
    for (const folder of this.store.state.folders) {
      if (folder.accountId === id && typeof folder.unread === "number")
        folder.unread = 0;
    }
    this.store.save();
    this.change();
    return true;
  }

  async purgeAccountFolder(id, specialUse) {
    const account = this.store.state.accounts.find((a) => a.id === id);
    if (!account) throw new Error("Учётная запись не найдена.");
    const folders = await this.listFolders(id);
    const folder = folders.find((item) => item.specialUse === specialUse);
    if (!folder) throw new Error("Нужная папка не найдена на сервере.");
    const client = await this.client(account);
    if (account.provider === "exchange") {
      await client.deleteItems(folder.path);
    } else {
    const lock = await client.getMailboxLock(folder.path);
    try {
      await client.messageDelete("*", { uid: true });
    } finally {
      lock.release();
    }
    }
    const removed = this.store.state.messages.filter(
      (message) => message.accountId === id && message.folder === folder.path,
    );
    for (const message of removed) this.store.dropBody(message.id);
    this.store.state.messages = this.store.state.messages.filter(
      (message) => !(message.accountId === id && message.folder === folder.path),
    );
    this.store.save();
    this.change();
    await this.listFolders(id);
    return true;
  }

  async listFolders(id) {
    const account = this.store.state.accounts.find((a) => a.id === id);
    if (!account) throw new Error("Учётная запись не найдена.");
    const client = await this.client(account);
    if (account.provider === "exchange") {
      const previous = this.store.state.folders.filter((f) => f.accountId === id);
      const folders = (await client.listFolders()).map((folder) => ({
        accountId: id,
        path: folder.path,
        name: folder.name,
        delimiter: folder.delimiter,
        specialUse: folder.specialUse,
        total: folder.total,
        unread: folder.unread,
        loaded: previous.find((old) => old.path === folder.path)?.loaded || 0,
        ewsId: folder.ewsId,
        changeKey: folder.changeKey,
      }));
      this.store.state.folders = this.store.state.folders
        .filter((f) => f.accountId !== id)
        .concat(folders);
      this.folderRefresh.set(id, Date.now());
      this.store.save();
      this.change();
      return folders;
    }
    let listed;
    try {
      listed = await client.list({
        statusQuery: { messages: true, unseen: true },
      });
    } catch (error) {
      if (!client.usable) throw error;
      listed = await client.list();
    }
    const previous = this.store.state.folders.filter((f) => f.accountId === id);
    const folders = listed
      .filter((f) => !f.flags?.has("\\Noselect"))
      .map((f) => ({
        accountId: id,
        path: f.path,
        name: f.path === "INBOX" ? "Входящие" : f.name,
        delimiter: f.delimiter,
        specialUse: f.path === "INBOX" ? "\\Inbox" : f.specialUse || null,
        total: f.status?.messages,
        unread: f.status?.unseen,
        loaded: previous.find((old) => old.path === f.path)?.loaded || 0,
      }));
    this.store.state.folders = this.store.state.folders
      .filter((f) => f.accountId !== id)
      .concat(folders);
    this.folderRefresh.set(id, Date.now());
    this.store.save();
    this.change();
    return folders;
  }
  async move(id, destination) {
    const m = this.store.state.messages.find((m) => m.id === id);
    if (!m) throw new Error("Письмо не найдено.");
    const account = this.store.state.accounts.find((a) => a.id === m.accountId);
    const folders = await this.listFolders(account.id);
    const target = destination.startsWith("\\")
      ? folders.find((f) => f.specialUse === destination)
      : folders.find((f) => f.path === destination);
    if (!target) throw new Error("Нужная папка не найдена на сервере.");
    if (target.path === m.folder) return;
    const client = await this.client(account);
    if (account.provider === "exchange") {
      await client.moveItem(m.ewsId, m.ewsChangeKey, target.path);
      this.store.state.messages = this.store.state.messages.filter((x) => x.id !== id);
      this.store.dropBody(id);
      this.store.save();
      this.change();
      await this.sync(account.id, false, m.folder || "INBOX");
      await this.sync(account.id, false, target.path);
      return target.path;
    }
    const lock = await client.getMailboxLock(m.folder || "INBOX");
    try {
      if (Number(client.mailbox.uidValidity) !== m.validity)
        throw new Error("Сначала обновите папку.");
      const result = await client.messageMove(m.uid, target.path, {
        uid: true,
      });
      if (!result) throw new Error("Сервер не переместил письмо.");
      this.store.state.messages = this.store.state.messages.filter(
        (x) => x.id !== id,
      );
      this.store.dropBody(id);
      this.store.save();
      this.change();
    } finally {
      lock.release();
    }
    await this.sync(account.id, false, m.folder || "INBOX");
    await this.sync(account.id, false, target.path);
    return target.path;
  }
  async send(input) {
    const data = validateOutgoing(input);
    const account = this.store.state.accounts.find(
      (a) => a.id === data.accountId,
    );
    if (!account) throw new Error("Отправитель не подключён.");
    if (account.provider !== "exchange" && !Object.hasOwn(SMTP, account.provider))
      throw new Error("Отправка для этой службы не настроена.");
    const key = data.draftId || account.id;
    if (this.sending.has(key)) throw new Error("Письмо уже отправляется.");
    this.sending.add(key);
    let transport;
    try {
      const attachments = data.attachmentIds.map((id) => {
        const item = this.store.state.files[id];
        if (!item) throw new Error("Вложение не найдено. Добавьте его заново.");
        return {
          filename: item.name,
          content: fs.readFileSync(this.store.filePath(id)),
        };
      });
      if (
        attachments.reduce((n, a) => n + a.content.length, 0) >
        25 * 1024 * 1024
      )
        throw new Error("Общий размер вложений больше 25 МБ.");
      const reply = this.store.state.messages.find(
        (m) => m.id === data.replyToId && m.accountId === account.id,
      );
      const built = await buildOutgoing(account, data, attachments, reply);
      if (account.provider === "exchange") {
        const client = await this.client(account);
        await client.sendMime(built.message);
        try {
          this.removeDraft(data.draftId);
          for (const id of data.attachmentIds) this.store.removeFile(id);
          this.store.save();
        } catch {}
        this.change();
        return {
          sent: true,
          messageId: built.messageId,
          warning: "",
          rejected: [],
        };
      }
      let secret = this.store.decrypt(account.secret);
      if (account.provider === "microsoft") {
        if (!secret.scope?.includes("SMTP.Send"))
          throw new Error(
            "Для отправки Microsoft нужно повторно подключить аккаунт с разрешением SMTP.Send.",
          );
        if (secret.expiresAt < Date.now() + 60000) {
          const next = await microsoft.refresh(
            account.clientId,
            secret.refresh_token,
          );
          Object.assign(secret, next, {
            expiresAt: Date.now() + next.expires_in * 1000,
          });
          account.secret = this.store.encrypt(secret);
          this.store.save();
        }
      }
      transport = this.transportFactory({
        ...SMTP[account.provider],
        auth:
          account.provider === "microsoft"
            ? {
                type: "OAuth2",
                user: account.email,
                accessToken: secret.access_token,
              }
            : { user: account.email, pass: secret.password },
        tls: { minVersion: "TLSv1.2" },
        logger: false,
        debug: false,
        connectionTimeout: 30000,
        socketTimeout: 60000,
        disableFileAccess: true,
        disableUrlAccess: true,
      });
      let result;
      try {
        result = await transport.sendMail({
          raw: built.message,
          envelope: built.envelope,
        });
      } catch (e) {
        if (
          e.command === "DATA" ||
          ["ETIMEDOUT", "ECONNECTION", "ESOCKET"].includes(e.code)
        )
          throw new Error(
            "Сервер не подтвердил результат отправки. Проверьте почту перед повторной отправкой: письмо могло быть доставлено.",
          );
        throw new Error(safeError(e));
      }
      if (!result.accepted?.length)
        throw new Error("Сервер не принял ни одного получателя.");
      // SMTP acceptance is the point of no return. Failures below must never turn into a retryable send error.
      let warning = "";
      try {
        this.removeDraft(data.draftId);
        for (const id of data.attachmentIds) this.store.removeFile(id);
        this.store.save();
      } catch {
        warning =
          "Письмо отправлено, но локальный черновик не удалось очистить. Не отправляйте его повторно.";
      }
      try {
        const folders = await this.listFolders(account.id);
        const sent = folders.find((f) => f.specialUse === "\\Sent");
        if (sent) {
          const client = await this.client(account);
          if (account.provider !== "gmail") {
            const lock = await client.getMailboxLock(sent.path);
            try {
              const found = await client.search(
                { header: { "message-id": built.messageId } },
                { uid: true },
              );
              if (!found?.length)
                await client.append(sent.path, built.message, ["\\Seen"]);
            } finally {
              lock.release();
            }
          }
          await this.sync(account.id, false, sent.path);
        } else
          warning +=
            " Письмо отправлено; папка «Отправленные» на сервере не найдена.";
      } catch {
        warning +=
          " Письмо отправлено, но сохранение или обновление «Отправленных» не удалось. Повторно отправлять письмо не нужно.";
      }
      if (result.rejected?.length)
        warning +=
          " Не приняты адреса: " +
          result.rejected
            .map((a) => (typeof a === "string" ? a : a.address))
            .join(", ");
      this.change();
      return {
        sent: true,
        messageId: built.messageId,
        warning: warning.trim(),
        rejected: result.rejected || [],
      };
    } finally {
      transport?.close?.();
      this.sending.delete(key);
    }
  }
  saveDraft(input) {
    if (
      !input ||
      !this.store.state.accounts.some((a) => a.id === input.accountId)
    )
      throw new Error("Выберите отправителя.");
    const id = input.id || require("node:crypto").randomUUID();
    if (!/^[a-f\d-]{36}$/i.test(id)) throw new Error("Некорректный черновик.");
    const draft = {
      id,
      accountId: input.accountId,
      updatedAt: new Date().toISOString(),
      attachmentIds: Array.isArray(input.attachmentIds)
        ? input.attachmentIds
            .filter((id) => Object.hasOwn(this.store.state.files, id))
            .slice(0, 30)
        : [],
      replyToId: typeof input.replyToId === "string" ? input.replyToId : null,
    };
    for (const key of ["to", "cc", "bcc", "subject", "text"]) {
      if (
        typeof input[key] !== "string" ||
        input[key].length > (key === "text" ? 2 * 1024 * 1024 : 10000)
      )
        throw new Error("Черновик слишком большой.");
      draft[key] = input[key];
    }
    const index = this.store.state.drafts.findIndex((d) => d.id === id);
    if (index < 0) this.store.state.drafts.push(draft);
    else this.store.state.drafts[index] = draft;
    this.store.save();
    this.change();
    return draft;
  }
  removeDraft(id) {
    const old = this.store.state.drafts.find((d) => d.id === id);
    if (!old) return;
    this.store.state.drafts = this.store.state.drafts.filter(
      (d) => d.id !== id,
    );
    for (const file of old.attachmentIds || []) this.store.removeFile(file);
    this.store.save();
    this.change();
  }

  remove(id) {
    clearInterval(this.timers.get(id));
    this.timers.delete(id);
    this.connections.get(id)?.close();
    this.connections.delete(id);
    this.store.remove(id);
    this.folderRefresh.delete(id);
    delete this.status[id];
    this.change();
  }
  stop() {
    this.stopped = true;
    for (const t of this.timers.values()) clearInterval(t);
    for (const c of this.connections.values()) c.close();
    for (const c of this.pendingClients) c.close();
  }
}
module.exports = { MailService };
