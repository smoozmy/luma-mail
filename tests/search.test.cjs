const { test } = require("node:test");
const assert = require("node:assert/strict");

let search;
async function loadSearch() {
  search ||= await import("../shared/search.mjs");
  return search;
}

const messages = {
  invoice: {
    from: "Billing",
    fromAddress: "billing@example.com",
    to: "me@example.com",
    subject: "Счёт за интернет",
    preview: "Оплата до 15 ноября",
    read: false,
    flagged: false,
    hasAttachments: true,
    folder: "INBOX",
    folderRole: "\\Inbox",
    date: "2026-11-10T10:00:00.000Z",
  },
  newsletter: {
    from: "Shop",
    fromAddress: "news@shop.example",
    to: "me@example.com",
    subject: "Скидки этой недели",
    preview: "Промокод и новые предложения",
    read: true,
    flagged: true,
    hasAttachments: false,
    folder: "INBOX",
    folderRole: "\\Inbox",
    date: "2026-11-01T10:00:00.000Z",
  },
};

test("search query parses quoted terms and operators", async () => {
  const { parseSearchQuery } = await loadSearch();
  assert.deepEqual(parseSearchQuery('from:billing subject:"Счёт за интернет" is:unread'), {
    terms: [],
    excludedTerms: [],
    filters: [
      { field: "from", value: "billing", negative: false },
      { field: "subject", value: "счёт за интернет", negative: false },
      { field: "is", value: "unread", negative: false },
    ],
  });
});

test("search query filters sender, attachment and unread state", async () => {
  const { matchesSearchQuery } = await loadSearch();
  assert.equal(
    matchesSearchQuery(messages.invoice, "from:billing has:attachment is:unread"),
    true,
  );
  assert.equal(
    matchesSearchQuery(messages.newsletter, "from:billing has:attachment is:unread"),
    false,
  );
});

test("search query supports exclusions, date boundaries and important callback", async () => {
  const { matchesSearchQuery } = await loadSearch();
  assert.equal(matchesSearchQuery(messages.invoice, "-shop after:2026-11-01"), true);
  assert.equal(matchesSearchQuery(messages.invoice, "before:2026-11-01"), false);
  assert.equal(
    matchesSearchQuery(messages.invoice, "is:important", {
      important: (message) => message.subject.includes("Счёт"),
    }),
    true,
  );
});
