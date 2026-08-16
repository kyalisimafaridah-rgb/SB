import { useState } from "react";
import { useLocation } from "wouter";
import { trpc } from "../lib/trpc";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { toast } from "sonner";
import { LogOut, KeyRound } from "lucide-react";
import { clearToken, getUser, setToken } from "../_core/hooks/useAuth";

// Account-level settings that apply to every logged-in user regardless of
// school role — name/email display, change password, and log out. This is
// deliberately separate from school-admin settings (School Details, Staff,
// Classes, etc.) so it can be reused as-is on both the owner's Settings page
// and the customer Settings page, and so "my account" never gets buried
// under school-management fields that don't apply to every role.
export function AccountSettings() {
  const [, navigate] = useLocation();
  const user = getUser();

  const [showChangePassword, setShowChangePassword] = useState(false);
  const [form, setForm] = useState({ current: "", next: "", confirm: "" });

  const changePasswordMutation = trpc.account.changePassword.useMutation({
    onSuccess: (result) => {
      // A fresh token is issued so this session keeps working — the old
      // token (and any other device's) is invalidated server-side.
      setToken(result.token);
      toast.success("Password changed");
      setShowChangePassword(false);
      setForm({ current: "", next: "", confirm: "" });
    },
    onError: (e) => toast.error(e.message),
  });

  function handleLogout() {
    clearToken();
    navigate("/");
  }

  const mismatch = form.confirm.length > 0 && form.next !== form.confirm;

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Account</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <div>
          <p className="text-sm font-medium">{user?.name}</p>
          <p className="text-xs text-muted-foreground">{user?.email}</p>
        </div>

        {!showChangePassword ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => setShowChangePassword(true)}>
              <KeyRound className="h-4 w-4 mr-1.5" /> Change Password
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="text-red-600 border-red-200 hover:bg-red-50 hover:text-red-700"
              onClick={handleLogout}
            >
              <LogOut className="h-4 w-4 mr-1.5" /> Log Out
            </Button>
          </div>
        ) : (
          <div className="space-y-3 max-w-sm">
            <div>
              <Label>Current Password</Label>
              <Input
                type="password"
                autoComplete="current-password"
                value={form.current}
                onChange={(e) => setForm((f) => ({ ...f, current: e.target.value }))}
              />
            </div>
            <div>
              <Label>New Password</Label>
              <Input
                type="password"
                autoComplete="new-password"
                placeholder="At least 8 characters"
                value={form.next}
                onChange={(e) => setForm((f) => ({ ...f, next: e.target.value }))}
              />
            </div>
            <div>
              <Label>Confirm New Password</Label>
              <Input
                type="password"
                autoComplete="new-password"
                value={form.confirm}
                onChange={(e) => setForm((f) => ({ ...f, confirm: e.target.value }))}
              />
              {mismatch && <p className="text-xs text-red-500 mt-1">Passwords don't match</p>}
            </div>
            <div className="flex gap-2 pt-1">
              <Button
                variant="outline"
                size="sm"
                onClick={() => { setShowChangePassword(false); setForm({ current: "", next: "", confirm: "" }); }}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={
                  changePasswordMutation.isPending ||
                  !form.current ||
                  form.next.length < 8 ||
                  form.next !== form.confirm
                }
                onClick={() => changePasswordMutation.mutate({ currentPassword: form.current, newPassword: form.next })}
              >
                {changePasswordMutation.isPending ? "Saving..." : "Save New Password"}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
