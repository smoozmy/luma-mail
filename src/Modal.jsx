import React, { useRef, useEffect } from "react";
import { X } from "lucide-react";
export default function Modal({ children, onClose, title, className = "" }) {
  const ref = useRef();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const old = document.activeElement;
    const first = ref.current?.querySelector("button,input,select");
    first?.focus();
    const key = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeRef.current();
      }
      if (e.key === "Tab") {
        const els = [
          ...ref.current.querySelectorAll(
            "button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href]",
          ),
        ];
        const first = els[0],
          last = els.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    ref.current.addEventListener("keydown", key);
    return () => {
      ref.current?.removeEventListener("keydown", key);
      old?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`modal ${className}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={ref}
      >
        <button
          className="modal-close"
          aria-label="Закрыть окно"
          onClick={onClose}
        >
          <X size={17} />
        </button>
        {children}
      </div>
    </div>
  );
}
