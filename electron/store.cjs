const fs = require("node:fs");
const path = require("node:path");
class Store {
  constructor(directory, vault) {
    this.directory = directory;
    this.vault = vault;
    fs.mkdirSync(directory, { recursive: true });
    this.file = path.join(directory, "mail-store.json");
    this.state = fs.existsSync(this.file)
      ? JSON.parse(fs.readFileSync(this.file, "utf8"))
      : {
          accounts: [],
          messages: [],
          settings: { notifications: true, threads: true },
          sync: {},
        };
    this.state.folders ||= [];
    this.state.smartBoxes ||= [];
    this.state.assistant ||= { verdicts: {} };
    this.state.assistant.verdicts ||= {};
    this.state.drafts ||= [];
    this.state.files ||= {};
    for (const m of this.state.messages) {
      m.folder ||= "INBOX";
      m.folderRole ||= m.folder === "INBOX" ? "\\Inbox" : null;
    }
    for (const a of this.state.accounts)
      if (!this.state.folders.some((f) => f.accountId === a.id))
        this.state.folders.push({
          accountId: a.id,
          path: "INBOX",
          name: "Входящие",
          specialUse: "\\Inbox",
        });
  }
  save() {
    const temp = this.file + ".tmp";
    fs.writeFileSync(temp, JSON.stringify(this.state), { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }
  encrypt(secret) {
    if (!this.vault.isEncryptionAvailable())
      throw new Error("Хранилище паролей Windows недоступно.");
    return this.vault.encryptString(JSON.stringify(secret)).toString("base64");
  }
  decrypt(secret) {
    return JSON.parse(this.vault.decryptString(Buffer.from(secret, "base64")));
  }
  bodyPath(id) {
    if (!/^[a-z\d-]+_\d+_\d+$/i.test(id))
      throw new Error("Некорректное письмо.");
    return path.join(this.directory, id + ".json");
  }
  body(id) {
    const file = this.bodyPath(id);
    return fs.existsSync(file)
      ? JSON.parse(fs.readFileSync(file, "utf8"))
      : null;
  }
  saveBody(id, body) {
    const file = this.bodyPath(id);
    fs.writeFileSync(file + ".tmp", JSON.stringify(body), { mode: 0o600 });
    fs.renameSync(file + ".tmp", file);
  }
  dropBody(id) {
    const file = this.bodyPath(id);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  filePath(id) {
    if (!/^[a-f\d-]{36}$/i.test(id)) throw new Error("Некорректное вложение.");
    return path.join(this.directory, "attachments", id);
  }
  removeFile(id) {
    const file = this.filePath(id);
    if (fs.existsSync(file)) fs.unlinkSync(file);
    delete this.state.files[id];
  }
  remove(accountId) {
    const account = this.state.accounts.find((a) => a.id === accountId);
    if (!account) return;
    this.state.accounts = this.state.accounts.filter((a) => a.id !== accountId);
    for (const name of fs.readdirSync(this.directory)) {
      if (
        (name.startsWith(accountId + "_") ||
          name.startsWith(accountId + "-f")) &&
        /^[-a-z\d]+_\d+_\d+\.json$/i.test(name)
      )
        fs.unlinkSync(path.join(this.directory, name));
    }
    this.state.messages = this.state.messages.filter(
      (m) => m.accountId !== accountId,
    );
    for (const key of Object.keys(this.state.sync))
      if (key === accountId || key.startsWith(accountId + "::"))
        delete this.state.sync[key];
    this.state.folders = this.state.folders.filter(
      (f) => f.accountId !== accountId,
    );
    const discarded = this.state.drafts.filter(
      (d) => d.accountId === accountId,
    );
    this.state.drafts = this.state.drafts.filter(
      (d) => d.accountId !== accountId,
    );
    for (const draft of discarded)
      for (const id of draft.attachmentIds || []) this.removeFile(id);
    this.save();
  }
}
module.exports = { Store };
