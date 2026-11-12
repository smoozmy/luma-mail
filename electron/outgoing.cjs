const MailComposer = require("nodemailer/lib/mail-composer");
const { randomUUID } = require("node:crypto");
const SMTP = {
  icloud: {
    host: "smtp.mail.me.com",
    port: 587,
    secure: false,
    requireTLS: true,
  },
  gmail: { host: "smtp.gmail.com", port: 465, secure: true },
  yandex: { host: "smtp.yandex.ru", port: 465, secure: true },
  microsoft: {
    host: "smtp.office365.com",
    port: 587,
    secure: false,
    requireTLS: true,
  },
};
function recipients(value, required = false) {
  if (typeof value !== "string" || value.length > 10000 || /[\r\n]/.test(value))
    throw new Error("Некорректный адрес получателя.");
  const list = value
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (required && !list.length) throw new Error("Укажите получателя.");
  if (
    list.length > 100 ||
    list.some((s) => !/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(s))
  )
    throw new Error("Введите адреса через запятую, например name@example.com.");
  return list;
}
function validateOutgoing(input) {
  if (!input || typeof input.accountId !== "string")
    throw new Error("Выберите отправителя.");
  const to = recipients(input.to || ""),
    cc = recipients(input.cc || ""),
    bcc = recipients(input.bcc || "");
  if (!to.length && !cc.length && !bcc.length)
    throw new Error("Укажите хотя бы одного получателя.");
  if (to.length + cc.length + bcc.length > 100)
    throw new Error("Не более 100 получателей.");
  if (
    typeof input.subject !== "string" ||
    input.subject.length > 998 ||
    /[\r\n]/.test(input.subject)
  )
    throw new Error("Некорректная тема письма.");
  if (typeof input.text !== "string" || input.text.length > 2 * 1024 * 1024)
    throw new Error("Текст письма слишком большой.");
  if (
    !Array.isArray(input.attachmentIds) ||
    input.attachmentIds.length > 30 ||
    input.attachmentIds.some((id) => typeof id !== "string")
  )
    throw new Error("Некорректные вложения.");
  return {
    accountId: input.accountId,
    to,
    cc,
    bcc,
    subject: input.subject,
    text: input.text,
    attachmentIds: [...new Set(input.attachmentIds)],
    replyToId: typeof input.replyToId === "string" ? input.replyToId : null,
    draftId: typeof input.draftId === "string" ? input.draftId : null,
  };
}
async function buildOutgoing(account, input, attachments, reply) {
  const compiled = new MailComposer({
    from: { name: account.senderName || "", address: account.email },
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject,
    text: input.text,
    attachments,
    messageId: `<${randomUUID()}@${account.email.split("@")[1]}>`,
    inReplyTo: reply?.messageId,
    references: reply
      ? [...(reply.references || []), reply.messageId].filter(Boolean)
      : undefined,
    disableFileAccess: true,
    disableUrlAccess: true,
  }).compile();
  compiled.keepBcc = false;
  const envelope = compiled.getEnvelope(),
    messageId = compiled.messageId();
  const message = await compiled.build();
  return { message, envelope, messageId };
}
module.exports = { SMTP, validateOutgoing, buildOutgoing };
