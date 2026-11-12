const {
  app,
  BrowserWindow,
  ipcMain,
  safeStorage,
  dialog,
  shell,
  Notification,
  Menu,
  nativeImage,
  Tray,
} = require("electron");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const { Store } = require("./store.cjs");
const { MailService } = require("./mail.cjs");
const assistant = require("./assistant.cjs");
const { createUpdaterController } = require("./updater.cjs");
const { validateAccount, cleanHtml, safeError } = require("./core.cjs");
const microsoft = require("./microsoft.cjs");
const exchange = require("./exchange.cjs");
let window,
  service,
  store,
  tray,
  updater,
  quitting = false,
  authAbort;
const demo = !app.isPackaged && process.argv.includes("--demo");
if (demo) app.setPath("userData", path.join(app.getPath("temp"), "posta-demo"));
else app.setPath("userData", path.join(app.getPath("appData"), "posta"));
const htmlEscape = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
function external(url) {
  try {
    const u = new URL(url);
    if (["https:", "http:", "mailto:"].includes(u.protocol))
      return shell.openExternal(u.href);
  } catch {}
  return Promise.resolve();
}
function send(channel, value) {
  if (window && !window.isDestroyed()) window.webContents.send(channel, value);
}
function loadUpdateFeed() {
  let config = {};
  try {
    const file = path.join(app.getAppPath(), "electron", "update-config.json");
    config = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {}
  const url = process.env.LUMA_UPDATE_URL || config.url;
  if (url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:") return null;
      return { provider: "generic", url: parsed.href.endsWith("/") ? parsed.href : `${parsed.href}/` };
    } catch {
      return null;
    }
  }
  if (config.provider === "github" && config.owner && config.repo)
    return {
      provider: "github",
      owner: String(config.owner),
      repo: String(config.repo),
      private: false,
    };
  return null;
}
function emit(channel, value) {
  send(channel, value);
  if (
    channel === "new-mail" &&
    store.state.settings.notifications &&
    Notification.isSupported()
  ) {
    const n = new Notification({
      title: `${value.account.name}: новые письма`,
      body: `Получено: ${value.count}`,
    });
    n.on("click", () => {
      window.show();
      window.focus();
    });
    n.show();
  }
}
function emailBackground(html) {
  const source = String(html || "");
  const match = source.match(
    /<body\b[^>]*(?:bgcolor\s*=\s*["']([^"']+)|style\s*=\s*["'][^"']*background(?:-color)?\s*:\s*([^;"']+))/i,
  );
  const color = match?.[1] || match?.[2] || "#fff";
  return /^(?:#[a-f\d]{3,8}|[a-z]+|rgba?\([\d\s.,%]+\))$/i.test(color.trim())
    ? color.trim()
    : "#fff";
}
function documentFor(body, remote = true, subject = "") {
  const content = body.html
    ? cleanHtml(body.html, body.attachments, remote, subject)
    : `<pre>${htmlEscape(body.text)}</pre>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: ${remote ? "https: http:" : ""}; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; script-src 'none'; object-src 'none'; frame-src 'none'"><style>*{box-sizing:border-box}html{color-scheme:light;overflow-x:hidden;min-width:0}body{font:16px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#222;margin:0;padding:24px 30px;width:100%;max-width:none;min-width:0;overflow-wrap:anywhere;background:${emailBackground(body.html)}}img,video{max-width:100%;height:auto}table{max-width:100%;border-spacing:0}td,th{max-width:100%;overflow-wrap:anywhere}pre{font:inherit;white-space:pre-wrap}a{color:#007aff}</style></head><body>${content}</body></html>`;
}
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame
    )
      throw new Error("Доступ запрещён.");
    try {
      return await fn(...args);
    } catch (e) {
      throw new Error(
        e.message?.slice(0, 300) || "Не удалось выполнить действие.",
      );
    }
  });
}
ipcMain.on("window:action", (event, action) => {
  const target = BrowserWindow.fromWebContents(event.sender);
  if (!target || target.isDestroyed()) return;
  if (action === "minimize") {
    target.minimize();
  }
  if (action === "maximize")
    target.isMaximized() ? target.unmaximize() : target.maximize();
  if (action === "quit") {
    quitting = true;
    target.close();
  }
});
async function boot() {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  await app.whenReady();
  app.setAppUserModelId("personal.posta.mail");
  store = new Store(app.getPath("userData"), safeStorage);
  service = new MailService(store, emit);
  window = new BrowserWindow({
    title: "Luma Почта",
    width: 1440,
    height: 920,
    minWidth: 1000,
    minHeight: 640,
    frame: false,
    // Let Windows draw and handle the real minimize/maximize/close buttons.
    // The old HTML buttons lived inside the frameless WebContents and could
    // lose hit-testing to the draggable regions of the window.
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#ffffff",
      symbolColor: "#85858c",
      height: 34,
    },
    icon: path.join(__dirname, "../assets/icon.png"),
    backgroundColor: "#ffffff",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    external(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (e) => e.preventDefault());
  window.webContents.on("will-frame-navigate", (e) => {
    e.preventDefault();
    if (!e.isMainFrame) external(e.url);
  });
  window.webContents.session.setPermissionRequestHandler(
    (_wc, _permission, callback) => callback(false),
  );
  handle("update:state", () =>
    updater?.getState() || {
      configured: false,
      state: "unconfigured",
      currentVersion: app.getVersion(),
      version: null,
      percent: 0,
      error: "",
    },
  );
  handle("update:check", () => updater?.check());
  handle("update:download", () => updater?.download());
  handle("update:install", () => updater?.install());
  window.on("ready-to-show", () => window.show());
  window.on("close", (e) => {
    if (!quitting && tray) {
      e.preventDefault();
      window.hide();
    }
  });
  if (app.isPackaged && process.platform === "win32") {
    const { autoUpdater } = require("electron-updater");
    updater = createUpdaterController({
      autoUpdater,
      feed: loadUpdateFeed(),
      currentVersion: app.getVersion(),
      send: (value) => send("update:state", value),
    });
    const timer = setInterval(() => updater?.check(), 6 * 60 * 60 * 1000);
    timer.unref?.();
    setTimeout(() => updater?.check(), 8000).unref?.();
  } else {
    updater = createUpdaterController({
      currentVersion: app.getVersion(),
      feed: null,
    });
  }
  handle("mail:state", () => service.snapshot());
  handle("mail:add", async (input) => {
    if (demo)
      throw new Error(
        "Для подключения почты запустите Luma Почта в обычном режиме, без --demo.",
      );
    const account = validateAccount(input);
    if (
      store.state.accounts.some(
        (a) => a.email.toLowerCase() === account.email.toLowerCase(),
      )
    )
      throw new Error("Этот ящик уже подключён.");
    if (authAbort)
      throw new Error("Дождитесь завершения текущего подключения.");
    authAbort = new AbortController();
    try {
      let secret = { password: input.password };
      if (account.provider === "exchange") {
        account.host = await exchange.discover(
          account.email,
          input.password,
        );
      }
      if (account.provider === "microsoft") {
        const tokens = await microsoft.authorize(
          account.clientId,
          (code) => send("auth:code", code),
          authAbort.signal,
        );
        secret = {
          ...tokens,
          expiresAt: Date.now() + tokens.expires_in * 1000,
        };
      }
      authAbort.signal.throwIfAborted();
      return await service.add(account, secret, authAbort.signal);
    } catch (e) {
      throw new Error(safeError(e));
    } finally {
      authAbort = null;
    }
  });
  handle("auth:cancel", () => authAbort?.abort());
  handle("mail:sync", async (id, folder = "INBOX") => {
    if (id) return service.sync(id, false, folder);
    await Promise.allSettled(
      store.state.accounts.map((a) => service.sync(a.id)),
    );
  });
  handle("mail:older", (id, folder = "INBOX") =>
    service.sync(id, true, folder),
  );
  handle("mail:body", async (id, remote = true) => {
    const b = await service.body(id);
    const message = store.state.messages.find((item) => item.id === id);
    return {
      document: documentFor(b, !!remote, message?.subject || ""),
      text: b.text,
      attachments: b.attachments
        .filter((a) => !a.inline)
        .map(({ content, ...a }) => a),
    };
  });
  handle("mail:flag", (id, type, value) => service.flag(id, type, value));
  handle("mail:bulk", (ids, action, destination) =>
    service.bulk(ids, action, destination),
  );
  handle("mail:accountRename", (id, name) => service.renameAccount(id, name));
  handle("mail:accountAction", async (id, action) => {
    if (action === "mark-read") return service.markAccountRead(id);
    if (action === "clear-spam") return service.purgeAccountFolder(id, "\\Junk");
    if (action === "clear-trash") return service.purgeAccountFolder(id, "\\Trash");
    throw new Error("Неизвестное действие для ящика.");
  });
  handle("mail:remove", async (id) => {
    await Promise.allSettled(
      [...service.busy.entries()]
        .filter(([key]) => key === id || key.startsWith(id + "::"))
        .map(([, job]) => job),
    );
    service.remove(id);
  });
  handle("mail:attachment", async (id, index) => {
    const b = await service.body(id);
    const a = b.attachments.find((a) => a.index === index);
    if (!a) throw new Error("Вложение не найдено.");
    const result = await dialog.showSaveDialog(window, {
      defaultPath: path.basename(a.name.replace(/\\/g, "/")),
    });
    if (!result.canceled && result.filePath)
      fs.writeFileSync(result.filePath, Buffer.from(a.content, "base64"));
    return !result.canceled;
  });
  handle("mail:folders", (id) => service.listFolders(id));
  handle("mail:move", (id, destination) => service.move(id, destination));
  handle("mail:send", (input) => {
    if (demo) throw new Error("Демонстрация не отправляет письма.");
    return service.send(input);
  });
  handle("draft:save", (input) => {
    if (demo) throw new Error("Демонстрация не сохраняет личные черновики.");
    return service.saveDraft(input);
  });
  handle("draft:remove", (id) => service.removeDraft(id));
  handle("compose:forwardAttachments", async (messageId) => {
    if (demo) return [];
    const body = await service.body(messageId);
    const all = body.attachments.filter((a) => !a.inline);
    if (
      all.length > 30 ||
      all.reduce((sum, a) => sum + Buffer.byteLength(a.content, "base64"), 0) >
        25 * 1024 * 1024
    )
      throw new Error(
        "Вложения исходного письма превышают лимит пересылки 25 МБ.",
      );
    fs.mkdirSync(path.join(store.directory, "attachments"), {
      recursive: true,
    });
    const added = [];
    try {
      for (const a of all) {
        const id = randomUUID();
        fs.writeFileSync(store.filePath(id), Buffer.from(a.content, "base64"), {
          mode: 0o600,
        });
        const item = { id, name: a.name, size: a.size };
        store.state.files[id] = item;
        added.push(item);
      }
      store.save();
      return added;
    } catch (e) {
      for (const a of added) store.removeFile(a.id);
      throw e;
    }
  });

  handle("compose:attachments", async () => {
    if (demo) return [];
    const result = await dialog.showOpenDialog(window, {
      title: "Добавить вложения",
      properties: ["openFile", "multiSelections"],
    });
    if (result.canceled) return [];
    if (result.filePaths.length > 30)
      throw new Error("Выберите не более 30 файлов.");
    const stats = result.filePaths.map((file) => fs.statSync(file));
    if (
      stats.some((s) => !s.isFile()) ||
      stats.reduce((n, s) => n + s.size, 0) > 25 * 1024 * 1024
    )
      throw new Error("Общий размер вложений не должен превышать 25 МБ.");
    fs.mkdirSync(path.join(store.directory, "attachments"), {
      recursive: true,
    });
    const attachments = [];
    for (let i = 0; i < result.filePaths.length; i++) {
      const id = randomUUID();
      try {
        fs.copyFileSync(result.filePaths[i], store.filePath(id));
        const entry = {
          id,
          name: path.basename(result.filePaths[i]),
          size: stats[i].size,
        };
        store.state.files[id] = entry;
        attachments.push(entry);
      } catch (e) {
        for (const item of attachments) store.removeFile(item.id);
        throw e;
      }
    }
    store.save();
    return attachments;
  });
  handle("compose:removeAttachment", (id) => {
    if (!store.state.drafts.some((d) => d.attachmentIds?.includes(id))) {
      store.removeFile(id);
      store.save();
    }
  });
  handle("smart:save", async (input) => {
    const { validateSmart } = await import("../shared/rules.mjs");
    const value = validateSmart(input);
    const id = input.id || randomUUID();
    if (!/^[a-f\d-]{36}$/i.test(id))
      throw new Error("Некорректный смарт-ящик.");
    const item = { ...value, id };
    const index = store.state.smartBoxes.findIndex((b) => b.id === id);
    if (index < 0) store.state.smartBoxes.push(item);
    else store.state.smartBoxes[index] = item;
    store.save();
    service.change();
    return item;
  });
  handle("smart:remove", (id) => {
    store.state.smartBoxes = store.state.smartBoxes.filter((b) => b.id !== id);
    store.save();
    service.change();
  });

  handle("settings:save", (patch) => {
    for (const k of ["notifications", "threads"])
      if (typeof patch?.[k] === "boolean") store.state.settings[k] = patch[k];
    store.save();
    service.change();
  });
  handle("external:open", external);
  handle("assistant:status", () =>
    assistant.publicStatus(Object.keys(store.state.assistant?.verdicts || {}).length),
  );
  handle("assistant:classify", async (messages) => {
    const inbox = (Array.isArray(messages) ? messages : []).filter(
      (message) => (message.folder || "INBOX") === "INBOX",
    );
    const verdicts = await assistant.classify(inbox);
    store.state.assistant.verdicts = {
      ...store.state.assistant.verdicts,
      ...verdicts,
    };
    store.save();
    service.change();
    return verdicts;
  });
  const trayImage = nativeImage
    .createFromPath(path.join(__dirname, "../assets/icon.png"))
    .resize({ width: 20, height: 20 });
  try {
    tray = new Tray(trayImage);
    tray.setToolTip("Luma Почта — входящая почта");
    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: "Открыть Luma Почта",
          click: () => {
            window.show();
            window.focus();
          },
        },
        {
          label: "Проверить почту",
          click: () => {
            for (const a of store.state.accounts)
              service.sync(a.id).catch(() => {});
          },
        },
        { type: "separator" },
        {
          label: "Завершить",
          click: () => {
            quitting = true;
            app.quit();
          },
        },
      ]),
    );
    tray.on("double-click", () => window.show());
  } catch {}
  Menu.setApplicationMenu(null);
  await window.loadFile(path.join(__dirname, "../dist/index.html"), {
    query: demo ? { demo: "1" } : {},
  });
  if (!demo) service.start();
  app.on("second-instance", () => {
    window.show();
    window.focus();
  });
  app.on("activate", () => window.show());
  app.on("before-quit", () => {
    quitting = true;
    authAbort?.abort();
    service.stop();
  });
}
boot().catch(() => {
  dialog.showErrorBox(
    "Luma Почта",
    "Не удалось запустить приложение или прочитать локальное хранилище.",
  );
  app.quit();
});
