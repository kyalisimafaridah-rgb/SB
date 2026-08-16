import { useState } from "react";
import { useLocation, Link } from "wouter";
import { setToken, setUser } from "../_core/hooks/useAuth";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import logoWordmark from "../assets/logo-wordmark.png";
import { isValidUgandaPhone } from "../../../shared/phone";

export default function Signup() {
  const [, navigate] = useLocation();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [form, setForm] = useState({
    schoolName: "",
    district: "",
    schoolType: "",
    contactPhone: "",
    ownerName: "",
    email: "",
    password: "",
    confirmPassword: "",
  });

  function update(field: string, value: string) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (form.password !== form.confirmPassword) {
      setError("Passwords do not match");
      return;
    }
    if (form.password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    if (!isValidUgandaPhone(form.contactPhone)) {
      setError("Enter a valid school phone number (e.g. 0772000000) — password-reset codes are sent here.");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          schoolName: form.schoolName,
          district: form.district,
          schoolType: form.schoolType,
          contactPhone: form.contactPhone,
          ownerName: form.ownerName,
          email: form.email,
          password: form.password,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Registration failed");
        return;
      }

      setToken(data.token);
      setUser(data.user);
      navigate("/dashboard");
    } catch {
      setError("Connection error. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center p-4">
      <div className="w-full max-w-lg space-y-6">
        <div className="text-center">
          <img src={logoWordmark} alt="ScholarBase" className="h-12 w-auto mx-auto" />
          <p className="text-gray-500 mt-2">Start your free 30-day trial</p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Register Your School</CardTitle>
            <CardDescription>No setup fee. No credit card. Cancel anytime.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <p className="text-sm font-semibold text-gray-500 uppercase tracking-wide">School Details</p>

              <div className="space-y-1">
                <Label>School Name *</Label>
                <Input
                  placeholder="Kibibi Muslim Secondary School"
                  value={form.schoolName}
                  onChange={(e) => update("schoolName", e.target.value)}
                  required
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label>District</Label>
                  <Input
                    placeholder="Kampala"
                    value={form.district}
                    onChange={(e) => update("district", e.target.value)}
                  />
                </div>
                <div className="space-y-1 min-w-0">
                  <Label>School Type</Label>
                  <Select onValueChange={(v) => update("schoolType", v)}>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Select..." />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="primary">Primary</SelectItem>
                      <SelectItem value="secondary">Secondary</SelectItem>
                      <SelectItem value="nursery">Nursery</SelectItem>
                      <SelectItem value="combined">Combined</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-1">
                <Label>School Phone Number *</Label>
                <Input
                  placeholder="0772 000 000"
                  value={form.contactPhone}
                  onChange={(e) => update("contactPhone", e.target.value)}
                  required
                />
                <p className="text-xs text-gray-400">Password-reset codes are sent to this number — make sure it's correct.</p>
              </div>

              <p className="text-sm font-semibold text-gray-500 uppercase tracking-wide pt-2">Your Account</p>

              <div className="space-y-1">
                <Label>Your Full Name *</Label>
                <Input
                  placeholder="John Ssali"
                  value={form.ownerName}
                  onChange={(e) => update("ownerName", e.target.value)}
                  required
                />
              </div>

              <div className="space-y-1">
                <Label>Email Address *</Label>
                <Input
                  type="email"
                  placeholder="headteacher@school.com"
                  value={form.email}
                  onChange={(e) => update("email", e.target.value)}
                  required
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label>Password *</Label>
                  <Input
                    type="password"
                    placeholder="Min 8 characters"
                    value={form.password}
                    onChange={(e) => update("password", e.target.value)}
                    required
                  />
                </div>
                <div className="space-y-1">
                  <Label>Confirm Password *</Label>
                  <Input
                    type="password"
                    placeholder="Repeat password"
                    value={form.confirmPassword}
                    onChange={(e) => update("confirmPassword", e.target.value)}
                    required
                  />
                </div>
              </div>

              {error && (
                <p className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded">{error}</p>
              )}

              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? "Creating your account..." : "Start Free Trial"}
              </Button>
            </form>
          </CardContent>
        </Card>

        <p className="text-center text-sm text-gray-600">
          Already have an account?{" "}
          <Link href="/login" className="text-indigo-600 font-medium hover:underline">
            Sign in
          </Link>
        </p>
        <p className="text-center text-xs text-gray-400">
          30-day free trial · Then from UGX 50,000 per term ·{" "}
          <Link href="/#pricing" className="underline hover:text-gray-600">
            See pricing
          </Link>
        </p>
      </div>
    </div>
  );
}
