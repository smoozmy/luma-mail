const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  cleanHtml,
  validateAccount,
  publicAccount,
} = require("../electron/core.cjs");
test("email HTML cannot execute scripts or navigate via forms", () => {
  const html = cleanHtml(
    '<script>alert(1)</script><iframe src="https://evil.test"></iframe><form action="https://evil.test"><input></form><img src="javascript:alert(1)" onerror="alert(1)"><a href="javascript:alert(1)">click</a><div style="background-image:url(https://tracker.test);color:#123">safe</div><style>@import "https://tracker.test";</style>',
  );
  assert(!/script|iframe|<form|<input|onerror|javascript:/.test(html));
  assert(!html.includes('@import'));
  assert(html.includes("color:#123"));
});
test("safe email CSS keeps layout backgrounds while blocking unsafe imports", () => {
  const html = cleanHtml(
    '<style>.hero{background-image:url("https://cdn.example.test/hero.png");display:block} @import url("https://tracker.test/x.css");</style><div class="hero">Контент</div>',
  );
  assert.match(html, /background-image:url\("https:\/\/cdn\.example\.test\/hero\.png"\)/);
  assert(!html.includes("@import"));
  assert(!html.includes("tracker.test"));
  assert(html.includes('class="hero"'));
});
test("inline and external images are rendered while unsafe image schemes stay blocked", () => {
  const a = [
    {
      cid: "photo",
      type: "image/png",
      content: Buffer.from("png").toString("base64"),
    },
  ];
  assert(
    cleanHtml('<img src="cid:photo">', a).includes("data:image/png;base64,"),
  );
  assert(!cleanHtml('<img src="data:text/html,hello">').includes("data:"));
  assert(
    cleanHtml('<img src="https://example.com/a.png">').includes(
      "https://example.com/a.png",
    ),
  );
  assert(
    cleanHtml('<img src="https://example.com/a.png">', [], true).includes(
      "https://example.com/a.png",
    ),
  );
});

test("a repeated subject heading is removed from sanitized email HTML", () => {
  const html = cleanHtml(
    "<h1>Battle.net — Важное сообщение</h1><p>Содержимое письма</p>",
    [],
    true,
    "Battle.net — Важное сообщение",
  );
  assert(!html.includes("<h1>"));
  assert(html.includes("Содержимое письма"));
});

test("email document metadata is not rendered as message content", () => {
  const html = cleanHtml(
    '<!doctype html><html><head><title>Тема письма</title><style>body{color:red}</style></head><body><p>Текст письма</p></body></html>',
  );
  assert(!html.includes("Тема письма"));
  assert(html.includes("body{color:red}"));
  assert(html.includes("Текст письма"));
});
test("account configuration only allows supported fixed TLS hosts and strips unrelated fields", () => {
  assert.throws(() =>
    validateAccount({
      provider: "custom",
      host: "localhost",
      email: "x@y.com",
      password: "x",
    }),
  );
  assert.throws(() =>
    validateAccount({ provider: "gmail", email: "invalid", password: "x" }),
  );
  const a = validateAccount({
    provider: "icloud",
    email: "a@icloud.com",
    password: "secret",
    host: "evil.test",
  });
  assert.equal(a.host, "imap.mail.me.com");
  assert(!("password" in a));
  assert.deepEqual(publicAccount({ ...a, secret: "encrypted" }), a);
});

test("Exchange accounts use Autodiscover and do not persist the password in config", () => {
  const account = validateAccount({
    provider: "exchange",
    email: "employee@example.com",
    password: "not-a-real-password",
    host: "https://untrusted.example/",
  });
  assert.equal(account.host, "");
  assert.equal(account.provider, "exchange");
  assert(!("password" in account));
});

test("inherited object keys cannot masquerade as a mail provider", () => {
  for (const provider of ["__proto__", "constructor", "toString"])
    assert.throws(() =>
      validateAccount({ provider, email: "a@example.com", password: "test" }),
    );
});
