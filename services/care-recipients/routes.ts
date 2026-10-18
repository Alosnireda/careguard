import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import {
  CAREGIVER_ROLES,
  CaregiverAccessError,
  HANDOFF_NOTE_MAX_LENGTH,
  roleHasPermission,
  type CaregiverAccessErrorCode,
  type CaregiverPermission,
  type CareRecipientsStore,
  type CareRecipientEntity,
  type RecipientCaregiver,
} from "./db.ts";
import { registerKnownNames } from "../../shared/redact.ts";
import { sanitizeFreeText, sanitizeUserString } from "../../shared/sanitize.ts";
import { optionalFreeTextSchema } from "../../shared/free-text.ts";
import { notify } from "../../shared/notifications.ts";

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const list: Record<string, string> = {};
  if (!cookieHeader) return list;
  cookieHeader.split(";").forEach((cookie) => {
    const parts = cookie.split("=");
    list[parts.shift()!.trim()] = decodeURIComponent(parts.join("="));
  });
  return list;
}

/**
 * Who is calling (#1179). The operator holding CAREGIVER_TOKEN keeps full
 * access, so existing single-caregiver deployments behave as before. A linked
 * caregiver authenticates with the access token issued when they accepted an
 * invite, and is limited to that recipient and role.
 */
export type CaregiverPrincipal =
  | { kind: "admin" }
  | { kind: "caregiver"; link: RecipientCaregiver };

function principalOf(res: Response): CaregiverPrincipal {
  return res.locals.principal as CaregiverPrincipal;
}

export function authenticateCaregiver(store: CareRecipientsStore, caregiverToken: string) {
  return function (req: Request, res: Response, next: NextFunction) {
    const auth = req.headers.authorization;
    let token: string | undefined;

    if (auth?.startsWith("Bearer ")) {
      token = auth.slice("Bearer ".length);
    } else {
      const cookies = parseCookies(req.headers.cookie);
      token = cookies["caregiver_token"];

      if (token) {
        const csrfHeader = req.headers["x-csrf-token"];
        const csrfCookie = cookies["csrf_token"];
        if (!csrfHeader || !csrfCookie || csrfHeader !== csrfCookie) {
          res.status(403).json({ error: "CSRF token mismatch or missing" });
          return;
        }
      }
    }

    if (!token) {
      res.status(401).setHeader("WWW-Authenticate", "Bearer").json({ error: "Missing caregiver token" });
      return;
    }
    if (token === caregiverToken) {
      res.locals.principal = { kind: "admin" } satisfies CaregiverPrincipal;
      next();
      return;
    }
    const link = store.authenticateCaregiver(token);
    if (!link) {
      res.status(403).json({ error: "Invalid caregiver token" });
      return;
    }
    res.locals.principal = { kind: "caregiver", link } satisfies CaregiverPrincipal;
    next();
  };
}

/**
 * Gates /recipients/:id/... by role. A caregiver who is not linked to the
 * recipient gets 404 rather than 403, so recipient ids are not disclosed.
 */
function requirePermission(store: CareRecipientsStore, permission: CaregiverPermission) {
  return function (req: Request<Record<string, string>>, res: Response, next: NextFunction) {
    const principal = principalOf(res);
    const recipientId = req.params.id;
    const linked =
      principal.kind === "admin"
        ? store.getById(recipientId) !== undefined
        : principal.link.recipient_id === recipientId;
    if (!linked) {
      res.status(404).json({ error: "Care recipient not found" });
      return;
    }
    if (principal.kind === "caregiver" && !roleHasPermission(principal.link.role, permission)) {
      res.status(403).json({ error: `The ${principal.link.role} role does not have ${permission} permission for this care recipient` });
      return;
    }
    next();
  };
}

const ACCESS_ERROR_STATUS: Record<CaregiverAccessErrorCode, number> = {
  recipient_not_found: 404,
  already_linked: 409,
  invite_invalid: 404,
  invite_expired: 410,
  last_owner: 409,
};

function sendAccessError(err: unknown, res: Response): void {
  if (!(err instanceof CaregiverAccessError)) throw err;
  res.status(ACCESS_ERROR_STATUS[err.code]).json({ error: err.message, code: err.code });
}

const InviteBodySchema = z.object({
  email: z.email().max(254),
  role: z.enum(CAREGIVER_ROLES),
});

const AcceptInviteBodySchema = z.object({
  token: z.string().min(1).max(128),
  display_name: optionalFreeTextSchema("display_name"),
});

const HandoffNoteBodySchema = z.object({
  text: z
    .string({ error: "text is required" })
    .transform(sanitizeFreeText)
    .pipe(
      z
        .string()
        .min(1, "text is required")
        .max(HANDOFF_NOTE_MAX_LENGTH, `text must be at most ${HANDOFF_NOTE_MAX_LENGTH} characters`),
    ),
  author: optionalFreeTextSchema("author"),
});

const HandoffNotesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/** Display name for a note author: the caller's identity, never client input. */
function authorOf(principal: CaregiverPrincipal, requestedAuthor: string | undefined): string {
  if (principal.kind === "caregiver") {
    const { display_name, email, caregiver_user_id } = principal.link;
    return display_name ?? email ?? caregiver_user_id;
  }
  // The shared operator token carries no identity, so the dashboard names the
  // signed-in caregiver profile explicitly.
  return sanitizeUserString(requestedAuthor) || "Caregiver";
}

/**
 * Care recipients routes, extracted from server.ts (Issue #791) so they
 * can be exercised via supertest against a real CareRecipientsStore without
 * booting the full unified server (Sentry/Stellar/LLM/agent runtime).
 * Extended with role-based caregiver access (#1179) and shift handoff
 * notes (#1180).
 */
export function createCareRecipientsRouter(store: CareRecipientsStore, caregiverToken: string): Router {
  const router = Router();
  const auth = authenticateCaregiver(store, caregiverToken);
  const canView = requirePermission(store, "view");
  const canAct = requirePermission(store, "act");
  const canManage = requirePermission(store, "manage");

  router.get("/recipients", auth, (_req, res) => {
    const principal = principalOf(res);
    if (principal.kind === "admin") {
      res.json(store.list());
      return;
    }
    const recipient = store.getById(principal.link.recipient_id);
    res.json(recipient ? [recipient] : []);
  });

  router.post("/recipients", auth, (req, res) => {
    if (principalOf(res).kind !== "admin") {
      res.status(403).json({ error: "Caregiver accounts cannot create care recipients" });
      return;
    }
    const body = req.body as Partial<CareRecipientEntity>;
    if (!body?.name || typeof body.name !== "string" || !body.name.trim()) {
      res.status(400).json({ error: "name is required" });
      return;
    }
    const created = store.create({
      name: body.name.trim(),
      age: typeof body.age === "number" ? body.age : null,
      medications: Array.isArray(body.medications) ? body.medications : [],
      primary_doctor: typeof body.primary_doctor === "string" ? body.primary_doctor : null,
      insurance: typeof body.insurance === "string" ? body.insurance : null,
    });
    registerKnownNames([created.name]);
    res.status(201).json(created);
  });

  // ── Caregiver access (#1179) ───────────────────────────────────────────────

  router.get("/recipients/:id/caregivers", auth, canView, (req, res) => {
    res.json({ recipientId: req.params.id, caregivers: store.listCaregivers(req.params.id) });
  });

  router.post("/recipients/:id/caregivers/invites", auth, canManage, (req, res) => {
    const parsed = InviteBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid invite", issues: parsed.error.issues });
      return;
    }
    const principal = principalOf(res);
    try {
      const { caregiver, inviteToken } = store.inviteCaregiver({
        recipientId: req.params.id,
        email: parsed.data.email,
        role: parsed.data.role,
        invitedBy: principal.kind === "admin" ? "admin" : principal.link.caregiver_user_id,
      });
      // The code travels only in the email body (context); notify() logs the
      // title and description, which deliberately carry no secret or PHI.
      void notify({
        level: "info",
        channel: "email",
        recipientEmail: caregiver.email ?? undefined,
        title: "You've been invited to CareGuard",
        description: `You were invited as ${caregiver.role}. Redeem the invite code before it expires.`,
        context: { inviteCode: inviteToken, expiresAt: caregiver.invite_expires_at },
      });
      // Also returned once so the inviter can share it when email is not configured.
      res.status(201).json({ caregiver, inviteToken });
    } catch (err) {
      sendAccessError(err, res);
    }
  });

  router.post("/caregiver-invites/accept", (req, res) => {
    const parsed = AcceptInviteBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid invite acceptance", issues: parsed.error.issues });
      return;
    }
    const displayName = sanitizeUserString(parsed.data.display_name) || undefined;
    try {
      const { caregiver, accessToken } = store.acceptInvite(parsed.data.token, displayName);
      if (displayName) registerKnownNames([displayName]);
      res.json({ caregiver, accessToken });
    } catch (err) {
      sendAccessError(err, res);
    }
  });

  router.delete("/recipients/:id/caregivers/:caregiverUserId", auth, canManage, (req, res) => {
    try {
      if (!store.removeCaregiver(req.params.id, req.params.caregiverUserId)) {
        res.status(404).json({ error: "Caregiver not found" });
        return;
      }
      res.status(204).end();
    } catch (err) {
      sendAccessError(err, res);
    }
  });

  // ── Shift handoff notes (#1180) ────────────────────────────────────────────

  router.get("/recipients/:id/handoff-notes", auth, canView, (req, res) => {
    const parsed = HandoffNotesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query", issues: parsed.error.issues });
      return;
    }
    res.json({
      recipientId: req.params.id,
      notes: store.listHandoffNotes(req.params.id, parsed.data.limit),
    });
  });

  router.post("/recipients/:id/handoff-notes", auth, canAct, (req, res) => {
    const parsed = HandoffNoteBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid handoff note", issues: parsed.error.issues });
      return;
    }
    const note = store.addHandoffNote({
      recipient_id: req.params.id,
      author: authorOf(principalOf(res), parsed.data.author),
      text: parsed.data.text,
    });
    res.status(201).json(note);
  });

  return router;
}
