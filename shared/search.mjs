const TOKEN_PATTERN = /[^\s"]+:"[^"]*"|[^\s']+:'[^']*'|"[^"]*"|'[^']*'|\S+/g;

const FIELD_ALIASES = new Map([
  ["from", "from"],
  ["sender", "from"],
  ["to", "to"],
  ["cc", "cc"],
  ["subject", "subject"],
  ["body", "body"],
  ["text", "body"],
  ["in", "in"],
  ["folder", "in"],
  ["before", "before"],
  ["after", "after"],
  ["is", "is"],
  ["has", "has"],
]);

function unquote(value) {
  const text = String(value || "").trim();
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'"))
      return text.slice(1, -1).trim();
  }
  return text;
}

function normalize(value) {
  return String(value || "")
    .toLocaleLowerCase("ru")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseSearchQuery(input = "") {
  const terms = [];
  const excludedTerms = [];
  const filters = [];

  for (const original of String(input).match(TOKEN_PATTERN) || []) {
    const negative = original.startsWith("-") && original.length > 1;
    const token = negative ? original.slice(1) : original;
    const match = token.match(/^([a-z][a-z0-9_-]*):(.*)$/i);
    const field = match && FIELD_ALIASES.get(match[1].toLowerCase());
    const value = match ? unquote(match[2]) : "";

    if (field && value) {
      filters.push({ field, value: normalize(value), negative });
      continue;
    }

    const term = normalize(unquote(token));
    if (!term) continue;
    (negative ? excludedTerms : terms).push(term);
  }

  return { terms, excludedTerms, filters };
}

function valuesFor(message, field) {
  if (field === "from")
    return [message.from, message.fromAddress];
  if (field === "to") return [message.to];
  if (field === "cc") return [message.cc];
  if (field === "subject") return [message.subject];
  if (field === "body") return [message.preview, message.searchText];
  return [];
}

function contains(values, expected) {
  const needle = normalize(expected);
  return values.some((value) => normalize(value).includes(needle));
}

function folderMatches(message, expected) {
  const value = normalize(expected);
  const folder = normalize(message.folder);
  const role = normalize(message.folderRole);
  const aliases = {
    inbox: ["inbox", "\\inbox"],
    archive: ["archive", "\\archive"],
    sent: ["sent", "\\sent"],
    trash: ["trash", "\\trash", "deleted", "удалённые", "удаленные"],
    spam: ["spam", "junk", "\\spam", "\\junk", "спам"],
    drafts: ["drafts", "\\drafts", "черновики"],
  };
  const candidates = aliases[value] || [value];
  return candidates.includes(folder) || candidates.includes(role);
}

function flagMatches(message, value, important) {
  const expected = normalize(value);
  if (["unread", "непрочитанное", "непрочитанные"].includes(expected))
    return message.read === false;
  if (["read", "прочитанное", "прочитанные"].includes(expected))
    return message.read === true;
  if (["flagged", "starred", "флажок", "важное"].includes(expected))
    return expected === "важное" ? Boolean(important?.(message)) : Boolean(message.flagged);
  if (["important", "важное"].includes(expected)) return Boolean(important?.(message));
  return false;
}

function filterMatches(message, filter, important) {
  const value = filter.value;
  let matched;
  if (filter.field === "from" || filter.field === "to" || filter.field === "cc" ||
      filter.field === "subject" || filter.field === "body")
    matched = contains(valuesFor(message, filter.field), value);
  else if (filter.field === "in") matched = folderMatches(message, value);
  else if (filter.field === "is") matched = flagMatches(message, value, important);
  else if (filter.field === "has")
    matched = value === "attachment" || value === "attachments"
      ? Boolean(message.hasAttachments)
      : false;
  else if (filter.field === "before" || filter.field === "after") {
    const time = Date.parse(message.date);
    const boundary = Date.parse(value);
    if (!Number.isFinite(time) || !Number.isFinite(boundary)) matched = false;
    else matched = filter.field === "before" ? time < boundary : time >= boundary;
  } else matched = false;
  return filter.negative ? !matched : matched;
}

export function searchableMessageText(message = {}) {
  return normalize([
    message.from,
    message.fromAddress,
    message.to,
    message.cc,
    message.subject,
    message.preview,
    message.searchText,
  ].filter(Boolean).join(" "));
}

export function matchesSearchQuery(message, query, options = {}) {
  const parsed = typeof query === "string" ? parseSearchQuery(query) : query;
  const allText = searchableMessageText(message);
  if (!parsed.terms.every((term) => allText.includes(term))) return false;
  if (parsed.excludedTerms.some((term) => allText.includes(term))) return false;
  return parsed.filters.every((filter) =>
    filterMatches(message, filter, options.important),
  );
}
