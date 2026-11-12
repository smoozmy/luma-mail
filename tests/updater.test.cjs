const { EventEmitter } = require("node:events");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createUpdaterController } = require("../electron/updater.cjs");

function fakeUpdater() {
  const updater = new EventEmitter();
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = false;
  updater.allowPrerelease = true;
  updater.feed = null;
  updater.setFeedURL = (feed) => {
    updater.feed = feed;
  };
  updater.checkForUpdates = async () => {};
  updater.downloadUpdate = async () => {};
  updater.quitAndInstall = (...args) => {
    updater.installArgs = args;
  };
  return updater;
}

test("updater stays disabled without a release feed", async () => {
  const updater = fakeUpdater();
  const controller = createUpdaterController({
    autoUpdater: updater,
    feed: null,
    currentVersion: "0.4.1",
  });
  assert.equal(controller.getState().state, "unconfigured");
  await controller.check();
  assert.equal(updater.feed, null);
});

test("updater reports available, downloaded and install states", async () => {
  const updater = fakeUpdater();
  const updates = [];
  const controller = createUpdaterController({
    autoUpdater: updater,
    feed: { provider: "github", owner: "smoozmy", repo: "luma-mail" },
    currentVersion: "0.4.1",
    send: (state) => updates.push(state),
  });
  await controller.check();
  assert.deepEqual(updater.feed, {
    provider: "github",
    owner: "smoozmy",
    repo: "luma-mail",
  });
  updater.emit("update-available", { version: "0.4.2" });
  assert.equal(controller.getState().state, "available");
  await controller.download();
  updater.emit("download-progress", { percent: 62 });
  assert.equal(controller.getState().percent, 62);
  updater.emit("update-downloaded", { version: "0.4.2" });
  assert.equal(controller.getState().state, "downloaded");
  assert.equal(controller.install(), true);
  assert.deepEqual(updater.installArgs, [false, true]);
  assert.ok(updates.some((state) => state.state === "downloaded"));
});
