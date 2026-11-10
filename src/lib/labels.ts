export type Tone = "ok" | "bad" | "wait" | "info" | "warn";
export interface Label { text: string; tone: Tone }
const L = (text: string, tone: Tone): Label => ({ text, tone });

export const DEPOSIT: Record<string, Label> = {
  pending: L("قيد الإنشاء", "wait"), awaiting_payment: L("بانتظار الدفع", "wait"), paid: L("مكتمل", "ok"),
  failed: L("فشل", "bad"), expired: L("منتهي", "bad"), cancelled: L("ملغي", "bad"), needs_review: L("يحتاج مراجعة", "warn"),
};
export const BUY: Record<string, Label> = {
  pending_review: L("بانتظار المراجعة", "wait"), approved: L("تمت الموافقة", "info"), processing: L("قيد التنفيذ", "info"),
  completed: L("مكتمل", "ok"), rejected: L("مرفوض", "bad"), cancelled: L("ملغي", "bad"), failed: L("فشل", "bad"), needs_attention: L("يحتاج انتباهًا", "warn"),
};
export const SELL: Record<string, Label> = {
  awaiting_deposit: L("بانتظار إيداع USDT", "wait"), deposit_submitted: L("بانتظار مراجعة الإيداع", "wait"),
  needs_review: L("يحتاج مراجعة", "warn"), awaiting_payout: L("بانتظار الصرف", "info"), completed: L("مكتمل", "ok"),
  rejected: L("مرفوض", "bad"), cancelled: L("ملغي", "bad"), expired: L("منتهي", "bad"), failed: L("فشل", "bad"),
};
export const TICKET: Record<string, Label> = {
  pending_staff: L("بانتظار الدعم", "wait"), pending_customer: L("بانتظار ردّك", "info"), closed: L("مغلقة", "ok"),
};
export const ACCOUNT: Record<string, Label> = {
  active: L("نشط", "ok"), pending_verification: L("بانتظار التحقق", "wait"), needs_review: L("يحتاج مراجعة", "warn"),
  restricted: L("مقيّد", "bad"), suspended: L("موقوف", "bad"),
};
export const CATEGORY: Record<string, string> = {
  deposit_issue: "مشكلة شحن", buy_issue: "مشكلة شراء USDT", sell_issue: "مشكلة بيع USDT", transfer_delay: "تأخر التحويل",
  account_data: "مشكلة في بيانات الحساب", financial_inquiry: "استفسار مالي", complaint: "شكوى", other: "أخرى",
};
export const ROLE: Record<string, string> = {
  super_admin: "مدير عام", admin: "مدير", finance_manager: "مدير مالي", buy_operator: "مشغّل شراء",
  sell_operator: "مشغّل بيع", deposit_reviewer: "مراجع إيداعات", support_agent: "دعم فني", auditor: "مدقق (قراءة فقط)",
};
export const PAYOUT_TYPE: Record<string, string> = {
  internal_wallet: "المحفظة الداخلية", bank_iban: "حساب مصرفي (IBAN)", bank_local: "حساب مصرفي محلي", other: "وسيلة أخرى",
};
export const KIND: Record<string, string> = {
  deposit: "شحن المحفظة", buy_hold: "حجز لطلب شراء", buy_release: "إرجاع مبلغ محجوز", buy_settle: "تنفيذ شراء USDT",
  sell_accept: "استلام USDT", sell_payout: "صرف مقابل البيع", adjustment: "تسوية",
};
export const NOTE_ICON_BY_LEVEL: Record<string, string> = { info: "bell", success: "check", warning: "alert", critical: "alert" };
