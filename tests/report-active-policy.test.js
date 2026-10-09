import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REPORT_TERMINAL_STATUSES, isReportActive,
  findActiveReport, assertNoActiveReport, activeReportConflict,
} from '../src/services/report-active-policy.js';

const closed = ['RESOLVED', 'CANCELLED', 'NO_ACTION', 'DUPLICATE'];
const active = [
  'SUBMITTED', 'PENDING_REVIEW', 'ROUTED_INTERNAL', 'PROCUREMENT',
  'PENDING_ASSIGNMENT', 'ASSIGNED', 'IN_PROGRESS', 'PENDING_PARTS',
  'ON_HOLD', 'COMPLETION_SUBMITTED', 'REWORK_REQUIRED', 'NEEDS_INFORMATION',
];

test('only four human/system terminal statuses release a new submission', () => {
  assert.deepEqual(REPORT_TERMINAL_STATUSES, closed);
  for (const s of closed) assert.equal(isReportActive(s), false, s);
  for (const s of active) assert.equal(isReportActive(s), true, s);
});

test('Agent FAILED on SUBMITTED remains an active report', () => {
  assert.equal(isReportActive('SUBMITTED'), true);
});

test('active-report query is scoped to Reporter and exactly four terminal exclusions', async () => {
  let params;
  let sql;
  const query = async (q, p) => {
    sql = q; params = p;
    return { rows: [{ id: 'own', reportNo: 'RPT-1', status: 'PENDING_REVIEW' }] };
  };
  assert.equal((await findActiveReport(query, 'reporter-a')).id, 'own');
  assert.deepEqual(params, ['reporter-a']);
  assert.match(sql, /WHERE "ReporterId"=\$1/);
  assert.match(sql, /'RESOLVED','CANCELLED','NO_ACTION','DUPLICATE'/);
});

test('attempting a second active report returns actionable HTTP 409', async () => {
  const q = async () => ({ rows: [{ id: 'abc', reportNo: 'RPT-9', status: 'IN_PROGRESS' }] });
  await assert.rejects(assertNoActiveReport(q, 'reporter-a'), (err) => {
    assert.equal(err.status, 409);
    assert.equal(err.code, 'ACTIVE_REPORT_EXISTS');
    assert.equal(err.details.activeReport.id, 'abc');
    assert.match(err.message, /RPT-9/);
    return true;
  });
});

test('Reporter is free to submit when all previous reports are closed', async () => {
  assert.equal(await findActiveReport(async () => ({ rows: [] }), 'reporter-a'), null);
  await assertNoActiveReport(async () => ({ rows: [] }), 'reporter-a');
});

test('response does not disclose any unrelated user data', () => {
  const err = activeReportConflict({ id: 'own', reportNo: 'RPT-10', status: 'SUBMITTED' });
  assert.deepEqual(Object.keys(err.details), ['activeReport']);
});

// Reporter-friendly cancellation presentation is separate from Agent completion.
test('cancelled reports show final reporter cancellation, not pending Agent', async () => {
  const { reportScreening } = await import('../src/services/report-presentation.js');
  const screening = reportScreening({ Status: 'CANCELLED', AgentStatus: 'PROCESSING' });
  assert.equal(screening.code, 'REPORTER_CANCELLED');
  assert.equal(screening.nextAction, 'NONE');
  assert.equal(screening.needsMaintenanceReview, false);
});
