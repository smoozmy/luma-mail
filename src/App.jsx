import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  PanelLeft,
  Folder,
  Trash2,
  Archive,
  ShieldAlert,
  FileText,
  Send,
  PenSquare,
  Reply,
  ReplyAll,
  Forward,
  MoreHorizontal,
  Inbox,
  Mail,
  Flag,
  Sparkles,
  Search,
  Settings,
  Plus,
  ChevronDown,
  ChevronRight,
  Check,
  Cloud,
  RefreshCw,
  Paperclip,
  X,
  Minus,
  Square,
  Download,
  WifiOff,
  ArrowLeft,
  ExternalLink,
  Bell,
  Monitor,
  User,
  MailOpen,
  LoaderCircle,
  AlertCircle,
  Clock,
  Copy,
  ChevronUp,
  Building2,
} from "lucide-react";
import { demoAccounts, demoMessages, demoBody } from "./demo";
import Modal from "./Modal";
import Compose from "./Compose";
import SmartEditor from "./SmartEditor";
import { matchesSmart, validateSmart } from "../shared/rules.mjs";
import { isImportantMessage } from "../shared/assistant.mjs";
import { matchesSearchQuery, parseSearchQuery } from "../shared/search.mjs";
const bridge = window.posta;
const forcedDemo = new URLSearchParams(location.search).has("demo");
const providerNames = {
  icloud: "iCloud",
  gmail: "Google",
  yandex: "Яндекс",
  microsoft: "Microsoft 365",
  exchange: "Exchange / OWA",
};
const providerLinks = {
  icloud: "https://account.apple.com/",
  gmail: "https://myaccount.google.com/apppasswords",
  yandex: "https://id.yandex.ru/security/app-passwords",
  microsoft: "https://entra.microsoft.com/",
  exchange: "https://support.microsoft.com/",
};
const initial = {
  accounts: [],
  messages: [],
  settings: { notifications: true, threads: true },
  status: {},
  folders: [],
  smartBoxes: [],
  assistant: { verdicts: {} },
  drafts: [],
};
function Button({
  icon: Icon,
  title,
  onClick,
  active,
  disabled,
  children,
  className = "",
  ...props
}) {
  return (
    <button
      type="button"
      className={`icon-button ${active ? "active" : ""} ${className}`.trim()}
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      {...props}
    >
      {Icon && <Icon size={20} strokeWidth={1.65} />} {children}
    </button>
  );
}
function plural(n, one, few, many) {
  const mod = n % 100;
  return (
    n +
    " " +
    (mod >= 11 && mod <= 14
      ? many
      : n % 10 === 1
        ? one
        : n % 10 >= 2 && n % 10 <= 4
          ? few
          : many)
  );
}
function dateLabel(value) {
  const d = new Date(value);
  const today = new Date();
  if (d.toDateString() === today.toDateString())
    return d.toLocaleTimeString("ru", { hour: "2-digit", minute: "2-digit" });
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "Вчера";
  return d.toLocaleDateString("ru", { day: "numeric", month: "short" });
}
function resizeEmailFrame(event) {
  const frame = event.currentTarget;
  try {
    frame.__postaResizeObserver?.disconnect();
    frame.__postaImageCleanup?.();
    const document = frame.contentDocument;
    if (!document) return;
    const resize = () => {
      const root = document.documentElement;
      const body = document.body;
      const heights = [
        root?.scrollHeight,
        body?.scrollHeight,
        root?.offsetHeight,
        body?.offsetHeight,
        root?.getBoundingClientRect?.().height,
        body?.getBoundingClientRect?.().height,
      ].filter((value) => Number.isFinite(value));
      frame.style.height = `${Math.max(...heights, 440)}px`;
    };
    const images = [...document.images];
    const onImageLoad = () => resize();
    images.forEach((image) => image.addEventListener("load", onImageLoad));
    resize();
    requestAnimationFrame(resize);
    window.setTimeout(resize, 80);
    window.setTimeout(resize, 350);
    window.setTimeout(resize, 750);
    window.setTimeout(resize, 1400);
    if (window.ResizeObserver) {
      const observer = new ResizeObserver(resize);
      observer.observe(document.documentElement);
      if (document.body) observer.observe(document.body);
      frame.__postaResizeObserver = observer;
    }
    frame.__postaImageCleanup = () =>
      images.forEach((image) => image.removeEventListener("load", onImageLoad));
  } catch {
    frame.style.height = "min(720px, calc(100vh - 180px))";
  }
}
function groupThreads(messages, enabled) {
  if (!enabled) return messages.map((m) => ({ ...m, conversation: [m] }));
  const byId = new Map(
    messages
      .filter((m) => m.messageId)
      .map((m) => [`${m.accountId}:${m.messageId}`, m]),
  );
  const root = (m) => {
    let next = m,
      seen = new Set();
    while (next.inReplyTo && !seen.has(next.id)) {
      seen.add(next.id);
      const parent = byId.get(`${m.accountId}:${next.inReplyTo}`);
      if (!parent) break;
      next = parent;
    }
    return `${m.accountId}:${next.references?.[0] || next.inReplyTo || next.messageId || next.id}`;
  };
  const groups = new Map();
  for (const m of messages) {
    const key = root(m);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }
  return [...groups.values()]
    .map((list) => {
      list.sort((a, b) => new Date(b.date) - new Date(a.date));
      return {
        ...list[0],
        read: list.every((m) => m.read),
        flagged: list.some((m) => m.flagged),
        conversation: list,
      };
    })
    .sort((a, b) => new Date(b.date) - new Date(a.date));
}
export default function App() {
  const [state, setState] = useState(initial),
    [demo, setDemo] = useState(forcedDemo),
    [view, setView] = useState("all"),
    [selected, setSelected] = useState(null),
    [query, setQuery] = useState(""),
    [unread, setUnread] = useState(false),
    [sidebar, setSidebar] = useState(true),
    [sidebarWidth, setSidebarWidth] = useState(224),
    [modal, setModal] = useState(null),
    [error, setError] = useState(""),
    [body, setBody] = useState(null),
    [bodyError, setBodyError] = useState(""),
    [remote, setRemote] = useState(true),
    [busy, setBusy] = useState(false),
    [bulkBusy, setBulkBusy] = useState(false),
    [groupOpen, setGroupOpen] = useState({}),
    [listWidth, setListWidth] = useState(365),
    workspaceRef = useRef(),
    [composer, setComposer] = useState(null),
    [smartEditor, setSmartEditor] = useState(null),
    [accountMenu, setAccountMenu] = useState(null),
    [messageMenu, setMessageMenu] = useState(null),
    [selectedRows, setSelectedRows] = useState(() => new Set()),
    [undoNotice, setUndoNotice] = useState(null),
    [accountRename, setAccountRename] = useState(null),
    [sendStatus, setSendStatus] = useState(null),
    [assistantStatus, setAssistantStatus] = useState(null),
    [assistantBusy, setAssistantBusy] = useState(false),
    [updateInfo, setUpdateInfo] = useState({
      configured: false,
      state: "unconfigured",
      currentVersion: "0.4.1",
      version: null,
      percent: 0,
      error: "",
    }),
    [updateBusy, setUpdateBusy] = useState(false);
  const searchRef = useRef(),
    readerScrollRef = useRef(),
    generation = useRef(0),
    sendStatusTimer = useRef(),
    scrollTimers = useRef({});
  const api = useMemo(
    () =>
      demo
        ? {
            body: demoBody,
            flag: async (id, type, value) =>
              setState((s) => ({
                ...s,
                messages: s.messages.map((m) =>
                  m.id === id ? { ...m, [type]: value } : m,
                ),
              })),
            bulk: async (ids, action, destination) => {
              const selected = new Set(ids);
              const folder =
                destination === "\\\\Archive"
                  ? "Archive"
                  : destination === "\\\\Junk"
                    ? "Junk"
                    : destination === "\\\\Trash"
                      ? "Trash"
                      : destination;
              setState((s) => ({
                ...s,
                messages: s.messages.map((m) => {
                    if (!selected.has(m.id)) return m;
                    if (action === "move")
                      return { ...m, folder, folderRole: folder };
                    if (action === "read" || action === "unread")
                      return { ...m, read: action === "read" };
                    if (action === "flag" || action === "unflag")
                      return { ...m, flagged: action === "flag" };
                    return m;
                  }),
              }));
            },
            sync: async () => {},
            folders: async () => [],
            renameAccount: async (id, name) =>
              setState((s) => ({
                ...s,
                accounts: s.accounts.map((account) =>
                  account.id === id ? { ...account, name } : account,
                ),
              })),
            accountAction: async (id, action) =>
              setState((s) => ({
                ...s,
                messages:
                  action === "mark-read"
                    ? s.messages.map((message) =>
                        message.accountId === id
                          ? { ...message, read: true }
                          : message,
                      )
                    : s.messages.filter(
                        (message) =>
                          !(
                            message.accountId === id &&
                            ((action === "clear-spam" &&
                              message.folderRole === "\\Junk") ||
                              (action === "clear-trash" &&
                                message.folderRole === "\\Trash"))
                          ),
                      ),
              })),
            move: async () => {
              throw new Error("Перемещение доступно после подключения почты.");
            },
            saveSmart: async (input) => {
              const box = {
                ...validateSmart(input),
                id: input.id || crypto.randomUUID(),
              };
              setState((s) => ({
                ...s,
                smartBoxes: [
                  ...(s.smartBoxes || []).filter((b) => b.id !== box.id),
                  box,
                ],
              }));
              return box;
            },
            removeSmart: async (id) =>
              setState((s) => ({
                ...s,
                smartBoxes: s.smartBoxes.filter((b) => b.id !== id),
              })),
            saveDraft: async (draft) => {
              setState((s) => ({
                ...s,
                drafts: [
                  ...(s.drafts || []).filter((d) => d.id !== draft.id),
                  { ...draft, updatedAt: new Date().toISOString() },
                ],
              }));
              return draft;
            },
            send: async () => {
              throw new Error("Демонстрация не отправляет письма.");
            },
            pickAttachments: async () => [],
            removeAttachment: async () => {},
            removeDraft: async (id) =>
              setState((s) => ({
                ...s,
                drafts: s.drafts.filter((d) => d.id !== id),
              })),
            forwardAttachments: async () => [],
            older: async () => {},
            window: bridge?.window || (() => {}),
            external: (url) =>
              bridge
                ? bridge.external(url)
                : window.open(url, "_blank", "noopener"),
            settings: async (patch) =>
              setState((s) => ({
                ...s,
                settings: { ...s.settings, ...patch },
              })),
            assistant: async () => ({}),
            assistantStatus: async () => ({ available: false, cached: 0 }),
          }
        : bridge,
    [demo],
  );
  useEffect(() => {
    if (demo) {
      setState({
        accounts: demoAccounts,
        folders: demoAccounts.flatMap((a) => [
          {
            accountId: a.id,
            path: "INBOX",
            specialUse: "\\Inbox",
            name: "Входящие",
          },
          ...[
            ["Sent", "\\Sent"],
            ["Junk", "\\Junk"],
            ["Trash", "\\Trash"],
            ["Drafts", "\\Drafts"],
            ["Archive", "\\Archive"],
          ].map(([path, specialUse]) => ({
            accountId: a.id,
            path,
            specialUse,
            name: path,
          })),
        ]),
        smartBoxes: [],
        assistant: { verdicts: {} },
        drafts: [],
        messages: demoMessages,
        settings: { notifications: true, threads: true },
        status: Object.fromEntries(
          demoAccounts.map((a) => [
            a.id,
            {
              state: "online",
              total: demoMessages.filter((m) => m.accountId === a.id).length,
              loaded: 300,
              lastSync: new Date().toISOString(),
            },
          ]),
        ),
      });
      setUpdateInfo((current) => ({ ...current, configured: false, state: "unconfigured" }));
      return;
    }
    setState(initial);
    setSelected(null);
    if (bridge) {
      bridge
        .state()
        .then(setState)
        .catch((e) => setError(e.message));
      bridge
        .assistantStatus?.()
        .then(setAssistantStatus)
        .catch(() => setAssistantStatus({ available: false, cached: 0 }));
      bridge
        .updateState?.()
        .then(setUpdateInfo)
        .catch(() => {});
      const unsubscribeState = bridge.onState(setState);
      const unsubscribeUpdate = bridge.onUpdate?.(setUpdateInfo);
      return () => {
        unsubscribeState?.();
        unsubscribeUpdate?.();
      };
    }
  }, [demo]);
  const accounts = state.accounts;
  const folders = state.folders || [],
    smartBoxes = state.smartBoxes || [],
    drafts = state.drafts || [];
  const folderSelection = useMemo(() => {
    if (!view.startsWith("folder:")) return null;
    const [_, id, ...rest] = view.split(":");
    return { accountId: id, path: decodeURIComponent(rest.join(":")) };
  }, [view]);
  const visibleDrafts = drafts.filter(
    (d) =>
      !query.trim() ||
      [d.to, d.subject, d.text]
        .join(" ")
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  const activeSmart = smartBoxes.find((b) => view === `smart:${b.id}`);
  const assistantVerdicts = state.assistant?.verdicts || {};
  const isDisplayedImportant = (message) =>
    message.flagged ||
    (Object.hasOwn(assistantVerdicts, message.id)
      ? assistantVerdicts[message.id]?.important === true
      : isImportantMessage(message));
  const folderView = (id, path) => `folder:${id}:${encodeURIComponent(path)}`;
  const totalUnread = state.messages.filter(
    (m) => (m.folder || "INBOX") === "INBOX" && !m.read,
  ).length;
  const importantUnread = state.messages.filter(
    (m) => isDisplayedImportant(m) && !m.read,
  ).length;
  const title =
    view === "all"
      ? "Все входящие"
      : view === "flagged"
        ? "Отмеченные флажком"
        : view === "important"
          ? "Важные письма"
          : view === "unread"
            ? "Непрочитанные"
            : view === "week"
              ? "За последнюю неделю"
              : view === "drafts"
                ? "Черновики на этом ПК"
                : activeSmart
                  ? activeSmart.name
                  : folderSelection
                    ? `${folderName(folders.find((f) => f.accountId === folderSelection.accountId && f.path === folderSelection.path) || { path: folderSelection.path })} — ${accounts.find((a) => a.id === folderSelection.accountId)?.name || ""}`
                    : "Входящие";
  const filtered = useMemo(() => {
    const searchQuery = parseSearchQuery(query);
    const seen = new Set();
    return state.messages
      .filter((m) => {
        const folder = m.folder || "INBOX";
        if (view === "drafts") return false;
        if (
          folderSelection &&
          (m.accountId !== folderSelection.accountId ||
            folder !== folderSelection.path)
        )
          return false;
        if (activeSmart && !matchesSmart(m, activeSmart)) return false;
        if (view === "important" && !isDisplayedImportant(m)) return false;
        if (
          !folderSelection &&
          !activeSmart &&
          !["flagged", "important"].includes(view) &&
          folder !== "INBOX"
        )
          return false;
        if (
          view === "flagged" &&
          !isVisibleFlaggedMessage(m)
        )
          return false;
        if (
          (view === "unread" && m.read) ||
          (view === "week" && Date.now() - new Date(m.date) > 7 * 86400000) ||
          (unread && m.read)
        )
          return false;
        if (
          (searchQuery.terms.length ||
            searchQuery.excludedTerms.length ||
            searchQuery.filters.length) &&
          !matchesSearchQuery(m, searchQuery, {
            important: isDisplayedImportant,
          })
        )
          return false;
        if (activeSmart && m.messageId) {
          const key = m.accountId + ":" + m.messageId;
          if (seen.has(key)) return false;
          seen.add(key);
        }
        return true;
      })
      .sort((a, b) => new Date(b.date) - new Date(a.date));
  }, [
    state.messages,
    query,
    view,
    unread,
    folderSelection,
    activeSmart,
    assistantVerdicts,
  ]);
  const messages = useMemo(
    () => groupThreads(filtered, state.settings.threads),
    [filtered, state.settings.threads],
  );
  useEffect(() => {
    if (selected)
      document
        .querySelector(`[data-message-id="${CSS.escape(selected)}"]`)
        ?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  useEffect(() => {
    const reader = readerScrollRef.current;
    if (!reader) return;
    reader.scrollTop = 0;
    reader.classList.remove("is-scrolled", "is-scrolling");
  }, [selected]);
  const current = state.messages.find((m) => m.id === selected);
  const conversation =
    messages.find((m) => m.conversation.some((x) => x.id === selected))
      ?.conversation || [];
  const selectedMessageIds = useMemo(
    () =>
      messages
        .filter((message) => selectedRows.has(message.id))
        .flatMap((message) => message.conversation)
        .map((message) => message.id),
    [messages, selectedRows],
  );
  const selectedMessageSet = useMemo(
    () => new Set(selectedMessageIds),
    [selectedMessageIds],
  );
  useEffect(() => {
    const token = ++generation.current;
    setBody(null);
    setBodyError("");
    if (!selected || !api) return;
    api
      .body(selected, remote)
      .then((b) => {
        if (generation.current === token) setBody(b);
      })
      .catch((e) => {
        if (generation.current === token) setBodyError(e.message);
      });
  }, [selected, remote, api]);
  function handleScroll(event, type) {
    const node = event.currentTarget;
    const scrolled = node.scrollTop > 1;
    const pane = node.closest(
      type === "reader"
        ? ".reader-pane"
        : type === "list"
          ? ".message-pane"
          : ".sidebar",
    );
    const toolbarSelector =
      type === "reader" ? ".reader-toolbar" : type === "list" ? ".list-toolbar" : null;
    const toolbar = toolbarSelector ? pane?.querySelector(toolbarSelector) : null;
    node.classList.toggle("is-scrolled", scrolled);
    toolbar?.classList.toggle("is-scrolled", scrolled);
    node.classList.add("is-scrolling");
    clearTimeout(scrollTimers.current[type]);
    scrollTimers.current[type] = window.setTimeout(() => {
      node.classList.remove("is-scrolling");
      scrollTimers.current[type] = null;
    }, 650);
  }
  async function runAccountMenuAction(action) {
    const menu = accountMenu;
    if (!menu) return;
    const account = accounts.find((item) => item.id === menu.accountId);
    setAccountMenu(null);
    if (!account) return;
    try {
      if (action === "rename") {
        setAccountRename({ accountId: menu.accountId, name: account.name });
        return;
      }
      if (
        action === "clear-spam" &&
        !window.confirm(`Стереть весь спам в ящике «${account.name}»?`)
      )
        return;
      if (
        action === "clear-trash" &&
        !window.confirm(`Стереть все удалённые письма в ящике «${account.name}»?`)
      )
        return;
      await api.accountAction(menu.accountId, action);
    } catch (e) {
      setError(e.message);
    }
  }
  function toggleRowSelection(message) {
    setSelectedRows((currentRows) => {
      const next = new Set(currentRows);
      if (next.has(message.id)) next.delete(message.id);
      else next.add(message.id);
      return next;
    });
    setSelected(message.id);
  }
  function openMessageMenu(event, message) {
    event.preventDefault();
    event.stopPropagation();
    setSelected(message.id);
    setSelectedRows((currentRows) => {
      if (currentRows.has(message.id)) return currentRows;
      return new Set([message.id]);
    });
    setMessageMenu({
      left: Math.min(event.clientX, window.innerWidth - 270),
      top: Math.min(event.clientY, window.innerHeight - 310),
      rowId: message.id,
    });
  }
  function closeMessageMenu() {
    setMessageMenu(null);
  }
  function actionLabel(action, count) {
    const noun = count === 1 ? "письмо" : "писем";
    return action === "read"
      ? `${count} ${noun} отмечено прочитанными`
      : action === "unread"
        ? `${count} ${noun} отмечено непрочитанными`
        : action === "flag"
          ? `${count} ${noun} отмечено флажком`
          : action === "unflag"
            ? `Флажок снят с ${count} ${noun}`
            : "Письма перемещены";
  }
  async function runBulkAction(action, destination = null) {
    const ids = [...selectedMessageSet];
    if (!ids.length || bulkBusy) return;
    const before = state.messages
      .filter((message) => selectedMessageSet.has(message.id))
      .map((message) => ({
        id: message.id,
        folder: message.folder || "INBOX",
        read: message.read,
        flagged: message.flagged,
      }));
    closeMessageMenu();
    setBulkBusy(true);
    try {
      await api.bulk(ids, action, destination);
      setSelectedRows(new Set());
      if (ids.includes(selected)) setSelected(null);
      setUndoNotice({ action, destination, before, label: actionLabel(action, ids.length) });
    } catch (e) {
      setError(e.message);
    } finally {
      setBulkBusy(false);
    }
  }
  async function undoLastAction() {
    const notice = undoNotice;
    if (!notice || bulkBusy) return;
    setUndoNotice(null);
    setBulkBusy(true);
    try {
      for (const item of notice.before) {
        const currentMessage = state.messages.find((message) => message.id === item.id);
        if (!currentMessage) continue;
        if (notice.action === "move") {
          if (item.folder !== notice.destination)
            await api.move(item.id, item.folder);
        } else if (notice.action === "read" || notice.action === "unread") {
          if (item.read !== (notice.action === "read"))
            await api.flag(item.id, "read", item.read);
        } else if (item.flagged !== (notice.action === "flag")) {
          await api.flag(item.id, "flagged", item.flagged);
        }
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBulkBusy(false);
    }
  }
  async function saveAccountRename(event) {
    event.preventDefault();
    if (!accountRename?.name.trim()) return;
    try {
      await api.renameAccount(accountRename.accountId, accountRename.name.trim());
      setAccountRename(null);
    } catch (e) {
      setError(e.message);
    }
  }
  function choose(m, event) {
    if (event?.ctrlKey || event?.metaKey) {
      toggleRowSelection(m);
      return;
    }
    setSelectedRows(new Set());
    setSelected(m.id);
    setRemote(true);
    if (!m.read)
      api?.flag(m.id, "read", true).catch((e) => setError(e.message));
  }
  function changeView(next) {
    setView(next);
    setSelected(null);
    setSelectedRows(new Set());
    setMessageMenu(null);
    setQuery("");
    setUnread(false);
  }
  async function refresh() {
    if (!api) return;
    setBusy(true);
    try {
      if (folderSelection)
        await api.sync(folderSelection.accountId, folderSelection.path);
      else if (activeSmart) {
        await Promise.all(
          accounts.map(async (a) => {
            const all = await api.folders(a.id);
            for (const folder of all.filter((f) => f.specialUse !== "\\All"))
              await api.sync(a.id, folder.path);
          }),
        );
      } else await api.sync();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function checkForUpdates() {
    if (!bridge?.updateCheck || updateBusy) return;
    setUpdateBusy(true);
    try {
      await bridge.updateCheck();
    } catch (e) {
      setError(e.message);
    } finally {
      setUpdateBusy(false);
    }
  }
  async function downloadUpdate() {
    if (!bridge?.updateDownload || updateBusy) return;
    setUpdateBusy(true);
    try {
      await bridge.updateDownload();
    } catch (e) {
      setError(e.message);
    } finally {
      setUpdateBusy(false);
    }
  }
  async function installUpdate() {
    if (!bridge?.updateInstall || updateBusy) return;
    setUpdateBusy(true);
    try {
      await bridge.updateInstall();
    } catch (e) {
      setError(e.message);
      setUpdateBusy(false);
    }
  }
  async function runAssistant() {
    if (!api?.assistant) return;
    if (!assistantStatus?.available) {
      setError(
        "ИИ не настроен. Задайте POSTA_OPENAI_API_KEY и перезапустите Luma Почту.",
      );
      return;
    }
    setAssistantBusy(true);
    try {
      const input = state.messages
        .filter((message) => (message.folder || "INBOX") === "INBOX")
        .map(({ id, from, fromAddress, subject, preview, date, folder }) => ({
          id,
          from,
          fromAddress,
          subject,
          preview,
          date,
          folder,
        }));
      const verdicts = await api.assistant(input);
      setState((currentState) => ({
        ...currentState,
        assistant: {
          ...currentState.assistant,
          verdicts: {
            ...(currentState.assistant?.verdicts || {}),
            ...verdicts,
          },
        },
      }));
      setAssistantStatus((currentStatus) => ({
        ...(currentStatus || {}),
        cached: Object.keys(verdicts).length,
      }));
    } catch (e) {
      setError(e.message);
    } finally {
      setAssistantBusy(false);
    }
  }
  useEffect(() => {
    if (folderSelection && !demo) {
      api
        ?.sync(folderSelection.accountId, folderSelection.path)
        .catch((e) => setError(e.message));
    }
  }, [view, demo]);
  async function openCompose(kind = "new") {
    if (!accounts.length) return;
    const base = {
      accountId: current?.accountId || accounts[0].id,
      to: "",
      cc: "",
      bcc: "",
      subject: "",
      text: "",
      attachmentIds: [],
    };
    if (kind !== "new" && current) {
      try {
        const content = body || (await api.body(current.id));
        const quote = `\n\n${new Date(current.date).toLocaleString("ru")} ${current.from} <${current.fromAddress}>:\n${content.text
          .split("\n")
          .map((line) => "> " + line)
          .join("\n")}`;
        base.subject = (kind === "forward" ? /^fwd?:/i : /^re:/i).test(
          current.subject,
        )
          ? current.subject
          : (kind === "forward" ? "Fwd: " : "Re: ") + current.subject;
        base.text = quote;
        if (kind === "forward") {
          const attached = await api.forwardAttachments(current.id);
          base.attachments = attached;
          base.attachmentIds = attached.map((a) => a.id);
        }
        if (kind !== "forward") {
          base.to =
            current.fromAddress?.toLowerCase() ===
            accounts
              .find((a) => a.id === current.accountId)
              ?.email.toLowerCase()
              ? current.to
              : current.replyTo || current.fromAddress;
          base.replyToId = current.id;
        }
        if (kind === "replyAll") {
          const own = new Set(accounts.map((a) => a.email.toLowerCase()));
          base.cc = [
            ...new Set(
              (current.to + "," + (current.cc || ""))
                .split(",")
                .map((x) => x.trim())
                .filter(
                  (x) =>
                    x &&
                    !own.has(x.toLowerCase()) &&
                    x.toLowerCase() !== base.to.toLowerCase(),
                ),
            ),
          ].join(", ");
        }
      } catch (e) {
        setError(e.message);
        return;
      }
    }
    setComposer(base);
  }
  async function moveCurrent(destination) {
    if (!current) return;
    try {
      await api.move(current.id, destination);
      setSelected(null);
    } catch (e) {
      setError(e.message);
    }
  }
  async function toggleFlag() {
    if (current)
      try {
        await api.flag(current.id, "flagged", !current.flagged);
      } catch (e) {
        setError(e.message);
      }
  }
  useEffect(() => {
    const listener = (e) => {
      if (modal || composer || smartEditor) return;
      if (e.target.matches("input,textarea,select")) {
        if (e.key === "Escape") e.target.blur();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        searchRef.current?.focus();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "r") {
        e.preventDefault();
        refresh();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const i = messages.findIndex((m) =>
          m.conversation.some((x) => x.id === selected),
        );
        const m =
          messages[
            Math.max(
              0,
              Math.min(
                messages.length - 1,
                i + (e.key === "ArrowDown" ? 1 : -1),
              ),
            )
          ];
        if (m) choose(m);
      } else if (e.key === "Escape") {
        setAccountMenu(null);
        setMessageMenu(null);
        setModal(null);
        setQuery("");
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [messages, selected, api, view, modal, composer, smartEditor]);
  useEffect(() => {
    if (!accountMenu && !messageMenu) return;
    const close = () => {
      setAccountMenu(null);
      setMessageMenu(null);
    };
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [accountMenu, messageMenu]);
  useEffect(() => {
    if (!undoNotice) return;
    const timer = window.setTimeout(() => setUndoNotice(null), 9000);
    return () => window.clearTimeout(timer);
  }, [undoNotice]);
  function windowAction(action) {
    try {
      const result = api?.window(action);
      result?.catch?.((e) => setError(e.message));
    } catch (e) {
      setError(e.message);
    }
  }
  function resize(e) {
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture?.(e.pointerId);
    const workspace = workspaceRef.current;
    if (!workspace) return;
    workspace.style.transition = "none";
    const start = e.clientX;
    const initial = listWidth;
    let next = initial;
    let frame = 0;
    const paint = () => {
      frame = 0;
      workspace.style.gridTemplateColumns = `${sidebar ? `${sidebarWidth}px` : "0px"} ${next}px minmax(350px,1fr)`;
    };
    const move = (event) => {
      event.preventDefault();
      next = Math.max(285, Math.min(580, initial + event.clientX - start));
      if (!frame) frame = requestAnimationFrame(paint);
    };
    const end = () => {
      if (frame) cancelAnimationFrame(frame);
      paint();
      setListWidth(next);
      workspace.style.transition = "";
      handle.releasePointerCapture?.(e.pointerId);
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", end, { once: true });
    window.addEventListener("pointercancel", end, { once: true });
  }
  function resizeSidebar(e) {
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture?.(e.pointerId);
    const workspace = workspaceRef.current;
    if (!workspace) return;
    workspace.style.transition = "none";
    const start = e.clientX;
    const initial = sidebarWidth;
    let next = initial;
    let frame = 0;
    const paint = () => {
      frame = 0;
      workspace.style.gridTemplateColumns = `${next}px ${listWidth}px minmax(350px,1fr)`;
    };
    const move = (event) => {
      event.preventDefault();
      next = Math.max(180, Math.min(420, initial + event.clientX - start));
      if (!frame) frame = requestAnimationFrame(paint);
    };
    const end = () => {
      if (frame) cancelAnimationFrame(frame);
      paint();
      setSidebarWidth(next);
      workspace.style.transition = "";
      handle.releasePointerCapture?.(e.pointerId);
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", end, { once: true });
    window.addEventListener("pointercancel", end, { once: true });
  }
  const syncing =
    busy || Object.values(state.status).some((s) => s.state === "syncing");
  const failed = Object.values(state.status).filter((s) => s.error);
  function showSendStatus(next, timeout = 0) {
    clearTimeout(sendStatusTimer.current);
    setSendStatus(next);
    if (timeout)
      sendStatusTimer.current = setTimeout(() => setSendStatus(null), timeout);
  }
  return (
    <div className="app-shell">
      {demo && (
        <div className="demo-banner">
          Демонстрационные письма · реальные аккаунты не подключены
          <button
            onClick={() => {
              setDemo(false);
              setModal("add");
            }}
          >
            Подключить мою почту <ArrowLeft size={13} className="rotate" />
          </button>
        </div>
      )}
      <div
        className="workspace"
        ref={workspaceRef}
        style={{
          gridTemplateColumns: `${sidebar ? `${sidebarWidth}px` : "0px"} ${listWidth}px minmax(350px,1fr)`,
        }}
      >
        <aside className={`sidebar ${!sidebar ? "hidden" : ""}`}>
          <div className="sidebar-toolbar">
            <div className="mail-app-mark" title="Luma Почта" aria-label="Luma Почта">
              <Mail size={21} strokeWidth={2} />
            </div>
            <Button
              icon={PanelLeft}
              title="Скрыть боковое меню"
              onClick={() => setSidebar(false)}
              className="sidebar-toggle-button"
            />
          </div>
          <nav aria-label="Почтовые ящики" onScroll={(event) => handleScroll(event, "sidebar")}>
            {!accounts.length && (
              <p className="sidebar-placeholder">
                Подключите почту, чтобы здесь появились ваши ящики и папки.
              </p>
            )}
            {accounts.length > 0 && (
              <>
                <h3>Избранное</h3>
                <NavRow
                  icon={Inbox}
                  label="Все входящие"
                  count={totalUnread}
                  active={view === "all"}
                  onClick={() => changeView("all")}
                />
                <NavRow
                  icon={Flag}
                  label="Отмеченные флажком"
                  count={state.messages.filter(isVisibleFlaggedMessage).length}
                  active={view === "flagged"}
                  onClick={() => changeView("flagged")}
                />
                <NavRow
                  icon={Sparkles}
                  label="Важные письма"
                  count={importantUnread}
                  active={view === "important"}
                  onClick={() => changeView("important")}
                />
                <NavRow
                  icon={FileText}
                  label="Черновики на ПК"
                  count={drafts.length}
                  active={view === "drafts"}
                  onClick={() => changeView("drafts")}
                />
              </>
            )}
            {accounts.map((a) => (
              <section key={a.id} className="account-section">
                <button
                  className="account-heading"
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setAccountMenu({
                      accountId: a.id,
                      left: event.clientX,
                      top: event.clientY,
                    });
                  }}
                  onClick={() =>
                    setGroupOpen({
                      ...groupOpen,
                      [a.id]: groupOpen[a.id] === false,
                    })
                  }
                >
                  <span>{a.name}</span>
                  {groupOpen[a.id] === false ? (
                    <ChevronRight size={13} />
                  ) : (
                    <ChevronDown size={13} />
                  )}
                </button>
                {groupOpen[a.id] !== false && (
                  <>
                    {folders
                      .filter((f) => f.accountId === a.id)
                      .sort(
                        (a, b) =>
                          folderOrder(a) - folderOrder(b) ||
                          a.path.localeCompare(b.path),
                      )
                      .map((folder) => (
                        <NavRow
                          key={folder.path}
                          title={folder.path}
                          icon={folderIcon(folder)}
                          label={folderName(folder)}
                          count={
                            folder.unread ??
                            state.messages.filter(
                              (m) =>
                                m.accountId === a.id &&
                                (m.folder || "INBOX") === folder.path &&
                                !m.read,
                            ).length
                          }
                          active={view === folderView(a.id, folder.path)}
                          onClick={() =>
                            changeView(folderView(a.id, folder.path))
                          }
                        />
                      ))}
                    <div className="account-address">
                      <span
                        className={`status-dot ${state.status[a.id]?.state || "offline"}`}
                      />
                      <span title={a.email}>{a.email}</span>
                    </div>
                    {state.status[a.id]?.error && (
                      <button
                        className="account-error"
                        onClick={() => setError(state.status[a.id].error)}
                      >
                        Нет подключения
                      </button>
                    )}
                  </>
                )}
              </section>
            ))}
            <button
              className="add-account-link"
              onClick={() => setModal("add")}
            >
              <Plus size={16} />
              Добавить учётную запись
            </button>
          </nav>
          <div className="sidebar-bottom">
            <Button
              icon={Settings}
              title="Настройки"
              onClick={() => setModal("settings")}
            />
            <span>
              {syncing
                ? "Получение почты…"
                : accounts.length
                  ? plural(
                      accounts.length,
                      "учётная запись",
                      "учётные записи",
                      "учётных записей",
                    )
                  : "Нет учётных записей"}
            </span>
          </div>
          <div
            className="sidebar-resize-handle"
            onPointerDown={resizeSidebar}
          />
        </aside>
        <section className="message-pane" aria-label="Список писем">
          <div className="list-toolbar">
            {!sidebar && (
              <Button
                icon={PanelLeft}
                title="Показать боковое меню"
                onClick={() => setSidebar(true)}
                className="sidebar-toggle-collapsed"
              />
            )}
            <div className="mailbox-title">
              <h1>{title}</h1>
              <p>
                {selectedRows.size
                  ? `${selectedRows.size} выбрано`
                  : view === "drafts"
                    ? plural(
                        visibleDrafts.length,
                        "черновик",
                        "черновика",
                        "черновиков",
                      )
                    : plural(filtered.length, "письмо", "письма", "писем")}
                {!selectedRows.size && filtered.filter((m) => !m.read).length > 0 &&
                  `, непрочитанных: ${filtered.filter((m) => !m.read).length}`}
              </p>
            </div>
            {selectedRows.size ? (
              <div className="pill bulk-actions" aria-label="Действия с выбранными письмами">
                <Button icon={MailOpen} title="Отметить прочитанными" disabled={bulkBusy} onClick={() => runBulkAction("read")} />
                <Button icon={Mail} title="Отметить непрочитанными" disabled={bulkBusy} onClick={() => runBulkAction("unread")} />
                <Button icon={Flag} title="Установить флажок" disabled={bulkBusy} onClick={() => runBulkAction("flag")} />
                <Button icon={Archive} title="В архив" disabled={bulkBusy} onClick={() => runBulkAction("move", "\\Archive")} />
                <Button icon={ShieldAlert} title="В спам" disabled={bulkBusy} onClick={() => runBulkAction("move", "\\Junk")} />
                <Button icon={Trash2} title="В удалённые" disabled={bulkBusy} onClick={() => runBulkAction("move", "\\Trash")} />
                <Button icon={X} title="Снять выбор" disabled={bulkBusy} onClick={() => setSelectedRows(new Set())} />
              </div>
            ) : (
              <div className="pill">
                <Button
                  icon={Mail}
                  title="Только непрочитанные"
                  active={unread}
                  onClick={() => setUnread(!unread)}
                />
              </div>
            )}
            {view === "important" && (
              <div className="pill">
                <Button
                  icon={Sparkles}
                  title={
                    assistantStatus?.available
                      ? "Уточнить важные письма через ИИ"
                      : "ИИ не настроен"
                  }
                  disabled={assistantBusy || !assistantStatus?.available}
                  onClick={runAssistant}
                  className={assistantBusy ? "spinning" : ""}
                />
              </div>
            )}
          </div>
          <div
            className="message-list"
            role="listbox"
            aria-label="Письма"
            onScroll={(event) => handleScroll(event, "list")}
          >
            {messages.map((m) => (
              <button
                role="option"
                data-message-id={m.id}
                aria-selected={m.conversation.some((x) => x.id === selected)}
                key={m.id}
                className={`message-row ${m.conversation.some((x) => x.id === selected) ? "selected" : ""} ${selectedRows.has(m.id) ? "bulk-selected" : ""} ${!m.read ? "unread" : ""}`}
                onClick={(event) => choose(m, event)}
                onContextMenu={(event) => openMessageMenu(event, m)}
              >
                <span className="unread-dot" />
                <div className="message-row-content">
                  <div className="message-row-top">
                    <strong>{m.from}</strong>
                    <div className="message-row-time">
                      <span className="message-row-account">
                        {accounts.find((a) => a.id === m.accountId)?.name}
                      </span>
                      <time>{dateLabel(m.date)}</time>
                    </div>
                  </div>
                  <div className="message-row-subject">{m.subject}</div>
                  <div className="message-row-preview">
                    {m.preview || "Нажмите, чтобы загрузить содержимое письма."}
                  </div>
                  <div className="message-row-meta">
                    <div>
                      {m.conversation.length > 1 && (
                        <span className="thread-count">
                          {m.conversation.length}
                        </span>
                      )}
                      {m.flagged && (
                        <Flag
                          size={12}
                          fill="currentColor"
                          className="orange"
                        />
                      )}
                    </div>
                  </div>
                </div>
              </button>
            ))}
            {view === "drafts" &&
              visibleDrafts.map((d) => (
                <button
                  className="message-row draft-row"
                  key={d.id}
                  onClick={() => setComposer(d)}
                >
                  <div className="message-row-content">
                    <div className="message-row-top">
                      <strong>{d.to || "Без получателя"}</strong>
                      <time>{dateLabel(d.updatedAt)}</time>
                    </div>
                    <div className="message-row-subject">
                      {d.subject || "Без темы"}
                    </div>
                    <div className="message-row-preview">
                      {d.text || "Пустой черновик"}
                    </div>
                    <div className="message-row-meta">
                      {accounts.find((a) => a.id === d.accountId)?.name}
                    </div>
                  </div>
                </button>
              ))}
            {activeSmart && (
              <div className="smart-scope-note">
                Среди загруженных писем.{" "}
                <button onClick={refresh} disabled={syncing}>
                  Обновить все папки
                </button>
              </div>
            )}
            {!messages.length &&
              !(view === "drafts" && visibleDrafts.length) && (
                <div className="list-empty">
                  {query ? (
                    <>
                      <Search size={31} />
                      <strong>Ничего не найдено</strong>
                      <p>Попробуйте другой запрос.</p>
                    </>
                  ) : accounts.length ? (
                    <>
                      <Inbox size={34} />
                      <strong>
                        {syncing ? "Получение писем…" : "Здесь пока нет писем"}
                      </strong>
                      <p>
                        {unread || view === "unread"
                          ? "Все письма прочитаны."
                          : "Письма появятся после синхронизации."}
                      </p>
                    </>
                  ) : (
                    <>
                      <Inbox size={34} />
                      <strong>Ваша почта — в одном месте</strong>
                      <p>Добавьте первый почтовый ящик.</p>
                      <button
                        className="text-button"
                        onClick={() => setModal("add")}
                      >
                        Добавить учётную запись
                      </button>
                    </>
                  )}
                </div>
              )}
            {accounts.length > 0 &&
              !query &&
              view !== "drafts" &&
              !activeSmart && (
                <div className="load-more">
                  <button
                    disabled={syncing}
                    onClick={async () => {
                      try {
                        if (folderSelection)
                          await api.older(
                            folderSelection.accountId,
                            folderSelection.path,
                          );
                        else
                          await Promise.all(
                            accounts.map((a) => api.older(a.id)),
                          );
                      } catch (e) {
                        setError(e.message);
                      }
                    }}
                  >
                    {syncing ? "Загрузка…" : "Загрузить более ранние письма"}
                  </button>
                </div>
              )}
          </div>
          <div className="resize-handle" onPointerDown={resize} />
        </section>
        <main className="reader-pane">
          <div className="reader-toolbar">
            <div className="reader-actions">
              <Button
                icon={PenSquare}
                title="Новое письмо"
                disabled={!accounts.length}
                onClick={() => openCompose()}
                className="new-message-button"
              />
              <div className="pill">
                <Button
                  icon={Reply}
                  title="Ответить"
                  disabled={!current}
                  onClick={() => openCompose("reply")}
                />
                <Button
                  icon={ReplyAll}
                  title="Ответить всем"
                  disabled={!current}
                  onClick={() => openCompose("replyAll")}
                />
                <Button
                  icon={Forward}
                  title="Переслать"
                  disabled={!current}
                  onClick={() => openCompose("forward")}
                />
              </div>
              <div className="pill">
                <Button
                  icon={MailOpen}
                  title={
                    current?.read
                      ? "Отметить непрочитанным"
                      : "Отметить прочитанным"
                  }
                  disabled={!current}
                  onClick={() =>
                    api
                      .flag(current.id, "read", !current.read)
                      .catch((e) => setError(e.message))
                  }
                />
                <Button
                  icon={Flag}
                  title="Установить флажок"
                  active={current?.flagged}
                  disabled={!current}
                  onClick={toggleFlag}
                />
              </div>
              <div className="pill">
                <Button
                  icon={Archive}
                  title="В архив"
                  disabled={
                    !current ||
                    !folders.some(
                      (f) =>
                        f.accountId === current.accountId &&
                        f.specialUse === "\\Archive",
                    )
                  }
                  onClick={() => moveCurrent("\\Archive")}
                />
                <Button
                  icon={ShieldAlert}
                  title="В спам"
                  disabled={!current}
                  onClick={() => moveCurrent("\\Junk")}
                />
                <Button
                  icon={Trash2}
                  title="В удалённые"
                  disabled={!current || current.folderRole === "\\Trash"}
                  onClick={() => moveCurrent("\\Trash")}
                />
              </div>
            </div>
            <div className="reader-toolbar-right">
              <div className="search-wrap toolbar-search">
                <Search size={15} />
                <input
                  ref={searchRef}
                  aria-label="Поиск писем"
                  placeholder="Поиск"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                {query && (
                  <button
                    aria-label="Очистить поиск"
                    onClick={() => setQuery("")}
                  >
                    <X size={13} />
                  </button>
                )}
              </div>
            </div>
          </div>
          {current ? (
            <div
              ref={readerScrollRef}
              className="reader-scroll"
              onScroll={(event) => handleScroll(event, "reader")}
            >
              <div className="message-header">
                <div className="avatar">
                  <User size={31} strokeWidth={1.5} />
                </div>
                <div className="message-header-copy">
                  <div className="sender-line">
                    <strong title={current.fromAddress}>{current.from}</strong>
                    <time>
                      {new Date(current.date).toLocaleString("ru", {
                        day: "numeric",
                        month: "long",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </time>
                  </div>
                  <h2>{current.subject}</h2>
                  <div className="recipient">
                    Кому: <span>{current.to}</span>
                  </div>
                  <details className="message-details">
                    <summary>
                      Подробнее <ChevronDown size={11} />
                    </summary>
                    <p>От: {current.fromAddress}</p>
                    <p>Кому: {current.to}</p>
                    <p>Дата: {new Date(current.date).toLocaleString("ru")}</p>
                  </details>
                </div>
              </div>
              {conversation.length > 1 && (
                <div className="conversation-bar">
                  <span>
                    В разговоре{" "}
                    {plural(conversation.length, "письмо", "письма", "писем")}
                  </span>
                  <select
                    aria-label="Письма в разговоре"
                    value={selected}
                    onChange={(e) => {
                      const m = conversation.find(
                        (m) => m.id === e.target.value,
                      );
                      if (m) choose(m);
                    }}
                  >
                    {conversation.map((m) => (
                      <option key={m.id} value={m.id}>
                        {dateLabel(m.date)} — {m.from}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {bodyError ? (
                <div className="body-error">
                  <WifiOff size={28} />
                  <strong>Не удалось загрузить письмо</strong>
                  <p>{bodyError}</p>
                  <button
                    className="secondary-button"
                    onClick={() => {
                      setSelected(null);
                      setTimeout(() => setSelected(current.id), 0);
                    }}
                  >
                    Повторить
                  </button>
                </div>
              ) : body ? (
                <>
                  {body.attachments.length > 0 && (
                    <div className="attachments attachments-above-message">
                      <h4>
                        <Paperclip size={15} />
                        Вложения · {body.attachments.length}
                      </h4>
                      {body.attachments.map((a) => (
                        <button
                          key={a.index}
                          onClick={() =>
                            bridge
                              ?.attachment(current.id, a.index)
                              .catch((e) => setError(e.message))
                          }
                        >
                          <div>
                            <Paperclip size={19} />
                            <span>
                              <strong>{a.name}</strong>
                              <small>
                                {a.size < 1024 * 1024
                                  ? Math.ceil(a.size / 1024) + " КБ"
                                  : (a.size / 1024 / 1024).toFixed(1) + " МБ"}
                              </small>
                            </span>
                          </div>
                          <Download size={16} />
                        </button>
                      ))}
                    </div>
                  )}
                  <iframe
                    key={current.id}
                    className="email-frame"
                    title="Содержимое письма"
                    srcDoc={body.document}
                    onLoad={resizeEmailFrame}
                    sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
                  />
                </>
              ) : (
                <div className="body-loading">
                  <LoaderCircle size={22} className="spinning" /> Загрузка
                  письма…
                </div>
              )}
            </div>
          ) : (
            <div className="reader-empty">
              <div className="empty-envelope">
                <Mail size={55} strokeWidth={1} />
              </div>
              <h2>
                {accounts.length
                  ? "Ни одно письмо не выбрано"
                  : "Вся ваша почта. Как дома."}
              </h2>
              <p>
                {accounts.length
                  ? "Выберите письмо, чтобы прочитать его."
                  : "Читайте iCloud, Gmail и Яндекс в привычном интерфейсе."}
              </p>
              {!accounts.length && (
                <>
                  <button
                    className="primary-button"
                    onClick={() => setModal("add")}
                  >
                    Добавить учётную запись
                  </button>
                </>
              )}
            </div>
          )}
        </main>
      </div>
      {accountMenu && (
        <div
          className="account-context-menu"
          style={{ left: accountMenu.left, top: accountMenu.top }}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="account-context-title">
            {accounts.find((account) => account.id === accountMenu.accountId)?.name}
          </div>
          <button
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              runAccountMenuAction("rename");
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <PenSquare size={15} />
            Переименовать ящик
          </button>
          <button
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              runAccountMenuAction("mark-read");
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <MailOpen size={15} />
            Отметить все письма как прочитанные
          </button>
          <button
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              runAccountMenuAction("clear-spam");
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <ShieldAlert size={15} />
            Стереть спам
          </button>
          <button
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              runAccountMenuAction("clear-trash");
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <Trash2 size={15} />
            Стереть удалённые объекты
          </button>
        </div>
      )}
      {messageMenu && (
        <div
          className="account-context-menu message-context-menu"
          style={{ left: messageMenu.left, top: messageMenu.top }}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="account-context-title">
            {selectedRows.size === 1
              ? "Действия с письмом"
              : `Действия с письмами · ${selectedRows.size}`}
          </div>
          <button onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); runBulkAction("read"); }} onClick={(event) => event.stopPropagation()}>
            <MailOpen size={15} />
            Отметить прочитанными
          </button>
          <button onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); runBulkAction("unread"); }} onClick={(event) => event.stopPropagation()}>
            <Mail size={15} />
            Отметить непрочитанными
          </button>
          <button onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); runBulkAction("flag"); }} onClick={(event) => event.stopPropagation()}>
            <Flag size={15} />
            Установить флажок
          </button>
          <button onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); runBulkAction("unflag"); }} onClick={(event) => event.stopPropagation()}>
            <Flag size={15} />
            Снять флажок
          </button>
          <button onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); runBulkAction("move", "\\Archive"); }} onClick={(event) => event.stopPropagation()}>
            <Archive size={15} />
            В архив
          </button>
          <button onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); runBulkAction("move", "\\Junk"); }} onClick={(event) => event.stopPropagation()}>
            <ShieldAlert size={15} />
            В спам
          </button>
          <button onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); runBulkAction("move", "\\Trash"); }} onClick={(event) => event.stopPropagation()}>
            <Trash2 size={15} />
            В удалённые
          </button>
          <button onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); closeMessageMenu(); }} onClick={(event) => event.stopPropagation()}>
            <X size={15} />
            Снять выбор
          </button>
        </div>
      )}
      {accountRename && (
        <Modal
          onClose={() => setAccountRename(null)}
          title="Переименовать ящик"
          className="rename-modal"
        >
          <h2>Переименовать ящик</h2>
          <p className="modal-description">
            Это название будет отображаться в боковом меню.
          </p>
          <form onSubmit={saveAccountRename}>
            <label>
              Название ящика
              <input
                autoFocus
                value={accountRename.name}
                maxLength={80}
                onChange={(event) =>
                  setAccountRename({
                    ...accountRename,
                    name: event.target.value,
                  })
                }
              />
            </label>
            <div className="form-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => setAccountRename(null)}
              >
                Отмена
              </button>
              <button
                className="primary-button"
                disabled={!accountRename.name.trim()}
              >
                Сохранить
              </button>
            </div>
          </form>
        </Modal>
      )}
      {sendStatus && (
        <div
          className={`send-status ${sendStatus.state}`}
          role="status"
          aria-live="polite"
        >
          <div className="send-status-track">
            <div className="send-status-fill" />
          </div>
          <span>{sendStatus.label}</span>
          {sendStatus.state !== "sending" && (
            <button
              aria-label="Закрыть статус отправки"
              onClick={() => setSendStatus(null)}
            >
              <X size={14} />
            </button>
          )}
        </div>
      )}
      {undoNotice && (
        <div className="action-undo-notice" role="status" aria-live="polite">
          <span>{undoNotice.label}</span>
          <button onClick={undoLastAction} disabled={bulkBusy}>Отменить</button>
          <button aria-label="Закрыть уведомление" onClick={() => setUndoNotice(null)}>
            <X size={14} />
          </button>
        </div>
      )}
      {updateInfo.state === "downloaded" && (
        <div className="update-notice" role="status" aria-live="polite">
          <Download size={16} />
          <span>
            Доступна Luma Почта {updateInfo.version || "новая версия"}.
          </span>
          <button onClick={installUpdate} disabled={updateBusy}>
            Перезапустить и установить
          </button>
          <button
            aria-label="Закрыть уведомление об обновлении"
            onClick={() => setUpdateInfo((current) => ({ ...current, state: "idle" }))}
          >
            <X size={14} />
          </button>
        </div>
      )}
      {composer && (
        <Compose
          accounts={accounts}
          initial={composer}
          api={api}
          onClose={() => setComposer(null)}
          onSending={() => {
            setComposer(null);
            showSendStatus({ state: "sending", label: "Отправка…" });
          }}
          onSent={(result) => {
            showSendStatus({
              state: "success",
              label: result.warning || "Письмо отправлено.",
            }, 7000);
          }}
          onSendError={(message) => {
            showSendStatus({ state: "error", label: `Ошибка отправки: ${message}` }, 10000);
            setError(message);
          }}
        />
      )}
      {smartEditor && (
        <SmartEditor
          initial={smartEditor}
          accounts={accounts}
          folders={folders}
          api={api}
          onClose={() => setSmartEditor(null)}
          onSaved={(box) => {
            setSmartEditor(null);
            changeView(`smart:${box.id}`);
          }}
          onRemoved={() => {
            setSmartEditor(null);
            changeView("all");
          }}
        />
      )}
      {error && (
        <div className="toast" role="alert">
          <AlertCircle size={18} />
          <span>
            {error.replace(
              /^Error invoking remote method '[^']+': Error: /,
              "",
            )}
          </span>
          <button aria-label="Закрыть сообщение" onClick={() => setError("")}>
            <X size={16} />
          </button>
        </div>
      )}
      {modal === "add" && (
        <AddAccount
          demo={demo}
          onClose={() => {
            bridge?.cancelAuth();
            setModal(null);
          }}
          onAdded={() => {
            setDemo(false);
            setModal(null);
          }}
        />
      )}
      {modal === "settings" && (
        <SettingsModal
          state={state}
          demo={demo}
          api={api}
          syncing={syncing}
          onRefresh={refresh}
          onClose={() => setModal(null)}
          onAdd={() => setModal("add")}
          onError={setError}
          updateInfo={updateInfo}
          updateBusy={updateBusy}
          onUpdateCheck={checkForUpdates}
          onUpdateDownload={downloadUpdate}
          onUpdateInstall={installUpdate}
        />
      )}
    </div>
  );
}
const folderLabels = {
  "\\Inbox": "Входящие",
  "\\Sent": "Отправленные",
  "\\Drafts": "Черновики",
  "\\Trash": "Удалённые",
  "\\Junk": "Спам",
  "\\Archive": "Архив",
  "\\All": "Вся почта",
  "\\Flagged": "Отмеченные",
};
function folderName(f) {
  return f.path === "INBOX"
    ? "Входящие"
    : folderLabels[f.specialUse] || f.name || f.path;
}
function folderOrder(f) {
  return [
    "\\Inbox",
    "\\Drafts",
    "\\Sent",
    "\\Junk",
    "\\Trash",
    "\\Archive",
  ].indexOf(f.specialUse) < 0
    ? 99
    : [
        "\\Inbox",
        "\\Drafts",
        "\\Sent",
        "\\Junk",
        "\\Trash",
        "\\Archive",
      ].indexOf(f.specialUse);
}
function folderIcon(f) {
  return (
    {
      "\\Inbox": Inbox,
      "\\Sent": Send,
      "\\Drafts": FileText,
      "\\Trash": Trash2,
      "\\Junk": ShieldAlert,
      "\\Archive": Archive,
    }[f.specialUse] || Folder
  );
}
function isTrashOrJunkMessage(message) {
  return ["\\Trash", "\\Junk", "\\Spam"].includes(message.folderRole) ||
    ["Trash", "Junk", "Spam", "TRASH", "JUNK", "SPAM"].includes(
      message.folder,
    );
}
function isVisibleFlaggedMessage(message) {
  return Boolean(message.flagged) && !isTrashOrJunkMessage(message);
}
function NavRow({ icon: Icon, label, count, active, onClick, title }) {
  return (
    <button
      title={title || label}
      className={`nav-row ${active ? "selected" : ""}`}
      onClick={onClick}
    >
      <Icon size={19} strokeWidth={1.65} />
      <span>{label}</span>
      {count > 0 && <small>{count}</small>}
    </button>
  );
}
function AddAccount({ onClose, onAdded, demo }) {
  const [provider, setProvider] = useState(null),
    [form, setForm] = useState({
      email: "",
      name: "",
      password: "",
      clientId: "",
    }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [code, setCode] = useState(null);
  useEffect(() => bridge?.onCode(setCode), []);
  async function submit(e) {
    e.preventDefault();
    if (!bridge) {
      setError("Подключение доступно в настольном приложении Luma Почта.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await bridge.add({ ...form, provider });
      onAdded();
    } catch (e) {
      setError(
        e.message.replace(/^Error invoking remote method '[^']+': Error: /, ""),
      );
    } finally {
      setBusy(false);
      setCode(null);
    }
  }
  return (
    <Modal
      onClose={onClose}
      title="Добавить учётную запись"
      className="add-modal"
    >
      <div className="modal-mail-icon">
        <Mail size={31} strokeWidth={1.5} />
      </div>
      <h2>
        {provider
          ? "Добавление " + providerNames[provider]
          : "Выберите почтовую службу"}
      </h2>
      <p className="modal-description">
        {provider
          ? "Почта будет приходить прямо на этот компьютер."
          : "Все ваши входящие — в одном приложении."}
      </p>
      {!provider ? (
        <>
          <div className="provider-list">
            {Object.entries(providerNames).map(([id, label]) => (
              <button
                key={id}
                onClick={() => {
                  setProvider(id);
                  setForm({ ...form, name: label });
                }}
              >
                <span className={`provider-logo ${id}`}>
                  {id === "icloud" ? (
                    <Cloud size={27} fill="currentColor" />
                  ) : id === "gmail" ? (
                    "G"
                  ) : id === "yandex" ? (
                    "Я"
                  ) : id === "microsoft" ? (
                    <span className="microsoft-tiles">
                      <i />
                      <i />
                      <i />
                      <i />
                    </span>
                  ) : (
                    <Building2 size={25} strokeWidth={1.7} />
                  )}
                </span>
                <strong>{label}</strong>
                <ChevronRight size={17} />
              </button>
            ))}
          </div>
          <p className="fine-print">
            Подключение напрямую к почтовому серверу.
            <br />
            Пароли хранятся зашифрованными на вашем компьютере.
          </p>
        </>
      ) : (
        <form onSubmit={submit}>
          <label>
            Название ящика
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
              maxLength={80}
              disabled={busy}
            />
          </label>
          <label>
            Адрес электронной почты
            <input
              autoFocus
              type="email"
              autoComplete="username"
              placeholder={
                provider === "icloud"
                  ? "name@icloud.com"
                  : provider === "gmail"
                    ? "name@gmail.com"
                    : provider === "yandex"
                      ? "name@yandex.ru"
                      : provider === "exchange"
                        ? "name@company.ru"
                      : "name@outlook.com"
              }
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              required
              disabled={busy}
            />
          </label>
          {provider === "microsoft" ? (
            <>
              <label>
                Application (client) ID
                <input
                  placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                  value={form.clientId}
                  onChange={(e) =>
                    setForm({ ...form, clientId: e.target.value })
                  }
                  required
                  disabled={busy}
                />
              </label>
              <p className="account-help">
                Для Microsoft 365 нужно зарегистрированное desktop-приложение с
                разрешением IMAP.AccessAsUser.All и включённым public client
                flow. Вход выполняется в браузере Microsoft. Корпоративный
                администратор может запретить IMAP.
              </p>
            </>
          ) : (
            <>
              <label>
                {provider === "exchange" ? "Пароль" : "Пароль приложения"}
                <input
                  type="password"
                  autoComplete="new-password"
                  placeholder={
                    provider === "exchange"
                      ? "Пароль рабочей учётной записи"
                      : "Отдельный пароль для почтового клиента"
                  }
                  value={form.password}
                  onChange={(e) =>
                    setForm({ ...form, password: e.target.value })
                  }
                  required
                  disabled={busy}
                />
              </label>
              <p className="account-help">
                {provider === "icloud"
                  ? "Создайте пароль приложения в настройках Аккаунта Apple."
                  : provider === "gmail"
                    ? "Нужна двухэтапная аутентификация Google и пароль приложения. Некоторые рабочие аккаунты не поддерживают этот способ входа."
                    : provider === "yandex"
                      ? "Создайте пароль приложения для почты и разрешите доступ по IMAP в настройках Яндекс Почты."
                      : "Luma найдёт сервер Exchange через Autodiscover и подключится по защищённому EWS/OWA. Пароль хранится только в зашифрованном хранилище Windows."}
              </p>
            </>
          )}
          <button
            type="button"
            className="help-link"
            onClick={() =>
              bridge
                ? bridge.external(providerLinks[provider])
                : window.open(providerLinks[provider], "_blank", "noopener")
            }
          >
            {provider === "microsoft"
              ? "Открыть Microsoft Entra"
              : provider === "exchange"
                ? "Справка Microsoft Exchange"
              : "Открыть настройки " + providerNames[provider]}
            <ExternalLink size={12} />
          </button>
          {code && (
            <div className="device-code">
              <p>Введите код на странице Microsoft:</p>
              <strong>{code.code}</strong>
              <button
                type="button"
                className="text-button"
                onClick={() => bridge.external(code.url)}
              >
                Открыть страницу входа <ExternalLink size={12} />
              </button>
            </div>
          )}
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
          <div className="form-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => {
                setProvider(null);
                setError("");
              }}
            >
              Назад
            </button>
            <button className="primary-button" disabled={busy}>
              {busy ? (
                <>
                  <LoaderCircle size={15} className="spinning" />
                  Подключение…
                </>
              ) : (
                "Подключить"
              )}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
function SettingsModal({
  state,
  api,
  onClose,
  onAdd,
  onError,
  demo,
  syncing,
  onRefresh,
  updateInfo,
  updateBusy,
  onUpdateCheck,
  onUpdateDownload,
  onUpdateInstall,
}) {
  const [tab, setTab] = useState("accounts"),
    [removing, setRemoving] = useState(null);
  return (
    <Modal onClose={onClose} title="Настройки" className="settings-modal">
      <div className="settings-tabs">
        <button
          className={tab === "accounts" ? "chosen" : ""}
          onClick={() => setTab("accounts")}
        >
          <User size={22} />
          Учётные записи
        </button>
        <button
          className={tab === "general" ? "chosen" : ""}
          onClick={() => setTab("general")}
        >
          <Settings size={22} />
          Основные
        </button>
        <button
          className={tab === "updates" ? "chosen" : ""}
          onClick={() => setTab("updates")}
        >
          <Download size={22} />
          Обновления
        </button>
      </div>
      {tab === "accounts" ? (
        <>
          <h2>Учётные записи</h2>
          <p className="modal-description">Подключённые почтовые ящики</p>
          <div className="settings-accounts">
            {state.accounts.map((a) => (
              <div key={a.id}>
                <div className={`account-symbol ${a.provider}`}>
                  {a.provider === "icloud" ? (
                    <Cloud size={20} />
                  ) : (
                    <Mail size={20} />
                  )}
                </div>
                <div>
                  <strong>{a.name}</strong>
                  <small>{a.email}</small>
                  <span className="account-state">
                    {state.status[a.id]?.state === "online"
                      ? "Подключено"
                      : state.status[a.id]?.state === "syncing"
                        ? "Синхронизация…"
                        : "Нет соединения"}
                  </span>
                </div>
                <button
                  className="text-button danger"
                  onClick={() => setRemoving(a.id)}
                >
                  Отключить
                </button>
              </div>
            ))}
            {!state.accounts.length && (
              <p className="no-accounts">Пока нет подключённых ящиков.</p>
            )}
          </div>
          <button className="secondary-button" onClick={onAdd}>
            <Plus size={15} />
            Добавить учётную запись
          </button>
          <button
            className="secondary-button settings-refresh"
            onClick={onRefresh}
            disabled={!state.accounts.length || syncing}
          >
            <RefreshCw size={15} className={syncing ? "spinning" : ""} />
            {syncing ? "Получение почты…" : "Получить почту"}
          </button>
          {removing && (
            <div className="remove-confirm">
              <p>
                Отключить ящик на этом компьютере? Локальная копия будет
                удалена. Письма на сервере сохранятся.
              </p>
              <button
                className="secondary-button"
                onClick={() => setRemoving(null)}
              >
                Отмена
              </button>
              <button
                className="primary-button"
                onClick={async () => {
                  try {
                    if (demo)
                      throw new Error(
                        "Демонстрационные аккаунты нельзя отключить.",
                      );
                    await bridge.remove(removing);
                    setRemoving(null);
                  } catch (e) {
                    onError(e.message);
                  }
                }}
              >
                Отключить
              </button>
            </div>
          )}
        </>
      ) : tab === "updates" ? (
        <>
          <h2>Обновления</h2>
          <p className="modal-description settings-update-description">
            Luma Почта автоматически проверяет новые версии при запуске и
            периодически во время работы приложения.
          </p>
          <div className={`update-panel ${updateInfo.state}`}>
            <div className="update-panel-icon">
              {updateInfo.state === "downloading" ? (
                <RefreshCw size={20} className="spinning" />
              ) : updateInfo.state === "downloaded" ? (
                <Check size={20} />
              ) : (
                <Download size={20} />
              )}
            </div>
            <div>
              <strong>
                {updateInfo.state === "checking"
                  ? "Проверяем обновления…"
                  : updateInfo.state === "available"
                    ? `Доступна версия ${updateInfo.version || "новее"}`
                    : updateInfo.state === "downloading"
                      ? `Загрузка обновления · ${Math.round(updateInfo.percent || 0)}%`
                      : updateInfo.state === "downloaded"
                        ? `Версия ${updateInfo.version || "новая"} готова к установке`
                        : updateInfo.state === "not-available"
                          ? "Установлена последняя версия"
                          : updateInfo.state === "error"
                            ? "Не удалось проверить обновления"
                            : updateInfo.configured
                              ? `Текущая версия ${updateInfo.currentVersion || "0.4.1"}`
                              : "Источник обновлений не настроен"}
              </strong>
              <p>
                {updateInfo.state === "error"
                  ? updateInfo.error
                  : updateInfo.state === "downloaded"
                    ? "Перезапустите приложение, чтобы применить обновление."
                    : updateInfo.configured
                      ? "Обновления скачиваются только после подтверждения."
                      : "Для автоматической доставки нужен опубликованный источник релизов."}
              </p>
            </div>
          </div>
          <div className="update-actions">
            <button
              className="secondary-button"
              onClick={onUpdateCheck}
              disabled={!updateInfo.configured || updateBusy || updateInfo.state === "checking"}
            >
              <RefreshCw size={15} className={updateInfo.state === "checking" ? "spinning" : ""} />
              Проверить сейчас
            </button>
            {updateInfo.state === "available" && (
              <button className="primary-button" onClick={onUpdateDownload} disabled={updateBusy}>
                <Download size={15} />
                Скачать
              </button>
            )}
            {updateInfo.state === "downloaded" && (
              <button className="primary-button" onClick={onUpdateInstall} disabled={updateBusy}>
                <Check size={15} />
                Перезапустить и установить
              </button>
            )}
          </div>
        </>
      ) : (
        <>
          <h2>Основные</h2>
          <div className="setting-row">
            <div>
              <strong>Уведомления о новых письмах</strong>
              <p>Уведомления Windows, пока Luma Почта работает</p>
            </div>
            <input
              aria-label="Уведомления о новых письмах"
              type="checkbox"
              checked={state.settings.notifications}
              onChange={(e) =>
                api
                  .settings({ notifications: e.target.checked })
                  .catch((e) => onError(e.message))
              }
            />
          </div>
          <div className="setting-row">
            <div>
              <strong>Объединять письма в разговоры</strong>
              <p>Группировать ответы по заголовкам переписки</p>
            </div>
            <input
              aria-label="Объединять письма в разговоры"
              type="checkbox"
              checked={state.settings.threads}
              onChange={(e) =>
                api
                  .settings({ threads: e.target.checked })
                  .catch((e) => onError(e.message))
              }
            />
          </div>
          <div className="setting-note">
            <Monitor size={18} />
            <p>
              Светлое оформление. При закрытии окна Luma Почта продолжает получать
              почту в области уведомлений Windows. Полностью закрыть приложение
              можно через значок в трее.
            </p>
          </div>
          <p className="fine-print">Luma Почта 0.4.1 · Личный почтовый клиент</p>
        </>
      )}
    </Modal>
  );
}
