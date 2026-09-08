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
  await page.evaluate(demo => { window.DAILYOPS_SUPABASE_CONFIG = { DEMO_MODE: demo }; }, demo);
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
        venue_members: [], roster_assignments: [], shift_cover_requests: [], notification_events: [], venue_notification_recipients: []
      }
    };
    const addHeaders = venueId => ['open', 'close'].forEach(list_type => mock.rows.checklist_templates.push({ id: crypto.randomUUID(), venue_id: venueId, list_type, name: list_type, active: true }));
    mock.rows.venues.forEach(row => addHeaders(row.id));
    DB = {
      from(table) {
        let action = 'select', payload, single = false;
        const filters = [];
        const query = {
          select() { return query; }, order() { return query; }, limit() { return query; },
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
        throw new Error('Unexpected RPC: ' + name);
      },
      functions: { async invoke() { return { data: { sent: 0, skipped: 'no-recipients' } }; } },
      async removeChannel() {},
      channel() { return { on() { return this; }, subscribe() { return this; } }; }
    };
    AUTH.profile = profile;
    AUTH.session = { user: { id: profile.id } };
    SUPABASE_ACCESS.verified = true;
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
