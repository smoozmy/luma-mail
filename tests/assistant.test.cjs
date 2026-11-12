const { test } = require("node:test");
const assert = require("node:assert/strict");

let assistant;
async function loadAssistant() {
  assistant ||= await import("../shared/assistant.mjs");
  return assistant;
}

test("assistant mailbox keeps billing, events and deadlines", async () => {
  const { classifyMessage } = await loadAssistant();
  assert.equal(
    classifyMessage({
      subject: "Счёт за интернет",
      from: "Провайдер",
      fromAddress: "billing@example.com",
      preview: "Оплата до 15 ноября",
    }).important,
    true,
  );
  assert.equal(
    classifyMessage({
      subject: "Встреча с врачом",
      from: "Клиника",
      fromAddress: "calendar@example.com",
      preview: "Напоминание: запись 12 ноября в 14:00",
    }).important,
    true,
  );
});

test("assistant mailbox filters promotional newsletters", async () => {
  const { classifyMessage } = await loadAssistant();
  assert.equal(
    classifyMessage({
      subject: "Скидки до 70%",
      from: "Магазин",
      fromAddress: "newsletter@shop.example",
      preview: "Промокод и лучшие предложения недели",
    }).important,
    false,
  );
  assert.equal(
    classifyMessage({
      subject: "От нуля к тестам: Java и REST Assured в одном курсе",
      from: "Онлайн-школа",
      fromAddress: "noreply@courses.example",
      preview: "Новая статья и подборка материалов без напоминаний",
      searchText: "Счёт за подписку и вход в аккаунт доступны в футере",
    }).important,
    false,
  );
});

test("assistant mailbox excludes trash, spam and sent messages", async () => {
  const { classifyMessage } = await loadAssistant();
  for (const folderRole of ["\\Trash", "\\Junk", "\\Sent"]) {
    assert.equal(
      classifyMessage({
        folderRole,
        subject: "Счёт за заказ",
        fromAddress: "billing@example.com",
      }).important,
      false,
    );
  }
});
