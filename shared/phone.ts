// Uganda phone number validation/formatting — shared between client-side form
// validation and server-side SMS sending. Previously server/sms.ts had its own
// private copy of this exact logic and nothing on the client (registration,
// admin "Add School", admin "Contact Phone", school Settings) validated the
// format at all. A malformed number was accepted everywhere, stored, and only
// failed silently much later when sendSMS actually tried to use it — which,
// for school.contactPhone specifically, is the one number password-reset OTPs
// depend on. Validating with the exact same rule sendSMS uses means a number
// that passes here is guaranteed not to fail there.
export function formatUgandaPhone(phone: string): string | null {
  const cleaned = phone.replace(/\D/g, "");
  if (cleaned.startsWith("256") && cleaned.length === 12) return `+${cleaned}`;
  if (cleaned.startsWith("0") && cleaned.length === 10) return `+256${cleaned.slice(1)}`;
  if (cleaned.length === 9) return `+256${cleaned}`;
  return null;
}

export function isValidUgandaPhone(phone: string): boolean {
  return formatUgandaPhone(phone) !== null;
}
