import React, { useState } from "react";
import { Plus, Minus, Settings, LoaderCircle } from "lucide-react";
import Modal from "./Modal";
import { smartFields, operators, validateSmart } from "../shared/rules.mjs";
export default function SmartEditor({
  initial,
  accounts,
  folders,
  api,
  onClose,
  onSaved,
  onRemoved,
}) {
  const [box, setBox] = useState(() => ({
      ...initial,
      includeTrash: !!initial.includeTrash,
      includeJunk: !!initial.includeJunk,
      includeSent: !!initial.includeSent,
    })),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [remove, setRemove] = useState(false);
  function update(index, patch) {
    setBox({
      ...box,
      conditions: box.conditions.map((c, i) =>
        i === index ? { ...c, ...patch } : c,
      ),
    });
  }
  function field(index, value) {
    update(index, {
      field: value,
      operator: operators(value)[0][0],
      value:
        value === "accountId"
          ? accounts[0]?.id || ""
          : value === "folder"
            ? "INBOX"
            : value === "date"
              ? "7"
              : "",
    });
  }
  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      validateSmart(box);
      const result = await api.saveSmart(box);
      onSaved(result);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Настройка смарт-ящика"
      onClose={() => {
        if (!busy) onClose();
      }}
      className="smart-modal"
    >
      <div className="smart-title">
        <Settings size={27} />
        <h2>{box.id ? "Настройка смарт-ящика" : "Новый смарт-ящик"}</h2>
      </div>
      <form onSubmit={save}>
        <fieldset disabled={busy}>
          <label className="smart-name">
            Название
            <input
              autoFocus
              aria-label="Название смарт-ящика"
              value={box.name}
              onChange={(e) => setBox({ ...box, name: e.target.value })}
              maxLength={80}
              required
              placeholder="Например, счета за месяц"
            />
          </label>
          <div className="smart-mode">
            Содержит письма, для которых выполняются{" "}
            <select
              aria-label="Режим условий"
              value={box.mode}
              onChange={(e) => setBox({ ...box, mode: e.target.value })}
            >
              <option value="all">все условия</option>
              <option value="any">любое из условий</option>
            </select>
            :
          </div>
          <div className="smart-conditions">
            {box.conditions.map((c, i) => (
              <div className="smart-condition" key={i}>
                <select
                  aria-label={`Поле условия ${i + 1}`}
                  value={c.field}
                  onChange={(e) => field(i, e.target.value)}
                >
                  {Object.entries(smartFields).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
                <select
                  aria-label={`Оператор условия ${i + 1}`}
                  value={c.operator}
                  onChange={(e) => update(i, { operator: e.target.value })}
                >
                  {operators(c.field).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
                {["read", "flagged", "hasAttachments"].includes(c.field) ? (
                  <span className="smart-boolean-space" />
                ) : c.field === "accountId" ? (
                  <select
                    aria-label={`Значение условия ${i + 1}`}
                    value={c.value}
                    required
                    onChange={(e) => update(i, { value: e.target.value })}
                  >
                    <option value="" disabled>
                      Выберите аккаунт
                    </option>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} — {a.email}
                      </option>
                    ))}
                  </select>
                ) : c.field === "folder" ? (
                  <select
                    aria-label={`Значение условия ${i + 1}`}
                    value={c.value}
                    onChange={(e) => update(i, { value: e.target.value })}
                  >
                    <option value="INBOX">Входящие</option>
                    {[
                      ...new Map(
                        folders
                          .filter((f) => f.path !== "INBOX")
                          .map((f) => [f.path, f]),
                      ).values(),
                    ].map((f) => (
                      <option key={f.path} value={f.path}>
                        {f.name || f.path}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    aria-label={`Значение условия ${i + 1}`}
                    type={c.field === "date" ? "number" : "text"}
                    min={c.field === "date" ? 1 : undefined}
                    max={c.field === "date" ? 36500 : undefined}
                    required
                    value={c.value}
                    onChange={(e) => update(i, { value: e.target.value })}
                  />
                )}
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Удалить условие ${i + 1}`}
                  disabled={box.conditions.length === 1}
                  onClick={() =>
                    setBox({
                      ...box,
                      conditions: box.conditions.filter(
                        (_, index) => index !== i,
                      ),
                    })
                  }
                >
                  <Minus size={15} />
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            className="text-button add-condition"
            disabled={box.conditions.length >= 30}
            onClick={() =>
              setBox({
                ...box,
                conditions: [
                  ...box.conditions,
                  { field: "subject", operator: "contains", value: "" },
                ],
              })
            }
          >
            <Plus size={14} />
            Добавить условие
          </button>
          <div className="smart-includes">
            {[
              ["includeSent", "Включать отправленные"],
              ["includeTrash", "Включать удалённые"],
              ["includeJunk", "Включать спам"],
            ].map(([key, label]) => (
              <label key={key}>
                <input
                  type="checkbox"
                  checked={box[key]}
                  onChange={(e) => setBox({ ...box, [key]: e.target.checked })}
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
        <p className="account-help">
          Смарт-ящик показывает подходящие письма из локально загруженных папок.
          Он не перемещает и не удаляет письма. Для поиска по другим папкам
          нажмите «Обновить все папки» в смарт-ящике.
        </p>
        {error && (
          <div className="form-error" role="alert">
            {error.replace(
              /^Error invoking remote method '[^']+': Error: /,
              "",
            )}
          </div>
        )}
        <div className="smart-footer">
          {box.id ? (
            <button
              type="button"
              className="text-button danger"
              disabled={busy}
              onClick={() => setRemove(true)}
            >
              Удалить смарт-ящик
            </button>
          ) : (
            <span />
          )}
          <div>
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={onClose}
            >
              Отмена
            </button>
            <button className="primary-button" disabled={busy}>
              {busy ? <LoaderCircle size={14} className="spinning" /> : null}
              Сохранить
            </button>
          </div>
        </div>
        {remove && (
          <div className="remove-confirm">
            <p>Удалить смарт-ящик? Письма сохранятся.</p>
            <button
              type="button"
              className="secondary-button"
              onClick={() => setRemove(false)}
            >
              Отмена
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api.removeSmart(box.id);
                  onRemoved();
                } catch (e) {
                  setError(e.message);
                  setBusy(false);
                }
              }}
            >
              Удалить
            </button>
          </div>
        )}
      </form>
    </Modal>
  );
}
