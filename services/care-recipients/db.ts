import { mkdirSync } from 'fs';
import { createRequire } from 'module';
import { createHash, randomBytes, randomUUID } from 'crypto';
import path from 'path';
import { logger } from '../../shared/logger.ts';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

/** Id of the recipient seeded into an empty database. */
export const DEFAULT_RECIPIENT_ID = 'rosa_garcia';

/** Caregiver roles (#1179), most to least privileged. */
export const CAREGIVER_ROLES = ['owner', 'co-caregiver', 'viewer'] as const;
export type CaregiverRole = (typeof CAREGIVER_ROLES)[number];

/**
 * - view:   read the recipient, its linked caregivers and handoff notes
 * - act:    day-to-day care actions, e.g. posting handoff notes
 * - manage: invite and remove caregivers
 */
export type CaregiverPermission = 'view' | 'act' | 'manage';

const ROLE_PERMISSIONS: Record<CaregiverRole, ReadonlySet<CaregiverPermission>> = {
  owner: new Set(['view', 'act', 'manage']),
  'co-caregiver': new Set(['view', 'act']),
  viewer: new Set(['view']),
};

export function roleHasPermission(role: CaregiverRole, permission: CaregiverPermission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const HANDOFF_NOTE_MAX_LENGTH = 500;

export interface CareRecipientEntity {
  id: string;
  name: string;
  age: number | null;
  medications: string[];
  primary_doctor: string | null;
  insurance: string | null;
}

export type CareRecipientInput = Omit<CareRecipientEntity, 'id'>;

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

      CREATE TABLE IF NOT EXISTS care_recipient_caregivers (
        recipient_id TEXT NOT NULL REFERENCES care_recipients(id) ON DELETE CASCADE,
        caregiver_user_id TEXT NOT NULL,
        email TEXT,
        display_name TEXT,
        role TEXT NOT NULL CHECK (role IN (${roles})),
        status TEXT NOT NULL CHECK (status IN ('active', 'invited')),
        invite_token_hash TEXT UNIQUE,
        invite_expires_at TEXT,
        access_token_hash TEXT UNIQUE,
        invited_by TEXT,
        created_at TEXT NOT NULL,
        accepted_at TEXT,
        PRIMARY KEY (recipient_id, caregiver_user_id)
      );

      CREATE TABLE IF NOT EXISTS handoff_notes (
        id TEXT PRIMARY KEY,
        recipient_id TEXT NOT NULL REFERENCES care_recipients(id) ON DELETE CASCADE,
        author TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS handoff_notes_recipient_time
        ON handoff_notes (recipient_id, created_at);
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

  // ── Caregiver links (#1179) ─────────────────────────────────────────────────

  /** Active caregivers and pending invites for a recipient, oldest first. */
  listCaregivers(recipientId: string): RecipientCaregiver[] {
    return this.db
      .prepare(`SELECT ${CAREGIVER_COLUMNS} FROM care_recipient_caregivers WHERE recipient_id = ? ORDER BY created_at ASC`)
      .all(recipientId) as RecipientCaregiver[];
  }

  private getCaregiver(recipientId: string, caregiverUserId: string): RecipientCaregiver | undefined {
    return this.db
      .prepare(`SELECT ${CAREGIVER_COLUMNS} FROM care_recipient_caregivers WHERE recipient_id = ? AND caregiver_user_id = ?`)
      .get(recipientId, caregiverUserId) as RecipientCaregiver | undefined;
  }

  /**
   * Invites a caregiver by email. Re-inviting a pending address rotates its
   * code and role; inviting an already active caregiver is rejected. Only the
   * SHA-256 of the invite code is stored, so the returned code is the one
   * chance to deliver it.
   */
  inviteCaregiver(input: {
    recipientId: string;
    email: string;
    role: CaregiverRole;
    invitedBy: string;
  }): { caregiver: RecipientCaregiver; inviteToken: string } {
    const email = normalizeEmail(input.email);
    const inviteToken = generateSecret();
    const now = Date.now();
    return this.transaction(() => {
      if (!this.getById(input.recipientId)) {
        throw new CaregiverAccessError('recipient_not_found', 'Care recipient not found');
      }
      const result = this.db.prepare(`
        INSERT INTO care_recipient_caregivers
          (recipient_id, caregiver_user_id, email, role, status, invite_token_hash, invite_expires_at, invited_by, created_at)
        VALUES (?, ?, ?, ?, 'invited', ?, ?, ?, ?)
        ON CONFLICT (recipient_id, caregiver_user_id) DO UPDATE SET
          role = excluded.role,
          invite_token_hash = excluded.invite_token_hash,
          invite_expires_at = excluded.invite_expires_at,
          invited_by = excluded.invited_by
        WHERE care_recipient_caregivers.status = 'invited'
      `).run(
        input.recipientId,
        email,
        email,
        input.role,
        hashSecret(inviteToken),
        new Date(now + INVITE_TTL_MS).toISOString(),
        input.invitedBy,
        new Date(now).toISOString(),
      );
      if (Number(result.changes) === 0) {
        throw new CaregiverAccessError('already_linked', 'Caregiver is already linked to this care recipient');
      }
      return { caregiver: this.getCaregiver(input.recipientId, email)!, inviteToken };
    });
  }

  /**
   * Redeems an invite code and issues an access token for that one recipient
   * link. Tokens are scoped to a link rather than to the email address because
   * the email is asserted by the inviter: a global identity would let an owner
   * of one recipient invite someone else's address, accept it and reach that
   * person's other recipients.
   */
  acceptInvite(inviteToken: string, displayName?: string): { caregiver: RecipientCaregiver; accessToken: string } {
    return this.transaction(() => {
      const invite = this.db
        .prepare(`SELECT ${CAREGIVER_COLUMNS} FROM care_recipient_caregivers WHERE invite_token_hash = ? AND status = 'invited'`)
        .get(hashSecret(inviteToken)) as RecipientCaregiver | undefined;
      if (!invite) {
        throw new CaregiverAccessError('invite_invalid', 'Invite code is invalid or has already been used');
      }
      if (!invite.invite_expires_at || Date.parse(invite.invite_expires_at) <= Date.now()) {
        throw new CaregiverAccessError('invite_expired', 'Invite code has expired; ask an owner to re-send it');
      }

      const accessToken = generateSecret();
      const acceptedAt = new Date().toISOString();
      this.db.prepare(`
        UPDATE care_recipient_caregivers
        SET status = 'active', display_name = ?, access_token_hash = ?, accepted_at = ?,
            invite_token_hash = NULL, invite_expires_at = NULL
        WHERE recipient_id = ? AND caregiver_user_id = ?
      `).run(displayName ?? null, hashSecret(accessToken), acceptedAt, invite.recipient_id, invite.caregiver_user_id);

      return {
        caregiver: {
          ...invite,
          status: 'active',
          display_name: displayName ?? null,
          accepted_at: acceptedAt,
          invite_expires_at: null,
        },
        accessToken,
      };
    });
  }

  /** Resolves an access token to its active caregiver link (indexed lookup). */
  authenticateCaregiver(accessToken: string): RecipientCaregiver | undefined {
    return this.db
      .prepare(`SELECT ${CAREGIVER_COLUMNS} FROM care_recipient_caregivers WHERE access_token_hash = ? AND status = 'active'`)
      .get(hashSecret(accessToken)) as RecipientCaregiver | undefined;
  }

  /**
   * Removes a caregiver link or revokes a pending invite; the link's access
   * token stops working immediately. The last active owner cannot be removed,
   * so a recipient is never left without someone able to manage access.
   */
  removeCaregiver(recipientId: string, caregiverUserId: string): boolean {
    return this.transaction(() => {
      const link = this.getCaregiver(recipientId, caregiverUserId);
      if (!link) return false;
      if (link.role === 'owner' && link.status === 'active') {
        const { count } = this.db
          .prepare(`SELECT COUNT(*) AS count FROM care_recipient_caregivers WHERE recipient_id = ? AND role = 'owner' AND status = 'active'`)
          .get(recipientId) as { count: number };
        if (count <= 1) {
          throw new CaregiverAccessError('last_owner', 'Cannot remove the last owner of a care recipient');
        }
      }
      this.db
        .prepare('DELETE FROM care_recipient_caregivers WHERE recipient_id = ? AND caregiver_user_id = ?')
        .run(recipientId, caregiverUserId);
      return true;
    });
  }

  // ── Shift handoff notes (#1180) ─────────────────────────────────────────────

  addHandoffNote(input: HandoffNoteInput): HandoffNote {
    const note: HandoffNote = {
      id: `note_${Date.now()}_${randomUUID().slice(0, 8)}`,
      ...input,
      created_at: new Date().toISOString(),
    };
    this.db.prepare(`
      INSERT INTO handoff_notes (id, recipient_id, author, text, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(note.id, note.recipient_id, note.author, note.text, note.created_at);
    return note;
  }

  /**
   * Newest notes first. Served by the (recipient_id, created_at) index, so the
   * cost is O(log n + limit) regardless of how many notes a recipient has;
   * rowid breaks ties between notes written in the same millisecond.
   */
  listHandoffNotes(recipientId: string, limit: number): HandoffNote[] {
    return this.db
      .prepare(`
        SELECT id, recipient_id, author, text, created_at FROM handoff_notes
        WHERE recipient_id = ?
        ORDER BY created_at DESC, rowid DESC
        LIMIT ?
      `)
      .all(recipientId, limit) as HandoffNote[];
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
