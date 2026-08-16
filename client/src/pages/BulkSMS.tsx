import { useState } from "react";
import { trpc } from "../lib/trpc";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { toast } from "sonner";
import { MessageSquare, Clock, Lock } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../components/ui/alert-dialog";
import { getUser } from "../_core/hooks/useAuth";

const TEMPLATES = [
  {
    label: "Payment Reminder",
    text: "Dear Parent, this is a reminder that school fees for this term are due. Please clear at the bursar's office at your earliest convenience. Thank you.",
  },
  {
    label: "Term Start",
    text: "Dear Parent, a new school term has begun. Please ensure your child's fees are paid by end of the first week. Contact the bursar for any queries. Thank you.",
  },
  {
    label: "General Announcement",
    text: "Dear Parent, this is an announcement from the school administration. ",
  },
];

// The GSM 03.38 default alphabet — characters that encode as GSM-7. Anything
// outside this set (curly quotes/apostrophes from mobile autocorrect, emoji,
// most accented characters beyond this list) forces the whole message to
// UCS-2 encoding, which has a much smaller per-segment budget.
const GSM7_REGEX = /^[A-Za-z0-9 \r\n@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà^{}\\[~\]|€]*$/;

// A flat text.length/160 estimate is only correct for a single-segment GSM-7
// message. The moment a message needs MORE than one segment, each segment
// actually carries 153 GSM-7 chars (7 reserved for the concatenation header),
// not 160 — so a 320-char message is 3 real segments, not the 2 a flat /160
// division would show. And any character outside the GSM-7 alphabet (a
// curly '’' apostrophe from autocorrect is enough) silently drops the whole
// message to UCS-2, where segments hold only 70 chars (67 once concatenated)
// — an estimate off by more than 2x is exactly the kind of thing that
// quietly costs more on the Africa's Talking bill than the UI promised.
function getSmsSegmentInfo(text: string): { segments: number; encoding: "GSM-7" | "UCS-2" } {
  const isGsm7 = GSM7_REGEX.test(text);
  if (text.length === 0) return { segments: 0, encoding: isGsm7 ? "GSM-7" : "UCS-2" };
  if (isGsm7) {
    return { segments: text.length <= 160 ? 1 : Math.ceil(text.length / 153), encoding: "GSM-7" };
  }
  return { segments: text.length <= 70 ? 1 : Math.ceil(text.length / 67), encoding: "UCS-2" };
}

export default function BulkSMS() {
  const user = getUser();
  const isBursar = user?.schoolRole === "bursar" || user?.schoolRole === "headTeacher";
  const [message, setMessage] = useState("");
  const [showConfirm, setShowConfirm] = useState(false);

  const { data: logs = [] } = trpc.sms.getLogs.useQuery();
  const { data: students = [] } = trpc.student.getAll.useQuery();

  const sendMutation = trpc.sms.sendToAll.useMutation({
    onSuccess: (data) => {
      toast.success(`SMS sent to ${data.success} parents. ${data.failed} failed.`);
      setMessage("");
    },
    onError: (e) => toast.error(e.message),
  });

  const charCount = message.length;
  const { segments: smsCount, encoding } = getSmsSegmentInfo(message);
  // Bug 4: count both phone fields — server sends to parentPhone AND parentPhone2
  const parentCount = new Set(
    students.flatMap((s) => [s.parentPhone, s.parentPhone2]).filter(Boolean)
  ).size;

  return (
    <div className="p-6 space-y-4">
      <h1 className="text-2xl font-bold">Bulk SMS</h1>

      {isBursar ? (
        <Card>
          <CardHeader><CardTitle className="text-base">Send to All Parents</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {/* Templates */}
            <div>
              <p className="text-xs text-gray-500 mb-2">Quick templates:</p>
              <div className="flex gap-2 flex-wrap">
                {TEMPLATES.map((t) => (
                  <button
                    key={t.label}
                    className="text-xs px-3 py-1.5 border rounded-full hover:bg-gray-50 text-gray-600"
                    onClick={() => setMessage(t.text)}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>

            <Textarea
              placeholder="Type your message here..."
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={4}
            />

            <div className="flex items-center justify-between text-xs text-gray-400">
              <span>{charCount} chars · {smsCount} SMS segment{smsCount !== 1 ? "s" : ""} per recipient</span>
              {smsCount > 1 && (
                <span className="text-amber-500">⚠ Billed as {smsCount} messages per parent</span>
              )}
            </div>
            {encoding === "UCS-2" && charCount > 0 && (
              <p className="text-xs text-amber-600">
                This message uses a character your keyboard likely added automatically (a curly quote, emoji, or accent) that forces a smaller per-segment limit — {"70 chars instead of 160"}. Switching it to a plain character (e.g. a straight ' instead of ’) can cut your SMS cost.
              </p>
            )}

            <div className="flex items-center justify-between">
              <p className="text-sm text-gray-600">
                Will send to <strong>{parentCount}</strong> parent{parentCount !== 1 ? "s" : ""}
              </p>
              <Button
                disabled={!message.trim() || sendMutation.isPending}
                onClick={() => setShowConfirm(true)}
              >
                <MessageSquare className="h-4 w-4 mr-1" />
                {sendMutation.isPending ? "Sending..." : "Send SMS"}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="py-8 text-center space-y-2">
            <Lock className="h-6 w-6 text-gray-300 mx-auto" />
            <p className="text-sm text-gray-500">
              Sending SMS requires a bursar or head teacher account. You can still review the send history below.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Bug 11: Confirm before sending to all parents — costly, irreversible */}
      <AlertDialog open={showConfirm} onOpenChange={setShowConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Send SMS to {parentCount} parent{parentCount !== 1 ? "s" : ""}?</AlertDialogTitle>
            <AlertDialogDescription>
              <span className="block mb-2">Message preview:</span>
              <span className="block bg-gray-50 rounded p-2 text-sm text-gray-700 whitespace-pre-wrap">{message}</span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => { sendMutation.mutate({ message }); setShowConfirm(false); }}>
              Send Now
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* SMS History */}
      <Card>
        <CardHeader><CardTitle className="text-base flex items-center gap-2"><Clock className="h-4 w-4" /> SMS History</CardTitle></CardHeader>
        <CardContent className="p-0">
          {logs.length === 0 ? (
            <p className="text-center py-8 text-gray-400 text-sm">No SMS sent yet. Compose a message above to notify parents.</p>
          ) : (
            <div className="divide-y">
              {[...logs].reverse().map((log) => (
                <div key={log.id} className="px-4 py-3">
                  <div className="flex justify-between items-start">
                    <p className="text-sm text-gray-700 flex-1 mr-4">{log.message}</p>
                    <span className="text-xs text-gray-400 shrink-0">
                      {new Date(log.sentAt).toLocaleDateString()}
                    </span>
                  </div>
                  <div className="flex gap-3 mt-1 text-xs text-gray-400">
                    <span>{log.recipients} recipients</span>
                    <span className="text-green-600">{log.successCount} delivered</span>
                    {log.failCount > 0 && <span className="text-red-500">{log.failCount} failed</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
