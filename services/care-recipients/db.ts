import { mkdirSync } from 'fs';
import { createRequire } from 'module';
import { createHash, randomBytes, randomUUID } from 'crypto';
import path from 'path';
import { logger } from '../../shared/logger.ts';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

export interface CareRecipientRecord {
  id: string;
  name: string;
  age: number | null;
  medications: string[];
  primary_doctor: string | null;
  insurance: string | null;
}

/** Backward-compatibility alias for CareRecipientRecord (Issue #1067) */
export type CareRecipientEntity = CareRecipientRecord;

interface CareRecipientRow {
  id: string;
  name: string;
  age: number | null;
  medications: string;
  primary_doctor: string | null;
  insurance: string | null;
}

export type CaregiverLinkStatus = 'active' | 'invited';

/** A caregiver linked to a recipient. Invite and access token hashes are never exposed. */
export interface RecipientCaregiver {
  recipient_id: string;
  caregiver_user_id: string;
  email: string | null;
  display_name: string | null;
  role: CaregiverRole;
  status: CaregiverLinkStatus;
  invited_by: string | null;
  created_at: string;
  accepted_at: string | null;
  invite_expires_at: string | null;
}

const CAREGIVER_COLUMNS =
  'recipient_id, caregiver_user_id, email, display_name, role, status, invited_by, created_at, accepted_at, invite_expires_at';

export interface HandoffNote {
  id: string;
  recipient_id: string;
  author: string;
  text: string;
  created_at: string;
}

export type HandoffNoteInput = Omit<HandoffNote, 'id' | 'created_at'>;

export type CaregiverAccessErrorCode =
  | 'recipient_not_found'
  | 'already_linked'
  | 'invite_invalid'
  | 'invite_expired'
  | 'last_owner';

export class CaregiverAccessError extends Error {
  constructor(
    readonly code: CaregiverAccessErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CaregiverAccessError';
  }
}

/** Invite codes and access tokens: 256 bits from the CSPRNG. */
function generateSecret(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Secrets are persisted only as SHA-256 digests. A fast hash is sufficient
 * because the inputs are 256-bit random values, not user-chosen passwords.
 */
function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Temporary approval delegation (#1195): `delegator` (the primary caregiver)
 * lets `delegate` (a co-caregiver) approve/deny pending transactions for one
 * recipient between `starts_at` and `ends_at`. A delegation is active only
 * inside that window and while `revoked_at` is null, so it expires on its own
 * at `ends_at` with no background job.
 */
export interface ApprovalDelegation {
  id: string;
  recipient_id: string;
  delegator: string;
  delegate: string;
  starts_at: string;
  ends_at: string;
  revoked_at: string | null;
  created_at: string;
}

export type DelegationStatus = 'scheduled' | 'active' | 'expired' | 'revoked';

export function delegationStatus(d: ApprovalDelegation, now: Date = new Date()): DelegationStatus {
  if (d.revoked_at) return 'revoked';
  const t = now.getTime();
  if (t < Date.parse(d.starts_at)) return 'scheduled';
  if (t >= Date.parse(d.ends_at)) return 'expired';
  return 'active';
}

function defaultDbPath(): string {
  if (process.env.CARE_RECIPIENTS_DB_PATH) {
    return path.resolve(process.cwd(), process.env.CARE_RECIPIENTS_DB_PATH);
  }
  if (process.env.NODE_ENV === 'test') {
    return ':memory:';
  }
  return new URL('../../data/careguard.sqlite', import.meta.url).pathname;
}

function rowToRecipient(row: CareRecipientRow): CareRecipientEntity {
  let medications: string[] = [];
  try {
    medications = JSON.parse(row.medications);
  } catch {
    medications = [];
  }
  return {
    id: row.id,
    name: row.name,
    age: row.age ?? null,
    medications,
    primary_doctor: row.primary_doctor ?? null,
    insurance: row.insurance ?? null,
  };
}

export class CareRecipientsStore {
  private readonly db: any;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath ?? defaultDbPath();
    if (resolvedPath !== ':memory:') {
      mkdirSync(path.dirname(resolvedPath), { recursive: true });
    }
    this.db = new DatabaseSync(resolvedPath);
    this.db.exec('PRAGMA foreign_keys = ON');
    this.migrate();
    this.seedIfEmpty();
  }

  /**
   * Runs fn atomically. BEGIN IMMEDIATE takes the write lock up front so a
   * read-then-write sequence cannot interleave with another connection to
   * the same file (e.g. the vitals store).
   */
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private migrate(): void {
    const roles = CAREGIVER_ROLES.map((role) => `'${role}'`).join(', ');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS care_recipients (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        age INTEGER,
        medications TEXT NOT NULL DEFAULT '[]',
        primary_doctor TEXT,
        insurance TEXT
      );
      CREATE TABLE IF NOT EXISTS approval_delegations (
        id TEXT PRIMARY KEY,
        recipient_id TEXT NOT NULL,
        delegator TEXT NOT NULL,
        delegate TEXT NOT NULL,
        starts_at TEXT NOT NULL,
        ends_at TEXT NOT NULL,
        revoked_at TEXT,
        created_at TEXT NOT NULL,
        CHECK (delegator <> delegate),
        CHECK (ends_at > starts_at)
      );
      CREATE INDEX IF NOT EXISTS idx_approval_delegations_lookup
        ON approval_delegations (recipient_id, delegate, ends_at);
    `);
    this.migrateLegacyCaregiverColumn();
  }

  /**
   * Migration path (#1179): databases created before the join table stored a
   * single care_recipients.caregiver_user_id. Each non-empty value becomes an
   * active 'owner' link, then the column is dropped. Runs at most once (the
   * column no longer exists afterwards) and is atomic.
   */
  private migrateLegacyCaregiverColumn(): void {
    const columns = this.db.prepare('PRAGMA table_info(care_recipients)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'caregiver_user_id')) return;

    const migratedAt = new Date().toISOString();
    this.transaction(() => {
      const result = this.db.prepare(`
        INSERT OR IGNORE INTO care_recipient_caregivers
          (recipient_id, caregiver_user_id, role, status, created_at, accepted_at)
        SELECT id, caregiver_user_id, 'owner', 'active', ?, ?
        FROM care_recipients
        WHERE caregiver_user_id IS NOT NULL AND caregiver_user_id <> ''
      `).run(migratedAt, migratedAt);
      this.db.exec('ALTER TABLE care_recipients DROP COLUMN caregiver_user_id');
      logger.info(
        { migratedOwners: Number(result.changes) },
        '[care-recipients] migrated caregiver_user_id into care_recipient_caregivers',
      );
    });
  }

  private seedIfEmpty(): void {
    const row = this.db
      .prepare('SELECT COUNT(*) AS count FROM care_recipients')
      .get() as { count: number };
    if (row.count > 0) return;

    this.db.prepare(`
      INSERT INTO care_recipients (id, name, age, medications, primary_doctor, insurance)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      DEFAULT_RECIPIENT_ID,
      'Rosa Garcia',
      78,
      JSON.stringify(['Lisinopril', 'Metformin', 'Atorvastatin', 'Amlodipine']),
      'Dr. Chen, General Hospital',
      'Medicare Part D',
    );
    logger.info('[care-recipients] seeded default recipient Rosa Garcia');
  }

  list(): CareRecipientEntity[] {
    const rows = this.db
      .prepare('SELECT * FROM care_recipients ORDER BY name ASC')
      .all() as CareRecipientRow[];
    return rows.map(rowToRecipient);
  }

  getById(id: string): CareRecipientEntity | undefined {
    const row = this.db
      .prepare('SELECT * FROM care_recipients WHERE id = ?')
      .get(id) as CareRecipientRow | undefined;
    return row ? rowToRecipient(row) : undefined;
  }

  create(input: CareRecipientInput): CareRecipientEntity {
    // Date.now() alone collides under concurrent creates of the same name within
    // the same millisecond (duplicate PRIMARY KEY -> insert throws); a short
    // random suffix keeps ids readable while guaranteeing uniqueness.
    const base = input.name.toLowerCase().replace(/\s+/g, '_');
    const id = `${base}_${Date.now()}_${randomUUID().slice(0, 8)}`;
    this.db.prepare(`
      INSERT INTO care_recipients (id, name, age, medications, primary_doctor, insurance)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.name,
      input.age ?? null,
      JSON.stringify(input.medications ?? []),
      input.primary_doctor ?? null,
      input.insurance ?? null,
    );
    return this.getById(id)!;
  }

  // ── Approval delegations (#1195) ──────────────────────────────────────────

  createDelegation(input: {
    recipient_id: string;
    delegator: string;
    delegate: string;
    starts_at: string;
    ends_at: string;
  }): ApprovalDelegation {
    const id = `dlg_${randomUUID()}`;
    this.db.prepare(`
      INSERT INTO approval_delegations (id, recipient_id, delegator, delegate, starts_at, ends_at, revoked_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
    `).run(id, input.recipient_id, input.delegator, input.delegate, input.starts_at, input.ends_at, new Date().toISOString());
    return this.getDelegation(id)!;
  }

  getDelegation(id: string): ApprovalDelegation | undefined {
    return this.db.prepare('SELECT * FROM approval_delegations WHERE id = ?').get(id) as ApprovalDelegation | undefined;
  }

  listDelegations(recipientId: string): ApprovalDelegation[] {
    return this.db
      .prepare('SELECT * FROM approval_delegations WHERE recipient_id = ? ORDER BY starts_at DESC')
      .all(recipientId) as ApprovalDelegation[];
  }

  /** The delegation letting `delegate` act for `delegator` on this recipient right now, if any. */
  findActiveDelegation(recipientId: string, delegator: string, delegate: string, now: Date = new Date()): ApprovalDelegation | undefined {
    const iso = now.toISOString();
    return this.db.prepare(`
      SELECT * FROM approval_delegations
      WHERE recipient_id = ? AND delegator = ? AND delegate = ?
        AND revoked_at IS NULL AND starts_at <= ? AND ends_at > ?
      ORDER BY ends_at DESC LIMIT 1
    `).get(recipientId, delegator, delegate, iso, iso) as ApprovalDelegation | undefined;
  }

  /** Active delegations held by `delegate` on this recipient (for the approvals banner). */
  listActiveDelegationsFor(recipientId: string, delegate: string, now: Date = new Date()): ApprovalDelegation[] {
    const iso = now.toISOString();
    return this.db.prepare(`
      SELECT * FROM approval_delegations
      WHERE recipient_id = ? AND delegate = ?
        AND revoked_at IS NULL AND starts_at <= ? AND ends_at > ?
      ORDER BY ends_at ASC
    `).all(recipientId, delegate, iso, iso) as ApprovalDelegation[];
  }

  /** Revoke early. Only the delegator may revoke; returns the updated row or undefined if not theirs/already ended. */
  revokeDelegation(id: string, delegator: string, now: Date = new Date()): ApprovalDelegation | undefined {
    const result = this.db.prepare(`
      UPDATE approval_delegations SET revoked_at = ?
      WHERE id = ? AND delegator = ? AND revoked_at IS NULL AND ends_at > ?
    `).run(now.toISOString(), id, delegator, now.toISOString());
    return result.changes > 0 ? this.getDelegation(id) : undefined;
  }
}

export function createCareRecipientsStore(dbPath?: string): CareRecipientsStore {
  return new CareRecipientsStore(dbPath);
}

let sharedStore: CareRecipientsStore | undefined;

/**
 * Process-wide store shared by the HTTP routes and the agent's
 * get_handoff_notes tool (#1180), so both use one connection and see the
 * same data (including the in-memory database used under NODE_ENV=test).
 */
export function getCareRecipientsStore(): CareRecipientsStore {
  sharedStore ??= new CareRecipientsStore();
  return sharedStore;
}
