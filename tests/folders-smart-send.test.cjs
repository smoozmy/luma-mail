const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const crypto = require("node:crypto");
const { Store } = require("../electron/store.cjs");
const { MailService } = require("../electron/mail.cjs");
const { validateOutgoing, buildOutgoing } = require("../electron/outgoing.cjs");
const nodemailer = require("nodemailer");
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "posta-v2-test-"));
  const vault = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(s),
    decryptString: (b) => b.toString(),
  };
  const store = new Store(dir, vault);
  const account = {
    id: "folder-account",
    email: "sender@example.com",
    provider: "icloud",
    name: "My mail",
    secret: store.encrypt({ password: "test-secret" }),
  };
  store.state.accounts.push(account);
  const boxes = new Map([
    ["INBOX", { validity: 10, uids: [1], subject: "Inbox message" }],
    ["Sent", { validity: 10, uids: [1], subject: "Sent message" }],
    ["Spam", { validity: 20, uids: [1], subject: "Spam message" }],
    ["Trash", { validity: 30, uids: [], subject: "Trash" }],
  ]);
  let current = "INBOX",
    tail = Promise.resolve();
  const flags = [];
  let appended = 0;
  const client = {
    mailbox: { uidValidity: 10 },
    async getMailboxLock(folder) {
      const prev = tail;
      let release;
      tail = new Promise((resolve) => (release = resolve));
      await prev;
      current = folder;
      this.mailbox.uidValidity = boxes.get(folder).validity;
      return { release };
    },
    list: async () =>
      [...boxes].map(([folder, box]) => ({
        path: folder,
        name: folder,
        specialUse:
          folder === "INBOX"
            ? "\\Inbox"
            : folder === "Spam"
              ? "\\Junk"
              : "\\" + folder,
        flags: new Set(),
        status: { messages: box.uids.length, unseen: box.uids.length },
      })),
    search: async (query) => (query.header ? [] : [...boxes.get(current).uids]),
    async *fetch(range) {
      for (const uid of String(range).split(",").map(Number))
        yield {
          uid,
          envelope: {
            subject: boxes.get(current).subject,
            from: [{ address: "contact@example.com" }],
            to: [{ address: account.email }],
            date: new Date("2026-10-19T09:00:00Z"),
            messageId: `<${current}-${uid}@example.com>`,
          },
          flags: new Set(),
          size: 100,
        };
    },
    fetchOne: async (uid) => ({
      source: Buffer.from(
        `From: contact@example.com\r\nTo: ${account.email}\r\nSubject: ${boxes.get(current).subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nBody of ${current} ${uid}`,
      ),
    }),
    messageFlagsAdd: async (uid, value) =>
      flags.push({ folder: current, uid, value }),
    messageFlagsRemove: async () => {},
    messageMove: async (uid, destination) => {
      boxes.get(current).uids = boxes
        .get(current)
        .uids.filter((x) => x !== uid);
      boxes.get(destination).uids.push(uid);
      return { uidMap: new Map([[uid, uid]]) };
    },
    append: async () => {
      appended++;
      return { uid: 2 };
    },
    close() {},
  };
  const service = new MailService(store, () => {});
  service.client = async () => client;
  t.after(() => {
    service.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    store,
    account,
    client,
    service,
    boxes,
    flags,
    appended: () => appended,
  };
}
test("folders are discovered and identical UIDs in different folders never collide", async (t) => {
  const f = fixture(t);
  await Promise.all([
    f.service.sync(f.account.id),
    f.service.sync(f.account.id, false, "Sent"),
  ]);
  assert.equal(f.store.state.folders.length, 4);
  assert.equal(f.store.state.messages.length, 2);
  const inbox = f.store.state.messages.find((m) => m.folder === "INBOX"),
    sent = f.store.state.messages.find((m) => m.folder === "Sent");
  assert.notEqual(inbox.id, sent.id);
  assert.match((await f.service.body(inbox.id)).text, /INBOX/);
  assert.match((await f.service.body(sent.id)).text, /Sent/);
  await f.service.flag(sent.id, "read", true);
  assert.equal(f.flags.at(-1).folder, "Sent");
  assert.equal(
    f.store.state.folders.find((folder) => folder.path === "Sent").unread,
    0,
  );
  f.boxes.get("Sent").validity = 11;
  await f.service.sync(f.account.id, false, "Sent");
  assert(f.store.state.messages.some((m) => m.id === inbox.id));
  assert(!f.store.state.messages.some((m) => m.id === sent.id));
});
test("moving to Trash changes server folder, preserves message, and refreshes both sides", async (t) => {
  const f = fixture(t);
  await f.service.sync(f.account.id);
  const id = f.store.state.messages[0].id;
  await f.service.move(id, "\\Trash");
  assert.equal(f.boxes.get("INBOX").uids.length, 0);
  assert.equal(f.boxes.get("Trash").uids.length, 1);
  assert(!f.store.state.messages.some((m) => m.id === id));
  assert(f.store.state.messages.some((m) => m.folder === "Trash"));
  f.service.remove(f.account.id);
  assert.equal(f.store.state.folders.length, 0);
  assert.equal(
    fs
      .readdirSync(f.store.directory)
      .filter((name) => name.startsWith("folder-account")).length,
    0,
  );
});
test("smart boxes support ALL/ANY, dates, flags, account conditions, and excluded folders", async () => {
  const { validateSmart, matchesSmart } = await import("../shared/rules.mjs");
  const now = Date.parse("2026-10-19T12:00:00Z");
  const m = {
    from: "Anna",
    fromAddress: "anna@example.com",
    subject: "Invoice October",
    date: "2026-10-18T10:00:00Z",
    read: false,
    flagged: true,
    accountId: "a",
    folder: "INBOX",
    folderRole: "\\Inbox",
  };
  const box = validateSmart({
    name: "Bills",
    mode: "all",
    conditions: [
      { field: "subject", operator: "contains", value: "invoice" },
      { field: "date", operator: "within", value: "7" },
      { field: "read", operator: "false" },
    ],
  });
  assert(matchesSmart(m, box, now));
  assert(!matchesSmart({ ...m, read: true }, box, now));
  assert(!matchesSmart({ ...m, folderRole: "\\Junk" }, box, now));
  assert(
    matchesSmart(
      { ...m, folderRole: "\\Junk" },
      { ...box, includeJunk: true },
      now,
    ),
  );
  assert(matchesSmart({ ...m, read: true }, { ...box, mode: "any" }, now));
  assert.throws(() =>
    validateSmart({
      ...box,
      conditions: [{ field: "date", operator: "within", value: "-1" }],
    }),
  );
  assert.throws(() => validateSmart({ ...box, conditions: [] }));
});
test("old stores gain empty folders/drafts/smart boxes without losing saved accounts or mail", (t) => {
  const f = fixture(t);
  const legacy = {
    accounts: [f.account],
    messages: [{ id: "folder-account_10_1", accountId: f.account.id }],
    settings: { notifications: true, threads: true },
    sync: {},
  };
  fs.writeFileSync(f.store.file, JSON.stringify(legacy));
  const migrated = new Store(f.store.directory, f.store.vault);
  assert.equal(migrated.state.accounts[0].email, f.account.email);
  assert.equal(migrated.state.messages[0].folder, "INBOX");
  assert.equal(migrated.state.folders[0].path, "INBOX");
  assert.deepEqual(migrated.state.smartBoxes, []);
  assert.deepEqual(migrated.state.drafts, []);
});
test("MIME building keeps Bcc out of headers while including it in SMTP envelope", async () => {
  const data = validateOutgoing({
    accountId: "a",
    to: "reader@example.com",
    cc: "copy@example.com",
    bcc: "hidden@example.com",
    subject: "Hello",
    text: "Hi",
    attachmentIds: [],
  });
  const built = await buildOutgoing(
    { email: "sender@example.com", name: "Sender" },
    data,
    [{ filename: "hello.txt", content: Buffer.from("attachment") }],
    { messageId: "<parent@example.com>", references: ["<root@example.com>"] },
  );
  assert(built.envelope.to.includes("hidden@example.com"));
  const headers = built.message.toString().split("\r\n\r\n")[0];
  assert(!/^bcc:/im.test(headers));
  assert.match(headers, /In-Reply-To: <parent@example.com>/);
  assert.match(built.message.toString(), /hello.txt/);
  assert.throws(() =>
    validateOutgoing({
      ...data,
      to: "evil@example.com\r\nBcc: leak@example.com",
    }),
  );
});
async function smtpServer(t, { reject } = {}) {
  const deliveries = [];
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "",
      data = false,
      body = [],
      recipients = [];
    socket.write("220 localhost test SMTP\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (data) {
          if (line === ".") {
            deliveries.push({
              body: body.join("\r\n"),
              recipients: [...recipients],
            });
            data = false;
            socket.write("250 accepted\r\n");
          } else body.push(line);
          continue;
        }
        if (/^EHLO|^HELO/.test(line))
          socket.write("250-localhost\r\n250 PIPELINING\r\n");
        else if (/^MAIL FROM/.test(line)) {
          recipients = [];
          body = [];
          socket.write("250 OK\r\n");
        } else if (/^RCPT TO/.test(line)) {
          if (reject && line.includes(reject))
            socket.write("550 recipient rejected\r\n");
          else {
            recipients.push(line);
            socket.write("250 OK\r\n");
          }
        } else if (line === "DATA") {
          data = true;
          socket.write("354 send data\r\n");
        } else if (line === "QUIT") {
          socket.end("221 bye\r\n");
        } else socket.write("250 OK\r\n");
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { port: server.address().port, deliveries };
}
function draft(f) {
  return f.service.saveDraft({
    id: crypto.randomUUID(),
    accountId: f.account.id,
    to: "reader@example.com",
    cc: "",
    bcc: "hidden@example.com",
    subject: "A test message",
    text: "No personal data",
    attachmentIds: [],
  });
}
test("real SMTP dialogue sends once, uses provider TLS configuration, and clears local draft only after acceptance", async (t) => {
  const server = await smtpServer(t);
  const f = fixture(t);
  const d = draft(f);
  let options;
  f.service.transportFactory = (configuration) => {
    options = configuration;
    return nodemailer.createTransport({
      host: "127.0.0.1",
      port: server.port,
      secure: false,
      ignoreTLS: true,
    });
  };
  const result = await f.service.send({ ...d, draftId: d.id });
  assert.equal(result.sent, true);
  assert.equal(server.deliveries.length, 1);
  assert.equal(server.deliveries[0].recipients.length, 2);
  assert.equal(options.host, "smtp.mail.me.com");
  assert.equal(options.requireTLS, true);
  assert.equal(f.store.state.drafts.length, 0);
  assert.equal(f.appended(), 1);
});
test("successful SMTP with a failed sent-copy stays successful and cannot prompt a duplicate retry", async (t) => {
  const f = fixture(t);
  const d = draft(f);
  let count = 0;
  f.service.transportFactory = () => ({
    sendMail: async () => {
      count++;
      return { accepted: ["reader@example.com"], rejected: [] };
    },
    close() {},
  });
  f.client.append = async () => {
    throw new Error("disk quota");
  };
  const result = await f.service.send({ ...d, draftId: d.id });
  assert.equal(result.sent, true);
  assert.match(result.warning, /Повторно отправлять/);
  assert.equal(count, 1);
  assert.equal(f.store.state.drafts.length, 0);
});
test("SMTP failure preserves draft and attachments, partial recipient rejection reports success with warning", async (t) => {
  const f = fixture(t);
  const d = draft(f);
  f.service.transportFactory = () => ({
    sendMail: async () => {
      throw Object.assign(new Error("AUTH failed"), { code: "EAUTH" });
    },
    close() {},
  });
  await assert.rejects(() => f.service.send({ ...d, draftId: d.id }));
  assert.equal(f.store.state.drafts.length, 1);
  f.service.transportFactory = () => ({
    sendMail: async () => ({
      accepted: ["reader@example.com"],
      rejected: ["hidden@example.com"],
    }),
    close() {},
  });
  const result = await f.service.send({ ...d, draftId: d.id });
  assert.equal(result.sent, true);
  assert.match(result.warning, /hidden@example.com/);
  assert.equal(f.store.state.drafts.length, 0);
});
