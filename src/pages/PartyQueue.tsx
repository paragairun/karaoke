// =============================================================================
// PartyQueue.tsx — Participant view for a Party
// =============================================================================
// CHANGELOG
// v1 — Original. audioUrl as cache key, no isPartyActive state.
// v2 — Clean rewrite. Realtime stages listener. PartyLeaderboard wired in.
// v3 — CURRENT:
//   ADDED:
//   - assigned_to field shown in queue items (who the song is for)
//   UI:
//   - Header updated to reflect: queue songs here, take host device to sing
// =============================================================================

import { useEffect, useState, useCallback } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { getDeviceId, getGuestName } from "@/hooks/usePartyDevice";
import { parseDurationToSeconds } from "@/lib/lyricsClient";
import { PartyLeaderboard } from "@/components/PartyLeaderboard";
import { ArrowLeft, Search, Music, Plus, X, Loader2, Mic, Check } from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface SearchTrack {
  id: string;
  title: string;
  artist: string;
  thumbnail: string;
  duration: string;
  audioUrl: string;
  album?: string;
  language?: string;
}

interface QueueItem {
  id: string;
  song_title: string;
  song_artist: string | null;
  thumbnail_url: string | null;
  singer_name: string;
  device_id: string;
  status: 'queued' | 'ready' | 'singing' | 'completed' | 'skipped';
  score: number | null;
  rating: string | null;
  assigned_to: string | null;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function PartyQueue() {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const { toast } = useToast();

  const [stageId, setStageId] = useState<string | null>(null);
  const [stageName, setStageName] = useState('');
  const [notFound, setNotFound] = useState(false);
  const [loading, setLoading] = useState(true);
  const [myName, setMyName] = useState('');
  const [isPartyActive, setIsPartyActive] = useState(true);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchTrack[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [addedId, setAddedId] = useState<string | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);

  const deviceId = getDeviceId();

  // ── Load stage ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (authLoading || !code) return;

    const displayName = user
      ? (user.user_metadata?.username || user.user_metadata?.full_name || 'Singer')
      : getGuestName(code.toUpperCase());

    if (!displayName) { navigate('/party/join'); return; }
    setMyName(displayName);

    const load = async () => {
      const { data } = await supabase
        .from('stages')
        .select('id, name, is_active')
        .eq('code', code.toUpperCase())
        .maybeSingle();

      if (!data || !data.is_active) { setNotFound(true); setLoading(false); return; }
      setStageId(data.id);
      setStageName(data.name);
      setLoading(false);
    };
    load();
  }, [code, user, authLoading, navigate]);

  // ── Realtime queue + party-ended listener ───────────────────────────────────
  useEffect(() => {
    if (!stageId) return;

    const fetchQueue = async () => {
      const { data } = await supabase
        .from('stage_queue')
        .select('id, song_title, song_artist, thumbnail_url, singer_name, device_id, status, score, rating, assigned_to')
        .eq('stage_id', stageId)
        .order('position', { ascending: true });
      if (data) setQueue(data as QueueItem[]);
    };
    fetchQueue();

    const queueChannel = supabase
      .channel(`stage-queue-participant-${stageId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'stage_queue', filter: `stage_id=eq.${stageId}` }, fetchQueue)
      .subscribe();

    // Listen for host ending the party
    const stageChannel = supabase
      .channel(`stage-active-${stageId}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'stages', filter: `id=eq.${stageId}` },
        (payload) => { if (payload.new?.is_active === false) setIsPartyActive(false); })
      .subscribe();

    return () => {
      supabase.removeChannel(queueChannel);
      supabase.removeChannel(stageChannel);
    };
  }, [stageId]);

  // ── Search ──────────────────────────────────────────────────────────────────
  const handleSearch = useCallback(async () => {
    if (!query.trim()) return;
    setIsSearching(true);
    try {
      const { data, error } = await supabase.functions.invoke('search-music', { body: { query: query.trim() } });
      if (error) throw error;
      setResults(data?.tracks ?? []);
    } catch {
      toast({ title: 'Search failed', description: 'Please try again', variant: 'destructive' });
    } finally {
      setIsSearching(false);
    }
  }, [query, toast]);

  // ── Add song ────────────────────────────────────────────────────────────────
  const handleAdd = async (track: SearchTrack) => {
    if (!stageId) return;
    setAddedId(track.id);
    const { error } = await supabase.from('stage_queue').insert({
      stage_id: stageId,
      track_id: track.id,
      song_title: track.title,
      song_artist: track.artist,
      thumbnail_url: track.thumbnail,
      audio_url: track.audioUrl,
      duration_seconds: parseDurationToSeconds(track.duration) ?? null,
      language: track.language ?? null,
      album: track.album ?? null,
      singer_name: myName,
      device_id: deviceId,
      status: 'queued',
    });
    if (error) {
      toast({ title: 'Could not add song', variant: 'destructive' });
      setAddedId(null);
    } else {
      toast({ title: 'Added to queue!' });
      setTimeout(() => setAddedId(null), 1500);
    }
  };

  const handleRemove = async (id: string) => {
    await supabase.from('stage_queue').delete().eq('id', id);
  };

  // ── Derived ─────────────────────────────────────────────────────────────────
  const singingSong = queue.find(q => q.status === 'singing');
  const queuedSongs = queue.filter(q => q.status === 'queued');

  // ── Early returns ───────────────────────────────────────────────────────────
  if (loading || authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-background gap-4 p-4">
        <p className="text-muted-foreground">This party doesn't exist or has ended.</p>
        <Link to="/"><Button variant="outline">Back to home</Button></Link>
      </div>
    );
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-background">
      <header className="glass border-b border-border p-4 sticky top-0 z-50">
        <div className="max-w-xl mx-auto flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <h1 className="font-semibold text-base flex items-center gap-2 truncate">
              <Mic className="w-4 h-4 text-primary shrink-0" />{stageName}
            </h1>
            <p className="text-xs text-muted-foreground">Queue songs here · take host's device to sing</p>
          </div>
          <Link to="/"><Button variant="outline" size="sm" className="shrink-0 gap-1"><ArrowLeft className="w-4 h-4" />Leave</Button></Link>
        </div>
      </header>

      <main className="max-w-xl mx-auto p-4 space-y-5">

        {/* Search + add */}
        <div className="flex gap-2">
          <Input
            placeholder="Search a song to add..."
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSearch()}
            className="rounded-full"
          />
          <Button onClick={handleSearch} disabled={isSearching || !query.trim()} size="icon" className="gradient-primary text-primary-foreground rounded-full shrink-0">
            {isSearching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
          </Button>
        </div>

        {results.length > 0 && (
          <div className="rounded-xl border border-border overflow-hidden">
            {results.map(track => (
              <div key={track.id} className="flex items-center gap-3 p-2 hover:bg-muted/50 border-b border-border/50 last:border-0">
                <div className="w-10 h-10 rounded-lg bg-muted shrink-0 overflow-hidden">
                  {track.thumbnail ? <img src={track.thumbnail} alt="" className="w-full h-full object-cover" loading="lazy" /> : <Music className="w-4 h-4 m-3 text-muted-foreground" />}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{track.title}</p>
                  <p className="text-xs text-muted-foreground truncate">{track.artist}</p>
                </div>
                <Button size="sm" variant="outline" className="h-8 shrink-0" onClick={() => handleAdd(track)} disabled={addedId === track.id}>
                  {addedId === track.id ? <Check className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
                </Button>
              </div>
            ))}
          </div>
        )}

        {/* Now singing */}
        {singingSong && (
          <div className="rounded-2xl border-2 border-primary bg-card p-4">
            <p className="text-xs text-muted-foreground mb-1">On stage now</p>
            <p className="font-semibold truncate">{singingSong.song_title}</p>
            <p className="text-sm text-muted-foreground">{singingSong.assigned_to || singingSong.singer_name}</p>
          </div>
        )}

        {/* Queue */}
        {queuedSongs.length > 0 && (
          <div>
            <p className="text-xs text-muted-foreground mb-2 px-1">Up next ({queuedSongs.length})</p>
            <div className="rounded-xl border border-border overflow-hidden">
              {queuedSongs.map((item, i) => (
                <div key={item.id} className={`flex items-center gap-3 p-3 hover:bg-muted/40 transition-colors ${i > 0 ? 'border-t border-border/50' : ''}`}>
                  <div className="w-9 h-9 rounded-lg bg-muted shrink-0 overflow-hidden flex items-center justify-center">
                    {item.thumbnail_url ? <img src={item.thumbnail_url} alt="" className="w-full h-full object-cover" loading="lazy" /> : <Music className="w-3.5 h-3.5 text-muted-foreground" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{item.song_title}</p>
                    <p className="text-xs text-muted-foreground truncate">
                      {item.assigned_to ? <><span className="text-primary font-medium">{item.assigned_to}</span> · {item.singer_name}</> : item.singer_name}
                    </p>
                  </div>
                  {item.device_id === deviceId && (
                    <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => handleRemove(item.id)}>
                      <X className="w-4 h-4" />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Party leaderboard */}
        {stageId && (
          <PartyLeaderboard
            stageId={stageId}
            currentSingerName={singingSong?.singer_name ?? null}
            isPartyActive={isPartyActive}
          />
        )}

      </main>
    </div>
  );
}
