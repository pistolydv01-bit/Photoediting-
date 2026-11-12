const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.PHOTO_ENHANCER_DATA_DIR = path.join(os.tmpdir(), `photo-enhancer-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
process.env.TURSO_DATABASE_URL = 'file::memory:';
process.env.TURSO_AUTH_TOKEN = 'local-test-token';
process.env.ADMIN_USERNAME = 'test-admin';
process.env.ADMIN_PASSWORD = 'test-admin-password';
process.env.FCM_ENABLED = 'false';
delete process.env.GEMINI_API_KEY;
const { app, closeStorage, readDb } = require('../server');
test.after(async () => {
  await closeStorage();
  fs.rmSync(process.env.PHOTO_ENHANCER_DATA_DIR, { recursive: true, force: true });
});

async function withServer(callback) {
  const server = app.listen(0);
  await once(server, 'listening');
  try {
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    await callback(baseUrl);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

test('health endpoint returns ok', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/health`);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.status, 'ok');
  });
});

test('registration returns created user', async () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Demo User',
        email: `demo-user-${suffix}@example.com`,
        mobile: `999${String(Date.now()).slice(-7)}`,
        password: 'Password@123'
      })
    });

    const payload = await response.json();
    assert.equal(response.status, 201);
    assert.equal(payload.user.email, `demo-user-${suffix}@example.com`);
    assert.equal(payload.user.status, 'pending');
    assert.equal('passwordHash' in payload.user, false);
  });
});

test('approval is required and user credentials remain hashed', async () => {
  const mobile = `88${Date.now()}`;
  const email = `flow-${Date.now()}@example.com`;
  await withServer(async (baseUrl) => {
    const registrationPayload = { name: 'Flow User', mobile, email, password: 'Password@123' };
    const registrations = await Promise.all([1, 2].map(() => fetch(`${baseUrl}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(registrationPayload)
    })));
    const registrationResults = await Promise.all(registrations.map(async (response) => ({
      status: response.status,
      payload: await response.json()
    })));
    assert.deepEqual(registrationResults.map((item) => item.status).sort(), [201, 409]);
    const registered = registrationResults.find((item) => item.status === 201).payload;

    const denied = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mobile, password: 'Password@123' })
    });
    assert.equal(denied.status, 403);

    const unauthenticatedAdmin = await fetch(`${baseUrl}/api/admin/users`);
    assert.equal(unauthenticatedAdmin.status, 401);

    const adminLogin = await fetch(`${baseUrl}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'test-admin', password: 'test-admin-password' })
    });
    const admin = await adminLogin.json();
    assert.equal(adminLogin.status, 200);

    const approval = await fetch(`${baseUrl}/api/admin/user/${registered.user.id}/status`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'active' })
    });
    assert.equal(approval.status, 200);

    const login = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: mobile, password: 'Password@123' })
    });
    const user = await login.json();
    assert.equal(login.status, 200);
    assert.ok(user.token);

    const promptWithoutAdmin = await fetch(`${baseUrl}/api/gemini/prompt`);
    assert.equal(promptWithoutAdmin.status, 401);

    const settings = await fetch(`${baseUrl}/api/settings`);
    const publicSettings = await settings.json();
    assert.equal('adSettings' in publicSettings.settings, true);

    const adminHeaders = { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' };
    const adminPrompt = 'Enhance only the supplied image; preserve the subject identity.';
    const savedPrompt = await fetch(`${baseUrl}/api/gemini/prompt`, {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({ prompt: adminPrompt })
    });
    assert.equal(savedPrompt.status, 200);

    const settingUpdate = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({ maintenanceMode: true, maxImageSizeMb: 2, dailyEnhancementLimit: 2 })
    });
    assert.equal(settingUpdate.status, 200);
    const adSettingsUpdate = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({ adsEnabled: true, adTestMode: true, rewardedAdUnitId: 'ca-app-pub-test/1', maxRewardedAdsPerDay: 3 })
    });
    assert.equal(adSettingsUpdate.status, 200);
    const publicAds = await fetch(`${baseUrl}/api/settings`);
    const publicAdsPayload = await publicAds.json();
    assert.equal(publicAdsPayload.settings.adSettings.maxRewardedAdsPerDay, 3);
    assert.equal('rewardedAdUnitId' in publicAdsPayload.settings.adSettings, true);

    const geminiStatus = await fetch(`${baseUrl}/api/admin/gemini/status`, { headers: adminHeaders });
    const geminiStatusPayload = await geminiStatus.json();
    assert.equal(geminiStatusPayload.configured, false);
    assert.equal('apiKey' in geminiStatusPayload, false);

    const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lWQAAAAASUVORK5CYII=', 'base64');
    const blockedPhoto = new FormData();
    blockedPhoto.append('photo', new Blob([imageBytes], { type: 'image/png' }), 'sample.png');
    const maintenanceResponse = await fetch(`${baseUrl}/api/enhance`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${user.token}` },
      body: blockedPhoto
    });
    assert.equal(maintenanceResponse.status, 503);

    await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({ maintenanceMode: false })
    });
    process.env.GEMINI_API_KEY = 'test-only-key';
    const realFetch = global.fetch;
    let geminiRequestBody;
    global.fetch = async (input, options) => {
      if (String(input).startsWith('https://generativelanguage.googleapis.com/')) {
        assert.equal(options.headers['x-goog-api-key'], 'test-only-key');
        geminiRequestBody = JSON.parse(options.body);
        return new Response(JSON.stringify({
          candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: imageBytes.toString('base64') } }] } }]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return realFetch(input, options);
    };
    try {
      const photo = new FormData();
      photo.append('photo', new Blob([imageBytes], { type: 'image/png' }), 'sample.png');
      photo.append('prompt', 'attacker supplied prompt');
      const enhanced = await fetch(`${baseUrl}/api/enhance`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.token}` },
        body: photo
      });
      const result = await enhanced.json();
      assert.equal(enhanced.status, 200);
      assert.match(result.output.base64, /^data:image\/png;base64,/);
      assert.equal(geminiRequestBody.contents[0].parts[0].text, adminPrompt);
      assert.ok(geminiRequestBody.contents[0].parts[1].inline_data.data);

      global.fetch = async (input, options) => {
        if (String(input).startsWith('https://generativelanguage.googleapis.com/')) {
          return new Response(JSON.stringify({
            candidates: [{ content: { parts: [{ text: 'Image processing complete.' }] } }]
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return realFetch(input, options);
      };
      const textOnlyPhoto = new FormData();
      textOnlyPhoto.append('photo', new Blob([imageBytes], { type: 'image/png' }), 'sample.png');
      const textOnly = await fetch(`${baseUrl}/api/enhance`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.token}` },
        body: textOnlyPhoto
      });
      assert.equal(textOnly.status, 500);
      assert.match((await textOnly.json()).error, /text-only/);

      const dailyLimitPhoto = new FormData();
      dailyLimitPhoto.append('photo', new Blob([imageBytes], { type: 'image/png' }), 'sample.png');
      const dailyLimitResponse = await fetch(`${baseUrl}/api/enhance`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.token}` },
        body: dailyLimitPhoto
      });
      assert.equal(dailyLimitResponse.status, 429);
    } finally {
      global.fetch = realFetch;
      delete process.env.GEMINI_API_KEY;
    }

    const userNotification = await fetch(`${baseUrl}/api/admin/notifications`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ title: 'Welcome', message: 'Your account is ready.' })
    });
    assert.equal(userNotification.status, 201);
    const inbox = await fetch(`${baseUrl}/api/notifications`, {
      headers: { Authorization: `Bearer ${user.token}` }
    });
    assert.equal((await inbox.json()).notifications[0].title, 'Welcome');

    const userLogout = await fetch(`${baseUrl}/api/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${user.token}` }
    });
    assert.equal(userLogout.status, 200);
    const expiredUserSession = await fetch(`${baseUrl}/api/user/profile`, {
      headers: { Authorization: `Bearer ${user.token}` }
    });
    assert.equal(expiredUserSession.status, 401);

    const adminLogout = await fetch(`${baseUrl}/api/admin/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${admin.token}` }
    });
    assert.equal(adminLogout.status, 200);
    const expiredAdminSession = await fetch(`${baseUrl}/api/admin/users`, {
      headers: { Authorization: `Bearer ${admin.token}` }
    });
    assert.equal(expiredAdminSession.status, 401);

    const savedUser = (await readDb()).users.find((entry) => entry.mobile === mobile);
    assert.equal(savedUser.password, undefined);
    assert.match(savedUser.passwordHash, /^scrypt\$/);
  });
});
