import { Component, ReactNode } from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HashRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "@/hooks/useAuth";
import { useEffect } from "react";
import { warmUpHFSpace } from "@/hooks/useVocalSeparation";
import Index from "./pages/Index";
import Auth from "./pages/Auth";
import Sing from "./pages/Sing";
import Leaderboard from "./pages/Leaderboard";
import History from "./pages/History";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

// Error boundary catches render-time crashes and shows them on screen
// instead of leaving a blank page with no indication of what went wrong.
class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ color: "red", padding: "2rem", fontFamily: "sans-serif", whiteSpace: "pre-wrap" }}>
          <h2>Something went wrong</h2>
          <p>{this.state.error.message}</p>
          <pre style={{ fontSize: "0.8rem" }}>{this.state.error.stack}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

const App = () => {
  useEffect(() => {
    warmUpHFSpace().catch(() => {});
  }, []);

  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <TooltipProvider>
            <Toaster />
            <Sonner />
            <HashRouter>
              <Routes>
                <Route path="/" element={<Index />} />
                <Route path="/auth" element={<Auth />} />
                <Route path="/sing/:trackId" element={<Sing />} />
                <Route path="/leaderboard" element={<Leaderboard />} />
                <Route path="/history" element={<History />} />
                <Route path="*" element={<NotFound />} />
              </Routes>
            </HashRouter>
          </TooltipProvider>
        </AuthProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
};

export default App;
