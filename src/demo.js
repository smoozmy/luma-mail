const now = Date.now();
export const demoAccounts = [
  {
    id: "demo-icloud",
    name: "iCloud",
    email: "alex@icloud.com",
    provider: "icloud",
  },
  {
    id: "demo-gmail",
    name: "Личная почта",
    email: "alex@gmail.com",
    provider: "gmail",
  },
  {
    id: "demo-yandex",
    name: "Яндекс",
    email: "alex@yandex.ru",
    provider: "yandex",
  },
];
const entries = [
  [
    "Анна Смирнова",
    "Планы на выходные",
    "Привет! Нашла прекрасное место за городом. Давай съездим туда в субботу?",
    "icloud",
  ],
  [
    "Google",
    "Проверка безопасности аккаунта",
    "В вашем аккаунте выполнен вход с нового устройства Windows.",
    "gmail",
  ],
  [
    "Яндекс Путешествия",
    "Ваше бронирование подтверждено",
    "Всё готово к поездке. Подробности бронирования — в этом письме.",
    "yandex",
  ],
  [
    "Михаил Орлов",
    "Фотографии из поездки",
    "Привет! Отправляю несколько фотографий с нашего путешествия.",
    "icloud",
  ],
  [
    "Notion",
    "Небольшое обновление вашего пространства",
    "На этой неделе мы добавили несколько полезных возможностей.",
    "gmail",
  ],
  [
    "Анна Смирнова",
    "Re: Планы на выходные",
    "Отлично! Давай встретимся в десять. Пришлю маршрут чуть позже.",
    "icloud",
  ],
  [
    "Яндекс Маркет",
    "Заказ уже в пути",
    "Ваш заказ передан в доставку. Мы сообщим, когда можно будет его забрать.",
    "yandex",
  ],
  [
    "Дмитрий",
    "Книга, о которой мы говорили",
    "Вот та самая книга. Думаю, тебе понравится глава о дизайне.",
    "gmail",
  ],
  [
    "Apple",
    "Новости вашей учётной записи",
    "Ваши устройства синхронизированы с iCloud.",
    "icloud",
  ],
  [
    "Команда проекта",
    "Материалы к встрече",
    "Добрый день! Собрали все материалы в одном месте.",
    "yandex",
  ],
];
export const demoMessages = entries.map(([from, subject, preview, p], i) => ({
  id: `demo-${i}`,
  accountId: `demo-${p}`,
  from,
  fromAddress:
    i === 0
      ? "anna@example.com"
      : `hello@${p === "icloud" ? "example.com" : p + ".com"}`,
  to: demoAccounts.find((a) => a.provider === p).email,
  subject,
  preview,
  date: new Date(now - i * 3800000).toISOString(),
  read: i > 3,
  flagged: i === 3 || i === 7,
  messageId: `<demo-${i}>`,
  inReplyTo: i === 5 ? "<demo-0>" : null,
  size: 2031,
}));
export function demoBody(id) {
  const m = demoMessages.find((m) => m.id === id);
  const text = `${m.preview}\n\nЭто демонстрационное письмо: так будет выглядеть ваша почта после подключения аккаунта.\n\nХорошего дня!\n${m.from}`;
  return Promise.resolve({
    text,
    document: `<!doctype html><html><head><meta charset="utf-8"><style>body{font:15px/1.7 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#252525;padding:24px 30px;margin:0}p{margin:0 0 22px}</style></head><body><p>${m.preview}</p><p>Это демонстрационное письмо: так будет выглядеть ваша почта после подключения аккаунта.</p><p>Хорошего дня!<br>${m.from}</p></body></html>`,
    attachments: [],
  });
}
