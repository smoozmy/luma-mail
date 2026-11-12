const DEFAULT_MODEL = "gpt-4o-mini";
const ENDPOINT = "https://api.openai.com/v1/chat/completions";
const BATCH_SIZE = 20;

function apiKey() {
  return process.env.POSTA_OPENAI_API_KEY?.trim() || "";
}

function model() {
  return process.env.POSTA_OPENAI_MODEL?.trim() || DEFAULT_MODEL;
}

function publicStatus(cached = 0) {
  return { available: !!apiKey(), model: model(), cached };
}

function safeMessage(message) {
  return {
    id: String(message?.id || "").slice(0, 200),
    from: String(message?.from || "").slice(0, 300),
    fromAddress: String(message?.fromAddress || "").slice(0, 300),
    subject: String(message?.subject || "").slice(0, 500),
    preview: String(message?.preview || "").slice(0, 1200),
    date: String(message?.date || "").slice(0, 80),
  };
}

function promptFor(messages) {
  return `Определи, какие письма действительно важны для владельца личного почтового ящика.

Важное письмо — это действие или информация, которую нельзя легко пропустить: счёт, чек, платёж, заказ или доставка, встреча или запись, событие с датой, код или уведомление безопасности, срок/продление, рабочая задача или личная переписка.

Неважное письмо — это реклама, скидки, массовая рассылка, дайджест, статья, подборка, рекомендация, образовательный маркетинг, афиша без конкретной записи пользователя и обычное рекламное уведомление.

Верни только JSON-объект вида {"items":[{"id":"...","important":true,"category":"billing|security|deadline|calendar|orders|work|other","reason":"краткая причина"}]}. Для каждого входного id должна быть ровно одна запись. Не изменяй id. Причина — не более 80 символов, на русском языке.

Письма:
${JSON.stringify(messages)}`;
}

function responseText(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .filter((item) => item?.type === "text")
      .map((item) => item.text)
      .join("\n");
  return "";
}

function parseItems(text) {
  const cleaned = String(text || "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const parsed = JSON.parse(cleaned);
  return Array.isArray(parsed) ? parsed : parsed?.items;
}

async function requestBatch(messages) {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: model(),
      temperature: 0,
      max_tokens: 5000,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "Ты аккуратный классификатор почты. Не додумывай важность по одному рекламному слову и всегда возвращай валидный JSON.",
        },
        { role: "user", content: promptFor(messages) },
      ],
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      data?.error?.message || `OpenAI API вернул HTTP ${response.status}.`,
    );
  return parseItems(responseText(data));
}

async function classify(messages) {
  if (!apiKey())
    throw new Error(
      "ИИ не настроен. Укажите POSTA_OPENAI_API_KEY и перезапустите Luma Почту.",
    );
  if (!Array.isArray(messages) || !messages.length) return {};

  const unique = new Map(
    messages
      .map(safeMessage)
      .filter((message) => message.id)
      .map((message) => [message.id, message]),
  );
  const result = {};
  const entries = [...unique.values()];
  for (let offset = 0; offset < entries.length; offset += BATCH_SIZE) {
    const batch = entries.slice(offset, offset + BATCH_SIZE);
    const allowed = new Set(batch.map((message) => message.id));
    const items = await requestBatch(batch);
    if (!Array.isArray(items)) throw new Error("ИИ вернул некорректный формат ответа.");
    for (const item of items) {
      const id = String(item?.id || "");
      if (!allowed.has(id)) continue;
      result[id] = {
        important: item.important === true,
        category: String(item.category || "other").slice(0, 40),
        reason: String(item.reason || "Определено ИИ").slice(0, 120),
        updatedAt: new Date().toISOString(),
        model: model(),
      };
    }
    for (const message of batch) {
      result[message.id] ||= {
        important: false,
        category: "other",
        reason: "ИИ не отметил письмо как важное",
        updatedAt: new Date().toISOString(),
        model: model(),
      };
    }
  }
  return result;
}

module.exports = { classify, publicStatus };
