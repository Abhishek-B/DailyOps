const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const source = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].at(-1)[1].replace(/\nstartApp\(\);\s*$/, '\n');
const shell = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link[^>]*href="https:[^>]*>/g, '');

async function fixture(page, { admin = false, empty = false, demo = false } = {}) {
  await page.route('**/*', route => route.request().url() === 'https://dailyops.test/'
    ? route.fulfill({ contentType: 'text/html', body: shell }) : route.abort());
  await page.goto('https://dailyops.test/');
  await page.evaluate(demo => { window.DAILYOPS_SUPABASE_CONFIG = { DEMO_MODE: demo, SUPABASE_URL: 'https://supabase.test', SUPABASE_PUBLISHABLE_KEY: 'public-test-key' }; }, demo);
  await page.addScriptTag({ content: source });
  await page.evaluate(async ({ admin, empty, demo }) => {
    S = defaultState();
    if (demo) { showApp(); render(); return; }
    const uid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const profile = { id: uid(1), display_name: 'Test Manager', email: 'manager@example.test', active: true, platform_role: admin ? 'admin' : 'user' };
    window.mock = {
      calls: [], fail: null, delayRecipients: false,
      rows: {
        profiles: [profile],
        organisations: empty && admin ? [] : [{ id: uid(10), name: 'Organisation A' }, { id: uid(11), name: 'Organisation B' }],
        organisation_members: [10, 11].map(n => ({ organisation_id: uid(n), user_id: uid(1), role: 'manager' })),
        venues: empty ? [] : [20, 21].map((n, i) => ({ id: uid(n), organisation_id: uid(10 + i), name: `Venue ${i ? 'B' : 'A'}`, subtitle: 'Hospitality', accent_key: i ? 'teal' : 'terracotta', timezone: 'Australia/Sydney', cutoff_time: '23:30', notify_complete: true, notify_end_of_day: true })),
        checklist_templates: [], template_tasks: [], daily_checklists: [], daily_tasks: [],
        task_evidence: [], task_evidence_exemptions: [], task_evidence_submissions: [],
        venue_members: [], roster_assignments: [], shift_cover_requests: [], notification_events: [], venue_notification_recipients: []
      }
    };
    const addHeaders = venueId => ['open', 'close'].forEach(list_type => mock.rows.checklist_templates.push({ id: crypto.randomUUID(), venue_id: venueId, list_type, name: list_type, active: true }));
    mock.rows.venues.forEach(row => addHeaders(row.id));
    DB = {
      from(table) {
        let action = 'select', payload, single = false, range;
        const filters = [];
        const query = {
          select() { return query; }, order() { return query; }, limit() { return query; },
          range(start, end) { range = [start, end]; return query; },
          eq(key, value) { filters.push(row => row[key] === value); return query; },
          in(key, values) { filters.push(row => values.includes(row[key])); return query; },
          gte(key, value) { filters.push(row => row[key] >= value); return query; },
          lte(key, value) { filters.push(row => row[key] <= value); return query; },
          lt(key, value) { filters.push(row => row[key] < value); return query; },
          is(key, value) { filters.push(row => (row[key] ?? null) === value); return query; },
          insert(value) { action = 'insert'; payload = value; return query; },
          update(value) { action = 'update'; payload = value; return query; },
          delete() { action = 'delete'; return query; },
          single() { single = true; return query; }, maybeSingle() { single = true; return query; },
          async then(resolve) {
            mock.calls.push({ table, action, payload });
            if (mock.fail?.table === table && mock.fail.action === action
              && mock.calls.filter(call => call.table === table && call.action === action).length > (mock.fail.after || 0)) return resolve({ error: { message: 'Simulated failure' }, data: null });
            let rows = (mock.rows[table] || []).filter(row => filters.every(filter => filter(row)));
            if (action === 'insert') {
              rows = (Array.isArray(payload) ? payload : [payload]).map(row => ({ ...row, id: row.id || crypto.randomUUID() }));
              mock.rows[table].push(...rows);
            } else if (action === 'update') rows.forEach(row => Object.assign(row, payload));
            else if (action === 'delete') mock.rows[table] = mock.rows[table].filter(row => !rows.includes(row));
            if (table === 'venue_notification_recipients' && mock.delayRecipients) {
              await new Promise(done => setTimeout(done, rows[0]?.venue_id === uid(20) ? 120 : 10));
            }
            if (range) rows = rows.slice(range[0], range[1] + 1);
            return resolve({ error: null, data: single ? rows[0] || null : rows });
          }
        };
        return query;
      },
      async rpc(name, args) {
        mock.calls.push({ rpc: name, args });
        if (mock.fail?.rpc === name) return { error: { message: 'Simulated RPC failure' }, data: null };
        if (name === 'is_protected_master_admin') return { data: false };
        if (name === 'create_venue') {
          const row = { id: args.p_venue_id, organisation_id: args.p_organisation_id, name: args.p_name, subtitle: args.p_subtitle, accent_key: args.p_accent_key, timezone: args.p_timezone, cutoff_time: args.p_cutoff_time, notify_complete: true, notify_end_of_day: true };
          if (!mock.rows.venues.some(venue => venue.id === row.id)) { mock.rows.venues.push(row); addHeaders(row.id); }
          return { data: row };
        }
        if (name === 'ensure_daily_checklists') {
          for (const list_type of ['open', 'close']) if (!mock.rows.daily_checklists.some(row => row.venue_id === args.p_venue_id && row.work_date === args.p_work_date && row.list_type === list_type)) {
            mock.rows.daily_checklists.push({ id: crypto.randomUUID(), venue_id: args.p_venue_id, work_date: args.p_work_date, list_type, submitted: false, notification_revision: 0 });
          }
          return { data: null };
        }
        if (name === 'submit_daily_checklist') {
          const row = mock.rows.daily_checklists.find(row => row.id === args.p_checklist_id);
          Object.assign(row, { submitted: true, submitted_by: profile.id, submitted_at: new Date().toISOString() });
          return { data: row };
        }
        if (name === 'approve_task_photo_exemption') {
          const task = mock.rows.daily_tasks.find(row => row.id === args.p_task_id);
          const list = mock.rows.daily_checklists.find(row => row.id === task.checklist_id);
          const row = { id: crypto.randomUUID(), task_id: task.id, checklist_id: list.id, venue_id: list.venue_id,
            notification_revision: list.notification_revision, reason: args.p_reason, approved_by: AUTH.profile.id, approved_at: new Date().toISOString(), revoked_at: null };
          mock.rows.task_evidence_exemptions.push(row);
          return { data: row };
        }
        if (name === 'revoke_task_photo_exemption' || name === 'remove_task_evidence') {
          const row = name === 'remove_task_evidence' ? mock.rows.task_evidence.find(row => row.id === args.p_evidence_id)
            : mock.rows.task_evidence_exemptions.find(row => row.id === args.p_exemption_id);
          if (!row) return { error: { message: 'Not found' } };
          if (name === 'remove_task_evidence') Object.assign(row, { state: 'delete_pending', deletion_reason: 'removed' });
          else row.revoked_at = new Date().toISOString();
          const task = mock.rows.daily_tasks.find(task => task.id === row.task_id);
          const list = mock.rows.daily_checklists.find(list => list.id === row.checklist_id);
          if (task?.requires_photo && !list.submitted && !mock.rows.task_evidence.some(item => item.task_id === task.id && item.state === 'ready')
            && !mock.rows.task_evidence_exemptions.some(item => item.task_id === task.id && !item.revoked_at && item.notification_revision === list.notification_revision)) task.status = 'pending';
          return { data: null };
        }
        throw new Error('Unexpected RPC: ' + name);
      },
      auth: { async getSession() { return { data: { session: { user: { id: AUTH.profile.id }, access_token: 'user-test-token' } } }; } },
      storage: { from(bucket) { return { async download(objectPath) {
        mock.calls.push({ download: objectPath, bucket });
        if (mock.downloadDenied) return { error: { message: 'Denied' } };
        return { data: window.testPhotoBlob || new Blob(['photo'], { type: 'image/jpeg' }) };
      } }; } },
      functions: { async invoke() { return { data: { sent: 0, skipped: 'no-recipients' } }; } },
      async removeChannel() {},
      channel() { return { on() { return this; }, subscribe() { return this; } }; }
    };
    AUTH.profile = profile;
    AUTH.session = { user: { id: profile.id } };
    SUPABASE_ACCESS.verified = true;
    window.fetch = async (url, options) => {
      if (!String(url).startsWith('https://supabase.test/functions/v1/upload-task-evidence')) throw new Error('Unexpected request');
      const params = new URL(url).searchParams;
      const task = mock.rows.daily_tasks.find(row => row.id === params.get('task_id'));
      const list = mock.rows.daily_checklists.find(row => row.id === task.checklist_id);
      const bytes = await options.body.arrayBuffer();
      mock.calls.push({ upload: params.get('evidence_id'), task: task.id, size: bytes.byteLength, bytes: [...new Uint8Array(bytes)], headers: options.headers });
      let row = mock.rows.task_evidence.find(row => row.id === params.get('evidence_id'));
      if (!row) {
        row = { id: params.get('evidence_id'), task_id: task.id, checklist_id: list.id, notification_revision: list.notification_revision, uploaded_by: AUTH.profile.id,
          object_path: 'private/test/' + params.get('evidence_id'), state: 'pending', created_at: new Date().toISOString(), upload_deadline: new Date(Date.now() + 3600000).toISOString() };
        mock.rows.task_evidence.push(row);
      }
      if (mock.uploadMode === 'reject') return new Response(JSON.stringify({ ok: false, code: 'invalid_photo', error: 'Invalid photo.' }), { status: 422 });
      if (mock.uploadMode !== 'fail-before') Object.assign(row, { state: 'ready', uploaded_at: new Date().toISOString(), expires_at: new Date(Date.now() + 30 * 86400000).toISOString() });
      if (['lost', 'fail-before'].includes(mock.uploadMode)) { mock.uploadMode = null; throw new TypeError('Network response lost'); }
      window.testPhotoBlob = options.body;
      return new Response(JSON.stringify({ ok: true, evidence: row }), { headers: { 'Content-Type': 'application/json' } });
    };
    await loadOrganisationAccess(AUTH.session);
    await loadSupabaseTeam();
    await loadSupabaseTemplates();
    await loadSupabaseToday();
    R.tab = 'settings';
    showApp(); render();
  }, { admin, empty, demo });
}

test('static app browser workflows', async t => {
  const browser = await chromium.launch({ channel: process.env.DAILYOPS_BROWSER_CHANNEL || 'chrome', headless: true });
  t.after(() => browser.close());
  let page;
  const errors = [];
  const fresh = async options => {
    if (page) await page.close();
    page = await browser.newPage({ viewport: { width: 1280, height: 900 }, timezoneId: 'America/Los_Angeles' });
    page.on('pageerror', error => errors.push(error.message));
    await fixture(page, options);
  };
  const photoTask = async () => {
    await fresh();
    await page.evaluate(async () => {
      const list = today().lists.open;
      mock.rows.daily_tasks.push({ id: '00000000-0000-4000-8000-000000000099', checklist_id: list.id,
        title: 'Close and sanitise the kitchen', detail: 'Photograph the clean preparation bench.', status: 'pending', source: 'adhoc', requires_photo: true, sort_order: 0, note: '', reason: '' });
      await loadSupabaseToday(); R.tab = 'today'; render();
    });
  };
  const imageFile = async () => ({ name: 'kitchen.png', mimeType: 'image/png', buffer: Buffer.from(await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 2000; canvas.height = 1000;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#335544'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    return [...new Uint8Array(await blob.arrayBuffer())];
  })) });
  const openPhotos = async () => {
    await page.locator('#page [data-act=task-evidence]').first().click();
    await page.waitForFunction(() => PHOTO_PANEL && !PHOTO_PANEL.busy && !PHOTO_PANEL.error);
  };

  await t.test('manager creates a venue with empty templates and a stable retry ID', async () => {
    await fresh();
    await page.locator('[data-act=add-venue]').last().click();
    assert.equal(await page.locator('#vn-org option').count(), 2);
    await page.locator('#vn-name').fill('New Restaurant');
    await page.evaluate(() => { mock.fail = { rpc: 'create_venue' }; });
    await page.locator('[data-x=save]').click();
    await page.waitForFunction(() => !document.querySelector('[data-x=save]').disabled);
    assert.equal(await page.locator('#vn-name').inputValue(), 'New Restaurant');
    await page.evaluate(() => { mock.fail = null; });
    await page.locator('[data-x=save]').click();
    await page.waitForFunction(() => R.tab === 'templates' && !document.querySelector('#modal-root.is-open'));
    const result = await page.evaluate(() => ({ name: V().name, tasks: TPL().open.length + TPL().close.length, calls: mock.calls.filter(call => call.rpc === 'create_venue') }));
    assert.equal(result.name, 'New Restaurant');
    assert.equal(result.tasks, 0);
    assert.equal(result.calls.length, 2);
    assert.equal(result.calls[0].args.p_venue_id, result.calls[1].args.p_venue_id);
  });
  await t.test('manager saves details, timing, colour and notification flags', async () => {
    await fresh();
    await page.locator('[data-act=edit-venue]').last().click();
    await page.locator('#vn-name').fill('Renamed Restaurant');
    await page.locator('#vn-timezone').fill('Pacific/Auckland');
    await page.locator('#vn-cut').fill('22:15');
    await page.locator('#vn-accent [data-key=berry]').click();
    await page.locator('[data-x=save]').click();
    await page.waitForFunction(() => !document.querySelector('#modal-root.is-open'));
    assert.deepEqual(await page.evaluate(() => [V().name, V().timezone, V().cutoff, V().accent]), ['Renamed Restaurant', 'Pacific/Auckland', '22:15', 'berry']);
    await page.locator('[data-act=setting-toggle][data-key=notifyComplete]').click();
    await page.waitForFunction(() => V().notifyComplete === false);
    assert.equal(await page.locator('[data-key=notifyComplete]').getAttribute('aria-checked'), 'false');
    await page.evaluate(async () => { await loadOrganisationAccess(AUTH.session); render(); });
    assert.equal(await page.locator('#venue-name').textContent(), 'Renamed Restaurant');
  });
  await t.test('zero-organisation admin and empty-organisation manager can finish setup', async () => {
    await fresh({ admin: true, empty: true });
    await page.locator('[data-act=add-organisation]').click();
    await page.locator('#org-name').fill('First Organisation');
    await page.locator('[data-x=save]').click();
    await page.waitForFunction(() => AUTH.organisations.length === 1 && !document.querySelector('#modal-root.is-open'));
    assert.equal(await page.getByRole('button', { name: 'Add first venue' }).count(), 1);
    await page.getByRole('button', { name: 'Team', exact: true }).last().click();
    await page.waitForFunction(() => R.tab === 'team');
    assert.equal(await page.locator('[data-act=create-user]').count(), 1);
    await fresh({ empty: true });
    assert.equal(await page.locator('[data-act=add-organisation]').count(), 0);
    await page.selectOption('#organisation-switch', '00000000-0000-4000-8000-000000000011');
    await page.waitForFunction(() => AUTH.selectedOrganisationId?.endsWith('11') && !REMOTE_MUTATIONS.has('organisation-switch'));
    await page.locator('[data-act=add-venue]').last().click();
    await page.locator('#vn-name').fill('First Venue');
    await page.locator('[data-x=save]').click();
    await page.waitForFunction(() => V()?.name === 'First Venue' && R.tab === 'templates');
  });
  await t.test('unavailable daily operations do not block settings, team or other venues', async () => {
    await fresh();
    await page.evaluate(() => { delete SUPABASE_TODAY.byVenue[V().realId]; R.tab = 'today'; render(); });
    assert.match(await page.locator('#page').textContent(), /could not be loaded/);
    await page.locator('#page [data-tab=settings]').click();
    await page.locator('[data-act=add-venue]').last().click();
    assert.equal(await page.locator('#vn-name').count(), 1);
    await page.keyboard.press('Escape');
    await page.evaluate(async () => {
      const original = loadSupabaseTodayForVenue;
      loadSupabaseTodayForVenue = async (context, date) => { if (context.name === 'Venue A') throw new Error('One venue unavailable'); return original(context, date); };
      await loadSupabaseToday(); R.tab = 'today'; render();
    });
    assert.equal(await page.evaluate(() => Object.keys(SUPABASE_TODAY.byVenue).length), 1);
    await page.locator('[data-act=goto-venue]').last().click();
    await page.waitForFunction(() => V().name === 'Venue B');
    assert.match(await page.locator('#page').textContent(), /Today's Operations/);
  });
  await t.test('recipient race keeps the latest venue response', async () => {
    await fresh();
    const result = await page.evaluate(async () => {
      mock.delayRecipients = true;
      mock.rows.venue_notification_recipients = AUTH.venueContexts.map(context => ({ id: crypto.randomUUID(), venue_id: context.realId, profile_id: AUTH.profile.id, enabled: true }));
      selectVenue(AUTH.venueContexts[0].id);
      const first = loadSupabaseNotificationRecipients();
      selectVenue(AUTH.venueContexts[1].id);
      const second = loadSupabaseNotificationRecipients();
      await Promise.all([first, second]);
      return { selected: V().realId, loaded: SUPABASE_NOTIFICATION_RECIPIENTS.venueId };
    });
    assert.equal(result.selected, result.loaded);
  });
  await t.test('Team resolves the actual membership and offers an organisation choice', async () => {
    await fresh();
    await page.evaluate(() => {
      const member = { id: 'employee', displayName: 'Employee', role: 'employee', active: true, explicitVenueIds: [], venueIds: [] };
      SUPABASE_TEAM.members.push({ ...member, organisationId: AUTH.organisations[1].id });
      openSupabaseUserEditor('employee');
    });
    assert.match(await page.locator('#modal-root').textContent(), /Organisation B/);
    await page.evaluate(() => {
      closeModal();
      SUPABASE_TEAM.members.push({ ...SUPABASE_TEAM.members.find(member => member.id === 'employee'), organisationId: AUTH.organisations[0].id });
      openSupabaseUserEditor('employee');
    });
    assert.equal(await page.locator('[data-org]').count(), 2);
  });
  await t.test('submitted review is read-only and note/remove are independent keyboard buttons', async () => {
    await fresh();
    await page.evaluate(() => {
      const list = today().lists.open;
      list.tasks = [{ id: 'task-1', title: 'Clean bench', status: 'pending', source: 'adhoc', note: '', reason: '' }];
      R.tab = 'today'; render();
    });
    const note = page.locator('[data-act=task-meta]');
    await note.focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#task-note-editor').count(), 1);
    assert.equal(await page.evaluate(() => today().lists.open.tasks[0].status), 'pending');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('button button').count(), 0);
    assert.equal(await page.locator('[data-act=del-task]').evaluate(el => el.tagName), 'BUTTON');
    await page.evaluate(() => { today().lists.open.submitted = true; render(); });
    assert.equal(await page.locator('[data-act=tick-all]').isDisabled(), true);
    assert.equal(await page.locator('[data-act=sync-tpl]').isDisabled(), true);
    await page.locator('[data-act=review]').click();
    assert.equal(await page.locator('#modal-root textarea, #modal-root input, #modal-root [data-x=submit]').count(), 0);
    assert.equal(await page.locator('[data-x=reopen]').count(), 1);
  });
  await t.test('review submits only edited tasks with original values and a save lock', async () => {
    await fresh();
    await page.evaluate(() => {
      const list = today().lists.open;
      mock.rows.daily_tasks.push(...[1, 2].map(n => ({ id: 'done-' + n, checklist_id: list.id, title: 'Completed ' + n, status: 'done', completed_by: AUTH.profile.id, completed_at: new Date().toISOString(), note: '', reason: '', source: 'adhoc' })));
    });
    await page.evaluate(async () => { await loadSupabaseToday(); openReview('open'); });
    await page.locator('#modal-root details').evaluate(el => { el.open = true; });
    await page.locator('[data-note=done-1]').fill('Only this note changed');
    await page.locator('[data-x=submit]').click();
    await page.waitForFunction(() => !document.querySelector('#modal-root.is-open'));
    const calls = await page.evaluate(() => mock.calls.filter(call => call.rpc === 'submit_daily_checklist'));
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args.p_changes, [{ id: 'done-1', expected_status: 'done', expected_note: '', expected_reason: '', note: 'Only this note changed' }]);
    assert.equal(calls[0].args.p_notification_revision, 0);
  });
  await t.test('venue midnight refresh works with a different device timezone', async () => {
    await fresh();
    await page.clock.install({ time: new Date('2026-09-08T13:59:50Z') });
    await page.evaluate(async () => { await loadSupabaseToday(); });
    assert.equal(await page.evaluate(() => loadedSupabaseDay().date), '2026-09-08');
    await page.clock.fastForward(20000);
    assert.equal(await page.evaluate(() => loadedSupabaseDay()), null);
    await page.evaluate(async () => { await refreshOperatingDays(); });
    assert.equal(await page.evaluate(() => loadedSupabaseDay().date), '2026-09-09');
    assert.equal(await page.evaluate(() => dayKey()), '2026-09-08');
  });
  await t.test('failed submission retains its draft and ignores a second save while pending', async () => {
    await fresh();
    await page.evaluate(() => {
      today().lists.open.tasks = [{ id: 'pending', title: 'Restock', status: 'pending', note: '', reason: '' }];
      const original = DB.rpc;
      DB.rpc = async (name, args) => {
        if (name === 'submit_daily_checklist') await new Promise(resolve => setTimeout(resolve, 150));
        return original(name, args);
      };
      mock.fail = { rpc: 'submit_daily_checklist' };
      openReview('open');
    });
    await page.locator('[data-reason=blocked]').click();
    await page.locator('[data-detail=pending]').fill('Delivery is late');
    await page.evaluate(() => { const save = document.querySelector('[data-x=submit]'); save.onclick(); save.onclick(); });
    await page.waitForFunction(() => !document.querySelector('[data-x=submit]').disabled);
    assert.equal(await page.locator('[data-detail=pending]').inputValue(), 'Delivery is late');
    assert.equal(await page.evaluate(() => mock.calls.filter(call => call.rpc === 'submit_daily_checklist').length), 1);
  });
  await t.test('template copy refetches after a partial failure and retry skips saved tasks', async () => {
    await fresh();
    await page.evaluate(async () => {
      const header = mock.rows.checklist_templates.find(row => row.venue_id === AUTH.venueContexts[1].realId && row.list_type === 'open');
      mock.rows.template_tasks.push(...[1, 2].map(n => ({ id: crypto.randomUUID(), template_id: header.id, title: 'Routine ' + n, sort_order: n })));
      await loadSupabaseTemplates();
      mock.fail = { table: 'template_tasks', action: 'insert', after: 1 };
      openCopyTemplate();
    });
    await page.locator('[data-x=save]').click();
    await page.waitForFunction(() => !document.querySelector('[data-x=save]').disabled);
    assert.equal(await page.evaluate(() => TPL().open.length), 1);
    assert.match(await page.locator('#toast-root').textContent(), /Copy stopped after 1/);
    await page.evaluate(() => { mock.fail = null; });
    await page.locator('[data-x=save]').click();
    await page.waitForFunction(() => !document.querySelector('#modal-root.is-open'));
    assert.equal(await page.evaluate(() => TPL().open.length), 2);
  });
  await t.test('cover without Telegram delivery does not claim the manager was notified', async () => {
    await fresh();
    await page.evaluate(async () => {
      AUTH.venueContexts.forEach(context => { context.organisationRole = 'employee'; });
      AUTH.organisationMemberships.forEach(membership => { membership.role = 'employee'; });
      await saveSupabaseCoverRequest('open', null);
    });
    const text = await page.locator('#toast-root').textContent();
    assert.match(text, /no recipients configured/);
    assert.match(text, /Contact your manager/);
    assert.doesNotMatch(text, /manager notified|Check Alerts/);
  });
  await t.test('roster search updates while typing and keeps keyboard focus', async () => {
    await fresh();
    await page.evaluate(() => { R.tab = 'roster'; render(); });
    await page.locator('[data-roster-filter=people]').pressSequentially('Alice');
    assert.equal(await page.evaluate(() => R.rosterPeopleSearch), 'Alice');
    assert.equal(await page.locator('[data-roster-filter=people]').evaluate(el => el === document.activeElement), true);
  });
  await t.test('photo requirement toggles persist on routine and one-off tasks without changing existing snapshots', async () => {
    await fresh();
    await page.evaluate(() => { R.tab = 'templates'; render(); openTemplateEditor('open'); });
    await page.locator('#tt-title').fill('Photo routine');
    await page.locator('#tt-photo').click();
    assert.equal(await page.locator('#tt-photo').getAttribute('aria-checked'), 'true');
    await page.locator('[data-x=save]').click();
    await page.waitForFunction(() => !document.querySelector('#modal-root.is-open'));
    assert.equal(await page.evaluate(() => TPL().open[0].requiresPhoto), true);
    await page.evaluate(() => { openTemplateEditor('open', TPL().open[0].id); });
    await page.locator('#tt-photo').click();
    await page.locator('[data-x=save]').click();
    await page.waitForFunction(() => !document.querySelector('#modal-root.is-open'));
    assert.equal(await page.evaluate(() => mock.rows.template_tasks[0].requires_photo), false);
    await page.evaluate(() => openAddTask('open'));
    await page.locator('#nt-title').fill('Photo one-off');
    await page.locator('#nt-photo').click();
    await page.locator('[data-x=save]').click();
    await page.waitForFunction(() => !document.querySelector('#modal-root.is-open'));
    assert.equal(await page.evaluate(() => today().lists.open.tasks[0].requiresPhoto), true);
    assert.equal(await page.evaluate(() => mock.calls.filter(call => call.table === 'daily_tasks' && call.action === 'update').length), 0);
    await page.evaluate(() => {
      const sourceVenue = venueCatalog().find(venue => venue.id !== V().id);
      const template = mock.rows.checklist_templates.find(row => row.venue_id === sourceVenue.realId && row.list_type === 'open');
      mock.rows.template_tasks.push({ id: crypto.randomUUID(), template_id: template.id, title: 'Copied photo rule', requires_photo: true, sort_order: 0 });
    });
    await page.evaluate(async () => { await loadSupabaseTemplates(); openCopyTemplate(); });
    await page.locator('[data-x=save]').click();
    await page.waitForFunction(() => !document.querySelector('#modal-root.is-open'));
    assert.equal(await page.evaluate(() => TPL().open.find(task => task.title === 'Copied photo rule').requiresPhoto), true);
  });
  await t.test('retention validates whole days and only updates the chosen managed organisation', async () => {
    await fresh();
    await page.locator('[data-act=photo-retention]').first().click();
    await page.locator('#photo-retention-days').fill('0');
    await page.locator('[data-retention-save]').click();
    assert.equal(await page.evaluate(() => mock.calls.filter(call => call.table === 'organisations' && call.action === 'update').length), 0);
    await page.locator('#photo-retention-days').fill('60');
    await page.locator('[data-retention-save]').click();
    await page.waitForFunction(() => !document.querySelector('#modal-root.is-open'));
    assert.deepEqual(await page.evaluate(() => mock.rows.organisations.map(org => org.photo_retention_days || 30)), [60, 30]);
    await page.evaluate(() => openPhotoRetention('unmanaged-org'));
    assert.equal(await page.locator('#modal-root.is-open').count(), 0);
  });
  await t.test('required Done opens evidence; real browser preprocessing uploads JPEG before completion', async () => {
    await photoTask();
    await page.locator('[data-task]').first().click();
    await page.waitForFunction(() => PHOTO_PANEL && !PHOTO_PANEL.busy);
    assert.equal(await page.locator('[data-photo-done]').isDisabled(), true);
    assert.equal(await page.locator('[data-photo-camera-input]').getAttribute('capture'), 'environment');
    assert.equal(await page.evaluate(() => mock.calls.filter(call => call.table === 'daily_tasks' && call.action === 'update').length), 0);
    await page.locator('[data-photo-gallery-input]').setInputFiles(await imageFile());
    await page.waitForFunction(() => PHOTO_PANEL && !PHOTO_PANEL.busy && validTaskPhotos(PHOTO_PANEL.task).length === 1);
    const sent = await page.evaluate(async () => {
      const call = mock.calls.find(call => call.upload);
      const bitmap = await createImageBitmap(window.testPhotoBlob);
      const result = { type: window.testPhotoBlob.type, width: bitmap.width, height: bitmap.height, prefix: call.bytes.slice(0, 2), headers: call.headers, status: PHOTO_PANEL.task.status };
      bitmap.close(); return result;
    });
    assert.deepEqual([sent.type, sent.width, sent.height, sent.prefix], ['image/jpeg', 1600, 800, [255, 216]]);
    assert.equal(sent.headers.Authorization, 'Bearer user-test-token');
    assert.equal(sent.headers.apikey, 'public-test-key');
    assert.equal(sent.status, 'pending');
    await page.locator('[data-photo-view]').click();
    await page.waitForFunction(() => !PHOTO_PANEL.busy && Object.keys(PHOTO_PANEL.urls).length === 1);
    assert.match(await page.locator('[data-photo-content] img').getAttribute('src'), /^blob:/);
    if (process.env.DAILYOPS_SCREENSHOT_DIR) {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: path.join(process.env.DAILYOPS_SCREENSHOT_DIR, 'photo-panel-390.png') });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    await page.locator('[data-photo-done]').click();
    await page.waitForFunction(() => !PHOTO_PANEL.busy && PHOTO_PANEL.task.status === 'done');
    await page.locator('[data-photo-remove]').click();
    await page.locator('[data-photo-remove]').click();
    await page.waitForFunction(() => !PHOTO_PANEL.busy && PHOTO_PANEL.task.status === 'pending');
    assert.equal(await page.locator('[data-photo-content] img').count(), 0);
    assert.equal(await page.locator('[data-photo-done]').isDisabled(), true);
    await page.locator('[data-photo-close]').click();
    assert.equal(await page.evaluate(() => PHOTO_PANEL), null);
  });
  await t.test('ambiguous upload retains the same ID and bytes for retry and does not mark Done', async () => {
    await photoTask(); await openPhotos();
    await page.evaluate(() => { mock.uploadMode = 'lost'; });
    await page.locator('[data-photo-gallery-input]').setInputFiles(await imageFile());
    await page.waitForFunction(() => PHOTO_PANEL && !PHOTO_PANEL.busy && !!PHOTO_PANEL.retry);
    assert.equal(await page.locator('[data-photo-done]').isDisabled(), true);
    await page.locator('[data-photo-retry]').click();
    await page.waitForFunction(() => !PHOTO_PANEL.busy && !PHOTO_PANEL.retry);
    const uploads = await page.evaluate(() => mock.calls.filter(call => call.upload));
    assert.equal(uploads.length, 2);
    assert.equal(uploads[0].upload, uploads[1].upload);
    assert.deepEqual(uploads[0].bytes, uploads[1].bytes);
    assert.equal(await page.evaluate(() => mock.rows.task_evidence.length), 1);
    assert.equal(await page.evaluate(() => PHOTO_PANEL.task.status), 'pending');
    const file = await imageFile();
    await page.locator('[data-photo-gallery-input]').setInputFiles([file, file, file]);
    assert.equal(await page.evaluate(() => mock.calls.filter(call => call.upload).length), 2);
  });
  await t.test('manager exemptions require reasons and explicit acknowledgement on submit', async () => {
    await photoTask(); await openPhotos();
    await page.locator('[data-photo-approve]').click();
    assert.equal(await page.evaluate(() => mock.rows.task_evidence_exemptions.length), 0);
    await page.locator('#photo-exemption-reason').fill('Camera unavailable; manager checked the bench in person.');
    await page.locator('[data-photo-approve]').click();
    await page.waitForFunction(() => !PHOTO_PANEL.busy && PHOTO_PANEL.task.exemptions.length === 1);
    await page.locator('[data-photo-done]').click();
    await page.waitForFunction(() => !PHOTO_PANEL.busy && PHOTO_PANEL.task.status === 'done');
    await page.locator('[data-photo-close]').click();
    await page.locator('[data-act=review]').click();
    assert.equal(await page.locator('[data-exemption-ack]').count(), 1);
    await page.locator('[data-x=submit]').click();
    assert.equal(await page.evaluate(() => mock.calls.filter(call => call.rpc === 'submit_daily_checklist').length), 0);
    await page.locator('[data-exemption-ack]').check();
    await page.locator('[data-x=submit]').click();
    await page.waitForFunction(() => !document.querySelector('#modal-root.is-open'));
    assert.deepEqual(await page.evaluate(() => mock.calls.find(call => call.rpc === 'submit_daily_checklist').args.p_exemption_ids),
      await page.evaluate(() => [mock.rows.task_evidence_exemptions[0].id]));
    await openPhotos();
    assert.equal(await page.locator('[data-photo-camera]').count(), 0);
    assert.equal(await page.locator('[data-photo-revoke]').count(), 0);
  });
  await t.test('revoking an exemption resets Done; reopening does not reuse an old revision approval', async () => {
    await photoTask(); await openPhotos();
    await page.locator('#photo-exemption-reason').fill('Checked in person');
    await page.locator('[data-photo-approve]').click();
    await page.waitForFunction(() => !PHOTO_PANEL.busy && PHOTO_PANEL.task.exemptions.length === 1);
    await page.locator('[data-photo-done]').click();
    await page.waitForFunction(() => !PHOTO_PANEL.busy && PHOTO_PANEL.task.status === 'done');
    await page.locator('[data-photo-revoke]').click();
    await page.waitForFunction(() => !PHOTO_PANEL.busy && PHOTO_PANEL.task.status === 'pending');
    assert.equal(await page.locator('[data-photo-done]').isDisabled(), true);
    await page.locator('#photo-exemption-reason').fill('Approved again');
    await page.locator('[data-photo-approve]').click();
    await page.waitForFunction(() => !PHOTO_PANEL.busy && !!activePhotoExemption(PHOTO_PANEL.task, PHOTO_PANEL.list));
    await page.evaluate(() => { mock.rows.daily_checklists.find(row => row.id === PHOTO_PANEL.list.id).notification_revision++; });
    await page.locator('[data-photo-refresh]').click();
    await page.waitForFunction(() => !PHOTO_PANEL.busy && PHOTO_PANEL.list.notificationRevision === 1);
    assert.equal(await page.locator('[data-photo-done]').isDisabled(), true);
  });
  await t.test('employees cannot approve exemptions or remove colleagues photos; access loss clears previews', async () => {
    await photoTask();
    await page.evaluate(async () => {
      AUTH.organisationMemberships.forEach(row => { row.role = 'employee'; });
      AUTH.venueContexts.forEach(row => { row.organisationRole = 'employee'; });
      const list = today().lists.open;
      mock.rows.task_evidence.push({ id: 'colleague-photo', task_id: list.tasks[0].id, checklist_id: list.id, state: 'ready', object_path: 'private/colleague', uploaded_by: 'colleague', uploaded_at: new Date().toISOString(), expires_at: new Date(Date.now()+86400000).toISOString() });
      await loadSupabaseToday(); render();
    });
    await openPhotos();
    assert.equal(await page.locator('[data-photo-approve],[data-photo-revoke],[data-photo-remove]').count(), 0);
    await page.locator('[data-photo-view]').click();
    await page.waitForFunction(() => !PHOTO_PANEL.busy && Object.keys(PHOTO_PANEL.urls).length === 1);
    await page.evaluate(() => { SUPABASE_ACCESS.verified = false; render(); });
    assert.equal(await page.locator('#modal-root.is-open').count(), 0);
    assert.equal(await page.evaluate(() => PHOTO_PANEL), null);
  });
  await t.test('reset-task submission evidence remains readable as expired audit without upload controls', async () => {
    await photoTask();
    await page.evaluate(async () => {
      const list = today().lists.open;
      mock.rows.task_evidence.push({ id: 'old-photo', task_id: 'reset-task', checklist_id: list.id, state: 'deleted', deletion_reason: 'expired', uploaded_by: AUTH.profile.id,
        uploaded_at: new Date(Date.now()-35*86400000).toISOString(), expires_at: new Date(Date.now()-5*86400000).toISOString() });
      mock.rows.task_evidence_submissions.push({ checklist_id: list.id, task_id: 'reset-task', task_title: 'Previous kitchen close', notification_revision: 0,
        task_status: 'done', requires_photo: true, evidence: [{ id: 'old-photo' }], submitted_by: AUTH.profile.id, submitted_at: new Date().toISOString() });
      await loadSupabaseToday(); render();
    });
    await page.locator('[data-act=evidence-audit]').click();
    await page.locator('[data-audit-index]').click();
    await page.waitForFunction(() => PHOTO_PANEL && !PHOTO_PANEL.busy && !PHOTO_PANEL.error);
    assert.match(await page.locator('[data-photo-content]').textContent(), /Expired — photo unavailable/);
    assert.equal(await page.locator('[data-photo-view],[data-photo-camera],[data-photo-approve]').count(), 0);
    assert.match(await page.locator('[data-photo-content]').textContent(), /Submission audit/);
  });
  await t.test('invalid photos never upload and bulk Done stops at a missing required photo', async () => {
    await photoTask();
    await page.locator('[data-act=tick-all]').click();
    await page.waitForFunction(() => PHOTO_PANEL && !PHOTO_PANEL.busy);
    await page.locator('[data-photo-gallery-input]').setInputFiles({ name: 'bad.png', mimeType: 'image/png', buffer: Buffer.from('not an image') });
    await page.waitForFunction(() => !PHOTO_PANEL.busy);
    assert.equal(await page.evaluate(() => mock.calls.filter(call => call.upload).length), 0);
    assert.equal(await page.evaluate(() => mock.calls.filter(call => call.table === 'daily_tasks' && call.action === 'update').length), 0);
    assert.match(await page.locator('[data-photo-content]').textContent(), /cannot be opened/);
  });
  await t.test('three photos upload in order and a failed reservation can be discarded', async () => {
    await photoTask(); await openPhotos();
    const file = await imageFile();
    await page.evaluate(() => { mock.uploadMode = 'fail-before'; });
    await page.locator('[data-photo-gallery-input]').setInputFiles(file);
    await page.waitForFunction(() => !PHOTO_PANEL.busy && !!PHOTO_PANEL.retry);
    await page.locator('[data-photo-discard]').click();
    await page.waitForFunction(() => !PHOTO_PANEL.busy && !PHOTO_PANEL.retry);
    assert.equal(await page.evaluate(() => mock.rows.task_evidence[0].state), 'delete_pending');
    await page.locator('[data-photo-gallery-input]').setInputFiles([file, file, file]);
    await page.waitForFunction(() => !PHOTO_PANEL.busy && validTaskPhotos(PHOTO_PANEL.task).length === 3);
    assert.equal(await page.locator('[data-photo-gallery]').isDisabled(), true);
    assert.equal(await page.locator('[data-photo-camera]').isDisabled(), true);
  });
  await t.test('expired previews are released and a metadata outage fails closed until refresh', async () => {
    await photoTask(); await openPhotos();
    await page.locator('[data-photo-gallery-input]').setInputFiles(await imageFile());
    await page.waitForFunction(() => !PHOTO_PANEL.busy && validTaskPhotos(PHOTO_PANEL.task).length === 1);
    await page.locator('[data-photo-view]').click();
    await page.waitForFunction(() => !PHOTO_PANEL.busy && !!document.querySelector('[data-photo-content] img'));
    await page.evaluate(() => { PHOTO_PANEL.task.evidence[0].expires_at = new Date(Date.now()-1000).toISOString(); });
    await page.waitForFunction(() => !document.querySelector('[data-photo-content] img'));
    assert.equal(await page.locator('[data-photo-done]').isDisabled(), true);
    await page.evaluate(() => { mock.fail = { table: 'task_evidence', action: 'select' }; });
    await page.locator('[data-photo-refresh]').click();
    await page.waitForFunction(() => !PHOTO_PANEL.busy && !!PHOTO_PANEL.error);
    assert.equal(await page.locator('[data-photo-camera]').count(), 0);
    await page.evaluate(() => { mock.fail = null; });
    await page.locator('[data-photo-refresh]').click();
    await page.waitForFunction(() => !PHOTO_PANEL.busy && !PHOTO_PANEL.error);
    assert.equal(await page.locator('[data-photo-camera]').count(), 1);
  });
  await t.test('late private downloads cannot recreate previews after closing or switching venue', async () => {
    await photoTask(); await openPhotos();
    await page.locator('[data-photo-gallery-input]').setInputFiles(await imageFile());
    await page.waitForFunction(() => !PHOTO_PANEL.busy && validTaskPhotos(PHOTO_PANEL.task).length === 1);
    await page.evaluate(() => { DB.storage.from = () => ({ download: () => new Promise(resolve => { window.finishDownload = resolve; }) }); });
    await page.locator('[data-photo-view]').click();
    await page.waitForFunction(() => typeof window.finishDownload === 'function');
    await page.locator('[data-photo-close]').click();
    await page.evaluate(async () => { finishDownload({ data: testPhotoBlob }); await Promise.resolve(); });
    assert.equal(await page.evaluate(() => PHOTO_PANEL), null);
    assert.equal(await page.locator('#modal-root img').count(), 0);
    await openPhotos();
    await page.evaluate(async () => { await switchVenue(venueCatalog().find(venue => venue.id !== V().id).id); });
    assert.equal(await page.evaluate(() => PHOTO_PANEL), null);
  });
  await t.test('historical task evidence opens read-only without bootstrapping or changing tasks', async () => {
    await photoTask();
    await page.evaluate(async () => {
      const date = dayKey(addDays(parseKey(operatingDayKey()), -1));
      for (const list_type of ['open', 'close']) {
        const id = crypto.randomUUID();
        mock.rows.daily_checklists.push({ id, venue_id: V().realId, work_date: date, list_type, submitted: true, notification_revision: 2 });
        if (list_type === 'open') mock.rows.daily_tasks.push({ id: crypto.randomUUID(), checklist_id: id, title: 'Historical clean', status: 'done', requires_photo: true, source: 'adhoc', sort_order: 0 });
      }
      await loadSupabaseHistory(true); openSupabaseHistoryDay(date); mock.calls = [];
    });
    await page.locator('#modal-root [data-act=task-evidence]').click();
    await page.waitForFunction(() => PHOTO_PANEL && !PHOTO_PANEL.busy && !PHOTO_PANEL.error);
    assert.equal(await page.locator('[data-photo-camera],[data-photo-approve]').count(), 0);
    assert.equal(await page.locator('[data-photo-done]').isHidden(), true);
    assert.equal(await page.evaluate(() => mock.calls.some(call => call.rpc === 'ensure_daily_checklists' || ['insert','update','delete'].includes(call.action))), false);
  });
  await t.test('browser conversion respects EXIF orientation and rejects animation', async () => {
    await fresh();
    const result = await page.evaluate(async () => {
      const canvas = document.createElement('canvas'); canvas.width = 100; canvas.height = 50;
      const jpeg = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg'));
      const raw = new Uint8Array(await jpeg.arrayBuffer());
      const exif = new Uint8Array([255,216,255,225,0,34,69,120,105,102,0,0,73,73,42,0,8,0,0,0,1,0,18,1,3,0,1,0,0,0,6,0,0,0,0,0,0,0]);
      const oriented = new File([exif, raw.subarray(2)], 'portrait.jpg', { type: 'image/jpeg' });
      const photo = await prepareTaskPhoto(oriented);
      const bitmap = await createImageBitmap(photo);
      const dimensions = [bitmap.width, bitmap.height]; bitmap.close();
      const animated = new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0,97,99,84,76,0,0,0,0]);
      let message;
      try { await prepareTaskPhoto(new File([animated], 'animated.png', { type: 'image/png' })); } catch (error) { message = error.message; }
      return { dimensions, message };
    });
    assert.deepEqual(result.dimensions, [50, 100]);
    assert.match(result.message, /Animated/);
  });
  await t.test('evidence loading paginates beyond a single response', async () => {
    await photoTask();
    assert.equal(await page.evaluate(async () => {
      const list = today().lists.open;
      mock.rows.task_evidence = Array.from({ length: 1001 }, (_, i) => ({ id: 'evidence-' + i, checklist_id: list.id, task_id: list.tasks[0].id, state: 'deleted' }));
      const evidence = await loadPhotoEvidence([list.id]);
      return evidence.photos.length;
    }), 1001);
  });
  const evidenceLinkFixture = async (options = {}) => {
    await photoTask();
    return page.evaluate(({ venueB = false, live = false } = {}) => {
      const venue = mock.rows.venues[venueB ? 1 : 0];
      const list = mock.rows.daily_checklists.find(row => row.venue_id === venue.id && row.list_type === 'open');
      const date = live ? list.work_date : '2020-01-15';
      if (!live) Object.assign(list, { work_date: date, submitted: false, notification_revision: 3 });
      const snapshot = { checklist_id: list.id, task_id: '00000000-0000-4000-8000-000000000088', venue_id: venue.id, work_date: date, list_type: 'open',
        notification_revision: 0, task_title: 'Original kitchen <proof>', task_status: 'done', requires_photo: true,
        evidence: [{ id: '00000000-0000-4000-8000-000000000077' }], exemption_id: null, submitted_by: AUTH.profile.id, submitted_at: '2020-01-15T02:00:00Z' };
      mock.rows.task_evidence_submissions.push(snapshot, { ...snapshot, notification_revision: 2, task_title: 'Different later revision' });
      mock.rows.task_evidence.push({ id: snapshot.evidence[0].id, checklist_id: list.id, task_id: snapshot.task_id, uploaded_by: AUTH.profile.id,
        state: 'deleted', deletion_reason: 'expired', expires_at: '2020-02-14T02:00:00Z', uploaded_at: snapshot.submitted_at, object_path: 'private/old' });
      const params = new URLSearchParams({ venue: venue.id, date, shift: 'open', checklist: list.id });
      if (!live) params.set('revision', '0');
      const hash = '#evidence?' + params;
      history.replaceState(null, '', hash);
      window.linkFixture = { hash, snapshot, list };
      return hash;
    }, options);
  };

  await t.test('notification links wait for sign-in and resume the exact old revision after authentication', async () => {
    const hash = await evidenceLinkFixture();
    await page.evaluate(async () => {
      AUTH.session = null; AUTH.profile = null; S = null; showLogin(); mock.calls = [];
      await openEvidenceLinkFromLocation();
    });
    assert.equal(await page.locator('#login-form').isVisible(), true);
    assert.equal(await page.locator('#modal-root.is-open').count(), 0);
    assert.equal(await page.evaluate(() => mock.calls.length), 0);
    assert.equal(await page.evaluate(() => location.hash), hash);
    await page.evaluate(async () => { await restoreAuthenticatedApp({ user: { id: mock.rows.profiles[0].id } }); });
    assert.match(await page.locator('[data-linked-evidence]').textContent(), /submission revision 0/);
    assert.match(await page.locator('[data-linked-evidence]').textContent(), /Original kitchen <proof>/);
    assert.doesNotMatch(await page.locator('[data-linked-evidence]').textContent(), /Different later revision/);
    assert.equal(await page.locator('[data-linked-evidence] proof').count(), 0);
    assert.equal(await page.evaluate(() => mock.calls.filter(row => row.download).length), 0);
    await page.locator('[data-linked-task]').click();
    await page.waitForFunction(() => PHOTO_PANEL && !PHOTO_PANEL.busy && !PHOTO_PANEL.error);
    assert.match(await page.locator('[data-photo-content]').textContent(), /Expired — photo unavailable/);
    assert.equal(await page.locator('[data-photo-gallery]').count(), 0);
    assert.equal(await page.locator('[data-photo-done]').isVisible(), false);
    await page.locator('[data-photo-back]').click();
    await page.waitForFunction(() => !!document.querySelector('[data-linked-task]'));
    assert.match(await page.locator('[data-linked-evidence]').textContent(), /submission revision 0/);
  });

  await t.test('evidence links select the authorised venue across organisations and support mobile layout', async () => {
    await evidenceLinkFixture({ venueB: true });
    await page.evaluate(async () => {
      AUTH.selectedOrganisationId = mock.rows.venues[0].organisation_id; AUTH.selectedVenueId = mock.rows.venues[0].id;
      mock.calls = []; await openEvidenceLinkFromLocation();
    });
    assert.equal(await page.evaluate(() => V().name), 'Venue B');
    assert.equal(await page.evaluate(() => AUTH.selectedOrganisationId), '00000000-0000-4000-8000-000000000011');
    assert.match(await page.locator('[data-linked-evidence]').textContent(), /Venue B/);
    assert.equal(await page.evaluate(() => mock.calls.filter(row => row.rpc || (row.action && row.action !== 'select')).length), 0);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    if (process.env.DAILYOPS_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.DAILYOPS_SCREENSHOT_DIR, 'notification-evidence-390.png'), animations: 'disabled' });
  });

  await t.test('invalid or inaccessible evidence links reveal no evidence and perform no writes', async () => {
    const hash = await evidenceLinkFixture();
    const invalid = [hash + '&revision=1', hash.replace('2020-01-15', '2020-02-31'), hash.replace('revision=0', 'revision=-1'), hash + '&redirect=https://attacker.test/'];
    for (const value of invalid) {
      await page.evaluate(async value => { closeModal(); EVIDENCE_LINK_HANDLED = ''; history.replaceState(null, '', value); mock.calls = []; await openEvidenceLinkFromLocation(); }, value);
      assert.match(await page.locator('[data-linked-evidence]').textContent(), /link is invalid/);
      assert.equal(await page.evaluate(() => mock.calls.length), 0);
    }
    await page.evaluate(async hash => {
      closeModal(); EVIDENCE_LINK_HANDLED = ''; history.replaceState(null, '', hash); AUTH.venueContexts = []; mock.calls = []; await openEvidenceLinkFromLocation();
    }, hash);
    assert.match(await page.locator('[data-linked-evidence]').textContent(), /venue is unavailable/);
    assert.equal(await page.evaluate(() => mock.calls.length), 0);
  });

  await t.test('wrong revision or mismatched venue-date does not fall back to another submission', async () => {
    const hash = await evidenceLinkFixture();
    for (const value of [hash.replace('revision=0', 'revision=99'), hash.replace('2020-01-15', '2020-01-16'), hash.replace('shift=open', 'shift=close')]) {
      await page.evaluate(async value => { closeModal(); EVIDENCE_LINK_HANDLED = ''; history.replaceState(null, '', value); await openEvidenceLinkFromLocation(); }, value);
      assert.match(await page.locator('[data-linked-evidence]').textContent(), /submission is unavailable/);
      assert.equal(await page.locator('[data-linked-task]').count(), 0);
    }
  });

  await t.test('current evidence links are read-only and refresh only the linked checklist without bootstrap', async () => {
    await evidenceLinkFixture({ live: true });
    await page.evaluate(async () => {
      mock.rows.daily_checklists = mock.rows.daily_checklists.filter(row => row.id === linkFixture.list.id);
      mock.calls = []; await openEvidenceLinkFromLocation();
    });
    assert.match(await page.locator('[data-linked-evidence]').textContent(), /current evidence \(may change\)/);
    await page.locator('[data-linked-task]').click();
    await page.waitForFunction(() => PHOTO_PANEL && !PHOTO_PANEL.busy && !PHOTO_PANEL.error);
    assert.equal(await page.locator('[data-photo-gallery]').count(), 0);
    assert.equal(await page.locator('[data-photo-done]').isVisible(), false);
    assert.equal(await page.evaluate(() => mock.calls.filter(row => row.rpc || (row.action && row.action !== 'select')).length), 0);
    assert.equal(await page.evaluate(() => today().lists.close.id !== undefined), true);
  });

  await t.test('failed evidence links show an error instead of an empty audit', async () => {
    await evidenceLinkFixture();
    await page.evaluate(async () => { mock.fail = { table: 'task_evidence_submissions', action: 'select' }; await openEvidenceLinkFromLocation(); });
    assert.match(await page.locator('[data-linked-evidence]').textContent(), /could not be loaded/);
    assert.equal(await page.locator('[data-linked-task]').count(), 0);
  });

  await t.test('closing, signing out or losing access discards late evidence link results', async () => {
    await evidenceLinkFixture();
    await page.evaluate(() => {
      const original = loadLinkedEvidenceDay;
      loadLinkedEvidenceDay = async route => { const day = await original(route); await new Promise(resolve => { window.finishLink = resolve; }); return day; };
      window.pendingLink = openEvidenceLinkFromLocation();
    });
    await page.waitForFunction(() => !!window.finishLink);
    await page.locator('[data-linked-close]').click();
    await page.evaluate(async () => { finishLink(); await pendingLink; });
    assert.equal(await page.locator('#modal-root.is-open').count(), 0);
    await evidenceLinkFixture();
    await page.evaluate(async () => { await openEvidenceLinkFromLocation(); SUPABASE_ACCESS.verified = false; render(); });
    assert.equal(await page.locator('#modal-root.is-open').count(), 0);
    await evidenceLinkFixture();
    await page.evaluate(async () => { await openEvidenceLinkFromLocation(); await restoreAuthenticatedApp(null); });
    assert.equal(await page.locator('#modal-root.is-open').count(), 0);
    assert.equal(await page.locator('#login-form').isVisible(), true);
  });

  await t.test('same-tab hash navigation opens new notification links but unrelated hashes do not', async () => {
    const hash = await evidenceLinkFixture();
    await page.evaluate(async () => { await openEvidenceLinkFromLocation(); });
    await page.evaluate(() => { location.hash = '#unrelated'; });
    await page.waitForFunction(() => !document.querySelector('#modal-root.is-open'));
    await page.evaluate(hash => { location.hash = hash; }, hash);
    await page.waitForFunction(() => !!document.querySelector('[data-linked-task]'));
    assert.match(await page.locator('[data-linked-evidence]').textContent(), /submission revision 0/);
  });

  await t.test('desktop and phone layouts retain usable controls without page overflow', async () => {
    await fresh();
    await page.evaluate(() => {
      today().lists.open.tasks = [{ id: 'layout-task', title: 'Clean and sanitise the benches before service', detail: 'Check all preparation surfaces and record any issues.', status: 'pending', source: 'adhoc', critical: true, note: '', reason: '' }];
    });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      for (const tab of ['today', 'templates', 'settings', 'team', 'roster', 'history', 'alerts']) {
        await page.evaluate(tab => { R.tab = tab; render(); }, tab);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${tab} overflow at ${width}`);
        assert.ok(await page.locator('#page .card-foot [data-act]').evaluateAll(buttons => buttons.every(button => {
          const bounds = button.getBoundingClientRect();
          return bounds.left >= 0 && bounds.right <= innerWidth;
        })), `${tab} footer controls clipped at ${width}`);
        if (process.env.DAILYOPS_SCREENSHOT_DIR && ['today', 'settings'].includes(tab)) {
          await page.screenshot({ path: path.join(process.env.DAILYOPS_SCREENSHOT_DIR, `${tab}-${width}.png`) });
          if (tab === 'today') await page.locator('#page .tasklist').screenshot({ path: path.join(process.env.DAILYOPS_SCREENSHOT_DIR, `task-row-${width}.png`) });
        }
      }
    }
    await fresh({ demo: true });
    assert.ok(await page.locator('[data-act=reset-all]').count());
    assert.deepEqual(errors, []);
  });
});
