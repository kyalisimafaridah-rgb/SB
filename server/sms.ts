import { ENV } from "./_core/env.js";
import { formatUgandaPhone } from "../shared/phone.js";

interface SMSResult {
  phone: string;
  status: "success" | "failed";
  messageId?: string;
}

export async function sendSMS(
  phones: string[],
  message: string
): Promise<{ success: number; failed: number; results: SMSResult[] }> {
  if (!ENV.atApiKey || !ENV.atUsername) {
    console.warn("Africa's Talking credentials not configured. SMS not sent.");
    return { success: 0, failed: phones.length, results: [] };
  }

  const results: SMSResult[] = [];

  for (const phone of phones) {
    try {
      const formatted = formatUgandaPhone(phone);
      if (!formatted) {
        results.push({ phone, status: "failed" });
        continue;
      }

      const body = new URLSearchParams({
        username: ENV.atUsername,
        to: formatted,
        message,
      });

      const response = await fetch("https://api.africastalking.com/version1/messaging", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
          apikey: ENV.atApiKey,
        },
        body: body.toString(),
      });

      // AT returns HTTP 201 even for failed recipients — check the response body
      if (response.ok) {
        try {
          const json = await response.json() as {
            SMSMessageData?: { Recipients?: Array<{ statusCode: number; messageId?: string }> }
          };
          const recipient = json.SMSMessageData?.Recipients?.[0];
          // AT status code 101 = success
          if (recipient?.statusCode === 101) {
            results.push({ phone, status: "success", messageId: recipient.messageId });
          } else {
            results.push({ phone, status: "failed" });
          }
        } catch {
          // If JSON parse fails, fall back to HTTP status
          results.push({ phone, status: "success" });
        }
      } else {
        results.push({ phone, status: "failed" });
      }
    } catch {
      results.push({ phone, status: "failed" });
    }
  }

  const success = results.filter((r) => r.status === "success").length;
  const failed = results.filter((r) => r.status === "failed").length;

  return { success, failed, results };
}

// Africa's Talking accepts a comma-separated "to" list and sends the SAME
// message to all of them in ONE request — use this for a shared-message bulk
// send (e.g. "Send to all") instead of one HTTP round trip per phone number.
// For a few hundred recipients that was the difference between seconds and
// several minutes, with real risk of a proxy/browser timeout along the way.
const AT_BATCH_SIZE = 100; // keep each request's recipient list modest
const AT_CHUNK_CONCURRENCY = 5; // how many batch requests run at once

export async function sendBulkSMS(
  phones: string[],
  message: string
): Promise<{ success: number; failed: number; results: SMSResult[] }> {
  if (!ENV.atApiKey || !ENV.atUsername) {
    console.warn("Africa's Talking credentials not configured. SMS not sent.");
    return { success: 0, failed: phones.length, results: [] };
  }

  const formattedPairs = phones.map((phone) => ({ phone, formatted: formatUgandaPhone(phone) }));
  const valid = formattedPairs.filter(
    (p): p is { phone: string; formatted: string } => !!p.formatted
  );
  const invalidResults: SMSResult[] = formattedPairs
    .filter((p) => !p.formatted)
    .map((p) => ({ phone: p.phone, status: "failed" as const }));

  const chunks: { phone: string; formatted: string }[][] = [];
  for (let i = 0; i < valid.length; i += AT_BATCH_SIZE) {
    chunks.push(valid.slice(i, i + AT_BATCH_SIZE));
  }

  const chunkResultGroups = await mapWithConcurrency(
    chunks,
    AT_CHUNK_CONCURRENCY,
    (chunk) => sendChunk(chunk, message)
  );

  const results = [...invalidResults, ...chunkResultGroups.flat()];
  const success = results.filter((r) => r.status === "success").length;
  const failed = results.filter((r) => r.status === "failed").length;
  return { success, failed, results };
}

async function sendChunk(
  chunk: { phone: string; formatted: string }[],
  message: string
): Promise<SMSResult[]> {
  try {
    const body = new URLSearchParams({
      username: ENV.atUsername!,
      to: chunk.map((c) => c.formatted).join(","),
      message,
    });

    const response = await fetch("https://api.africastalking.com/version1/messaging", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        apikey: ENV.atApiKey!,
      },
      body: body.toString(),
    });

    if (!response.ok) {
      return chunk.map((c) => ({ phone: c.phone, status: "failed" as const }));
    }

    try {
      const json = (await response.json()) as {
        SMSMessageData?: { Recipients?: Array<{ number?: string; statusCode: number; messageId?: string }> };
      };
      const recipients = json.SMSMessageData?.Recipients ?? [];
      // Match by the returned number rather than array position — AT doesn't
      // guarantee its response order matches the request order.
      const byNumber = new Map(recipients.map((r) => [r.number, r]));

      // If AT's response format ever doesn't exactly match what
      // formatUgandaPhone sends ("+256..."), every lookup below silently
      // misses and the whole chunk reads as "failed" even though the
      // messages actually sent — indistinguishable from a genuine bulk
      // rejection unless this is logged loudly.
      if (recipients.length > 0 && chunk.every((c) => !byNumber.has(c.formatted))) {
        console.error(
          "sendChunk: AT returned recipients but none matched by number — check the response format hasn't changed.",
          { sentFormat: chunk[0]?.formatted, receivedFormat: recipients[0]?.number }
        );
      }

      return chunk.map((c) => {
        const r = byNumber.get(c.formatted);
        if (r?.statusCode === 101) {
          return { phone: c.phone, status: "success" as const, messageId: r.messageId };
        }
        return { phone: c.phone, status: "failed" as const };
      });
    } catch {
      // 2xx but not parseable JSON — assume the chunk went through
      return chunk.map((c) => ({ phone: c.phone, status: "success" as const }));
    }
  } catch {
    return chunk.map((c) => ({ phone: c.phone, status: "failed" as const }));
  }
}

// Runs `fn` over `items` with at most `limit` in flight at once — used to
// parallelize personalized sends (where each recipient gets different text,
// so they can't be merged into one batch request) without firing everything
// at the API simultaneously.
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export function buildDefaulterMessage(
  studentName: string,
  className: string,
  currentTermAmount: number,
  arrearsAmount: number,
  term: number,
  year: number,
  schoolName: string
): string {
  const parts: string[] = [];
  parts.push(`Dear Parent, ${studentName} (${className}) has outstanding fees:`);

  if (currentTermAmount > 0) {
    parts.push(`Term ${term} ${year}: ${currentTermAmount.toLocaleString()} UGX`);
  }
  if (arrearsAmount > 0) {
    parts.push(`Arrears: ${arrearsAmount.toLocaleString()} UGX`);
  }

  const total = currentTermAmount + arrearsAmount;
  parts.push(`Total due: ${total.toLocaleString()} UGX`);
  parts.push(`Please clear at the bursar's office. - ${schoolName}`);

  return parts.join(". ");
}
