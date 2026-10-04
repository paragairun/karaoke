// =============================================================================
// PartyStage.tsx — Host control screen
// =============================================================================
// CHANGELOG
// v1 — Original. Missing stageId in activePartyContext, audioUrl as cache key,
//      hardcoded source: "saavn", completedSongs list.
// v2 — CURRENT: Clean rewrite.
//   FIXED:
//   - stageId now included in activePartyContext — was missing, causing all
//     party scores to have stage_id=null and never appear on party leaderboard
//   - Pre-separation uses track_id as cache key (stable) not audioUrl (expires)
//   - source field set dynamically from queue item (supports YouTube tracks)
//   - handlePlayNext also warms Modal if cache miss (saves ~30s on next song)
//   REMOVED:
//   - completedSongs list — replaced by PartyLeaderboard component
//   - Card/CardContent imports — replaced with plain divs
//   UI:
//   - Energetic design matching new theme
//   - PartyLeaderboard wired in
// =============================================================================

import { useEffect, useState, useRef, useCallback } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { useVocalSeparation, warmUpModal } from "@/hooks/useVocalSeparation";
import { fetchLyricsCached, parseDurationToSeconds } from "@/lib/lyricsClient";
import { getDeviceId } from "@/hooks/usePartyDevice";
import { PartyLeaderboard } from "@/components/PartyLeaderboard";
import { ArrowLeft, Copy, Check, Play, X, Music, Loader2, Mic, Share2, HelpCircle, Search, Plus } from "lucide-react";

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
  source?: string;
}

interface QueueItem {
  id: string;
  track_id: string;
  song_title: string;
  song_artist: string | null;
  thumbnail_url: string | null;
  audio_url: string;
  duration_seconds: number | null;
  language: string | null;
  album: string | null;
  singer_name: string;
  device_id: string;
  position: number;
  status: 'queued' | 'ready' | 'singing' | 'completed' | 'skipped';
  score: number | null;
  rating: string | null;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function PartyStage() {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const { toast } = useToast();
  const { separateVocals } = useVocalSeparation();

  const [stageId, setStageId] = useState<string | null>(null);
  const [stageName, setStageName] = useState('');
  const [isHost, setIsHost] = useState<boolean | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [startingId, setStartingId] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [addQuery, setAddQuery] = useState('');
  const [addResults, setAddResults] = useState<SearchTrack[]>([]);
  const [isAddSearching, setIsAddSearching] = useState(false);
  const [addedTrackId, setAddedTrackId] = useState<string | null>(null);

  const preSeparatedRef = useRef<Set<string>>(new Set());
  const deviceId = getDeviceId();

  // ── Load stage + verify host ────────────────────────────────────────────────
  useEffect(() => {
    if (authLoading || !code) return;
    const load = async () => {
      const { data, error } = await supabase
        .from('stages')
        .select('id, name, host_user_id, is_active')
        .eq('code', code.toUpperCase())
        .maybeSingle();

      if (error || !data || !data.is_active) {
        toast({ title: 'Party not found', description: 'This party may have ended', variant: 'destructive' });
        navigate('/'); return;
      }
      if (!user || user.id !== data.host_user_id) {
        toast({ title: 'Not your party', description: 'Only the host can control this party', variant: 'destructive' });
        navigate('/'); return;
      }

      setStageId(data.id);
      setStageName(data.name);
      setIsHost(true);
      setLoading(false);
    };
    load();
  }, [code, user, authLoading, navigate, toast]);

  // ── Realtime queue ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!stageId) return;
    const fetchQueue = async () => {
      const { data } = await supabase
        .from('stage_queue')
        .select('*')
        .eq('stage_id', stageId)
        .order('position', { ascending: true });
      if (data) setQueue(data as QueueItem[]);
    };
    fetchQueue();
    const channel = supabase
      .channel(`stage-queue-${stageId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'stage_queue', filter: `stage_id=eq.${stageId}` }, fetchQueue)
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [stageId]);

  // ── Background pre-separation of next queued song ───────────────────────────
  // Caching now lives server-side inside the separate-vocals edge function
  // (Supabase Storage, global cache) — no local IndexedDB check/save needed
  // here anymore. If the song's already in Storage from a previous singer
  // anywhere, this call returns almost instantly with fromCache: true.
  useEffect(() => {
    const next = queue.find(q => q.status === 'queued');
    if (!next || preSeparatedRef.current.has(next.id)) return;
    preSeparatedRef.current.add(next.id);

    // Background T4 tier — nobody actively waiting on this one yet.
    separateVocals(next.audio_url, 'background', next.track_id)
      .then(result => {
        if (result) console.log('[Party] Pre-separated:', next.song_title, result.fromCache ? '(Storage cache hit)' : '(fresh)');
      })
      .catch(e => console.warn('[Party] Pre-separation failed (non-fatal):', e));
  }, [queue, separateVocals]);

  // ── Handlers ────────────────────────────────────────────────────────────────

  const handleCopyCode = () => {
    if (!code) return;
    navigator.clipboard.writeText(code.toUpperCase());
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleShareCode = async () => {
    if (!code) return;
    // Clean URL (no #). Old #/ links still work: App.tsx converts them on load.
    const shareUrl = `${window.location.origin}/party/${code.toUpperCase()}/queue`;
    const text = `Join my KaraokeParty! Code: ${code.toUpperCase()}\n${shareUrl}`;
    if (navigator.share) {
      try { await navigator.share({ title: `${stageName} — KaraokeParty`, text, url: shareUrl }); }
      catch { /* user cancelled */ }
    } else {
      navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast({ title: 'Link copied', description: 'Paste it to share with friends' });
    }
  };

  const handleAddSearch = useCallback(async () => {
    if (!addQuery.trim()) return;
    setIsAddSearching(true);
    try {
      const { data, error } = await supabase.functions.invoke('search-music', { body: { query: addQuery.trim() } });
      if (error) throw error;
      setAddResults(data?.tracks ?? []);
    } catch {
      toast({ title: 'Search failed', description: 'Please try again', variant: 'destructive' });
    } finally {
      setIsAddSearching(false);
    }
  }, [addQuery, toast]);

  const handleAddSong = async (track: SearchTrack) => {
    if (!stageId || !user) return;
    setAddedTrackId(track.id);
    const singerName = user.user_metadata?.username || user.user_metadata?.full_name || 'Host';
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
      singer_name: singerName,
      device_id: deviceId,
      status: 'queued',
    });
    if (error) {
      toast({ title: 'Could not add song', variant: 'destructive' });
      setAddedTrackId(null);
    } else {
      setTimeout(() => setAddedTrackId(null), 1500);
    }
  };

  const handleRemove = async (id: string) => {
    await supabase.from('stage_queue').delete().eq('id', id);
  };

  const handlePlayNext = useCallback(async (item: QueueItem) => {
    setStartingId(item.id);
    await supabase.from('stage_queue').update({ status: 'singing' }).eq('id', item.id);

    const track = {
      id: item.track_id,
      title: item.song_title,
      artist: item.song_artist ?? '',
      thumbnail: item.thumbnail_url ?? '',
      duration: item.duration_seconds ? String(item.duration_seconds) : '',
      // source is dynamic — queue may contain YouTube tracks from the cascade
      source: (item as any).source ?? 'saavn',
      audioUrl: item.audio_url,
      album: item.album ?? undefined,
      language: item.language ?? undefined,
    };

    sessionStorage.setItem('selectedTrack', JSON.stringify(track));
    // Include stageId so Sing.tsx links the score to this party's leaderboard
    sessionStorage.setItem('activePartyContext', JSON.stringify({
      code: code?.toUpperCase(),
      queueId: item.id,
      singerName: item.singer_name,
      stageId,
    }));
    sessionStorage.removeItem('prefetchedLyrics');

    // Prefetch lyrics in parallel
    // Whole result (lines + synced/mismatch flags), keyed to this track, as on the homepage.
    fetchLyricsCached({ trackId: track.id, title: track.title, artist: track.artist, album: track.album, duration: parseDurationToSeconds(track.duration), language: track.language })
      .then(result => { if (result?.lyrics?.length > 0) sessionStorage.setItem('prefetchedLyrics', JSON.stringify({ ...result, trackId: track.id })); })
      .catch(() => {});

    // Warm Modal unconditionally — no local cache check available anymore
    // (caching lives in Storage, checked server-side). Harmless if it turns
    // out this song is already cached; the edge function just won't need
    // Modal at all in that case.
    warmUpModal();

    navigate(`/sing/${track.id}`);
  }, [code, navigate, stageId]);

  const handleEndParty = async () => {
    if (!stageId) return;
    await supabase.from('stages').update({ is_active: false }).eq('id', stageId);
    navigate('/');
  };

  // ── Derived state ───────────────────────────────────────────────────────────
  const singingSong = queue.find(q => q.status === 'singing');
  const queuedSongs = queue.filter(q => q.status === 'queued');

  // ── Render ──────────────────────────────────────────────────────────────────
  if (loading || isHost === null) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="glass border-b border-border p-4 sticky top-0 z-50">
        <div className="max-w-3xl mx-auto flex items-center gap-3">
          <Link to="/"><Button variant="ghost" size="icon"><ArrowLeft className="w-5 h-5" /></Button></Link>
          <div className="flex-1 min-w-0">
            <h1 className="font-semibold text-base flex items-center gap-2 truncate">
              <Mic className="w-4 h-4 text-primary shrink-0" />{stageName}
            </h1>
            <p className="text-xs text-muted-foreground">You're hosting — only you can play songs</p>
          </div>
          <Button variant="outline" size="sm" onClick={handleEndParty} className="shrink-0">End party</Button>
        </div>
      </header>

      <main className="max-w-3xl mx-auto p-4 space-y-5">

        {/* Search + add */}
        <div>
          <div className="flex gap-2">
            <Input
              placeholder="Search a song to add..."
              value={addQuery}
              onChange={e => setAddQuery(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleAddSearch()}
              className="rounded-full"
            />
            <Button onClick={handleAddSearch} disabled={isAddSearching || !addQuery.trim()} size="icon" className="gradient-primary text-primary-foreground rounded-full shrink-0">
              {isAddSearching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
            </Button>
          </div>
          {addResults.length > 0 && (
            <div className="mt-2 rounded-xl border border-border overflow-hidden">
              {addResults.map(track => (
                <div key={track.id} className="flex items-center gap-3 p-2 hover:bg-muted/50 border-b border-border/50 last:border-0">
                  <div className="w-10 h-10 rounded-lg bg-muted shrink-0 overflow-hidden">
                    {track.thumbnail ? <img src={track.thumbnail} alt="" className="w-full h-full object-cover" loading="lazy" /> : <Music className="w-4 h-4 m-3 text-muted-foreground" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{track.title}</p>
                    <p className="text-xs text-muted-foreground truncate">{track.artist}</p>
                  </div>
                  <Button size="sm" variant="outline" className="h-8 shrink-0" onClick={() => handleAddSong(track)} disabled={addedTrackId === track.id}>
                    {addedTrackId === track.id ? <Check className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Join code card */}
        <div className="rounded-2xl border border-border bg-card p-4">
          <div className="flex items-center justify-between mb-3">
            <div>
              <p className="text-xs text-muted-foreground mb-1">Share this code with friends</p>
              <p className="text-3xl font-bold tracking-[0.3em] text-gradient">{code?.toUpperCase()}</p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={handleCopyCode}>
                {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
              </Button>
              <Button size="sm" className="gradient-primary text-primary-foreground" onClick={handleShareCode}>
                <Share2 className="w-4 h-4 mr-1.5" />Share
              </Button>
            </div>
          </div>
          <button onClick={() => setShowHelp(s => !s)} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors">
            <HelpCircle className="w-3.5 h-3.5" /> How does this work?
          </button>
          {showHelp && (
            <div className="mt-2 text-xs text-muted-foreground space-y-1 bg-muted/50 rounded-lg p-3">
              <p>1. Share the code above with your friends.</p>
              <p>2. They tap "Join Party" and enter the code on their own phone.</p>
              <p>3. They search and add songs to the queue with their name.</p>
              <p>4. Only you play each song here. Hand the mic around!</p>
              <p>5. Everyone sees live scores as each song finishes.</p>
            </div>
          )}
        </div>

        {/* Now singing / up next */}
        {singingSong ? (
          <div className="rounded-2xl border-2 border-primary bg-card p-4">
            <p className="text-xs text-muted-foreground mb-1">On stage now</p>
            <p className="font-semibold truncate">{singingSong.song_title}</p>
            <p className="text-sm text-muted-foreground">{singingSong.singer_name} is singing</p>
          </div>
        ) : queuedSongs.length > 0 ? (
          <div className="rounded-2xl border-2 border-primary bg-card p-4 flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground mb-1">Up next</p>
              <p className="font-semibold truncate">{queuedSongs[0].song_title}</p>
              <p className="text-sm text-muted-foreground truncate">{queuedSongs[0].singer_name}</p>
            </div>
            <Button
              className="gradient-primary text-primary-foreground shrink-0"
              onClick={() => handlePlayNext(queuedSongs[0])}
              disabled={startingId === queuedSongs[0].id}
            >
              {startingId === queuedSongs[0].id ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Play className="w-4 h-4 mr-2" />}
              Play
            </Button>
          </div>
        ) : (
          <p className="text-center text-sm text-muted-foreground py-6">
            No songs queued yet. Share the code so friends can add some!
          </p>
        )}

        {/* Rest of queue */}
        {queuedSongs.length > 1 && (
          <div>
            <p className="text-xs text-muted-foreground mb-2 px-1">Queue ({queuedSongs.length - 1} more)</p>
            <div className="rounded-xl border border-border overflow-hidden">
              {queuedSongs.slice(1).map((item, i) => (
                <div key={item.id} className={`flex items-center gap-3 p-3 hover:bg-muted/40 transition-colors ${i > 0 ? 'border-t border-border/50' : ''}`}>
                  <div className="w-10 h-10 rounded-lg bg-muted shrink-0 overflow-hidden flex items-center justify-center">
                    {item.thumbnail_url ? <img src={item.thumbnail_url} alt="" className="w-full h-full object-cover" loading="lazy" /> : <Music className="w-4 h-4 text-muted-foreground" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{item.song_title}</p>
                    <p className="text-xs text-muted-foreground truncate">{item.singer_name}</p>
                  </div>
                  <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={() => handleRemove(item.id)}>
                    <X className="w-4 h-4" />
                  </Button>
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
            isPartyActive={true}
          />
        )}

      </main>
    </div>
  );
}
