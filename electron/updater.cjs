function cloneState(state) {
  return { ...state };
}

function createUpdaterController({ autoUpdater, feed, currentVersion, send }) {
  const configured = Boolean(feed && (feed.url || (feed.owner && feed.repo)));
  let state = {
    configured,
    state: configured ? "idle" : "unconfigured",
    currentVersion,
    version: null,
    percent: 0,
    error: "",
  };
  let feedSet = false;

  function publish(patch) {
    state = { ...state, ...patch };
    send?.(cloneState(state));
    return cloneState(state);
  }

  if (autoUpdater) {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;
    autoUpdater.on("checking-for-update", () =>
      publish({ state: "checking", error: "", percent: 0 }),
    );
    autoUpdater.on("update-available", (info = {}) =>
      publish({ state: "available", version: info.version || null, error: "" }),
    );
    autoUpdater.on("update-not-available", () =>
      publish({ state: "not-available", version: null, error: "" }),
    );
    autoUpdater.on("download-progress", (progress = {}) =>
      publish({
        state: "downloading",
        percent: Number.isFinite(progress.percent) ? progress.percent : 0,
        error: "",
      }),
    );
    autoUpdater.on("update-downloaded", (info = {}) =>
      publish({
        state: "downloaded",
        version: info.version || state.version,
        percent: 100,
        error: "",
      }),
    );
    autoUpdater.on("error", (error) =>
      publish({
        state: "error",
        error: String(error?.message || error || "Не удалось проверить обновления.").slice(0, 300),
      }),
    );
  }

  function configureFeed() {
    if (!configured || feedSet || !autoUpdater) return;
    autoUpdater.setFeedURL(feed);
    feedSet = true;
  }

  async function check() {
    if (!configured || !autoUpdater) return cloneState(state);
    try {
      configureFeed();
      publish({ state: "checking", error: "", percent: 0 });
      await autoUpdater.checkForUpdates();
    } catch (error) {
      publish({
        state: "error",
        error: String(error?.message || error || "Не удалось проверить обновления.").slice(0, 300),
      });
    }
    return cloneState(state);
  }

  async function download() {
    if (!configured || !autoUpdater || state.state !== "available")
      return cloneState(state);
    try {
      publish({ state: "downloading", percent: 0, error: "" });
      await autoUpdater.downloadUpdate();
    } catch (error) {
      publish({
        state: "error",
        error: String(error?.message || error || "Не удалось скачать обновление.").slice(0, 300),
      });
    }
    return cloneState(state);
  }

  function install() {
    if (!configured || !autoUpdater || state.state !== "downloaded")
      return false;
    autoUpdater.quitAndInstall(false, true);
    return true;
  }

  return {
    getState: () => cloneState(state),
    check,
    download,
    install,
  };
}

module.exports = { createUpdaterController };
