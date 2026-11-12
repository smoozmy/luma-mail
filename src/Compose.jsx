import React, { useState, useEffect, useRef } from "react";
import {
  Send,
  Paperclip,
  X,
  LoaderCircle,
  Trash2,
  Check,
  AlertCircle,
} from "lucide-react";
import Modal from "./Modal";
export default function Compose({
  accounts,
  initial,
  api,
  onClose,
  onSending,
  onSent,
  onSendError,
}) {
  const [form, setForm] = useState(() => ({
    id: initial.id || crypto.randomUUID(),
    accountId: initial.accountId || accounts[0]?.id,
    to: initial.to || "",
    cc: initial.cc || "",
    bcc: initial.bcc || "",
    subject: initial.subject || "",
    text: initial.text || "",
    replyToId: initial.replyToId || null,
    attachmentIds: initial.attachmentIds || [],
  }));
  const [attachments, setAttachments] = useState(initial.attachments || []),
    [status, setStatus] = useState(""),
    [error, setError] = useState(""),
    [sending, setSending] = useState(false),
    [attaching, setAttaching] = useState(false),
    [showCopies, setShowCopies] = useState(!!initial.cc || !!initial.bcc),
    [confirmDiscard, setConfirmDiscard] = useState(false);
  const latest = useRef(form),
    queue = useRef(Promise.resolve()),
    timer = useRef(),
    revision = useRef(0),
    sendingRef = useRef(false),
    mounted = useRef(true);
  latest.current = form;
  useEffect(
    () => () => {
      mounted.current = false;
      clearTimeout(timer.current);
    },
    [],
  );
  function enqueue(snapshot) {
    const next = queue.current
      .catch(() => {})
      .then(() => api.saveDraft(snapshot));
    queue.current = next;
    return next;
  }
  useEffect(() => {
    clearTimeout(timer.current);
    if (sendingRef.current) return;
    const generation = ++revision.current;
    setStatus("Сохранение…");
    timer.current = setTimeout(() => {
      enqueue(form)
        .then(() => {
          if (mounted.current && generation === revision.current)
            setStatus("Сохранено на этом ПК");
        })
        .catch((e) => {
          if (mounted.current) {
            setStatus("Не сохранено");
            setError(e.message);
          }
        });
    }, 600);
    return () => clearTimeout(timer.current);
  }, [form]);
  async function saveNow(snapshot = latest.current) {
    clearTimeout(timer.current);
    ++revision.current;
    await enqueue(snapshot);
    if (mounted.current) setStatus("Сохранено на этом ПК");
  }
  async function close() {
    if (sendingRef.current || attaching) return;
    try {
      await saveNow();
      onClose();
    } catch (e) {
      setError("Не удалось сохранить черновик. " + e.message);
    }
  }
  async function send(e) {
    e.preventDefault();
    if (sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setError("");
    try {
      await saveNow();
      onSending?.();
      const result = await api.send({
        ...latest.current,
        draftId: latest.current.id,
      });
      if (!result?.sent) throw new Error("Сервер не подтвердил отправку.");
      onSent(result);
    } catch (e) {
      setError(e.message);
      onSendError?.(e.message);
    } finally {
      sendingRef.current = false;
      if (mounted.current) setSending(false);
    }
  }
  async function addFiles() {
    setAttaching(true);
    setError("");
    try {
      const added = await api.pickAttachments();
      const next = [...attachments, ...added];
      if (
        next.length > 30 ||
        next.reduce((n, a) => n + a.size, 0) > 25 * 1024 * 1024
      ) {
        for (const a of added) await api.removeAttachment(a.id);
        throw new Error(
          "Можно прикрепить до 30 файлов общим размером до 25 МБ.",
        );
      }
      setAttachments(next);
      setForm((f) => ({ ...f, attachmentIds: next.map((a) => a.id) }));
    } catch (e) {
      setError(e.message);
    } finally {
      setAttaching(false);
    }
  }
  async function removeFile(id) {
    const next = {
      ...latest.current,
      attachmentIds: latest.current.attachmentIds.filter((x) => x !== id),
    };
    setForm(next);
    setAttachments(attachments.filter((a) => a.id !== id));
    try {
      await saveNow(next);
      await api.removeAttachment(id);
    } catch (e) {
      setError(e.message);
    }
  }
  async function discard() {
    if (sendingRef.current) return;
    clearTimeout(timer.current);
    await queue.current.catch(() => {});
    try {
      await api.removeDraft(form.id);
      for (const a of attachments) await api.removeAttachment(a.id);
      onClose();
    } catch (e) {
      setError(e.message);
    }
  }
  return (
    <Modal title="Новое письмо" onClose={close} className="compose-modal">
      <form onSubmit={send}>
        <header className="compose-header">
          <h2>{form.subject || "Новое письмо"}</h2>
          <div>
            <button
              type="button"
              className="icon-button"
              title="Добавить вложения"
              aria-label="Добавить вложения"
              disabled={sending || attaching}
              onClick={addFiles}
            >
              <Paperclip size={20} />
            </button>
            <button
              className="primary-button"
              disabled={sending || attaching || !accounts.length}
            >
              {sending ? (
                <LoaderCircle size={15} className="spinning" />
              ) : (
                <Send size={15} />
              )}{" "}
              {sending ? "Отправка…" : "Отправить"}
            </button>
          </div>
        </header>
        <fieldset disabled={sending} className="compose-fields">
          <label>
            <span>От:</span>
            <select
              aria-label="Отправитель"
              value={form.accountId}
              onChange={(e) => setForm({ ...form, accountId: e.target.value })}
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} &lt;{a.email}&gt;
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Кому:</span>
            <input
              autoFocus
              autoComplete="off"
              aria-label="Кому"
              placeholder="name@example.com"
              value={form.to}
              onChange={(e) => setForm({ ...form, to: e.target.value })}
            />
            <button
              type="button"
              className="text-button"
              onClick={() => setShowCopies(!showCopies)}
            >
              Копия / Скрытая
            </button>
          </label>
          {showCopies && (
            <>
              <label>
                <span>Копия:</span>
                <input
                  aria-label="Копия"
                  value={form.cc}
                  onChange={(e) => setForm({ ...form, cc: e.target.value })}
                />
              </label>
              <label>
                <span>Скрытая:</span>
                <input
                  aria-label="Скрытая копия"
                  value={form.bcc}
                  onChange={(e) => setForm({ ...form, bcc: e.target.value })}
                />
              </label>
            </>
          )}
          <label>
            <span>Тема:</span>
            <input
              aria-label="Тема"
              value={form.subject}
              onChange={(e) => setForm({ ...form, subject: e.target.value })}
              maxLength={998}
            />
          </label>
          <textarea
            aria-label="Текст письма"
            placeholder="Текст письма"
            value={form.text}
            onChange={(e) => setForm({ ...form, text: e.target.value })}
          />
        </fieldset>
        {attachments.length > 0 && (
          <div className="compose-attachments">
            {attachments.map((a) => (
              <div key={a.id}>
                <Paperclip size={14} />
                <span>{a.name}</span>
                <small>{Math.ceil(a.size / 1024)} КБ</small>
                <button
                  type="button"
                  aria-label={`Убрать ${a.name}`}
                  disabled={sending}
                  onClick={() => removeFile(a.id)}
                >
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
        {error && (
          <div className="form-error" role="alert">
            {error.replace(
              /^Error invoking remote method '[^']+': Error: /,
              "",
            )}
          </div>
        )}
        <footer className="compose-footer">
          <span>{sending ? "Ожидание подтверждения сервера…" : status}</span>
          <div>
            <button
              type="button"
              className="text-button danger"
              disabled={sending || attaching}
              onClick={() => setConfirmDiscard(true)}
            >
              <Trash2 size={13} />
              Удалить черновик
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={sending || attaching}
              onClick={close}
            >
              Сохранить и закрыть
            </button>
          </div>
        </footer>
        {confirmDiscard && (
          <div className="remove-confirm">
            <p>Удалить этот черновик и его локальные вложения?</p>
            <button
              type="button"
              className="secondary-button"
              onClick={() => setConfirmDiscard(false)}
            >
              Отмена
            </button>
            <button type="button" className="primary-button" onClick={discard}>
              Удалить
            </button>
          </div>
        )}
      </form>
    </Modal>
  );
}
