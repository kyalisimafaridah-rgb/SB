import { Link } from "wouter";
import { isTokenValid } from "../_core/hooks/useAuth";
import { Button } from "../components/ui/button";

export default function NotFound() {
  const home = isTokenValid() ? "/dashboard" : "/";
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-6">
      <div className="text-center space-y-4 max-w-sm">
        <p className="text-5xl font-bold text-gray-200">404</p>
        <h1 className="text-xl font-semibold text-gray-900">Page not found</h1>
        <p className="text-sm text-gray-500">
          That link doesn’t exist or may have moved.
        </p>
        <Link href={home}>
          <Button className="bg-indigo-600 hover:bg-indigo-700">
            {isTokenValid() ? "Back to dashboard" : "Go home"}
          </Button>
        </Link>
      </div>
    </div>
  );
}
