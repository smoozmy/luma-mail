const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../electron/store.cjs");
const { MailService } = require("../electron/mail.cjs");
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "posta-test-"));
  const vault = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(s),
    decryptString: (b) => b.toString(),
  };
  const store = new Store(dir, vault);
  const account = {
    id: "test-account",
    email: "test@example.com",
    name: "Test",
    provider: "gmail",
    secret: store.encrypt({ password: "test" }),
  };
  store.state.accounts.push(account);
  let uids = [1, 2],
    validity = 100;
  const flags = new Map();
  let fetches = 0;
  const client = {
    mailbox: { uidValidity: 100 },
    getMailboxLock: async () => {
      client.mailbox.uidValidity = validity;
      return { release() {} };
    },
    list: async () => [
      { path: "INBOX", name: "INBOX", flags: new Set(), specialUse: "\\Inbox" },
    ],
    search: async () => uids,
    async *fetch(range) {
      for (const uid of String(range).split(",").filter(Boolean).map(Number)) {
        yield {
          uid,
          envelope: {
            subject: "Письмо " + uid,
            from: [{ name: "Sender", address: "sender@example.com" }],
            to: [{ address: account.email }],
            date: new Date(uid * 100000),
            messageId: `<${uid}>`,
          },
          flags: new Set(flags.get(uid) || []),
          size: 150,
        };
      }
    },
    fetchOne: async (uid) => {
      fetches++;
      return {
        source: Buffer.from(
          `From: Sender <sender@example.com>\r\nTo: test@example.com\r\nSubject: Test\r\nMessage-ID: <${uid}>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nBody ${uid}`,
        ),
      };
    },
    messageFlagsAdd: async (uid, f) => flags.set(uid, f),
    messageFlagsRemove: async (uid) => flags.delete(uid),
    close() {},
  };
  const events = [];
  const service = new MailService(store, (...e) => events.push(e));
  service.client = async () => client;
  t.after(() => {
    service.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    store,
    service,
    account,
    client,
    events,
    flags,
    setUids: (v) => (uids = v),
    setValidity: (v) => (validity = v),
    fetches: () => fetches,
  };
}
test("sync merges UIDs without duplicates, caches MIME body and removes vanished mail", async (t) => {
  const f = fixture(t);
  await f.service.sync(f.account.id);
  assert.equal(f.store.state.messages.length, 2);
  assert(f.store.state.messages.every((m) => m.preview.startsWith("Body")));
  const count = f.fetches();
  await f.service.sync(f.account.id);
  assert.equal(f.store.state.messages.length, 2);
  assert.equal(f.fetches(), count);
  f.setUids([2, 3]);
  await f.service.sync(f.account.id);
  assert.deepEqual(f.store.state.messages.map((m) => m.uid).sort(), [2, 3]);
  assert.equal(f.events.filter((e) => e[0] === "new-mail").length, 1);
});
test("UIDVALIDITY changes cannot reuse cached body from a previous mailbox incarnation", async (t) => {
  const f = fixture(t);
  await f.service.sync(f.account.id);
  const old = f.store.state.messages[0].id;
  f.setValidity(101);
  await f.service.sync(f.account.id);
  assert(
    f.store.state.messages.every((m) => m.id !== old && m.validity === 101),
  );
  await assert.rejects(() => f.service.body(old), /не найдено/);
});
test("read and flagged status is synchronized with server; inbox data remains when disconnected", async (t) => {
  const f = fixture(t);
  await f.service.sync(f.account.id);
  const m = f.store.state.messages[0];
  await f.service.flag(m.id, "read", true);
  assert.deepEqual(f.flags.get(m.uid), ["\\Seen"]);
  assert(m.read);
  f.service.client = async () => {
    throw new Error("ECONNRESET");
  };
  assert((await f.service.body(m.id)).text.includes("Body"));
  await assert.rejects(() => f.service.sync(f.account.id));
  assert.equal(f.store.state.messages.length, 2);
  assert.equal(f.service.status[f.account.id].state, "error");
});
test("concurrent refresh calls share one sync; removing an account removes its local cache", async (t) => {
  const f = fixture(t);
  const a = f.service.sync(f.account.id),
    b = f.service.sync(f.account.id);
  assert.equal(a, b);
  await a;
  const id = f.store.state.messages[0].id;
  assert(f.store.body(id));
  f.service.remove(f.account.id);
  assert.equal(f.store.state.messages.length, 0);
  assert.equal(f.store.state.accounts.length, 0);
  assert.equal(f.store.body(id), null);
});
test("secrets cannot be stored without an OS encryption facility", (t) => {
  const f = fixture(t);
  f.store.vault = { isEncryptionAvailable: () => false };
  assert.throws(() => f.store.encrypt({ password: "test" }), /недоступно/);
});
test("simultaneous consumers share a single reconnect attempt", async (t) => {
  const f = fixture(t);
  f.service.client = MailService.prototype.client;
  let opens = 0;
  f.service.openClient = async () => {
    opens++;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return f.client;
  };
  const clients = await Promise.all([
    f.service.client(f.account),
    f.service.client(f.account),
    f.service.client(f.account),
  ]);
  assert.equal(opens, 1);
  assert(clients.every((c) => c === f.client));
});
test("MIME attachments survive caching with filenames, content IDs and exact bytes", async (t) => {
  const f = fixture(t);
  await f.service.sync(f.account.id);
  const m = f.store.state.messages[0];
  f.store.dropBody(m.id);
  f.client.fetchOne = async () => ({
    source: Buffer.from(
      'From: Sender <sender@example.com>\r\nTo: test@example.com\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="part"\r\n\r\n--part\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nA message with an attachment\r\n--part\r\nContent-Type: application/pdf; name="test.pdf"\r\nContent-Disposition: attachment; filename="test.pdf"\r\nContent-ID: <test-file>\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0xLjQK\r\n--part--\r\n',
    ),
  });
  const b = await f.service.body(m.id);
  assert.equal(b.attachments[0].name, "test.pdf");
  assert.equal(b.attachments[0].type, "application/pdf");
  assert.equal(b.attachments[0].cid, "test-file");
  assert.equal(b.attachments[0].inline, false);
  assert.equal(
    Buffer.from(b.attachments[0].content, "base64").toString(),
    "%PDF-1.4\n",
  );
  assert.deepEqual(f.store.body(m.id), b);
});
