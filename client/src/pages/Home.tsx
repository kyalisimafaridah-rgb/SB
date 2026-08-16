import { Link } from "wouter";
import { Button } from "../components/ui/button";
import {
  CheckCircle2,
  Smartphone,
  Users,
  FileText,
  MessageSquare,
  Shield,
  WifiOff,
  ArrowRight,
} from "lucide-react";
import logoWordmark from "../assets/logo-wordmark.png";
import {
  TIER_AMOUNTS,
  TIER_LABELS,
  TIER_STUDENT_RANGES,
  TIER_DESCRIPTIONS,
  formatUgx,
  BILLING_PERIOD,
  TRIAL_DAYS,
  FEATURES,
  type SchoolTier,
} from "../../../shared/pricing";

const TIERS: SchoolTier[] = ["small", "medium", "large"];

const FEATURE_ICONS = [FileText, Users, Smartphone, MessageSquare, Shield, WifiOff];

export default function Home() {
  return (
    <div className="min-h-screen bg-card text-foreground">
      {/* Nav */}
      <header className="border-b border-gray-100 sticky top-0 bg-card/95 backdrop-blur z-20">
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between">
          <Link href="/">
            <img src={logoWordmark} alt="ScholarBase" className="h-8 w-auto cursor-pointer" />
          </Link>
          <div className="flex items-center gap-2">
            <Link href="/login">
              <Button variant="ghost" size="sm">
                Sign in
              </Button>
            </Link>
            <Link href="/signup">
              <Button size="sm" className="bg-indigo-600 hover:bg-indigo-700">
                Start free trial
              </Button>
            </Link>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="bg-gradient-to-br from-indigo-50 via-white to-blue-50">
        <div className="max-w-5xl mx-auto px-4 py-16 sm:py-24 text-center">
          <p className="text-sm font-medium text-indigo-600 mb-3">
            Built for Ugandan schools
          </p>
          <h1 className="text-3xl sm:text-5xl font-bold tracking-tight text-foreground max-w-2xl mx-auto leading-tight">
            Collect school fees without the chaos
          </h1>
          <p className="mt-4 text-lg text-muted-foreground max-w-xl mx-auto">
            Track every student balance, record MoMo and cash payments, chase
            defaulters with SMS, and give parents a simple portal — all in one
            place.
          </p>
          <div className="mt-8 flex flex-col sm:flex-row gap-3 justify-center">
            <Link href="/signup">
              <Button size="lg" className="bg-indigo-600 hover:bg-indigo-700 w-full sm:w-auto">
                Start {TRIAL_DAYS}-day free trial
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </Link>
            <a href="#pricing">
              <Button size="lg" variant="outline" className="w-full sm:w-auto">
                See pricing
              </Button>
            </a>
          </div>
          <p className="mt-4 text-sm text-muted-foreground">
            No setup fee · No long contract · Cancel anytime
          </p>
        </div>
      </section>

      {/* Features */}
      <section className="max-w-5xl mx-auto px-4 py-16 sm:py-20">
        <h2 className="text-2xl sm:text-3xl font-bold text-center mb-3">
          Everything your bursar needs
        </h2>
        <p className="text-center text-muted-foreground mb-12 max-w-lg mx-auto">
          Designed around how Ugandan schools actually collect fees — terms,
          streams, UNEB, lunch, and mobile money.
        </p>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {FEATURES.map((f, i) => {
            const Icon = FEATURE_ICONS[i] ?? CheckCircle2;
            return (
              <div
                key={f.title}
                className="rounded-xl border border-gray-100 bg-muted/50 p-5 hover:border-indigo-200 transition-colors"
              >
                <div className="h-9 w-9 rounded-lg bg-indigo-100 text-indigo-600 flex items-center justify-center mb-3">
                  <Icon className="h-5 w-5" />
                </div>
                <h3 className="font-semibold text-foreground">{f.title}</h3>
                <p className="mt-1.5 text-sm text-muted-foreground leading-relaxed">
                  {f.description}
                </p>
              </div>
            );
          })}
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="bg-muted border-y border-gray-100">
        <div className="max-w-5xl mx-auto px-4 py-16 sm:py-20">
          <h2 className="text-2xl sm:text-3xl font-bold text-center mb-3">
            Simple pricing by school size
          </h2>
          <p className="text-center text-muted-foreground mb-10 max-w-md mx-auto">
            One plan, clear price. Pay per term. All features included on every
            tier.
          </p>
          <div className="grid md:grid-cols-3 gap-5 max-w-4xl mx-auto">
            {TIERS.map((tier) => {
              const popular = tier === "medium";
              return (
                <div
                  key={tier}
                  className={`relative rounded-2xl bg-card p-6 border-2 flex flex-col ${
                    popular
                      ? "border-indigo-500 shadow-lg shadow-indigo-100"
                      : "border-gray-200"
                  }`}
                >
                  {popular && (
                    <span className="absolute -top-3 left-1/2 -translate-x-1/2 bg-indigo-600 text-white text-xs font-semibold px-3 py-0.5 rounded-full">
                      Most popular
                    </span>
                  )}
                  <h3 className="font-bold text-lg text-foreground">
                    {TIER_LABELS[tier]}
                  </h3>
                  <p className="text-sm text-muted-foreground mt-0.5">
                    {TIER_STUDENT_RANGES[tier]}
                  </p>
                  <p className="mt-4">
                    <span className="text-3xl font-bold text-foreground">
                      {formatUgx(TIER_AMOUNTS[tier])}
                    </span>
                    <span className="text-sm text-muted-foreground ml-1">{BILLING_PERIOD}</span>
                  </p>
                  <p className="mt-3 text-sm text-muted-foreground flex-1">
                    {TIER_DESCRIPTIONS[tier]}
                  </p>
                  <ul className="mt-4 space-y-2 text-sm text-muted-foreground">
                    {[
                      "Unlimited students in tier",
                      "Fee tracking & payments",
                      "Parent portal",
                      "Bulk SMS",
                      "Exam clearance",
                      "Offline mode",
                    ].map((item) => (
                      <li key={item} className="flex items-start gap-2">
                        <CheckCircle2 className="h-4 w-4 text-green-500 mt-0.5 shrink-0" />
                        {item}
                      </li>
                    ))}
                  </ul>
                  <Link href="/signup" className="mt-6 block">
                    <Button
                      className={`w-full ${
                        popular
                          ? "bg-indigo-600 hover:bg-indigo-700"
                          : "bg-gray-900 hover:bg-gray-800"
                      }`}
                    >
                      Start free trial
                    </Button>
                  </Link>
                </div>
              );
            })}
          </div>
          <p className="text-center text-sm text-muted-foreground mt-8">
            After the {TRIAL_DAYS}-day trial, message us on WhatsApp to activate
            your plan. MTN MoMo, Airtel Money, or bank transfer accepted.
          </p>
        </div>
      </section>

      {/* CTA */}
      <section className="max-w-5xl mx-auto px-4 py-16 text-center">
        <h2 className="text-2xl sm:text-3xl font-bold mb-3">
          Ready to stop chasing paper receipts?
        </h2>
        <p className="text-muted-foreground mb-6 max-w-md mx-auto">
          Set up your school in minutes. Invite your bursar. Start recording
          payments the same day.
        </p>
        <Link href="/signup">
          <Button size="lg" className="bg-indigo-600 hover:bg-indigo-700">
            Create your school — free for {TRIAL_DAYS} days
          </Button>
        </Link>
      </section>

      {/* Footer */}
      <footer className="border-t border-gray-100 py-8">
        <div className="max-w-5xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-3 text-sm text-muted-foreground">
          <div className="flex items-center gap-2">
            <img src={logoWordmark} alt="ScholarBase" className="h-5 w-auto opacity-70" />
            <span>© {new Date().getFullYear()} ScholarBase</span>
          </div>
          <div className="flex gap-4">
            <Link href="/login" className="hover:text-foreground">
              Sign in
            </Link>
            <Link href="/signup" className="hover:text-foreground">
              Sign up
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
