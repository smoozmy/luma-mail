const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("posta", {
  folders: (id) => ipcRenderer.invoke("mail:folders", id),
  move: (id, destination) => ipcRenderer.invoke("mail:move", id, destination),
  send: (input) => ipcRenderer.invoke("mail:send", input),
  saveDraft: (input) => ipcRenderer.invoke("draft:save", input),
  removeDraft: (id) => ipcRenderer.invoke("draft:remove", id),
  forwardAttachments: (id) =>
    ipcRenderer.invoke("compose:forwardAttachments", id),
  pickAttachments: () => ipcRenderer.invoke("compose:attachments"),
  removeAttachment: (id) => ipcRenderer.invoke("compose:removeAttachment", id),
  saveSmart: (input) => ipcRenderer.invoke("smart:save", input),
  removeSmart: (id) => ipcRenderer.invoke("smart:remove", id),
  state: () => ipcRenderer.invoke("mail:state"),
  add: (input) => ipcRenderer.invoke("mail:add", input),
  cancelAuth: () => ipcRenderer.invoke("auth:cancel"),
  sync: (id, folder) => ipcRenderer.invoke("mail:sync", id, folder),
  older: (id, folder) => ipcRenderer.invoke("mail:older", id, folder),
  body: (id, remote) => ipcRenderer.invoke("mail:body", id, remote),
  flag: (id, type, value) => ipcRenderer.invoke("mail:flag", id, type, value),
  bulk: (ids, action, destination) =>
    ipcRenderer.invoke("mail:bulk", ids, action, destination),
  renameAccount: (id, name) => ipcRenderer.invoke("mail:accountRename", id, name),
  accountAction: (id, action) => ipcRenderer.invoke("mail:accountAction", id, action),
  remove: (id) => ipcRenderer.invoke("mail:remove", id),
  attachment: (id, index) => ipcRenderer.invoke("mail:attachment", id, index),
  settings: (patch) => ipcRenderer.invoke("settings:save", patch),
  window: (action) => ipcRenderer.send("window:action", action),
  external: (url) => ipcRenderer.invoke("external:open", url),
  assistant: (messages) => ipcRenderer.invoke("assistant:classify", messages),
  assistantStatus: () => ipcRenderer.invoke("assistant:status"),
  updateState: () => ipcRenderer.invoke("update:state"),
  updateCheck: () => ipcRenderer.invoke("update:check"),
  updateDownload: () => ipcRenderer.invoke("update:download"),
  updateInstall: () => ipcRenderer.invoke("update:install"),
  onUpdate: (callback) => {
    const listener = (_e, state) => callback(state);
    ipcRenderer.on("update:state", listener);
    return () => ipcRenderer.removeListener("update:state", listener);
  },
  onState: (callback) => {
    const listener = (_e, state) => callback(state);
    ipcRenderer.on("state", listener);
    return () => ipcRenderer.removeListener("state", listener);
  },
  onCode: (callback) => {
    const listener = (_e, code) => callback(code);
    ipcRenderer.on("auth:code", listener);
    return () => ipcRenderer.removeListener("auth:code", listener);
  },
});
