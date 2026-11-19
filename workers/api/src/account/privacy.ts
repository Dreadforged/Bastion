import { schemas } from "@bastion/shared";

interface Row {
  dm_policy: schemas.DmPolicy;
  typing_indicators: number;
}

/** A user's settings, or the defaults if they never changed any. */
export async function getPrivacy(db: D1Database, userId: string): Promise<schemas.PrivacySettings> {
  const row = await db.prepare("SELECT dm_policy, typing_indicators FROM privacy_settings WHERE user_id = ?").bind(userId).first<Row>();
  if (!row) return { ...schemas.DEFAULT_PRIVACY };
  return { dmPolicy: row.dm_policy, typingIndicators: row.typing_indicators === 1 };
}

export async function updatePrivacy(
  db: D1Database,
  userId: string,
  change: schemas.UpdatePrivacyRequest,
  now: number,
): Promise<schemas.PrivacySettings> {
  const current = await getPrivacy(db, userId);
  const next: schemas.PrivacySettings = {
    dmPolicy: change.dmPolicy ?? current.dmPolicy,
    typingIndicators: change.typingIndicators ?? current.typingIndicators,
  };
  await db
    .prepare(
      `INSERT INTO privacy_settings (user_id, dm_policy, typing_indicators, updated_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (user_id) DO UPDATE SET dm_policy = ?2, typing_indicators = ?3, updated_at = ?4`,
    )
    .bind(userId, next.dmPolicy, next.typingIndicators ? 1 : 0, now)
    .run();
  return next;
}
