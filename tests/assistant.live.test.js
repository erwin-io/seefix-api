/**
 * Opt-in live checks (SEEFIX_INTEGRATION_DB=1) after db/migrations/2026-10-16-v2-workflow-assistant.sql. LOCAL DB ONLY.
 * Needs one active user per role. Creates its own reporters, a worker and PENDING_REVIEW reports, and deletes them (and
 * everything hanging off them) at the end. The Agent and seefix-worker are simulated with the SQL claim contract.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const live = process.env.SEEFIX_INTEGRATION_DB === "1";
const ROLES = ["ADMIN", "MAINTENANCE_SUPERVISOR", "MAINTENANCE_STAFF", "PROCUREMENT", "WORKER", "REPORTER"];

test("live: assistant tools, actions, reassessment queue and reminders", { skip: !live && "set SEEFIX_INTEGRATION_DB=1" }, async (t) => {
  const { app } = await import("../src/app.js");
  const { pool, query, withTransaction } = await import("../src/database.js");
  const { signAccessToken } = await import("../src/middleware/auth.js");
  const { createNotification } = await import("../src/services/notifications.js");
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const tag = `assistant-live-${randomUUID().slice(0, 8)}`;
  const createdUsers = [];
  const createdReports = [];
  t.after(async () => {
    server.close();
    try {
      await query(`DELETE FROM "dbo"."MaintenanceReviews" WHERE "ReportId" = ANY($1::uuid[])`, [createdReports]);
      // Notifications of the created users go with them (CASCADE); also remove the ones about the test reports.
      await query(`DELETE FROM "dbo"."OutboxEvents" WHERE "RecipientUserId" = ANY($1::uuid[]) OR "Payload"->>'entityId' = ANY($2::text[])`, [createdUsers, createdReports]);
      await query(`DELETE FROM "dbo"."Notifications" WHERE "EntityId" = ANY($1::uuid[])`, [createdReports]);
      await query(`DELETE FROM "dbo"."AssistantReminders" WHERE "Title" LIKE $1`, [`${tag}%`]);
      await query(`DELETE FROM "dbo"."AssistantDrafts" WHERE "Body" LIKE $1`, [`${tag}%`]);
      await query(`DELETE FROM "dbo"."Reports" WHERE "Id" = ANY($1::uuid[])`, [createdReports]);
      await query(`DELETE FROM "dbo"."AuditLogs" WHERE "EntityId" = ANY($1::uuid[]) OR "Action" LIKE 'ASSISTANT_REMINDER_%'`, [createdReports]);
      await query(`DELETE FROM "dbo"."RateLimitBuckets" WHERE "Key" LIKE 'ai-gen-user:%' OR "Key" LIKE 'assistant-ask-user:%'`);
      await query(`DELETE FROM "dbo"."Users" WHERE "Id" = ANY($1::uuid[])`, [createdUsers]);
    } finally {
      await pool.end();
    }
  });

  const token = (u) => ({ Authorization: `Bearer ${signAccessToken({ id: u.Id, role: u.Role, email: u.Email }, u.CredentialsVersion)}` });
  const users = {};
  for (const role of ROLES) {
    const u = (await query(
      `SELECT u."Id",u."Role",u."Email",u."CredentialsVersion" FROM "dbo"."Users" u WHERE u."IsActive" AND u."Role"=$1
        ORDER BY EXISTS(SELECT 1 FROM "dbo"."WorkOrders" w WHERE w."ResponsibleLeadUserId"=u."Id") DESC, u."Id" LIMIT 1`, [role])).rows[0];
    assert.ok(u, `needs an active ${role}`);
    users[role] = { id: u.Id, headers: token(u) };
  }
  const newUser = async (role) => {
    const u = (await query(
      `INSERT INTO "dbo"."Users" ("FullName","Email","PasswordHash","Role") VALUES ($1,$2,'x',$3) RETURNING "Id","Role","Email","CredentialsVersion"`,
      [`${tag} ${role}`, `${tag}-${randomUUID().slice(0, 6)}@test.invalid`, role])).rows[0];
    createdUsers.push(u.Id);
    return { id: u.Id, row: u, headers: token(u) };
  };
  // A report waiting for Maintenance Review: the Agent completion trigger advances SUBMITTED → PENDING_REVIEW.
  const pendingReviewReport = async () => {
    const reporter = await newUser("REPORTER");
    const id = await withTransaction(null, async (c) => {
      const r = await c.query(
        `INSERT INTO "dbo"."Reports" ("ReporterId","Description","Building") VALUES ($1,$2,'Live Test Hall') RETURNING "Id"`,
        [reporter.id, `${tag} leaking pipe`]);
      await c.query(`INSERT INTO "dbo"."ReportImages" ("ReportId","PublicId","SecureUrl","IsPrimary") VALUES ($1,'test/x','https://example.invalid/x.jpg',TRUE)`, [r.rows[0].Id]);
      await c.query(
        `UPDATE "dbo"."Reports" SET "AgentStatus"='COMPLETED',"AgentAttemptCount"=1,"ScopeDecision"='Facility Issue',"ScopeShouldAnalyze"=TRUE,
                "AiCategory"='Plumbing',"AiRecommendedUrgency"='High' WHERE "Id"=$1`, [r.rows[0].Id]);
      return r.rows[0].Id;
    });
    createdReports.push(id);
    const status = (await query(`SELECT "Status" FROM "dbo"."Reports" WHERE "Id"=$1`, [id])).rows[0].Status;
    assert.equal(status, "PENDING_REVIEW");
    return id;
  };

  const call = async (who, method, path, body) => {
    const r = await fetch(base + path, {
      method, headers: { ...who.headers, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: r.headers.get("content-type")?.includes("json") ? await r.json() : null, headers: r.headers };
  };
  const get = (role, path) => call(users[role], "GET", path);
  const sql = async (text, params = []) => (await query(text, params)).rows;
  // Fingerprint of every human-decision table: a prohibited or draft action must leave it unchanged.
  const workflowFingerprint = async () => (await sql(`
    SELECT md5(string_agg(x, '|' ORDER BY x)) f FROM (
      SELECT 'R' || "Id" || "Status" || "AgentStatus" || coalesce("AiCategory",'') AS x FROM "dbo"."Reports"
      UNION ALL SELECT 'V' || "Id" || "Status" || coalesce("Decision",'') FROM "dbo"."MaintenanceReviews"
      UNION ALL SELECT 'M' || "Id" || "Status" FROM "dbo"."MaintenanceRequests"
      UNION ALL SELECT 'W' || "Id" || "Status" || coalesce("ResponsibleLeadUserId"::text,'') FROM "dbo"."WorkOrders"
      UNION ALL SELECT 'P' || "Id" || "Status" FROM "dbo"."ProcurementHandoffs"
      UNION ALL SELECT 'O' || "Id" FROM "dbo"."ProcurementOutcomes") s`))[0].f;

  await t.test("RBAC: five internal roles, REPORTER 403; no-store", async () => {
    for (const path of ["/api/assistant/tools", "/api/assistant/tools/summary", "/api/assistant/tools/action-queue", "/api/assistant/tools/trends", "/api/assistant/tools/navigation", "/api/assistant/reminders"]) {
      const got = [];
      for (const role of ROLES) got.push((await get(role, path)).status);
      assert.deepEqual(got, [200, 200, 200, 200, 200, 403], path);
    }
    assert.equal((await get("ADMIN", "/api/assistant/tools")).headers.get("cache-control"), "no-store");
    assert.equal((await get("ADMIN", "/api/assistant/tools/trends?days=500")).status, 400);
    const trends = (await get("WORKER", "/api/assistant/tools/trends?days=7")).body;
    assert.deepEqual(Object.keys(trends.series), ["myWorkOrdersAssigned", "myWorkOrdersCompleted"]);
    assert.equal(trends.series.myWorkOrdersAssigned.length, 7);
  });

  await t.test("record tools give exactly the detail route's answer for every role", async () => {
    const reportIds = (await sql(`SELECT "Id" FROM "dbo"."Reports" ORDER BY "CreatedAt" DESC LIMIT 8`)).map((r) => r.Id);
    const woIds = (await sql(`SELECT "Id" FROM "dbo"."WorkOrders" ORDER BY "CreatedAt" DESC LIMIT 6`)).map((r) => r.Id);
    const handoffIds = (await sql(`SELECT "Id" FROM "dbo"."ProcurementHandoffs" LIMIT 3`)).map((r) => r.Id);
    const cases = [
      ...reportIds.map((id) => ["report", id, `/api/reports/${id}`]),
      ...woIds.map((id) => ["work_order", id, `/api/work-orders/${id}`]),
      ...handoffIds.map((id) => ["handoff", id, `/api/procurement/handoffs/${id}`]),
      ["report", randomUUID(), null],
    ];
    let denied = 0;
    for (const role of ROLES.slice(0, 5)) {
      for (const [type, id, detail] of cases) {
        const tool = await get(role, `/api/assistant/tools/records/${type}/${id}`);
        const expected = detail ? (await get(role, detail)).status : 404;
        assert.equal(tool.status, expected, `${role} ${type} ${id}`);
        if (tool.status === 200) {
          const text = JSON.stringify(tool.body.fact);
          assert.ok(!/@|secureUrl|Email|Phone|ReporterName/i.test(text), "no PII in facts");
        } else denied += 1;
      }
    }
    assert.ok(denied > 0, "some records are denied (worker/procurement scope)");
    assert.equal((await get("ADMIN", "/api/assistant/tools/records/users/" + users.ADMIN.id)).status, 400);
    const own = new Set((await sql(`SELECT "Id" FROM "dbo"."WorkOrders" WHERE "ResponsibleLeadUserId"=$1`, [users.WORKER.id])).map((r) => r.Id));
    for (const item of (await get("WORKER", "/api/assistant/tools/action-queue?limit=50")).body.items) assert.ok(own.has(item.entityId));
  });

  await t.test("prohibited actions: 403 for every role, nothing written", async () => {
    const before = await workflowFingerprint();
    const wo = (await sql(`SELECT "Id" FROM "dbo"."WorkOrders" LIMIT 1`))[0]?.Id ?? randomUUID();
    for (const role of ROLES.slice(0, 5)) {
      for (const action of ["complete_work_order", "rework_work_order", "create_work_order", "authorize_work_order", "approve_routing", "review_report", "record_procurement_outcome"]) {
        const r = await call(users[role], "POST", "/api/assistant/actions", { action, params: { workOrderId: wo, decision: "INTERNAL" }, confirm: true, idempotencyKey: randomUUID() });
        assert.equal(r.status, 403, `${role} ${action}`);
        assert.equal(r.body.error.code, "ASSISTANT_ACTION_PROHIBITED");
      }
    }
    assert.equal((await call(users.ADMIN, "POST", "/api/assistant/actions", { action: "run_sql", params: { sql: "DELETE FROM x" }, confirm: true })).status, 400);
    assert.equal((await call(users.REPORTER, "POST", "/api/assistant/actions", { action: "create_reminder", confirm: true })).status, 403);
    assert.equal(await workflowFingerprint(), before, "workflow tables unchanged");
  });

  const R1 = await pendingReviewReport();
  const R2 = await pendingReviewReport();
  const sup = users.MAINTENANCE_SUPERVISOR;
  const reassess = (who, reportId, key = randomUUID(), extra = {}) =>
    call(who, "POST", "/api/assistant/reassessments", { reportId, reason: `${tag} recheck`, idempotencyKey: key, confirm: true, ...extra });
  const job = async (id) => (await sql(`SELECT * FROM "dbo"."AssessmentRegenerationJobs" WHERE "Id"=$1`, [id]))[0];
  const claim = async () => (await sql(`SELECT * FROM "dbo"."ClaimNextAssessmentRegeneration"('live-agent')`))[0];
  const finish = async (id, attempt, ok = true) => (await sql(`SELECT "dbo"."FinishAssessmentRegeneration"($1,$2,$3,$4) AS ok`, [id, attempt, ok, ok ? null : "model down"]))[0].ok;

  await t.test("reassessment: confirmation, roles, concurrency, replay", async () => {
    const preview = await call(sup, "POST", "/api/assistant/reassessments", { reportId: R1, reason: "x y z" });
    assert.equal(preview.body.status, "CONFIRMATION_REQUIRED");
    assert.equal((await sql(`SELECT 1 FROM "dbo"."AssessmentRegenerationJobs" WHERE "ReportId"=$1`, [R1])).length, 0, "preview writes nothing");
    for (const role of ["WORKER", "PROCUREMENT", "REPORTER"]) assert.equal((await reassess(users[role], R1)).status, 403, role);
    assert.equal((await reassess(sup, randomUUID())).status, 404);

    const results = await Promise.all(Array.from({ length: 10 }, () => reassess(sup, R1)));
    const codes = results.map((r) => r.status).sort();
    assert.deepEqual(codes, [201, ...Array(9).fill(409)], "exactly one job from 10 concurrent requests");
    assert.ok(results.filter((r) => r.status === 409).every((r) => r.body.error.code === "REASSESSMENT_IN_PROGRESS"));
    const first = results.find((r) => r.status === 201).body.job;

    const key = randomUUID();
    const a = await reassess(users.MAINTENANCE_STAFF, R2, key);
    const [b, c] = await Promise.all([reassess(users.MAINTENANCE_STAFF, R2, key), reassess(users.MAINTENANCE_STAFF, R2, key)]);
    assert.equal(a.status, 201);
    assert.deepEqual([b.status, c.status], [200, 200], "replays return the original");
    assert.equal(b.body.job.id, a.body.job.id);
    assert.equal((await reassess(users.MAINTENANCE_STAFF, R1, key)).body.error.code, "IDEMPOTENCY_KEY_REUSED");
    assert.equal((await call(users.MAINTENANCE_STAFF, "POST", `/api/assistant/reassessments/${a.body.job.id}/cancel`, {})).body.status, "CONFIRMATION_REQUIRED");
    assert.equal((await call(users.MAINTENANCE_STAFF, "POST", `/api/assistant/reassessments/${a.body.job.id}/cancel`, { confirm: true })).status, 200);
    assert.ok(first.id);
  });

  await t.test("reassessment: Agent claim, stale requeue, late attempt fenced, cancel never revived", async () => {
    const claimed = await claim();
    assert.equal(claimed.ReportId, R1, "R2's job was cancelled, so only R1's is claimable");
    assert.equal(claimed.Attempt, 1);
    assert.equal(await claim(), undefined, "nothing else to claim");
    // The Agent dies: its claim goes stale and is requeued; a second Agent claims attempt 2.
    await query(`UPDATE "dbo"."AssessmentRegenerationJobs" SET "ClaimedAt"=now()-interval '1 hour' WHERE "Id"=$1`, [claimed.JobId]);
    assert.equal((await sql(`SELECT "dbo"."RequeueStaleAssessmentRegenerations"(30) n`))[0].n, 1);
    const second = await claim();
    assert.equal(second.Attempt, 2);
    assert.equal(await finish(claimed.JobId, 1), false, "late result of attempt 1 is discarded");
    assert.equal(await finish(second.JobId, 2), true, "current attempt may write");
    assert.equal((await job(second.JobId)).Status, "COMPLETED");
    assert.equal(await finish(second.JobId, 2), false, "a finished job can't be finished twice");

    const again = await reassess(sup, R1);
    assert.equal(again.status, 201, "a new request after completion is allowed");
    const cancelled = await call(sup, "POST", `/api/assistant/reassessments/${again.body.job.id}/cancel`, { confirm: true });
    assert.equal(cancelled.body.job.status, "CANCELLED");
    assert.equal(await claim(), undefined, "a cancelled job is never claimed");
    assert.equal((await sql(`SELECT "dbo"."RequeueStaleAssessmentRegenerations"(0) n`))[0].n, 0);
    assert.equal((await job(again.body.job.id)).Status, "CANCELLED", "and never revived");
    assert.equal((await call(sup, "POST", `/api/assistant/reassessments/${again.body.job.id}/cancel`, { confirm: true })).status, 200, "cancel is idempotent");
    assert.equal((await call(sup, "POST", `/api/assistant/reassessments/${second.JobId}/cancel`, { confirm: true })).body.error.code, "REASSESSMENT_FINISHED");

    // Cancel while the Agent is running: its finish is refused.
    const third = await reassess(sup, R1);
    const running = await claim();
    await call(sup, "POST", `/api/assistant/reassessments/${third.body.job.id}/cancel`, { confirm: true });
    assert.equal(await finish(running.JobId, running.Attempt), false);

    const history = (await get("MAINTENANCE_STAFF", `/api/assistant/reassessments?reportId=${R1}`)).body;
    assert.ok(history.jobs.length >= 3);
    assert.equal((await get("WORKER", `/api/assistant/reassessments?reportId=${R1}`)).status, 403);
    assert.ok((await sql(`SELECT 1 FROM "dbo"."AuditLogs" WHERE "Action"='ASSESSMENT_REGENERATION_REQUESTED' AND "EntityId"=$1`, [R1])).length >= 3);
  });

  await t.test("reassessment: a human decision supersedes the job and blocks new ones", async () => {
    const queued = await reassess(sup, R1);
    const running = await claim();
    assert.equal(running.JobId, queued.body.job.id);
    const review = await call(sup, "POST", `/api/maintenance/reports/${R1}/review`, { decision: "NO_ACTION", decisionReason: `${tag} not a defect` });
    assert.equal(review.status, 200, JSON.stringify(review.body));
    assert.equal((await job(running.JobId)).Status, "SUPERSEDED", "review supersedes the running job");
    assert.equal(await finish(running.JobId, running.Attempt), false, "late Agent result can't overwrite the human decision");
    assert.equal((await sql(`SELECT "Status" FROM "dbo"."Reports" WHERE "Id"=$1`, [R1]))[0].Status, "NO_ACTION");
    assert.equal((await reassess(sup, R1)).body.error.code, "REPORT_NOT_REASSESSABLE");

    // A review recorded (not yet completed) on R2 counts as a human decision too.
    await query(`INSERT INTO "dbo"."MaintenanceReviews" ("ReportId","Status") VALUES ($1,'PENDING')`, [R2]);
    assert.equal((await reassess(sup, R2)).body.error.code, "HUMAN_DECISION_EXISTS");
    await query(`DELETE FROM "dbo"."MaintenanceReviews" WHERE "ReportId"=$1`, [R2]);

    // History limit.
    const R3 = await pendingReviewReport();
    await query(
      `INSERT INTO "dbo"."AssessmentRegenerationJobs" ("ReportId","RequestedBy","Reason","IdempotencyKey","BaseAgentAttempt","Status")
       SELECT $1,$2,'old job',gen_random_uuid(),1,'CANCELLED' FROM generate_series(1,5)`, [R3, sup.id]);
    assert.equal((await reassess(sup, R3)).body.error.code, "REASSESSMENT_LIMIT_REACHED");
  });

  const worker2 = await newUser("WORKER");
  const remind = (who, body, key = randomUUID()) =>
    call(who, "POST", "/api/assistant/reminders", { title: `${tag} check`, timeZone: "Asia/Manila", dueAt: "2026-12-01T09:00", idempotencyKey: key, confirm: true, ...body });

  await t.test("reminders: recipient policy and record-leak checks", async () => {
    assert.equal((await remind(users.WORKER, {})).status, 201, "self");
    assert.equal((await remind(users.WORKER, { recipientUserId: worker2.id })).body.error.code, "REMINDER_RECIPIENT_FORBIDDEN");
    assert.equal((await remind(users.MAINTENANCE_STAFF, { recipientUserId: worker2.id })).status, 403);
    assert.equal((await remind(sup, { recipientUserId: worker2.id })).status, 201, "supervisor → worker");
    assert.equal((await remind(sup, { recipientUserId: users.ADMIN.id })).status, 403, "supervisor → admin");
    assert.equal((await remind(users.ADMIN, { recipientUserId: users.PROCUREMENT.id })).status, 201, "admin → procurement");
    assert.equal((await remind(users.ADMIN, { recipientUserId: users.REPORTER.id })).status, 403, "never a reporter");
    assert.equal((await remind(users.ADMIN, { recipientUserId: randomUUID() })).status, 403, "unknown user looks the same");
    // Entity must be readable by creator AND recipient.
    assert.equal((await remind(sup, { recipientUserId: worker2.id, entity: { type: "report", id: R2 } })).body.error.code, "REMINDER_ENTITY_FORBIDDEN");
    assert.equal((await remind(sup, { entity: { type: "report", id: R2 } })).status, 201);
    const foreignWo = (await sql(`SELECT "Id" FROM "dbo"."WorkOrders" WHERE "ResponsibleLeadUserId" IS DISTINCT FROM $1 LIMIT 1`, [users.WORKER.id]))[0];
    if (foreignWo) assert.equal((await remind(users.WORKER, { entity: { type: "work_order", id: foreignWo.Id } })).status, 403);
    assert.ok((await sql(`SELECT 1 FROM "dbo"."AuditLogs" WHERE "Action"='ASSISTANT_REMINDER_CREATED' AND "ActorUserId"=$1`, [sup.id])).length >= 2);
  });

  await t.test("reminders: time zones stored as UTC; validation", async () => {
    const due = async (dueAt, timeZone) => {
      const r = await remind(users.ADMIN, { dueAt, timeZone });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      return new Date(r.body.reminder.dueAt).toISOString();
    };
    assert.equal(await due("2026-11-10T09:00", "Asia/Manila"), "2026-11-10T01:00:00.000Z");
    assert.equal(await due("2026-12-01T08:00:00+08:00", "America/New_York"), "2026-12-01T00:00:00.000Z", "an instant keeps its offset");
    assert.equal(await due("2027-03-14T02:30", "America/New_York"), "2027-03-14T07:30:00.000Z", "DST gap → 03:30 EDT");
    assert.equal(await due("2026-11-01T01:30", "America/New_York"), "2026-11-01T06:30:00.000Z", "ambiguous → the later, standard-time occurrence (EST)");
    for (const [dueAt, timeZone, code] of [
      ["2026-12-01T09:00", "Mars/Olympus", "INVALID_TIME_ZONE"], ["2020-01-01T09:00", "UTC", "INVALID_DUE_AT"],
      ["2026-02-30T09:00", "UTC", "INVALID_DUE_AT"], ["tomorrow", "UTC", "INVALID_DUE_AT"], ["2030-01-01T09:00", "UTC", "INVALID_DUE_AT"],
    ]) {
      const r = await remind(users.ADMIN, { dueAt, timeZone });
      assert.equal(r.status, 400, dueAt);
      assert.equal(r.body.error.code, code, dueAt);
    }
  });

  await t.test("reminders: replay/idempotency, cancel rules", async () => {
    const key = randomUUID();
    const all = await Promise.all(Array.from({ length: 5 }, () => remind(users.MAINTENANCE_STAFF, {}, key)));
    assert.deepEqual(all.map((r) => r.status).sort(), [200, 200, 200, 200, 201]);
    assert.equal(new Set(all.map((r) => r.body.reminder.id)).size, 1);
    const id = all[0].body.reminder.id;
    assert.equal((await call(users.WORKER, "POST", `/api/assistant/reminders/${id}/cancel`, { confirm: true })).status, 404, "a stranger can't see it");
    assert.equal((await call(users.MAINTENANCE_STAFF, "POST", `/api/assistant/reminders/${id}/cancel`, { confirm: true })).body.reminder.status, "CANCELLED");
    assert.equal((await call(users.MAINTENANCE_STAFF, "POST", `/api/assistant/reminders/${id}/cancel`, { confirm: true })).status, 200);
    const received = (await get("ADMIN", "/api/assistant/reminders?scope=created&page=1&pageSize=2")).body;
    assert.equal(received.items.length, 2);
    assert.equal(received.hasMore, true);
  });

  await t.test("reminders: Worker claim contract, outage recovery, retry/backoff, delivery fence", async () => {
    const r = await remind(sup, { recipientUserId: worker2.id });
    const id = r.body.reminder.id;
    await query(`UPDATE "dbo"."AssistantReminders" SET "NextRunAt"=now()-interval '1 second' WHERE "Id"=$1`, [id]);
    const claimDue = async () => (await sql(`SELECT * FROM "dbo"."ClaimDueAssistantReminders"('live-worker', 50, 60)`)).filter((x) => x.Id === id);
    const finishRem = (attempt, ok, notificationId = null, c = { query }) =>
      c.query(`SELECT "dbo"."FinishAssistantReminder"($1,$2,$3,$4,$5) AS ok`, [id, attempt, ok, ok ? null : "pusher down", notificationId]).then((x) => x.rows[0].ok);

    const [first] = await claimDue();
    assert.equal(first.Attempts, 1);
    assert.deepEqual(await claimDue(), [], "a live lease is not re-claimed");
    // Worker outage: the lease expires and another Worker takes over.
    await query(`UPDATE "dbo"."AssistantReminders" SET "ClaimedAt"=now()-interval '5 minutes' WHERE "Id"=$1`, [id]);
    const [second] = await claimDue();
    assert.equal(second.Attempts, 2);
    assert.equal(await finishRem(1, true), false, "the dead Worker's late finish is refused");
    assert.equal(await finishRem(2, false), true, "failure recorded");
    const backoff = (await sql(`SELECT "Status", "NextRunAt" - now() AS wait FROM "dbo"."AssistantReminders" WHERE "Id"=$1`, [id]))[0];
    assert.equal(backoff.Status, "SCHEDULED");
    assert.ok(backoff.wait.minutes >= 3, "backs off 2^attempts minutes");
    assert.deepEqual(await claimDue(), [], "not due during backoff");

    await query(`UPDATE "dbo"."AssistantReminders" SET "NextRunAt"=now() WHERE "Id"=$1`, [id]);
    const [third] = await claimDue();
    // Delivery: notification + outbox + finish in ONE transaction, exactly as seefix-worker#3 will do it.
    await withTransaction(null, async (c) => {
      const n = await createNotification(c, {
        userId: third.RecipientUserId, type: "ASSISTANT_REMINDER", title: third.Title, message: third.Message ?? third.Title,
        entityType: third.EntityType, entityId: third.EntityId, deduplicationKey: `assistant-reminder:${third.Id}`,
      });
      assert.equal(await finishRem(third.Attempts, true, n.id, c), true);
    });
    const sent = (await sql(`SELECT * FROM "dbo"."AssistantReminders" WHERE "Id"=$1`, [id]))[0];
    assert.equal(sent.Status, "SENT");
    assert.equal((await sql(`SELECT 1 FROM "dbo"."Notifications" WHERE "Id"=$1 AND "UserId"=$2`, [sent.NotificationId, worker2.id])).length, 1, "only the recipient is notified");
    assert.equal((await sql(`SELECT 1 FROM "dbo"."OutboxEvents" WHERE "AggregateId"=$1`, [sent.NotificationId])).length, 1, "realtime outbox row");
    assert.equal((await call(sup, "POST", `/api/assistant/reminders/${id}/cancel`, { confirm: true })).body.error.code, "REMINDER_ALREADY_SENT");

    // Cancelled while PROCESSING → the Worker's finish is refused.
    const r2 = await remind(users.ADMIN, {});
    await query(`UPDATE "dbo"."AssistantReminders" SET "NextRunAt"=now() WHERE "Id"=$1`, [r2.body.reminder.id]);
    const claimed = (await sql(`SELECT * FROM "dbo"."ClaimDueAssistantReminders"('w', 50, 60)`)).find((x) => x.Id === r2.body.reminder.id);
    await call(users.ADMIN, "POST", `/api/assistant/reminders/${r2.body.reminder.id}/cancel`, { confirm: true });
    assert.equal((await sql(`SELECT "dbo"."FinishAssistantReminder"($1,$2,TRUE,NULL,NULL) ok`, [claimed.Id, claimed.Attempts]))[0].ok, false);

    // A deactivated recipient is never notified.
    const r3 = await remind(sup, { recipientUserId: worker2.id });
    await query(`UPDATE "dbo"."Users" SET "IsActive"=FALSE WHERE "Id"=$1`, [worker2.id]);
    await query(`UPDATE "dbo"."AssistantReminders" SET "NextRunAt"=now() WHERE "Id"=$1`, [r3.body.reminder.id]);
    assert.ok(!(await sql(`SELECT * FROM "dbo"."ClaimDueAssistantReminders"('w', 50, 60)`)).some((x) => x.Id === r3.body.reminder.id));
    const gone = (await sql(`SELECT "Status","LastError" FROM "dbo"."AssistantReminders" WHERE "Id"=$1`, [r3.body.reminder.id]))[0];
    assert.deepEqual([gone.Status, gone.LastError], ["CANCELLED", "RECIPIENT_INACTIVE"]);
  });

  await t.test("drafts are private and never touch the workflow", async () => {
    const before = await workflowFingerprint();
    const save = (who, kind, entityId, key = randomUUID()) =>
      call(who, "POST", "/api/assistant/drafts", { kind, entityId, body: `${tag} suggested note`, idempotencyKey: key, confirm: true });
    assert.equal((await save(users.WORKER, "REVIEW_NOTE", R2)).body.error.code, "DRAFT_KIND_FORBIDDEN");
    const d = await save(users.MAINTENANCE_STAFF, "REVIEW_NOTE", R2);
    assert.equal(d.status, 201);
    assert.equal(await workflowFingerprint(), before, "a draft writes no workflow row");
    assert.ok((await get("MAINTENANCE_STAFF", `/api/assistant/drafts?entityId=${R2}`)).body.items.some((x) => x.id === d.body.draft.id));
    assert.equal((await get("ADMIN", `/api/assistant/drafts?entityId=${R2}`)).body.items.length, 0, "private to the author");
    assert.equal((await call(users.ADMIN, "POST", `/api/assistant/drafts/${d.body.draft.id}/discard`, { confirm: true })).status, 404);
  });

  await t.test("ask: facts are role-scoped; Agent down → safe 200 fallback; foreign context → 403", async () => {
    const r = await call(users.WORKER, "POST", "/api/assistant/ask", { question: "What should I do first?" });
    assert.equal(r.status, 200);
    assert.ok(["ANSWERED", "NO_FACTS", "FALLBACK"].includes(r.body.status));
    const own = new Set((await sql(`SELECT "Id" FROM "dbo"."WorkOrders" WHERE "ResponsibleLeadUserId"=$1`, [users.WORKER.id])).map((x) => `/work-orders/${x.Id}`));
    for (const n of r.body.navigation) assert.ok(n.path === "/dashboard" || own.has(n.path), n.path);
    assert.equal((await call(users.WORKER, "POST", "/api/assistant/ask", { question: "details?", context: { type: "report", id: R2 } })).status, 403);
    assert.equal((await call(users.WORKER, "POST", "/api/assistant/ask", { question: "" })).status, 400);
  });

  await t.test("a session revoked by a credentials change (password/OTP flow) loses the assistant", async () => {
    const w = await newUser("WORKER");
    assert.equal((await call(w, "GET", "/api/assistant/tools")).status, 200);
    await query(`UPDATE "dbo"."Users" SET "CredentialsVersion"="CredentialsVersion"+1 WHERE "Id"=$1`, [w.id]);
    const r = await call(w, "GET", "/api/assistant/tools");
    assert.equal(r.status, 401);
    assert.equal(r.body.error.code, "SESSION_REVOKED");
  });
});
