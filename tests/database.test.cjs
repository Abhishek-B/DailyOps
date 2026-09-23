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
    create schema storage;
    create table storage.buckets (id text primary key, public boolean not null default false);
    create table storage.objects (
      id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id),
      name text not null, metadata jsonb, unique(bucket_id, name)
    );
    alter table storage.objects enable row level security;
    grant usage on schema storage to anon, authenticated, service_role;
    grant select, insert, update, delete on storage.objects to anon, authenticated, service_role;
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

  const asService = async action => {
    await db.exec("set role service_role; set request.jwt.claim.role='service_role';");
    try { return await action(); }
    finally { await db.exec('reset role; reset request.jwt.claim.role;'); }
  };
  await asUser(id(2), () => createVenue(id(300), id(10)));
  await db.query('insert into venue_members(venue_id,user_id) values ($1,$2),($1,$3)', [id(300), id(3), id(4)]);
  const photoDate = await scalar("select (now() at time zone 'Australia/Sydney')::date::text");
  const photoTemplate = await scalar("select id from checklist_templates where venue_id=$1 and list_type='open'", [id(300)]);
  await asUser(id(2), () => db.query(
    'insert into template_tasks(id,template_id,title,requires_photo) values ($1,$2,$3,true)',
    [id(301), photoTemplate, 'Clean the benches']
  ));
  await asUser(id(3), () => db.query('select public.ensure_daily_checklists($1,$2)', [id(300), photoDate]));
  const photoChecklist = await scalar("select id from daily_checklists where venue_id=$1 and work_date=$2 and list_type='open'", [id(300), photoDate]);
  const photoTask = await scalar('select id from daily_tasks where checklist_id=$1', [photoChecklist]);
  const reserve = async (taskId, evidenceId, userId = id(3)) =>
    (await asUser(userId, () => db.query('select * from reserve_task_evidence($1,$2)', [taskId, evidenceId]))).rows[0];
  const finalize = evidenceId => asService(() => db.query('select * from finalize_task_evidence($1,$2,$3,$4,$5)',
    [evidenceId, id(3), 1024, 'image/jpeg', 'a'.repeat(64)]));
  const upload = async (taskId, evidenceId) => {
    const evidence = await reserve(taskId, evidenceId);
    await asUser(id(3), () => db.query("insert into storage.objects(bucket_id,name,metadata) values ('task-evidence',$1,$2)",
      [evidence.object_path, { size: 1024, mimetype: 'image/jpeg' }]));
    return (await finalize(evidenceId)).rows[0];
  };
  const approve = async (taskId, reason = 'Camera damaged', userId = id(2)) =>
    (await asUser(userId, () => db.query('select * from approve_task_photo_exemption($1,$2)', [taskId, reason]))).rows[0];
  const photoSubmit = (exemptions = [], revision = 0, changes = []) => asUser(id(3), () => db.query(
    'select * from submit_daily_checklist($1,$2,$3,$4)', [photoChecklist, revision, JSON.stringify(changes), exemptions]
  ));
  const photoReopen = () => asUser(id(2), () => db.query(
    'update daily_checklists set submitted=false,submitted_by=null,submitted_at=null where id=$1', [photoChecklist]
  ));
  const addPhotoTask = (taskId, required = true, parent = photoChecklist) => asUser(id(2), () => db.query(
    "insert into daily_tasks(id,checklist_id,title,source,requires_photo) values ($1,$2,'Photo task','adhoc',$3)",
    [taskId, parent, required]
  ));

  await t.test('photo requirements snapshot on employee initialisation and template-linked inserts', async () => {
    assert.equal(await scalar('select requires_photo from daily_tasks where id=$1', [photoTask]), true);
    await asUser(id(2), () => db.query('update template_tasks set requires_photo=false where id=$1', [id(301)]));
    assert.equal(await scalar('select requires_photo from daily_tasks where id=$1', [photoTask]), true);
    await asUser(id(2), () => db.query(
      "insert into daily_tasks(id,checklist_id,template_task_id,title,requires_photo) values ($1,$2,$3,'New copy',true)",
      [id(302), photoChecklist, id(301)]
    ));
    assert.equal(await scalar('select requires_photo from daily_tasks where id=$1', [id(302)]), false);
    await complete(id(302), id(3));
    for (const userId of [id(2), id(3)]) {
      await assert.rejects(asUser(userId, () => db.query('update daily_tasks set requires_photo=false where id=$1', [photoTask])), /requirements are fixed/);
    }
    const denied = await asUser(id(3), () => db.query('update template_tasks set requires_photo=true where id=$1 returning id', [id(301)]));
    assert.equal(denied.rows.length, 0);
    const otherChecklist = await scalar("select id from daily_checklists where venue_id=$1 and work_date=$2 and list_type='close'", [id(20), date]);
    await assert.rejects(asUser(id(2), () => db.query(
      "insert into daily_tasks(checklist_id,template_task_id,title) values ($1,$2,'Wrong venue')", [otherChecklist, id(301)]
    )), /does not belong/);
  });

  await t.test('missing or pending photos block Done, including manager and direct insert paths', async () => {
    await assert.rejects(complete(photoTask, id(3)), /photo or manager-approved exemption/);
    await assert.rejects(asUser(id(2), () => db.query(
      "update daily_tasks set status='done',completed_by=$2,completed_at=now() where id=$1", [photoTask, id(2)]
    )), /photo or manager-approved exemption/);
    await assert.rejects(asUser(id(2), () => db.query(
      "insert into daily_tasks(checklist_id,title,requires_photo,status,completed_by,completed_at) values ($1,'Bypass',true,'done',$2,now())",
      [photoChecklist, id(2)]
    )), /photo or manager-approved exemption/);
    const first = await reserve(photoTask, id(310));
    assert.deepEqual(await reserve(photoTask, id(310)), first);
    assert.equal(first.state, 'pending');
    assert.equal(first.venue_id, id(300));
    assert.equal(first.uploaded_by, id(3));
    await assert.rejects(complete(photoTask, id(3)), /photo or manager-approved exemption/);
    await assert.rejects(reserve(photoTask, id(310), id(4)), /already in use/);
    await reserve(photoTask, id(311));
    await reserve(photoTask, id(312));
    await assert.rejects(reserve(photoTask, id(313)), /up to three/);
    await asUser(id(3), () => db.query('select remove_task_evidence($1)', [id(312)]));
  });

  await t.test('evidence metadata and server-only functions cannot be forged', async () => {
    for (const userId of [id(1), id(2), id(3)]) {
      await assert.rejects(asUser(userId, () => db.query("update task_evidence set state='ready' where id=$1", [id(310)])), /permission denied/);
      await assert.rejects(asUser(userId, () => db.query('delete from task_evidence where id=$1', [id(310)])), /permission denied/);
      await assert.rejects(asUser(userId, () => db.query('select finalize_task_evidence($1,$2,1024,$3,$4)',
        [id(310), id(3), 'image/jpeg', 'a'.repeat(64)])), /permission denied/);
      await assert.rejects(asUser(userId, () => db.query('select queue_expired_task_evidence()')), /permission denied/);
    }
    await assert.rejects(asService(() => db.exec("update task_evidence set state='ready'")), /permission denied/);
    for (const userId of [id(5), id(6)]) {
      await assert.rejects(reserve(photoTask, id(313), userId), /not available/);
      assert.equal((await asUser(userId, () => db.query('select * from task_evidence'))).rows.length, 0);
    }
    await assert.rejects(finalize(id(310)), /private uploaded object/);
  });

  await t.test('Storage policies isolate pending uploads and withstand broader existing policies', async () => {
    await db.exec("insert into storage.buckets(id) values ('task-evidence'),('unrelated');");
    await db.exec('create policy broad_existing_storage_policy on storage.objects for all to anon, authenticated using (true) with check (true);');
    const evidence = await reserve(photoTask, id(310));
    await assert.rejects(asUser(id(4), () => db.query("insert into storage.objects(bucket_id,name) values ('task-evidence',$1)", [evidence.object_path])), /row-level security/);
    await assert.rejects(asUser(id(3), () => db.exec("insert into storage.objects(bucket_id,name) values ('task-evidence','invented/path')")), /row-level security/);
    await asUser(id(3), () => db.query("insert into storage.objects(bucket_id,name,metadata) values ('task-evidence',$1,$2)",
      [evidence.object_path, { size: 1024, mimetype: 'image/jpeg' }]));
    assert.equal((await asUser(id(3), () => db.query('select * from storage.objects where name=$1', [evidence.object_path]))).rows.length, 0);
    await db.exec('set role anon;');
    try {
      assert.equal((await db.query("select * from storage.objects where bucket_id='task-evidence'")).rows.length, 0);
      await assert.rejects(db.exec("insert into storage.objects(bucket_id,name) values ('task-evidence','anon')"), /row-level security/);
      await db.exec("insert into storage.objects(bucket_id,name) values ('unrelated','public-file')");
    } finally { await db.exec('reset role'); }
    const ready = (await finalize(id(310))).rows[0];
    assert.equal(ready.state, 'ready');
    assert.equal(new Date(ready.expires_at) - new Date(ready.uploaded_at), 30 * 86400000);
    assert.deepEqual((await finalize(id(310))).rows[0], ready);
    for (const userId of [id(1), id(2), id(3), id(4)]) {
      assert.equal((await asUser(userId, () => db.query('select * from storage.objects where name=$1', [evidence.object_path]))).rows.length, 1);
      assert.equal((await asUser(userId, () => db.query('update storage.objects set metadata=$2 where name=$1 returning id', [evidence.object_path, {}]))).rows.length, 0);
      assert.equal((await asUser(userId, () => db.query('delete from storage.objects where name=$1 returning id', [evidence.object_path]))).rows.length, 0);
    }
    for (const userId of [id(5), id(6)]) {
      assert.equal((await asUser(userId, () => db.query('select * from storage.objects where name=$1', [evidence.object_path]))).rows.length, 0);
    }
    await complete(photoTask, id(4));
  });

  await t.test('retention is organisation scoped, bounded and fixed at upload finalisation', async () => {
    await asUser(id(2), () => db.query('update organisations set photo_retention_days=60 where id=$1', [id(10)]));
    for (const userId of [id(3), id(6)]) {
      assert.equal((await asUser(userId, () => db.query('update organisations set photo_retention_days=90 where id=$1 returning id', [id(10)]))).rows.length, 0);
    }
    assert.equal((await asUser(id(2), () => db.query('update organisations set photo_retention_days=90 where id=$1 returning id', [id(11)]))).rows.length, 0);
    await assert.rejects(asUser(id(2), () => db.query('update organisations set photo_retention_days=0 where id=$1', [id(10)])), /check constraint/);
    const second = await upload(photoTask, id(311));
    assert.equal(new Date(second.expires_at) - new Date(second.uploaded_at), 60 * 86400000);
    assert.equal(await scalar('select extract(epoch from expires_at-uploaded_at)::int from task_evidence where id=$1', [id(310)]), 30 * 86400);
  });

  await t.test('manager exemption approval is scoped, attributed and requires a reason', async () => {
    await addPhotoTask(id(320));
    for (const userId of [id(3), id(4), id(6)]) {
      await assert.rejects(approve(id(320), 'Camera broken', userId), /Only an authorised manager/);
    }
    await assert.rejects(approve(id(320), '   '), /needs a reason/);
    await assert.rejects(approve(id(302)), /does not require/);
    await assert.rejects(asUser(id(2), () => db.exec('insert into task_evidence_exemptions default values')), /permission denied/);
    const exemption = await approve(id(320));
    assert.equal(exemption.approved_by, id(2));
    assert.equal(exemption.notification_revision, 0);
    assert.deepEqual(await approve(id(320)), exemption);
    await complete(id(320), id(3));
  });

  await t.test('submission requires explicit current exemption selection and snapshots evidence atomically', async () => {
    const exemptionId = await scalar('select id from task_evidence_exemptions where task_id=$1', [id(320)]);
    await assert.rejects(photoSubmit(), /Explicitly acknowledge/);
    await assert.rejects(photoSubmit([id(999)]), /Explicitly acknowledge/);
    await assert.rejects(photoSubmit([exemptionId, exemptionId]), /Explicitly acknowledge/);
    await assert.rejects(asUser(id(3), () => db.query(
      'update daily_checklists set submitted=true,submitted_by=$2,submitted_at=now() where id=$1', [photoChecklist, id(3)]
    )), /Explicitly acknowledge/);
    await assert.rejects(asUser(id(3), () => db.query('update daily_checklists set evidence_exemption_ids=$2 where id=$1',
      [photoChecklist, [exemptionId]])), /only when submitting/);
    const submitted = (await photoSubmit([exemptionId])).rows[0];
    assert.equal(submitted.submitted, true);
    const snapshot = (await db.query('select * from task_evidence_submissions where checklist_id=$1 order by task_id', [photoChecklist])).rows;
    assert.equal(snapshot.length, 3);
    assert.equal(snapshot.find(row => row.task_id === photoTask).evidence.length, 2);
    assert.equal(snapshot.find(row => row.task_id === id(320)).exemption_reason, 'Camera damaged');
    await photoSubmit([exemptionId]);
    assert.deepEqual((await db.query('select * from task_evidence_submissions where checklist_id=$1 order by task_id', [photoChecklist])).rows, snapshot);
    await assert.rejects(asUser(id(2), () => db.exec("update task_evidence_submissions set evidence='[]'")), /permission denied/);
  });

  await t.test('submitted evidence and task definitions stay locked even for managers', async () => {
    for (const userId of [id(2), id(3)]) {
      await assert.rejects(asUser(userId, () => db.query('select remove_task_evidence($1)', [id(310)])), /Reopen the shift/);
      await assert.rejects(reserve(photoTask, id(313), userId), /Reopen the shift/);
    }
    await assert.rejects(approve(id(320)), /Reopen the shift/);
    await assert.rejects(asUser(id(2), () => db.query('update daily_tasks set requires_photo=false where id=$1', [photoTask])), /Reopen the shift/);
    await assert.rejects(asUser(id(2), () => db.query('delete from daily_tasks where id=$1', [id(320)])), /Reopen the shift/);
    await assert.rejects(addPhotoTask(id(321)), /Reopen the shift/);
    await assert.rejects(asUser(id(2), () => db.query("update daily_checklists set work_date=work_date+1 where id=$1", [photoChecklist])), /cannot be changed/);
  });

  await t.test('expiry preserves submissions, denies downloads, and reopening rechecks photos and exemptions', async () => {
    const before = (await db.query('select * from task_evidence_submissions where checklist_id=$1 order by task_id', [photoChecklist])).rows;
    await db.query("update task_evidence set uploaded_at=now()-interval '61 days',expires_at=now()-interval '1 day' where task_id=$1 and state='ready'", [photoTask]);
    assert.equal((await asUser(id(3), () => db.exec("select * from storage.objects where bucket_id='task-evidence'")))[0].rows.length, 0);
    assert.equal(await asService(() => scalar('select queue_expired_task_evidence()')), 2);
    assert.equal(await scalar('select status from daily_tasks where id=$1', [photoTask]), 'done');
    assert.equal(await scalar('select submitted from daily_checklists where id=$1', [photoChecklist]), true);
    assert.deepEqual((await db.query('select * from task_evidence_submissions where checklist_id=$1 order by task_id', [photoChecklist])).rows, before);
    await photoReopen();
    assert.equal(await scalar('select status from daily_tasks where id=$1', [photoTask]), 'pending');
    assert.equal(await scalar('select status from daily_tasks where id=$1', [id(320)]), 'pending');
    assert.deepEqual(await scalar('select evidence_exemption_ids from daily_checklists where id=$1', [photoChecklist]), []);
    await assert.rejects(complete(id(320), id(3)), /photo or manager-approved exemption/);
    await assert.rejects(finalize(id(310)), /shift changed/);
    await assert.rejects(photoSubmit([], 0), /shift changed/);
    await assert.rejects(asService(() => db.query('select confirm_task_evidence_deleted($1)', [id(310)])), /Storage API/);
    await db.query("delete from storage.objects where bucket_id='task-evidence' and name=(select object_path from task_evidence where id=$1)", [id(310)]);
    await asService(() => db.query('select confirm_task_evidence_deleted($1)', [id(310)]));
    await asService(() => db.query('select confirm_task_evidence_deleted($1)', [id(310)]));
    assert.equal(await scalar('select state from task_evidence where id=$1', [id(310)]), 'deleted');
  });

  await t.test('removal and exemption revocation invalidate only unsubmitted Done tasks', async () => {
    await upload(photoTask, id(313));
    await complete(photoTask, id(4));
    await assert.rejects(asUser(id(4), () => db.query('select remove_task_evidence($1)', [id(313)])), /uploader or venue manager/);
    await asUser(id(3), () => db.query('select remove_task_evidence($1)', [id(313)]));
    assert.equal(await scalar('select status from daily_tasks where id=$1', [photoTask]), 'pending');
    assert.equal(await scalar('select completed_by from daily_tasks where id=$1', [photoTask]), null);
    const exemption = await approve(photoTask, 'Device unavailable', id(1));
    assert.equal(exemption.approved_by, id(1));
    await complete(photoTask, id(3));
    await assert.rejects(asUser(id(3), () => db.query('select revoke_task_photo_exemption($1)', [exemption.id])), /Only an authorised manager/);
    await asUser(id(2), () => db.query('select revoke_task_photo_exemption($1)', [exemption.id]));
    assert.equal(await scalar('select status from daily_tasks where id=$1', [photoTask]), 'pending');
    assert.equal(await scalar('select revoked_by from task_evidence_exemptions where id=$1', [exemption.id]), id(2));
  });

  await t.test('Blocked, NA and Skipped tasks submit without photos', async () => {
    await addPhotoTask(id(321));
    const changes = [[photoTask, 'blocked', 'Equipment failed'], [id(320), 'na', ''], [id(321), 'skipped', '']]
      .map(([taskId, status, reason]) => ({ id: taskId, expected_status: 'pending', expected_note: '', expected_reason: '', status, reason }));
    assert.equal((await photoSubmit([], 1, changes)).rows[0].submitted, true);
  });

  await t.test('reset preserves evidence audit and queues files while new tasks snapshot the latest template', async () => {
    await photoReopen();
    await upload(photoTask, id(314));
    await asUser(id(2), () => db.query('update template_tasks set requires_photo=true where id=$1', [id(301)]));
    const snapshotCount = await scalar('select count(*)::int from task_evidence_submissions where checklist_id=$1', [photoChecklist]);
    await asUser(id(2), () => db.query('select * from reset_today_operations($1)', [id(300)]));
    assert.equal(await scalar('select count(*)::int from daily_tasks where id=$1', [photoTask]), 0);
    assert.equal(await scalar('select state from task_evidence where id=$1', [id(314)]), 'delete_pending');
    assert.equal(await scalar('select deletion_reason from task_evidence where id=$1', [id(314)]), 'task_deleted');
    assert.equal(await scalar('select count(*)::int from task_evidence_submissions where checklist_id=$1', [photoChecklist]), snapshotCount);
    const replacement = (await db.query('select * from daily_tasks where checklist_id=$1', [photoChecklist])).rows[0];
    assert.notEqual(replacement.id, photoTask);
    assert.equal(replacement.requires_photo, true);
    await assert.rejects(complete(replacement.id, id(3)), /photo or manager-approved exemption/);
  });

  await t.test('revoked venue access is rechecked before finalisation and reads', async () => {
    await addPhotoTask(id(330));
    const evidence = await reserve(id(330), id(331));
    await asUser(id(3), () => db.query("insert into storage.objects(bucket_id,name,metadata) values ('task-evidence',$1,$2)",
      [evidence.object_path, { size: 1024, mimetype: 'image/jpeg' }]));
    await db.query('delete from venue_members where venue_id=$1 and user_id=$2', [id(300), id(3)]);
    await assert.rejects(finalize(id(331)), /no longer has venue access/);
    assert.equal((await asUser(id(3), () => db.query('select * from task_evidence where id=$1', [id(331)]))).rows.length, 0);
    assert.equal(await asUser(id(3), () => scalar('select can_upload_task_evidence($1)', [evidence.object_path])), false);
    await db.query('insert into venue_members(venue_id,user_id) values ($1,$2)', [id(300), id(3)]);
    await finalize(id(331));
    await db.query('update profiles set active=false where id=$1', [id(3)]);
    await assert.rejects(finalize(id(331)), /no longer has venue access/);
    assert.equal(await asUser(id(3), () => scalar('select can_read_task_evidence($1)', [evidence.object_path])), false);
    await db.query('update profiles set active=true where id=$1', [id(3)]);
  });

  await t.test('cross-organisation managers cannot approve or read evidence', async () => {
    await db.query('insert into auth.users(id,email) values ($1,$2)', [id(7), 'other-manager@example.test']);
    await db.query("insert into organisation_members(organisation_id,user_id,role) values ($1,$2,'manager')", [id(11), id(7)]);
    await assert.rejects(approve(id(330), 'Denied', id(7)), /Only an authorised manager/);
    await assert.rejects(reserve(id(330), id(332), id(7)), /not available/);
    for (const table of ['task_evidence', 'task_evidence_exemptions', 'task_evidence_submissions']) {
      assert.equal((await asUser(id(7), () => db.query(`select * from ${table}`))).rows.length, 0);
    }
    await asUser(id(1), () => db.query('update organisations set photo_retention_days=90 where id=$1', [id(11)]));
    assert.equal(await scalar('select photo_retention_days from organisations where id=$1', [id(11)]), 90);
  });

  await t.test('malformed, mismatched and expired upload reservations never become evidence', async () => {
    const evidence = await reserve(id(330), id(332));
    await asUser(id(3), () => db.query("insert into storage.objects(bucket_id,name,metadata) values ('task-evidence',$1,$2)",
      [evidence.object_path, { size: 100, mimetype: 'image/png' }]));
    await assert.rejects(finalize(id(332)), /private uploaded object/);
    await assert.rejects(asService(() => db.query('select finalize_task_evidence($1,$2,$3,$4,$5)',
      [id(332), id(3), 100, 'image/png', 'invalid-hash'])), /check constraint/);
    assert.equal(await scalar('select state from task_evidence where id=$1', [id(332)]), 'pending');
    await db.query("update task_evidence set upload_deadline=now()-interval '1 hour' where id=$1", [id(332)]);
    await assert.rejects(finalize(id(332)), /no longer active/);
    assert.equal(await asUser(id(3), () => scalar('select can_upload_task_evidence($1)', [evidence.object_path])), false);
    await asService(() => db.query('select queue_expired_task_evidence()'));
    assert.equal(await scalar('select deletion_reason from task_evidence where id=$1', [id(332)]), 'abandoned');
  });

  await t.test('expiry or a missing Storage object blocks direct submission before cleanup runs', async () => {
    const otherChecklist = await scalar("select id from daily_checklists where venue_id=$1 and work_date=$2 and list_type='close'", [id(300), photoDate]);
    await addPhotoTask(id(340), true, otherChecklist);
    const evidence = await upload(id(340), id(341));
    await complete(id(340), id(3));
    await db.query("update task_evidence set uploaded_at=now()-interval '61 days',expires_at=now()-interval '1 day' where id=$1", [id(341)]);
    await assert.rejects(asUser(id(3), () => db.query(
      'update daily_checklists set submitted=true,submitted_by=$2,submitted_at=now() where id=$1', [otherChecklist, id(3)]
    )), /missing its required photo/);
    await db.query('update task_evidence set uploaded_at=$2,expires_at=$3 where id=$1', [id(341), evidence.uploaded_at, evidence.expires_at]);
    await db.query("delete from storage.objects where bucket_id='task-evidence' and name=$1", [evidence.object_path]);
    const revision = await scalar('select notification_revision from daily_checklists where id=$1', [otherChecklist]);
    await assert.rejects(asUser(id(3), () => db.query('select * from submit_daily_checklist($1,$2)', [otherChecklist, revision])), /missing its required photo/);
    assert.equal(await scalar('select submitted from daily_checklists where id=$1', [otherChecklist]), false);
    assert.equal(await scalar('select count(*)::int from task_evidence_submissions where checklist_id=$1', [otherChecklist]), 0);
    await asUser(id(3), () => db.query('select remove_task_evidence($1)', [id(341)]));
    assert.equal(await scalar('select status from daily_tasks where id=$1', [id(340)]), 'pending');
  });

  await t.test('deleting one-off tasks queues both pending and ready photos without losing metadata', async () => {
    await upload(id(330), id(333));
    const pending = await reserve(id(330), id(334));
    await asUser(id(2), () => db.query('delete from daily_tasks where id=$1', [id(330)]));
    const evidence = (await db.query('select * from task_evidence where task_id=$1', [id(330)])).rows;
    assert.equal(evidence.length, 4);
    assert.ok(evidence.every(row => row.state === 'delete_pending'));
    assert.equal(evidence.find(row => row.id === id(334)).object_path, pending.object_path);
    assert.equal(await asUser(id(3), () => scalar('select can_upload_task_evidence($1)', [pending.object_path])), false);
    await assert.rejects(finalize(id(333)), /no longer available/);
  });

  await t.test('deleting a routine template still preserves submitted daily snapshots', async () => {
    const taskId = await scalar('select id from daily_tasks where checklist_id=$1 and template_task_id=$2', [photoChecklist, id(301)]);
    await upload(taskId, id(342));
    await complete(taskId, id(3));
    const revision = await scalar('select notification_revision from daily_checklists where id=$1', [photoChecklist]);
    await photoSubmit([], revision);
    const before = (await db.query('select * from task_evidence_submissions where checklist_id=$1 and notification_revision=$2', [photoChecklist, revision])).rows;
    await asUser(id(2), () => db.query('delete from template_tasks where id=$1', [id(301)]));
    assert.equal(await scalar('select template_task_id from daily_tasks where id=$1', [taskId]), null);
    assert.equal(await scalar('select requires_photo from daily_tasks where id=$1', [taskId]), true);
    assert.equal(await scalar('select status from daily_tasks where id=$1', [taskId]), 'done');
    assert.deepEqual((await db.query('select * from task_evidence_submissions where checklist_id=$1 and notification_revision=$2', [photoChecklist, revision])).rows, before);
  });

  const cleanupChecklist = await scalar("select id from daily_checklists where venue_id=$1 and work_date=$2 and list_type='close'", [id(300), photoDate]);
  await addPhotoTask(id(360), true, cleanupChecklist);
  await reserve(id(360), id(361));
  await upload(id(360), id(362));

  await t.test('upload rejection is service-only, owner-bound and never removes verified evidence', async () => {
    for (const userId of [id(1), id(2), id(3)]) {
      await assert.rejects(asUser(userId, () => db.query('select reject_task_evidence_upload($1,$2)', [id(361), id(3)])), /permission denied/);
      await assert.rejects(asUser(userId, () => db.query('select record_task_evidence_cleanup_failure($1,$2)', [id(361), 'fake'])), /permission denied/);
      await assert.rejects(asUser(userId, () => db.query('select requeue_late_task_evidence_objects()')), /permission denied/);
    }
    await assert.rejects(asService(() => db.query('select reject_task_evidence_upload($1,$2)', [id(361), id(4)])), /owner does not match/);
    await asService(() => db.query('select reject_task_evidence_upload($1,$2)', [id(361), id(3)]));
    assert.equal(await scalar('select state from task_evidence where id=$1', [id(361)]), 'delete_pending');
    assert.equal(await scalar('select deletion_reason from task_evidence where id=$1', [id(361)]), 'abandoned');
    await asService(() => db.query('select reject_task_evidence_upload($1,$2)', [id(362), id(3)]));
    assert.equal(await scalar('select state from task_evidence where id=$1', [id(362)]), 'ready');
  });

  await t.test('cleanup failures back off, preserve queued objects and clear errors only after deletion', async () => {
    await asService(() => db.query('select record_task_evidence_cleanup_failure($1,$2)', [id(361), 'storage_remove_failed']));
    const first = (await db.query('select * from task_evidence where id=$1', [id(361)])).rows[0];
    assert.equal(first.cleanup_attempts, 1);
    assert.equal(first.cleanup_last_error, 'storage_remove_failed');
    assert.equal(first.state, 'delete_pending');
    assert.equal(first.deleted_at, null);
    assert.equal(await scalar('select cleanup_next_attempt_at > clock_timestamp() from task_evidence where id=$1', [id(361)]), true);
    await asService(() => db.query('select record_task_evidence_cleanup_failure($1,$2)', [id(361), 'x'.repeat(500)]));
    assert.equal(await scalar('select length(cleanup_last_error) from task_evidence where id=$1', [id(361)]), 200);
    assert.equal(await scalar('select extract(epoch from cleanup_next_attempt_at-cleanup_last_attempt_at)::int from task_evidence where id=$1', [id(361)]), 60);
    await asService(() => db.query('select confirm_task_evidence_deleted($1)', [id(361)]));
    assert.equal(await scalar('select state from task_evidence where id=$1', [id(361)]), 'deleted');
    assert.equal(await scalar('select cleanup_last_error from task_evidence where id=$1', [id(361)]), null);
    const count = await scalar('select cleanup_attempts from task_evidence where id=$1', [id(361)]);
    await asService(() => db.query('select confirm_task_evidence_deleted($1)', [id(361)]));
    await asService(() => db.query('select record_task_evidence_cleanup_failure($1,$2)', [id(361), 'late failure']));
    assert.equal(await scalar('select cleanup_attempts from task_evidence where id=$1', [id(361)]), count);
    assert.equal(await scalar('select cleanup_last_error from task_evidence where id=$1', [id(361)]), null);
  });

  await t.test('late Storage arrivals requeue only known deleted paths without reviving evidence', async () => {
    const path = await scalar('select object_path from task_evidence where id=$1', [id(361)]);
    await db.query("insert into storage.objects(bucket_id,name,metadata) values ('task-evidence',$1,$2)", [path, { size: 1024, mimetype: 'image/jpeg' }]);
    await db.exec("insert into storage.objects(bucket_id,name) values ('task-evidence','unrelated-admin-file')");
    const snapshots = await scalar('select count(*)::int from task_evidence_submissions');
    assert.equal(await asService(() => scalar('select requeue_late_task_evidence_objects()')), 1);
    assert.equal(await scalar('select state from task_evidence where id=$1', [id(361)]), 'delete_pending');
    assert.equal(await scalar('select deleted_at from task_evidence where id=$1', [id(361)]), null);
    assert.equal(await scalar('select cleanup_last_error from task_evidence where id=$1', [id(361)]), 'late_upload_requeued');
    assert.equal(await asUser(id(3), () => scalar('select can_read_task_evidence($1)', [path])), false);
    assert.equal(await scalar('select state from task_evidence where id=$1', [id(362)]), 'ready');
    assert.equal(await scalar('select count(*)::int from task_evidence_submissions'), snapshots);
    assert.equal(await asService(() => scalar('select requeue_late_task_evidence_objects()')), 0);
    await assert.rejects(asService(() => db.query('select requeue_late_task_evidence_objects($1)', [501])), /between 1 and 500/);
    await assert.rejects(asService(() => db.query('select confirm_task_evidence_deleted($1)', [id(361)])), /Storage API/);
    assert.equal(await scalar("select count(*)::int from storage.objects where name='unrelated-admin-file'"), 1);
  });
});
