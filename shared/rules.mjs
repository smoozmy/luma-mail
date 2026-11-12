export const smartFields = {
  from: "Отправитель",
  to: "Получатель",
  subject: "Тема",
  text: "Текст письма",
  accountId: "Учётная запись",
  folder: "Папка",
  date: "Дата",
  read: "Прочитано",
  flagged: "С флажком",
  hasAttachments: "Есть вложения",
};
export function operators(field) {
  return ["read", "flagged", "hasAttachments"].includes(field)
    ? [
        ["true", "Да"],
        ["false", "Нет"],
      ]
    : field === "date"
      ? [
          ["within", "За последние дни"],
          ["older", "Старше дней"],
        ]
      : ["accountId", "folder"].includes(field)
        ? [
            ["equals", "Совпадает"],
            ["notEquals", "Не совпадает"],
          ]
        : [
            ["contains", "Содержит"],
            ["notContains", "Не содержит"],
            ["equals", "Совпадает"],
            ["startsWith", "Начинается с"],
          ];
}
export function validateSmart(input) {
  if (
    !input ||
    typeof input.name !== "string" ||
    !input.name.trim() ||
    input.name.length > 80
  )
    throw new Error("Введите название смарт-ящика (до 80 символов).");
  if (
    !Array.isArray(input.conditions) ||
    !input.conditions.length ||
    input.conditions.length > 30
  )
    throw new Error("Добавьте от 1 до 30 условий.");
  const conditions = input.conditions.map((c) => {
    if (
      !Object.hasOwn(smartFields, c.field) ||
      !operators(c.field).some(([op]) => op === c.operator)
    )
      throw new Error("Некорректное условие.");
    const value = String(c.value ?? "").trim();
    if (
      c.field === "date" &&
      (!/^\d+$/.test(value) || +value < 1 || +value > 36500)
    )
      throw new Error("Укажите число дней от 1 до 36500.");
    if (
      !["read", "flagged", "hasAttachments"].includes(c.field) &&
      (!value || value.length > 500)
    )
      throw new Error("Заполните значение каждого условия.");
    return { field: c.field, operator: c.operator, value };
  });
  return {
    name: input.name.trim(),
    mode: input.mode === "any" ? "any" : "all",
    includeTrash: !!input.includeTrash,
    includeJunk: !!input.includeJunk,
    includeSent: !!input.includeSent,
    conditions,
  };
}
export function matchesSmart(message, box, now = Date.now()) {
  const role = message.folderRole;
  if (
    (role === "\\Trash" && !box.includeTrash) ||
    (role === "\\Junk" && !box.includeJunk) ||
    (role === "\\Sent" && !box.includeSent)
  )
    return false;
  const matches = (c) => {
    if (["read", "flagged", "hasAttachments"].includes(c.field))
      return !!message[c.field] === (c.operator === "true");
    if (c.field === "date") {
      const age = now - new Date(message.date).getTime();
      return (
        Number.isFinite(age) &&
        (c.operator === "within"
          ? age >= 0 && age < +c.value * 86400000
          : age > +c.value * 86400000)
      );
    }
    const text = String(
      c.field === "from"
        ? `${message.from} ${message.fromAddress}`
        : c.field === "text"
          ? `${message.preview || ""} ${message.searchText || ""}`
          : (message[c.field] ?? ""),
    ).toLocaleLowerCase();
    const value = c.value.toLocaleLowerCase();
    return c.operator === "contains"
      ? text.includes(value)
      : c.operator === "notContains"
        ? !text.includes(value)
        : c.operator === "equals"
          ? text === value
          : c.operator === "notEquals"
            ? text !== value
            : c.operator === "startsWith"
              ? text.startsWith(value)
              : false;
  };
  return (
    !!box.conditions?.length &&
    (box.mode === "any"
      ? box.conditions.some(matches)
      : box.conditions.every(matches))
  );
}
