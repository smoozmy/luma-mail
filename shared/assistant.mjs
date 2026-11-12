const SIGNALS = [
  {
    category: "billing",
    score: 5,
    pattern:
      /(сч[её]т(?:\s|$|[№:])|invoice|bill|payment|оплат|плат[её]ж|квитанц|чек|receipt|баланс|balance|возврат|refund|зарплат|salary|налог|tax)/i,
    reason: "Счёт или платёж",
  },
  {
    category: "security",
    score: 5,
    pattern:
      /(безопас|security|login|вход\s+(?:в\s+(?:аккаунт|уч[её]тн|систем|icloud)|выполнен|осуществл)|вош[её]л|парол|password|код подтвержд|verification|подозр|suspicious|двухфактор|two-factor|2fa|find my|локатор|отключен(?:о|а)?\s+устройств)/i,
    reason: "Безопасность аккаунта",
  },
  {
    category: "deadline",
    score: 5,
    pattern:
      /(срок|дедлайн|deadline|due|истека|заканчива|продле|renew|expires?|напомин(?:ание|а)\s+(?:о|об)|reminder\s+(?:to|for)|срочно|urgent)/i,
    reason: "Срок или напоминание",
  },
  {
    category: "calendar",
    score: 4,
    pattern:
      /(встреч|meeting|митинг|запис|при[её]м|appointment|календар|calendar|приглашен|invitation|ticket)/i,
    reason: "Событие или встреча",
  },
  {
    category: "orders",
    score: 4,
    pattern:
      /(заказ|достав|трек|tracking|посыл|брон|booking|reservation|билет|flight|поезд|отел|hotel|pickup|самовывоз|пункт выдачи|заберите|успейте до)/i,
    reason: "Заказ, доставка или поездка",
  },
  {
    category: "work",
    score: 3,
    pattern:
      /(задач|task|проект|project|контракт|contract|собесед|interview|signature)/i,
    reason: "Рабочее письмо",
  },
];

const NOISE_PATTERN =
  /(рассыл|newsletter|unsubscribe|отпис|промокод|промо|скид|распрод|акци|sale|offer|реклам|marketing|digest|дайджест|подборк|каталог|catalog|курс|courses|обучен|тренаж[её]р|урок|lesson|рекомендуем|recommended|webinar|вебинар|афиш|премьер|трансляц|бонус|мили|зарегистрир|статья|подарок|професс|карьер|учись|скилл)/i;
const AUTOMATED_SENDER_PATTERN =
  /(?:^|[.@+_-])(no-?reply|noreply|newsletter|marketing|promo|notification|notifications)(?:$|[.@+_-])/i;
const RESCUE_PATTERN =
  /(invoice|bill|payment|оплат|плат[её]ж|квитанц|чек|receipt|сч[её]т\s*(?:№|на|от)|налог(?:и|овое)?|зарплат|login|вход\s+(?:в\s+(?:аккаунт|уч[её]тн|систем|icloud)|выполнен|осуществл)|парол|password|код подтвержд|verification|подозр|suspicious|security alert|find my|локатор|двухфактор|two-factor|2fa|заказ|достав|tracking|трек|посыл|брон|booking|reservation|билет|flight|поезд|отел|hotel|pickup|самовывоз|пункт выдачи|заберите|успейте до|встреч|meeting|митинг|appointment|приглашен|invitation|продле(?:ть|ние)|renew|expires?|deadline|дедлайн|срок оплаты)/i;

function normalizedMessageText(message) {
  const fields = [
    message?.subject,
    message?.from,
    message?.fromAddress,
    message?.preview,
  ];

  // The full body often contains footer links, unsubscribe text and generic
  // words that make a newsletter look important. Use it only for messages
  // without a usable preview.
  if (!message?.preview && message?.searchText) fields.push(message.searchText);

  return fields
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isAssistantExcluded(message) {
  return ["\\Trash", "\\Junk", "\\Spam", "\\Sent"].includes(
    message?.folderRole,
  ) || ["Trash", "Junk", "Spam", "TRASH", "JUNK", "SPAM", "Sent"].includes(
    message?.folder,
  );
}

export function classifyMessage(message = {}) {
  const text = normalizedMessageText(message);
  const sender = String(message.fromAddress || "");
  const matches = SIGNALS.filter(({ pattern }) => pattern.test(text));
  const noise = NOISE_PATTERN.test(text);
  const automated = AUTOMATED_SENDER_PATTERN.test(sender);
  const coreImportant = RESCUE_PATTERN.test(text);
  let score = matches.reduce((total, signal) => total + signal.score, 0);

  if (noise) score -= 5;
  if (automated) score -= 1;
  if (message.hasAttachments) score += 1;
  if (message.flagged) score += 2;
  if (!automated && !noise && message.fromAddress) score += 1;

  const strongest = matches[0];
  const important =
    !isAssistantExcluded(message) &&
    (!noise || message.flagged || coreImportant) &&
    (score >= 4 || (message.flagged && score >= 2));

  return {
    important,
    score,
    category: strongest?.category || (message.flagged ? "flagged" : "other"),
    reason: strongest?.reason ||
      (message.flagged ? "Отмечено вами" : "Похоже на важную переписку"),
  };
}

export function isImportantMessage(message) {
  return classifyMessage(message).important;
}
