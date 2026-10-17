import { z } from "zod";

export const BillLineItemSchema = z.object({
  description: z.string(),
  cptCode: z.string().optional(),
  quantity: z.number(),
  chargedAmount: z.number(),
  status: z.enum(["valid", "duplicate", "upcoded", "unbundled", "error"]),
  suggestedAmount: z.number().optional(),
  errorDescription: z.string().optional(),
});

export const BillAuditResultSchema = z.object({
  totalCharged: z.number(),
  totalCorrect: z.number(),
  totalOvercharge: z.number(),
  errorCount: z.number(),
  savingsPercent: z.number().optional(),
  lineItems: z.array(BillLineItemSchema),
  recommendation: z.string().optional(),
});

export type BillAuditResult = z.infer<typeof BillAuditResultSchema>;

export const PharmacyPriceSchema = z.object({
  pharmacyName: z.string(),
  pharmacyId: z.string().optional(),
  price: z.number(),
  distance: z.string().optional(),
  inStock: z.union([z.boolean(), z.literal('unknown')]).optional(),
});

export const PharmacyCompareResultSchema = z.object({
  drug: z.string(),
  prices: z.array(PharmacyPriceSchema),
  cheapest: PharmacyPriceSchema,
  mostExpensive: PharmacyPriceSchema.optional(),
  potentialSavings: z.number().optional(),
  savingsPercent: z.number().optional(),
});

export type PharmacyCompareResult = z.infer<typeof PharmacyCompareResultSchema>;

export const DrugInteractionSchema = z.object({
  drug1: z.string(),
  drug2: z.string(),
  severity: z.string(),
  recommendation: z.string(),
});

export const DrugInteractionResultSchema = z.object({
  summary: z.string().optional(),
  interactions: z.array(DrugInteractionSchema).optional(),
});

export type DrugInteractionResult = z.infer<typeof DrugInteractionResultSchema>;

export const TransactionSchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  type: z.enum(["medication", "bill", "service_fee"]),
  description: z.string(),
  amount: z.number(),
  recipient: z.string(),
  // Always a real 64-char hex Stellar tx hash, or undefined (#14).
  stellarTxHash: z.string().optional(),
  txHashStatus: z.enum(["extracted", "extraction_failed"]).optional(),
  mppOrderId: z.string().optional(),
  pendingUntil: z.string().optional(),
  status: z.string(),
  category: z.string(),
});

export type Transaction = z.infer<typeof TransactionSchema>;

export const AuditLogSchema = z.object({
  timestamp: z.string(),
  event: z.string(),
  actor: z.string(),
  details: z.any(),
});

export type AuditLogEvent = z.infer<typeof AuditLogSchema>;

export const SpendingDataSchema = z.object({
  policy: z.object({
    dailyLimit: z.number(),
    monthlyLimit: z.number(),
    medicationMonthlyBudget: z.number(),
    billMonthlyBudget: z.number(),
    approvalThreshold: z.number(), holdTimeSeconds: z.number().optional().default(86400),
  }),
  spending: z.object({
    medications: z.number(),
    bills: z.number(),
    serviceFees: z.number(),
    total: z.number(),
  }),
  budgetRemaining: z.object({
    medications: z.number(),
    bills: z.number(),
  }),
  transactionCount: z.number(),
  recentTransactions: z.array(TransactionSchema),
});

export type SpendingData = z.infer<typeof SpendingDataSchema>;

export type RecipientProfile = {
  name: string;
  age?: number;
  facility?: string;
  medications?: string[];
  doctor?: string;
  insurance?: string;
  avatar?: string;
};

export type CaregiverProfile = {
  name: string;
  relationship?: string;
  location?: string;
  notifications?: string;
};

export type DisputeLetter = {
  billId: string;
  recipientName: string;
  facility: string;
  totalOvercharge: number;
  errorCount: number;
  emailText: string;
  emailHtml: string;
  generatedAt: string;
};

// ── Vitals (#1237) ────────────────────────────────────────────────────────────

export const VITAL_TYPES = ["weight", "blood_pressure", "glucose"] as const;
export type VitalType = (typeof VITAL_TYPES)[number];

/** Default unit per vital type — mirrors services/vitals/db.ts. */
export const VITAL_DEFAULT_UNIT: Record<VitalType, string> = {
  weight: "lb",
  blood_pressure: "mmHg",
  glucose: "mg/dL",
};

export const VitalSchema = z.object({
  id: z.string(),
  recipient_id: z.string(),
  type: z.enum(VITAL_TYPES),
  value: z.number(),
  secondary_value: z.number().nullable(),
  unit: z.string(),
  timestamp: z.string(),
});

export type Vital = z.infer<typeof VitalSchema>;

export const AdherenceTimelineEventSchema = z.object({
  id: z.string(),
  drug: z.string(),
  date: z.string(),
  status: z.enum(["pending", "confirmed", "skipped", "flagged"]),
});

export type AdherenceTimelineEvent = z.infer<typeof AdherenceTimelineEventSchema>;

/** Human-readable reading, e.g. "128/82 mmHg" or "162 lb". */
export function formatVital(v: Pick<Vital, "type" | "value" | "secondary_value" | "unit">): string {
  const reading =
    v.type === "blood_pressure" && v.secondary_value != null
      ? `${v.value}/${v.secondary_value}`
      : `${v.value}`;
  return `${reading} ${v.unit}`;
}

// ── Allergies & Adverse Reactions (Issue #1230) ────────────────────────────────

export const AllergySeveritySchema = z.enum([
  'mild',
  'moderate',
  'severe',
  'life_threatening',
]);

export type AllergySeverity = z.infer<typeof AllergySeveritySchema>;

export const RecipientAllergySchema = z.object({
  id: z.string().min(1),
  substance: z.string().min(1),
  severity: AllergySeveritySchema,
  reaction: z.string().optional(),
  notes: z.string().optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().optional(),
});

export type RecipientAllergy = z.infer<typeof RecipientAllergySchema>;

// ── Co-Caregiver Presence (Issue #1231) ───────────────────────────────────────

export const ItemPresenceEntrySchema = z.object({
  caregiverId: z.string().min(1),
  caregiverName: z.string().min(1),
  avatar: z.string().optional(),
  lastViewedAt: z.string().min(1),
});

export type ItemPresenceEntry = z.infer<typeof ItemPresenceEntrySchema>;

export type ItemPresenceMap = Record<string, ItemPresenceEntry[]>;
