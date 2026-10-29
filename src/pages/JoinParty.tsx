// =============================================================================
// JoinParty.tsx — Join Party flow
// =============================================================================
// CHANGELOG
// v1 — Original. setIsJoining(false) before navigation block.
// v2 — Clean rewrite. setIsJoining in finally block. Validation before DB call.
// v3 — CURRENT:
//   UI:
//   - Descriptions updated to reflect join device = song queue device model
//   - Subtitle and bullets clarify: join phone queues songs, host device is the mic
// =============================================================================

import { useState, useCallback } from "react";
import { useNavigate, Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { setGuestName } from "@/hooks/usePartyDevice";
import { ArrowLeft, Users, Loader2 } from "lucide-react";

export default function JoinParty() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { toast } = useToast();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [isJoining, setIsJoining] = useState(false);

  const handleJoin = useCallback(async () => {
    const trimCode = code.trim().toUpperCase();
    if (!trimCode) return;

    // Validate name before DB round-trip
    if (!user && !name.trim()) {
      toast({ title: 'Enter your name', description: 'Friends need to know who added each song', variant: 'destructive' });
      return;
    }

    setIsJoining(true);
    try {
      const { data, error } = await supabase
        .from('stages')
        .select('code, is_active')
        .eq('code', trimCode)
        .eq('is_active', true)
        .maybeSingle();

      if (error || !data) {
        toast({ title: 'Party not found', description: 'Check the code and try again', variant: 'destructive' });
        return;
      }

      if (!user) setGuestName(trimCode, name.trim());
      navigate(`/party/${trimCode}/queue`);
    } finally {
      setIsJoining(false);
    }
  }, [code, name, user, navigate, toast]);

  const canJoin = !!code.trim() && (!!user || !!name.trim());

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-md">

        <Link to="/" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground mb-6">
          <ArrowLeft className="w-4 h-4" /> Back
        </Link>

        <div className="rounded-2xl border border-border bg-card p-6">

          {/* Icon + title */}
          <div className="flex flex-col items-center mb-6">
            <div className="w-14 h-14 rounded-2xl gradient-primary flex items-center justify-center mb-3">
              <Users className="w-7 h-7 text-primary-foreground" />
            </div>
            <h1 className="text-xl font-semibold">Join a party</h1>
            <p className="text-sm text-muted-foreground text-center mt-1">
              Use your phone to queue songs — take the host's device when it's your turn to sing
            </p>
          </div>

          {/* How it works */}
          <div className="bg-muted/50 rounded-xl p-3 mb-5 space-y-1.5">
            <p className="text-xs font-medium">How joining works</p>
            {[
              'Enter the 4-letter code your host shared with you',
              'Browse and queue songs from your phone for your turn',
              'When it\'s your turn, walk up and take the host\'s device to sing',
              'Your score posts to the party leaderboard live',
            ].map(line => (
              <p key={line} className="text-xs text-muted-foreground">· {line}</p>
            ))}
          </div>

          {/* Form */}
          <div className="space-y-3">
            <Input
              placeholder="ABCD"
              value={code}
              onChange={e => setCode(e.target.value.toUpperCase())}
              maxLength={4}
              className="text-center text-2xl tracking-[0.3em] font-semibold h-14"
              onKeyDown={e => e.key === 'Enter' && handleJoin()}
              autoCapitalize="characters"
              autoCorrect="off"
            />
            {!user && (
              <Input
                placeholder="Your name"
                value={name}
                onChange={e => setName(e.target.value)}
                maxLength={30}
                onKeyDown={e => e.key === 'Enter' && handleJoin()}
                className="h-11"
              />
            )}
            <Button
              className="w-full gradient-primary text-primary-foreground h-11"
              onClick={handleJoin}
              disabled={isJoining || !canJoin}
            >
              {isJoining && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
              Join party
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
