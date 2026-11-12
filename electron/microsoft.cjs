const BASE = "https://login.microsoftonline.com/common/oauth2/v2.0/";
const SCOPE =
  "https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access";
async function request(endpoint, fields) {
  const res = await fetch(BASE + endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
    signal: AbortSignal.timeout(25000),
  });
  const data = await res.json();
  if (!res.ok) {
    const e = new Error(data.error_description || data.error);
    e.code = data.error;
    throw e;
  }
  return data;
}
async function authorize(clientId, notify, signal) {
  const device = await request("devicecode", {
    client_id: clientId,
    scope: SCOPE,
  });
  notify({ url: device.verification_uri, code: device.user_code });
  const end = Date.now() + device.expires_in * 1000;
  let interval = device.interval * 1000;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, interval));
    if (signal?.aborted) throw new Error("Вход отменён.");
    try {
      return await request("token", {
        client_id: clientId,
        device_code: device.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      });
    } catch (e) {
      if (e.code === "slow_down") {
        interval += 5000;
        continue;
      }
      if (e.code !== "authorization_pending") throw e;
    }
  }
  throw new Error("Время входа истекло.");
}
async function refresh(clientId, token) {
  return request("token", {
    client_id: clientId,
    refresh_token: token,
    grant_type: "refresh_token",
    scope: SCOPE,
  });
}
module.exports = { authorize, refresh };
