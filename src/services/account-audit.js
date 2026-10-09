export async function auditAccount(client, userId, action, details = {}) {
  await client.query(
    `INSERT INTO "dbo"."AuditLogs"
       ("ActorUserId","ActorType","Action","EntityType","EntityId","NewData")
     VALUES ($1,'USER',$2,'USER',$1,$3::jsonb)`,
    [userId, action, JSON.stringify(details)],
  );
}
