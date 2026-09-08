const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { pgcrypto } = require('@electric-sql/pglite/contrib/pgcrypto');

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('migrations, venue permissions and shared-shift submission', async t => {
  const db = new PGlite({ extensions: { pgcrypto } });
  t.after(() => db.close());
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create function auth.role() returns text language sql stable as
      $$ select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'service_role') $$;
    grant usage on schema auth to anon, authenticated, service_role;
    grant execute on all functions in schema auth to anon, authenticated, service_role;
    create publication supabase_realtime;
  `);
  const folder = path.join(__dirname, '../supabase/migrations');
  for (const file of fs.readdirSync(folder).filter(file => file.endsWith('.sql')).sort()) {
    await db.exec(fs.readFileSync(path.join(folder, file), 'utf8'));
    if (file.startsWith('002_')) {
      await db.exec(`insert into auth.users(id,email) values ('${id(1)}','ab2824484@gmail.com');
        update public.profiles set platform_role='admin' where id='${id(1)}';`);
    }
  }
  const asUser = async (userId, action) => {
    await db.exec(`set role authenticated; set request.jwt.claim.sub='${userId}'; set request.jwt.claim.role='authenticated';`);
    try { return await action(); }
    finally { await db.exec(`reset role; reset request.jwt.claim.sub; reset request.jwt.claim.role;`); }
  };
  const scalar = async (sql, params = []) => Object.values((await db.query(sql, params)).rows[0])[0];
  const createVenue = (venueId, orgId, accent = 'teal') => db.query(
    'select * from public.create_venue($1,$2,$3,$4,$5,$6,$7)',
    [venueId, orgId, 'Test venue', 'Kitchen', accent, 'Australia/Sydney', '23:30']
  );
  await db.exec(`
    insert into auth.users(id,email) values
      ('${id(2)}','manager@example.test'), ('${id(3)}','employee-a@example.test'),
      ('${id(4)}','employee-b@example.test'), ('${id(5)}','employee-c@example.test'),
      ('${id(6)}','inactive@example.test');
    update profiles set active=false where id='${id(6)}';
    insert into organisations(id,name) values ('${id(10)}','Organisation A'), ('${id(11)}','Organisation B');
    insert into organisation_members(organisation_id,user_id,role) values
      ('${id(10)}','${id(2)}','manager'), ('${id(10)}','${id(3)}','employee'),
      ('${id(10)}','${id(4)}','employee'), ('${id(10)}','${id(5)}','employee'),
      ('${id(10)}','${id(6)}','manager');
  `);

  await t.test('admin creates organisations; manager and employee requests are denied', async () => {
    await asUser(id(1), () => db.query('insert into organisations(id,name) values ($1,$2)', [id(12), 'New organisation']));
    for (const userId of [id(2), id(3), id(6)]) {
      await assert.rejects(asUser(userId, () => db.query('insert into organisations(name) values ($1)', ['Denied'])), /row-level security/);
    }
  });
  await t.test('venue creation is scoped, atomic, empty and retry-safe', async () => {
    await asUser(id(2), () => createVenue(id(20), id(10)));
    await asUser(id(2), () => createVenue(id(20), id(10)));
    assert.equal(await scalar('select count(*)::int from venues where id=$1', [id(20)]), 1);
    assert.equal(await scalar('select count(*)::int from checklist_templates where venue_id=$1 and active', [id(20)]), 2);
    assert.equal(await scalar('select count(*)::int from template_tasks'), 0);
    for (const [userId, orgId] of [[id(2), id(11)], [id(3), id(10)], [id(6), id(10)]]) {
      await assert.rejects(asUser(userId, () => createVenue(id(21), orgId)), /authorised organisation manager/);
    }
    await assert.rejects(asUser(id(2), () => createVenue(id(22), id(10), 'invalid')), /check constraint/);
    assert.equal(await scalar('select count(*)::int from venues where id=$1', [id(22)]), 0);
    await asUser(id(1), () => createVenue(id(23), id(11)));
  });
  await t.test('managers persist own venue details and timing without moving ownership', async () => {
    await asUser(id(2), () => db.exec(`update venues set name='Renamed', accent_key='berry', timezone='Pacific/Auckland', cutoff_time='22:15', notify_complete=false, notify_end_of_day=false where id='${id(20)}';`));
    const row = (await db.query('select * from venues where id=$1', [id(20)])).rows[0];
    assert.equal(row.name, 'Renamed');
    assert.equal(row.accent_key, 'berry');
    assert.equal(row.timezone, 'Pacific/Auckland');
    assert.equal(row.cutoff_time, '22:15:00');
    assert.equal(row.notify_complete, false);
    assert.equal(row.notify_end_of_day, false);
    await assert.rejects(asUser(id(2), () => db.exec(`update venues set organisation_id='${id(11)}' where id='${id(20)}'`)), /identity and organisation/);
    await assert.rejects(asUser(id(2), () => db.exec(`update venues set timezone='Mars/Olympus' where id='${id(20)}'`)), /valid IANA timezone/);
    for (const [userId, venueId] of [[id(2), id(23)], [id(3), id(20)], [id(6), id(20)]]) {
      const result = await asUser(userId, () => db.query('update venues set name=$1 where id=$2 returning id', ['Denied', venueId]));
      assert.equal(result.rows.length, 0);
    }
  });
  await db.exec(`insert into venue_members(venue_id,user_id) values ('${id(20)}','${id(3)}'), ('${id(20)}','${id(4)}'), ('${id(20)}','${id(5)}');`);
  await asUser(id(2), () => db.query("update venues set timezone='Pacific/Kiritimati' where id=$1", [id(20)]));
  const date = await scalar(`select (now() at time zone 'Pacific/Kiritimati')::date::text`);
  await t.test('first employee can initialise today and retries do not duplicate shifts', async () => {
    for (const userId of [id(3), id(4)]) {
      await asUser(userId, () => db.query('select public.ensure_daily_checklists($1,$2)', [id(20), date]));
    }
    assert.equal(await scalar('select count(*)::int from daily_checklists where venue_id=$1', [id(20)]), 2);
    await assert.rejects(asUser(id(3), () => db.query('select public.ensure_daily_checklists($1,$2::date-1)', [id(20), date])), /current|today/i);
  });
  const checklistId = await scalar(`select id from daily_checklists where venue_id=$1 and list_type='open'`, [id(20)]);
  const templateId = await scalar(`select id from checklist_templates where venue_id=$1 and list_type='open'`, [id(20)]);
  await db.query('insert into template_tasks(id,template_id,title) values ($1,$2,$3)', [id(30), templateId, 'Future routine']);
  for (const n of [40, 41, 42]) {
    await asUser(id(2), () => db.query('insert into daily_tasks(id,checklist_id,title,source,added_by) values ($1,$2,$3,$4,$5)', [id(n), checklistId, `Task ${n}`, 'adhoc', id(2)]));
  }
  const complete = (taskId, userId) => asUser(userId, () => db.query("update daily_tasks set status='done' where id=$1", [taskId]));
  await complete(id(40), id(3));
  await complete(id(41), id(4));
  const attribution = (await db.query('select id,completed_by,completed_at from daily_tasks where status=$1 order by id', ['done'])).rows;
  await t.test('editing a colleague’s note preserves completion attribution', async () => {
    await asUser(id(5), () => db.query('update daily_tasks set note=$1 where id=$2', ['Checked', id(40)]));
    assert.deepEqual((await db.query('select id,completed_by,completed_at from daily_tasks where status=$1 order by id', ['done'])).rows, attribution);
  });
  const change = { id: id(42), expected_status: 'pending', expected_note: '', expected_reason: '', status: 'blocked', reason: 'Supplier delayed' };
  const submit = (changes, revision = 0, userId = id(5)) => asUser(userId, () => db.query('select * from public.submit_daily_checklist($1,$2,$3)', [checklistId, revision, JSON.stringify(changes)]));
  await t.test('failed submission rolls back every task change', async () => {
    await assert.rejects(submit([change, { id: id(40), expected_status: 'done', expected_note: 'stale', expected_reason: '', note: 'Overwrite' }]), /task changed/);
    assert.equal(await scalar('select status from daily_tasks where id=$1', [id(42)]), 'pending');
    assert.equal(await scalar('select submitted from daily_checklists where id=$1', [checklistId]), false);
    await assert.rejects(submit([]), /unfinished task/);
  });
  await t.test('third employee submits once without rewriting completion or submission attribution', async () => {
    const first = (await submit([change])).rows[0];
    assert.equal(first.submitted_by, id(5));
    const retry = (await submit([], 0, id(4))).rows[0];
    assert.equal(retry.submitted_by, first.submitted_by);
    assert.deepEqual(retry.submitted_at, first.submitted_at);
    assert.deepEqual((await db.query('select id,completed_by,completed_at from daily_tasks where status=$1 order by id', ['done'])).rows, attribution);
  });
  await t.test('explicit reopen advances revision and rejects stale submission', async () => {
    await asUser(id(2), () => db.query('update daily_checklists set submitted=false,submitted_by=null,submitted_at=null where id=$1', [checklistId]));
    await assert.rejects(submit([], 0), /shift changed/);
    const result = (await submit([], 1)).rows[0];
    assert.equal(result.notification_revision, 1);
    assert.equal(result.submitted, true);
  });
  await t.test('employee initialisation snapshots routines on a new venue-local date', async () => {
    await asUser(id(2), () => db.query("update venues set timezone='Pacific/Pago_Pago' where id=$1", [id(20)]));
    const newDate = await scalar("select (now() at time zone 'Pacific/Pago_Pago')::date::text");
    assert.notEqual(newDate, date);
    await asUser(id(3), () => db.query('select public.ensure_daily_checklists($1,$2)', [id(20), newDate]));
    assert.equal(await scalar('select count(*)::int from daily_tasks dt join daily_checklists dc on dc.id=dt.checklist_id where dc.venue_id=$1 and dc.work_date=$2 and dt.template_task_id=$3', [id(20), newDate, id(30)]), 1);
  });
});
